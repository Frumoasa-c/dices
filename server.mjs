import { createServer as createViteServer } from 'vite';
import { WebSocketServer } from 'ws';

const rooms = new Map();
const clients = new Map();
const randomCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();
const rollDice = () => Array.from({ length: 5 }, () => 1 + Math.floor(Math.random() * 6));
const strength = (point) => (point === 1 ? 7 : point);
function message(ws, payload) { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); }
function error(ws, text) { message(ws, { type: 'error', text }); }
function roomFor(ws) { return rooms.get(clients.get(ws)?.roomCode); }
function serialise(room, viewer) {
  const viewerId = clients.get(viewer)?.playerId;
  return { type: 'state', room: { code: room.code, youId: viewerId, capacity: room.capacity, phase: room.phase, hostId: room.hostId, currentPlayerId: room.currentPlayerId, bid: room.bid, result: room.result, players: room.players.map((player) => ({ id: player.id, name: player.name, losses: player.losses, dice: room.phase === 'revealed' || player.id === viewerId ? player.dice : null })) } };
}
function broadcast(room) { room.players.forEach((player) => message(player.ws, serialise(room, player.ws))); }
function nextPlayer(room, id) { const i = room.players.findIndex((p) => p.id === id); return room.players[(i + 1) % room.players.length]?.id; }
function beginRound(room, firstId = room.currentPlayerId) { room.players.forEach((p) => { p.dice = rollDice(); }); room.phase = 'playing'; room.bid = null; room.result = null; room.currentPlayerId = firstId || room.players[0]?.id; broadcast(room); }
function canRaise(previous, next) {
  if (!previous) return next.count >= 2;
  if (previous.mode === 'zai') return next.mode === 'fly' && next.count >= previous.count * 2;
  if (next.mode === 'zai') return next.count >= previous.count;
  return next.count > previous.count || (next.count === previous.count && strength(next.point) > strength(previous.point));
}
function handleBid(ws, data) {
  const room = roomFor(ws); const client = clients.get(ws);
  if (!room || room.phase !== 'playing' || room.currentPlayerId !== client?.playerId) return error(ws, '现在不能叫点。');
  const count = Number(data.count), point = Number(data.point), label = data.mode;
  if (!Number.isInteger(count) || count < room.capacity || count > 15 || !Number.isInteger(point) || point < 1 || point > 6 || !['normal', 'zai', 'fly'].includes(label)) return error(ws, '叫点不符合规则。');
  if (label === 'fly' && room.bid?.mode !== 'zai') return error(ws, '只有上家叫斋时才能飞。');
  if (label !== 'fly' && room.bid?.mode === 'zai') return error(ws, '上家叫斋后，只能开骰或飞。');
  const bid = { count, point, mode: label === 'fly' ? 'normal' : label, label, playerId: client.playerId };
  if (!canRaise(room.bid, bid)) return error(ws, room.bid?.mode === 'zai' ? '飞必须至少是上次数量的两倍。' : '新叫点必须比上次更大。');
  room.bid = bid; room.currentPlayerId = nextPlayer(room, client.playerId); broadcast(room);
}
function challenge(ws) {
  const room = roomFor(ws), client = clients.get(ws);
  if (!room || !room.bid || room.phase !== 'playing' || room.currentPlayerId !== client?.playerId) return error(ws, '现在不能开骰。');
  const actual = room.players.flatMap((p) => p.dice).filter((die) => die === room.bid.point || (room.bid.mode === 'normal' && die === 1)).length;
  const loserId = actual >= room.bid.count ? client.playerId : room.bid.playerId;
  room.players.find((p) => p.id === loserId).losses += 1; room.phase = 'revealed'; room.result = { actual, loserId }; room.currentPlayerId = loserId; broadcast(room);
}
function leave(ws) {
  const client = clients.get(ws), room = roomFor(ws); clients.delete(ws); if (!room || !client) return;
  room.players = room.players.filter((p) => p.id !== client.playerId); if (!room.players.length) return rooms.delete(room.code);
  room.hostId = room.players[0].id; if (room.phase !== 'lobby' && room.players.length < 2) { room.phase = 'lobby'; room.bid = null; room.result = null; }
  if (!room.players.some((p) => p.id === room.currentPlayerId)) room.currentPlayerId = room.players[0].id; broadcast(room);
}

const vite = await createViteServer({ server: { host: '0.0.0.0', port: 3095 } });
// Vite uses its own WebSocket endpoint for hot reload. Keep game traffic on a
// separate path so HMR frames can never be interpreted as game messages.
const wss = new WebSocketServer({ noServer: true });
vite.httpServer.on('upgrade', (request, socket, head) => {
  if (request.url !== '/dice') return;
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});
wss.on('connection', (ws) => {
  ws.on('error', () => ws.terminate());
  ws.on('message', (raw) => {
  let data; try { data = JSON.parse(raw); } catch { return error(ws, '无效消息。'); }
  if (data.type === 'create') {
    const capacity = Number(data.capacity); if (![2, 3].includes(capacity)) return error(ws, '房间只支持 2 或 3 人。'); let code; do { code = randomCode(); } while (rooms.has(code));
    const player = { id: crypto.randomUUID(), name: String(data.name || '玩家').trim().slice(0, 12) || '玩家', ws, dice: [], losses: 0 };
    const room = { code, capacity, phase: 'lobby', hostId: player.id, players: [player], bid: null, result: null, currentPlayerId: player.id }; rooms.set(code, room); clients.set(ws, { roomCode: code, playerId: player.id }); broadcast(room);
  } else if (data.type === 'join') {
    const room = rooms.get(String(data.code || '').trim().toUpperCase()); if (!room || room.phase !== 'lobby') return error(ws, '房间不存在或已经开始。'); if (room.players.length >= room.capacity) return error(ws, '房间已满。');
    const player = { id: crypto.randomUUID(), name: String(data.name || '玩家').trim().slice(0, 12) || '玩家', ws, dice: [], losses: 0 }; room.players.push(player); clients.set(ws, { roomCode: room.code, playerId: player.id }); broadcast(room);
  } else if (data.type === 'start') { const room = roomFor(ws); if (!room || clients.get(ws)?.playerId !== room.hostId) return error(ws, '只有房主可以开始。'); if (room.players.length !== room.capacity) return error(ws, `等待 ${room.capacity} 位玩家加入。`); beginRound(room, room.hostId); }
  else if (data.type === 'bid') handleBid(ws, data); else if (data.type === 'challenge') challenge(ws);
  else if (data.type === 'nextRound') { const room = roomFor(ws); if (room?.phase === 'revealed') beginRound(room, room.currentPlayerId); }
  });
  ws.on('close', () => leave(ws));
});
await vite.listen(); console.log('DiceShaker LAN server: http://0.0.0.0:3095');
