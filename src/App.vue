<template>
  <main class="app-shell">
    <header><span class="eyebrow">LAN LIAR'S DICE</span><h1>酒桌大话骰</h1><p>2～3 人局域网房间 · 服务器保密摇骰</p></header>
    <section v-if="!room" class="panel lobby">
      <h2>创建或加入房间</h2><label>昵称<input v-model.trim="name" maxlength="12" placeholder="玩家昵称" /></label>
      <div class="lobby-grid"><div class="choice"><h3>创建房间</h3><p>选择本局人数，成为房主。</p><div class="buttons"><button @click="create(2)">2 人房</button><button @click="create(3)">3 人房</button></div></div><div class="choice"><h3>加入房间</h3><p>输入房主分享的四位房间码。</p><input v-model.trim="roomCode" maxlength="4" placeholder="例如 A7K2" /><button @click="join">加入</button></div></div>
      <p v-if="notice" class="notice">{{ notice }}</p>
    </section>
    <section v-else class="panel game-panel">
      <div class="room-bar"><span>房间 <b>{{ room.code }}</b></span><span>{{ room.players.length }}/{{ room.capacity }} 人</span><span v-if="room.phase === 'playing'">{{ currentName }} 的回合</span></div>
      <div v-if="room.phase === 'lobby'" class="waiting"><h2>等待玩家加入</h2><p>把房间码 <b>{{ room.code }}</b> 分享给同一局域网内的朋友。</p><div class="player-list"><div v-for="player in room.players" :key="player.id" class="player-chip">{{ player.name }} <small v-if="player.id === room.hostId">房主</small></div></div><button v-if="me?.id === room.hostId" :disabled="room.players.length !== room.capacity" @click="send({type:'start'})">开始游戏</button><p v-else>等待房主开始…</p></div>
      <template v-else>
        <div class="players"><article v-for="player in room.players" :key="player.id" class="player" :class="{ current: player.id === room.currentPlayerId, me: player.id === me?.id }"><div><b>{{ player.name }}</b><span v-if="player.id === me?.id">我</span><small>负场 {{ player.losses }}</small></div><div v-if="player.dice" class="dice-row" :class="{ rolling: isRolling(player), landed }"><i v-for="(die,index) in diceFor(player)" :key="index" class="die" :style="{ animationDelay: `${index * 45}ms` }">{{ die }}</i></div><p v-else class="hidden-dice" :class="{ shaking: rolling }">{{ rolling ? '摇骰中…' : '骰盅已盖好' }}</p></article></div>
        <p v-if="rolling" class="roll-hint">骰子在骰盅里滚动…</p>
        <div class="bid-card"><template v-if="room.bid"><span class="eyebrow">当前叫点</span><strong>{{ room.bid.count }} 个 {{ room.bid.point }}{{ room.bid.mode === 'zai' ? ' 斋' : '' }}</strong><p>由 {{ bidderName }} 叫出</p></template><template v-else><span class="eyebrow">本局开始</span><strong>等待首个叫点</strong><p>起叫数量至少为 {{ room.capacity }} 个。</p></template></div>
        <section v-if="room.phase === 'playing' && myTurn" class="action-box"><h2>你的回合</h2><div class="form-row"><label>数量<input v-model.number="bidCount" type="number" :min="room.capacity" max="15" /></label><label>点数<select v-model.number="bidPoint"><option v-for="point in 6" :key="point" :value="point">{{ point }} 点</option></select></label><label>模式<select v-model="bidMode"><option value="normal">普通</option><option value="zai" :disabled="room.bid?.mode === 'zai'">斋</option><option value="fly" :disabled="room.bid?.mode !== 'zai'">飞</option></select></label></div><div class="buttons"><button :disabled="rolling" @click="bid">叫点</button><button class="danger" :disabled="!room.bid || rolling" @click="send({type:'challenge'})">开骰</button></div><p class="rule">普通：1 可代替任意点。斋：1 不算万能。上家叫斋后，飞必须至少把数量翻倍。</p></section>
        <section v-else-if="room.phase === 'revealed'" class="result"><h2>{{ loserName }} 输了这局</h2><p>叫点为 {{ room.bid.count }} 个 {{ room.bid.point }}{{ room.bid.mode === 'zai' ? '斋' : '' }}；实际可计数为 <b>{{ room.result.actual }}</b> 个。</p><button v-if="me?.id === room.currentPlayerId || me?.id === room.hostId" @click="send({type:'nextRound'})">开始下一局</button><p v-else>等待下一局开始…</p></section>
        <p v-else class="waiting-turn">等待 {{ currentName }} 叫点或开骰…</p>
      </template><p v-if="notice" class="notice">{{ notice }}</p>
    </section>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
const name = ref(localStorage.getItem('dice-name') || ''), roomCode = ref(''), room = ref(null), me = ref(null), notice = ref('');
const bidCount = ref(3), bidPoint = ref(6), bidMode = ref('normal'); let socket;
// 摇骰动画：rolling 期间骰子区显示随机点面，停下后直接显示骰子区里的真实点数。
const rolling = ref(false), landed = ref(false), rollFaces = ref([]);
const ROLL_TICK = 70, ROLL_TIME = 1120, LAND_TIME = 700;
let rollTimer = null, rollEndTimer = null, landTimer = null;
const currentName = computed(() => room.value?.players.find(p => p.id === room.value.currentPlayerId)?.name || '玩家');
const bidderName = computed(() => room.value?.players.find(p => p.id === room.value.bid?.playerId)?.name || '上一家');
const loserName = computed(() => room.value?.players.find(p => p.id === room.value.result?.loserId)?.name || '玩家');
const myTurn = computed(() => room.value?.currentPlayerId === me.value?.id);
// 骰子区里属于“我”的骰子：摇骰动画的数量与最终点数都以它为准。
const myDice = computed(() => room.value?.players.find(p => p.id === me.value?.id)?.dice || []);
const isRolling = (player) => rolling.value && player.id === me.value?.id;
const diceFor = (player) => (isRolling(player) ? rollFaces.value : player.dice);
const randomFaces = (count) => Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6));
function stopRoll() { clearInterval(rollTimer); clearTimeout(rollEndTimer); clearTimeout(landTimer); rollTimer = rollEndTimer = landTimer = null; rolling.value = false; landed.value = false; rollFaces.value = []; }
function startRoll() {
  const count = myDice.value.length;            // 骰子数量与骰子区完全一致
  if (!count) return;
  stopRoll();
  rollFaces.value = randomFaces(count);
  rolling.value = true;
  rollTimer = setInterval(() => { rollFaces.value = randomFaces(count); }, ROLL_TICK);
  rollEndTimer = setTimeout(() => {
    clearInterval(rollTimer); rollTimer = null;
    rolling.value = false;                     // 停下后骰子区显示服务端骰出的真实点数
    landed.value = true;
    landTimer = setTimeout(() => { landed.value = false; landTimer = null; }, LAND_TIME);
  }, ROLL_TIME);
}
// 开局与每局重开都由服务端把 phase 推回 playing，此时播放摇骰动画；离开对局阶段则立即收掉。
watch(() => room.value?.phase, (phase, previous) => { if (phase !== 'playing') stopRoll(); else if (previous !== 'playing') startRoll(); });
function connect() { if (socket?.readyState === WebSocket.OPEN) return; socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/dice`); socket.onmessage = ({ data }) => { const msg = JSON.parse(data); if (msg.type === 'error') return notice.value = msg.text; if (msg.type === 'state') { room.value = msg.room; me.value = room.value.players.find(p => p.id === room.value.youId) || null; notice.value = ''; if (room.value.bid) { bidCount.value = room.value.bid.count; bidPoint.value = room.value.bid.point; bidMode.value = room.value.bid.mode === 'zai' ? 'fly' : 'normal'; } } }; socket.onclose = () => { if (room.value) notice.value = '与游戏服务器断开连接。'; }; }
function send(payload) { if (socket?.readyState !== WebSocket.OPEN) return notice.value = '正在连接服务器，请稍后重试。'; socket.send(JSON.stringify(payload)); }
function playerName() { const value = name.value || '玩家'; localStorage.setItem('dice-name', value); return value; }
function create(capacity) { connect(); const go = () => send({ type: 'create', name: playerName(), capacity }); socket.readyState === WebSocket.OPEN ? go() : socket.addEventListener('open', go, { once: true }); }
function join() { if (!roomCode.value) return notice.value = '请输入房间码。'; connect(); const go = () => send({ type: 'join', name: playerName(), code: roomCode.value }); socket.readyState === WebSocket.OPEN ? go() : socket.addEventListener('open', go, { once: true }); }
function bid() { send({ type: 'bid', count: bidCount.value, point: bidPoint.value, mode: bidMode.value }); }
onMounted(connect); onBeforeUnmount(() => { stopRoll(); socket?.close(); });
</script>
