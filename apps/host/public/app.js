import { setupKeyboardBindings } from "./keymap.js";
import { gamepadState, setupGamepadBindings } from "./gamepad-map.js";
import { createHapticsController } from "./haptics.js";
import { DigitalEdgeHistory, highestDigitalEdgeSequence } from "./input-reliability.js";
import { addIceCandidateOrQueue, drainIceCandidates } from "./webrtc-ice.js";
import {
  CONTROLLER_SLOT_COUNT,
  controllerSlotLabel,
  participantForSlot,
  slotIsLocallyAvailable,
  validControllerSlot,
} from "./controller-slots.js";
import {
  DATA_CHANNEL_HIGH_WATER,
  DATA_CHANNEL_LOW_WATER,
  DATA_CHANNEL_OPTIONS,
  P2P_ACK_TIMEOUT_MS,
  TRANSPORT_P2P,
  TRANSPORT_RELAY,
  buildGuestLink,
  normalizeTransportMode,
  transportModeLabel,
} from "./transport.js";
const neutral = () => ({ buttons: 0, hat: 8, lx: 128, ly: 128, rx: 128, ry: 128 });
let state = neutral(), socket, guestDataChannel, signalSocket, guestPeer, reconnectTimer, signalReconnectTimer, peerStatsTimer, p2pWatchTimer, peerDisconnectTimer, localSocketReplaced = false;
let relaySequence = 0, canControl = true, assignedSlot = null;
let pendingDataPayload = null, pendingRelayState = null, relayInFlightSequence = null, relayAckTimer = null;
let p2pSequence = 0, lastP2pAckAt = 0, lastP2pSendAt = 0;
let localGuestId = null;
let pendingGuestIce = [];
let participantsCache = [];
let controllerDiagnostics = [];
const hostSessions = new Map();
const storedSlot = Number(localStorage.getItem("controllerSlot"));
let selectedSlot = validControllerSlot(storedSlot) ? storedSlot : 0;
let digitalEdges;
const edgeRetryTimers = new Set();
const params = new URLSearchParams(location.search);
const remoteCode = params.get("remote")?.toUpperCase();
const remoteTransportMode = normalizeTransportMode(params.get("transport"));
let hostTransportMode = TRANSPORT_P2P;
const status = document.querySelector("#status");
const gamepadLabel = document.querySelector("#gamepad");
const controller = document.querySelector(".controller");
const heldHats = new Set(), downKeys = new Set();
const heldKeyboardSticks = { left: new Set(), right: new Set() };
const claimControl = document.querySelector("#claim-control");
const topControlState = document.querySelector("#top-control-state");
const rumbleToggle = document.querySelector("#rumble-toggle");
const rumbleStatus = document.querySelector("#rumble-status");
const controllerTarget = document.querySelector("#controller-target");
const activeGamepad = () => [...navigator.getGamepads()].find(Boolean);
const haptics = createHapticsController({
  getGamepad: activeGamepad,
  storage: localStorage,
  isVisible: () => document.visibilityState === "visible",
  onStatus: (state, enabled) => {
    const labels = { off: "停止中", waiting: "ゲームパッド待ち", ready: "使用可能", unsupported: "非対応" };
    rumbleToggle.textContent = enabled ? "振動 ON" : "振動 OFF";
    rumbleToggle.setAttribute("aria-pressed", String(enabled));
    rumbleToggle.classList.toggle("enabled", enabled);
    rumbleStatus.textContent = labels[state] || "確認中";
  },
});
rumbleToggle.addEventListener("click", () => haptics.toggle());
controller.addEventListener("contextmenu", (event) => event.preventDefault());
controller.addEventListener("selectstart", (event) => event.preventDefault());
controller.addEventListener("dblclick", (event) => event.preventDefault());

function connect(takeover = false) {
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;
  socket = new WebSocket(`ws://${location.host}/control${takeover ? "?takeover=1" : ""}`);
  socket.addEventListener("open", () => {
    localSocketReplaced = false;
    status.textContent = "PC→デバイス接続済み（Switch接続は未確認）";
    status.className = "status waiting";
  });
  socket.addEventListener("message", ({ data }) => {
    try {
      const message = JSON.parse(data);
      if (message.type === "edge-ack" && message.sid === digitalEdges?.sessionId) digitalEdges.acknowledge(message.edgeAck);
      if (message.type === "rumble") routeRumble(message);
    } catch { }
  });
  socket.addEventListener("close", (event) => {
    if (event.code === 4001) {
      localSocketReplaced = true;
      status.textContent = "別タブで操作中（タップして戻す）"; status.className = "status waiting reclaimable";
      return;
    }
    status.textContent = "再接続中"; status.className = "status offline";
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 800);
  });
}

function reclaimLocalBridge() {
  if (remoteCode || !localSocketReplaced) return;
  localSocketReplaced = false;
  socket = undefined;
  status.textContent = "操作を戻しています"; status.className = "status waiting";
  connect(true);
}
status.addEventListener("click", reclaimLocalBridge);
addEventListener("pointerdown", reclaimLocalBridge, { capture: true });
addEventListener("keydown", reclaimLocalBridge, { capture: true });

function flushDataChannel() {
  const channel = guestDataChannel;
  if (!pendingDataPayload || channel?.readyState !== "open" || channel.bufferedAmount >= DATA_CHANNEL_HIGH_WATER) return;
  const payload = pendingDataPayload;
  pendingDataPayload = null;
  try {
    channel.send(payload);
    lastP2pSendAt = Date.now();
  } catch {
    pendingDataPayload = payload;
  }
}

function resetRemoteSendQueues() {
  pendingDataPayload = null;
  pendingRelayState = null;
  relayInFlightSequence = null;
  clearTimeout(relayAckTimer);
  relayAckTimer = null;
  clearInterval(peerStatsTimer);
  peerStatsTimer = null;
  clearInterval(p2pWatchTimer);
  p2pWatchTimer = null;
  clearTimeout(peerDisconnectTimer);
  peerDisconnectTimer = null;
  for (const timer of edgeRetryTimers) clearTimeout(timer);
  edgeRetryTimers.clear();
}

function closeGuestPeer() {
  const oldChannel = guestDataChannel;
  const oldPeer = guestPeer;
  guestDataChannel = null;
  guestPeer = null;
  pendingGuestIce = [];
  if (oldChannel) oldChannel.onclose = null;
  if (oldPeer) oldPeer.onconnectionstatechange = null;
  try { oldChannel?.close(); } catch { }
  try { oldPeer?.close(); } catch { }
}

function routeRumble(message) {
  if (remoteCode) {
    if (assignedSlot === null || message.slot === undefined || message.slot === assignedSlot) haptics.handle(message);
    return;
  }
  if (!validControllerSlot(message.slot)) return;
  const session = hostSessions.get(message.slot);
  if (!session) {
    if (message.slot === selectedSlot) haptics.handle(message);
    return;
  }
  const payload = JSON.stringify(message);
  const stopping = message.duration === 0 || (message.strong === 0 && message.weak === 0);
  if (session.channel?.readyState === "open") {
    // Haptics are latest-value-wins. Never add them behind a congested input/ack queue.
    if (session.channel.bufferedAmount < DATA_CHANNEL_LOW_WATER) {
      try { session.channel.send(payload); } catch { }
    } else if (stopping && signalSocket?.readyState === WebSocket.OPEN) {
      // A stop may bypass a congested P2P queue through the relay. Its higher
      // sequence makes any older unordered P2P vibration harmless on arrival.
      try { signalSocket.send(payload); } catch { }
    }
    return;
  }
  if (signalSocket?.readyState === WebSocket.OPEN) {
    try { signalSocket.send(payload); } catch { }
  }
}

function fallbackGuestToRelay(reason = "P2P応答なし") {
  if (!remoteCode || !canControl) return;
  closeGuestPeer();
  resetRemoteSendQueues();
  status.textContent = `${controllerSlotLabel(assignedSlot)} 操作中（リレー・${reason}）`;
  status.className = "status online";
  pendingRelayState = digitalEdges.envelope(state);
  flushRelay();
}

function startP2pWatch() {
  clearInterval(p2pWatchTimer);
  lastP2pAckAt = Date.now();
  lastP2pSendAt = 0;
  p2pWatchTimer = setInterval(() => {
    if (guestDataChannel?.readyState !== "open" || !lastP2pSendAt) return;
    if (Date.now() - lastP2pAckAt > P2P_ACK_TIMEOUT_MS) fallbackGuestToRelay("P2P無応答");
  }, 250);
}

function flushRelay() {
  if (!pendingRelayState || relayInFlightSequence !== null || signalSocket?.readyState !== WebSocket.OPEN) return;
  const seq = relaySequence++;
  const nextInput = pendingRelayState;
  pendingRelayState = null;
  relayInFlightSequence = seq;
  signalSocket.send(JSON.stringify({ type: "input", seq, ...nextInput }));
  clearTimeout(relayAckTimer);
  relayAckTimer = setTimeout(() => {
    if (relayInFlightSequence !== seq) return;
    relayInFlightSequence = null;
    pendingRelayState = digitalEdges.envelope(state);
    flushRelay();
  }, 500);
}

function acknowledgeRelay(message) {
  if (Number.isSafeInteger(message?.edgeAck)) digitalEdges.acknowledge(message.edgeAck);
  const seq = message?.seq;
  if (!Number.isSafeInteger(seq) || seq !== relayInFlightSequence) return;
  relayInFlightSequence = null;
  clearTimeout(relayAckTimer);
  relayAckTimer = null;
  flushRelay();
}

async function refreshPeerStats() {
  if (!guestPeer || guestPeer.connectionState !== "connected") return;
  try {
    const stats = await guestPeer.getStats();
    let pair;
    for (const report of stats.values()) {
      if (report.type === "transport" && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
    }
    if (!pair) for (const report of stats.values()) {
      if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) { pair = report; break; }
    }
    if (!pair) return;
    const remoteCandidate = stats.get(pair.remoteCandidateId);
    const route = remoteCandidate?.candidateType === "relay" ? "TURN" : "direct";
    const rtt = Number.isFinite(pair.currentRoundTripTime) ? `・RTT ${Math.round(pair.currentRoundTripTime * 1000)}ms` : "";
    const label = `P2P/${route}${rtt}`;
    if (remoteCode && canControl && guestDataChannel?.readyState === "open") status.textContent = `${controllerSlotLabel(assignedSlot)} 操作中（${label}）`;
  } catch { }
}

function startPeerStats() {
  clearInterval(peerStatsTimer);
  refreshPeerStats();
  peerStatsTimer = setInterval(refreshPeerStats, 1000);
}

function send() {
  const envelope = digitalEdges.envelope(state);
  if (remoteCode) {
    if (!canControl) return;
    if (guestDataChannel?.readyState === "open") {
      pendingDataPayload = JSON.stringify({ ...envelope, _p2pSeq: p2pSequence++ });
      flushDataChannel();
    } else if (signalSocket?.readyState === WebSocket.OPEN) {
      pendingRelayState = envelope;
      flushRelay();
    }
  } else if (inputEnabled() && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "input", slot: selectedSlot, ...envelope }));
  }
}
function forwardInput(message, slot) {
  if (!validControllerSlot(slot)) return false;
  const envelope = {
    state: message?.state && typeof message.state === "object" ? message.state : message,
    sid: message?.sid,
    edges: message?.edges,
  };
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type: "input", slot, ...envelope }));
  return true;
}

function sendNeutralToBridge(slot) {
  if (!validControllerSlot(slot) || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "input",
    slot,
    state: neutral(),
    sid: randomHex(8),
    edges: [],
  }));
}

function inputEnabled() {
  return remoteCode ? canControl
    : slotIsLocallyAvailable(participantsCache, selectedSlot) && !hostSessions.has(selectedSlot);
}
// Input handlers send changes immediately; this 100 Hz refresh keeps held
// buttons/sticks alive and bounds recovery time after a lost network packet.
setInterval(send, 10);

const defaultIce = [{ urls: "stun:stun.cloudflare.com:3478" }];
async function iceServers(base, code) {
  try { const response = await fetch(`${base}/api/ice/${code}`); if (response.ok) return (await response.json()).iceServers; } catch { }
  return defaultIce;
}
function websocketUrl(base, route) {
  const url = new URL(route, base); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; return url;
}
function randomBase32(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}
function randomHex(length) { return [...crypto.getRandomValues(new Uint8Array(length))].map(v => v.toString(16).padStart(2, "0")).join(""); }
digitalEdges = new DigitalEdgeHistory(randomHex(8), state);
function resetInput() {
  state = neutral(); heldHats.clear(); downKeys.clear();
  heldKeyboardSticks.left.clear(); heldKeyboardSticks.right.clear();
  document.querySelectorAll("[data-button].active, [data-hat].active").forEach((element) => element.classList.remove("active"));
  document.querySelectorAll(".stick-knob").forEach((knob) => { knob.style.transform = ""; });
  document.querySelectorAll(".stick.active").forEach((stick) => stick.classList.remove("active"));
  digitalEdges.observe(state);
}
function resetDigitalSession() { digitalEdges.reset(randomHex(8), state); }
function scheduleDigitalRetries() {
  if (!remoteCode || !canControl) return;
  for (const delay of [12, 30]) {
    const timer = setTimeout(() => { edgeRetryTimers.delete(timer); send(); }, delay);
    edgeRetryTimers.add(timer);
  }
}
function sendDigitalChange() {
  if (!inputEnabled()) return;
  const changed = digitalEdges.observe(state);
  send();
  if (changed) scheduleDigitalRetries();
}
function updateInputAvailability() {
  const enabled = inputEnabled();
  controller.classList.toggle("locked", !enabled);
  controller.setAttribute("aria-disabled", String(!enabled));
  controller.toggleAttribute("inert", !enabled);
  const owner = remoteCode ? null : participantForSlot(participantsCache, selectedSlot);
  if (remoteCode) {
    controllerTarget.textContent = canControl
      ? `${controllerSlotLabel(assignedSlot)}を操作しています`
      : "コントローラーの空きを待っています";
  } else if (owner || hostSessions.has(selectedSlot)) {
    controllerTarget.textContent = owner
      ? `${controllerSlotLabel(selectedSlot)}は ${owner.name} さんが遠隔操作中です`
      : `${controllerSlotLabel(selectedSlot)}は遠隔接続を準備中です`;
  } else {
    controllerTarget.textContent = `${controllerSlotLabel(selectedSlot)}をローカル操作しています`;
  }
  const releaseButton = document.querySelector("#release-control");
  if (!remoteCode && releaseButton) {
    releaseButton.textContent = `${controllerSlotLabel(selectedSlot)}の割り当てを解除`;
    releaseButton.disabled = !owner || signalSocket?.readyState !== WebSocket.OPEN;
  }
}

function updateSlotCards() {
  for (let slot = 0; slot < CONTROLLER_SLOT_COUNT; slot += 1) {
    const card = document.querySelector(`[data-controller-slot="${slot}"]`);
    if (!card) continue;
    const owner = participantForSlot(participantsCache, slot);
    const remotelyAssigned = Boolean(owner || hostSessions.has(slot));
    const diagnostic = controllerDiagnostics[slot];
    const stateLabel = diagnostic?.ready ? "Switch接続済み"
      : diagnostic?.connected ? "接続準備中"
        : diagnostic?.state === "advertising" ? "ペアリング待ち" : "未接続";
    card.classList.toggle("selected", !remoteCode && slot === selectedSlot);
    card.classList.toggle("assigned", remotelyAssigned);
    card.classList.toggle("ready", Boolean(diagnostic?.ready));
    card.setAttribute("aria-pressed", String(!remoteCode && slot === selectedSlot));
    card.querySelector(".slot-state").textContent = stateLabel;
    card.querySelector(".slot-owner").textContent = owner
      ? `${owner.name} さんが遠隔操作`
      : remotelyAssigned ? "遠隔接続を準備中" : "ローカル操作可";
  }
}

function selectControllerSlot(slot) {
  if (remoteCode || !validControllerSlot(slot) || slot === selectedSlot) return;
  if (slotIsLocallyAvailable(participantsCache, selectedSlot) &&
      !hostSessions.has(selectedSlot)) {
    resetInput();
    send();
  }
  selectedSlot = slot;
  localStorage.setItem("controllerSlot", String(slot));
  state = neutral();
  previousGamepad = "";
  resetDigitalSession();
  updateSlotCards();
  updateInputAvailability();
  refreshDeviceDiagnostics();
}

for (const card of document.querySelectorAll("[data-controller-slot]")) {
  card.addEventListener("click", () => selectControllerSlot(Number(card.dataset.controllerSlot)));
}

function setControlEnabled(enabled, slot = null) {
  const nextSlot = enabled && validControllerSlot(slot) ? slot : null;
  const slotChanged = canControl && nextSlot !== null && assignedSlot !== nextSlot;
  canControl = enabled && nextSlot !== null;
  assignedSlot = nextSlot;
  if (canControl) previousGamepad = "";
  if (!canControl || slotChanged) {
    haptics.stop();
    resetRemoteSendQueues();
    closeGuestPeer();
  }
  if (!canControl) resetInput();
  else resetDigitalSession();
  updateInputAvailability();
  document.querySelector("#control-state").textContent = canControl
    ? `${controllerSlotLabel(assignedSlot)}を操作中です`
    : "空いているコントローラーが割り当てられるまで待機してください";
  if (remoteCode) {
    claimControl.disabled = canControl || signalSocket?.readyState !== WebSocket.OPEN;
    claimControl.textContent = canControl ? `${controllerSlotLabel(assignedSlot)} 操作中` : "空きを取得する";
    topControlState.textContent = canControl
      ? `${controllerSlotLabel(assignedSlot)}を操作しています`
      : "3台すべて使用中の場合は待機します";
  }
}

claimControl.onclick = () => signalSocket?.send(JSON.stringify({ type: "claim" }));

function attachGuestDataChannel(channel) {
  guestDataChannel = channel;
  channel.bufferedAmountLowThreshold = DATA_CHANNEL_LOW_WATER;
  channel.onbufferedamountlow = flushDataChannel;
  channel.onmessage = ({ data }) => {
    try {
      const message = JSON.parse(data);
      if (message.type === "input-ack" && Number.isSafeInteger(message.seq)) {
        lastP2pAckAt = Date.now();
        digitalEdges.acknowledge(message.edgeAck);
      }
      if (message.type === "rumble" && canControl && message.slot === assignedSlot) haptics.handle(message);
    } catch { }
  };
  channel.onopen = () => {
    resetRemoteSendQueues();
    p2pSequence = 0;
    status.textContent = `${controllerSlotLabel(assignedSlot)} 操作中（P2P）`;
    status.className = "status online";
    startPeerStats();
    startP2pWatch();
    send();
  };
  channel.onclose = () => {
    if (channel !== guestDataChannel) return;
    guestDataChannel = null;
    if (canControl) {
      resetRemoteSendQueues();
      status.textContent = `${controllerSlotLabel(assignedSlot)} 操作中（リレー）`;
      send();
    }
  };
}

async function connectGuest() {
  if (signalSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(signalSocket.readyState)) return;
  const nameInput = document.querySelector("#guest-name");
  const name = nameInput.value.trim().slice(0, 32);
  if (!name) { nameInput.focus(); return; }
  localStorage.setItem("guestName", name);
  document.querySelector("#join-session").disabled = true;
  const storageKey = `guestId:${remoteCode}`;
  const guestId = sessionStorage.getItem(storageKey) || randomHex(8);
  sessionStorage.setItem(storageKey, guestId);
  localGuestId = guestId;
  const base = location.origin, ice = await iceServers(base, remoteCode);
  const query = new URLSearchParams({ role: "guest", id: guestId, name });
  signalSocket = new WebSocket(websocketUrl(base, `/api/room/${remoteCode}?${query}`));
  const guestSignalSocket = signalSocket;
  signalSocket.onopen = () => {
    document.querySelector("#guest-join-fields").hidden = true;
    status.textContent = "ロビー参加中"; status.className = "status online";
    claimControl.disabled = false;
    topControlState.textContent = "空いているコントローラーを自動取得します";
  };
  signalSocket.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "participants") renderGuestParticipants(message.participants);
    if (message.type === "input-ack") acknowledgeRelay(message);
    if (message.type === "rumble" && canControl && message.slot === assignedSlot) haptics.handle(message);
    if (message.type === "control") {
      setControlEnabled(message.active, message.slot);
      status.textContent = message.active
        ? remoteTransportMode === TRANSPORT_RELAY
          ? `${controllerSlotLabel(message.slot)} 操作中（リレー固定）`
          : `${controllerSlotLabel(message.slot)} 操作中（P2P接続待ち・一時リレー）`
        : "ロビーで待機中";
      status.className = message.active ? "status online" : "status waiting";
      if (message.active) { relaySequence = 0; resetInput(); send(); }
    } else if (message.type === "offer" && canControl && message.slot === assignedSlot && remoteTransportMode !== TRANSPORT_RELAY) {
      const earlyIce = pendingGuestIce;
      closeGuestPeer();
      pendingGuestIce = earlyIce;
      guestPeer = new RTCPeerConnection({ iceServers: ice });
      const currentPeer = guestPeer;
      currentPeer.ondatachannel = ({ channel }) => attachGuestDataChannel(channel);
      currentPeer.onicecandidate = ({ candidate }) => candidate && signalSocket.send(JSON.stringify({ type: "ice", slot: assignedSlot, candidate }));
      currentPeer.onconnectionstatechange = () => {
        const connectionState = currentPeer.connectionState;
        if (!canControl) return;
        if (connectionState === "failed") fallbackGuestToRelay("P2P切断");
        else if (connectionState === "disconnected") {
          clearTimeout(peerDisconnectTimer);
          peerDisconnectTimer = setTimeout(() => {
            if (currentPeer === guestPeer && currentPeer.connectionState === "disconnected") fallbackGuestToRelay("P2P切断");
          }, 1000);
        } else if (connectionState === "connected") clearTimeout(peerDisconnectTimer);
      };
      await currentPeer.setRemoteDescription(message.offer);
      await drainIceCandidates(currentPeer, pendingGuestIce);
      await currentPeer.setLocalDescription(await currentPeer.createAnswer());
      if (currentPeer === guestPeer && signalSocket?.readyState === WebSocket.OPEN) {
        signalSocket.send(JSON.stringify({ type: "answer", slot: assignedSlot, answer: currentPeer.localDescription }));
      }
    } else if (message.type === "ice" && message.slot === assignedSlot) {
      await addIceCandidateOrQueue(guestPeer, message.candidate, pendingGuestIce);
    }
  };
  signalSocket.onclose = (event) => {
    if (signalSocket !== guestSignalSocket) return;
    signalSocket = null;
    setControlEnabled(false); status.textContent = event.reason || "セッション終了"; status.className = "status offline";
    document.querySelector("#join-session").disabled = false;
    if ([1006, 1012, 1013].includes(event.code)) {
      status.textContent = "シグナリング再接続中";
      clearTimeout(signalReconnectTimer);
      signalReconnectTimer = setTimeout(connectGuest, 800);
    }
  };
}

function renderParticipants(participants) {
  participantsCache = Array.isArray(participants) ? participants : [];
  const list = document.querySelector("#participant-list"); list.replaceChildren();
  document.querySelector("#participant-count").textContent = `${participantsCache.length}人参加中・最大3人操作`;
  for (const participant of participantsCache) {
    const row = document.createElement("div"); row.className = `participant${participant.active ? " active" : ""}`;
    const label = document.createElement("span");
    label.textContent = participant.active ? `${participant.name}・${controllerSlotLabel(participant.slot)}` : `${participant.name}・待機中`;
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${participant.name} の割り当て`);
    const waiting = document.createElement("option"); waiting.value = ""; waiting.textContent = "待機"; select.append(waiting);
    for (let slot = 0; slot < CONTROLLER_SLOT_COUNT; slot += 1) {
      const option = document.createElement("option");
      const owner = participantForSlot(participantsCache, slot);
      option.value = String(slot);
      option.textContent = owner && owner.id !== participant.id
        ? `${controllerSlotLabel(slot)}（${owner.name} さんと交代）`
        : controllerSlotLabel(slot);
      select.append(option);
    }
    select.value = participant.active ? String(participant.slot) : "";
    select.onchange = () => {
      if (select.value === "") {
        if (validControllerSlot(participant.slot)) signalSocket?.send(JSON.stringify({ type: "release", slot: participant.slot }));
      } else {
        signalSocket?.send(JSON.stringify({ type: "grant", guestId: participant.id, slot: Number(select.value) }));
      }
    };
    row.append(label, select); list.append(row);
  }
  if (!participantsCache.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "参加者を待っています"; list.append(empty); }
  updateSlotCards();
  updateInputAvailability();
}

function renderGuestParticipants(participants) {
  const list = document.querySelector("#guest-participant-list"); list.replaceChildren();
  const activeCount = participants.filter((participant) => participant.active).length;
  document.querySelector("#guest-participant-count").textContent = `${activeCount}/3台使用中・${participants.length}人参加`;
  for (const participant of participants) {
    const row = document.createElement("div"); row.className = `participant${participant.active ? " active" : ""}`;
    const label = document.createElement("span");
    label.textContent = `${participant.name}${participant.id === localGuestId ? "（自分）" : ""}・${controllerSlotLabel(participant.slot)}`;
    row.append(label);
    if (!participant.active && participant.id === localGuestId) {
      const button = document.createElement("button");
      button.textContent = "空きを取得する";
      button.onclick = () => signalSocket?.send(JSON.stringify({ type: "claim" }));
      row.append(button);
    }
    list.append(row);
  }
  if (!participants.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "参加者を待っています"; list.append(empty); }
}

function updateSessionTransportLabel() {
  const codeLabel = document.querySelector("#session-code");
  const sessions = [...hostSessions.values()];
  if (!sessions.length) {
    codeLabel.dataset.transport = "遠隔操作未割当";
    updateSlotCards();
    updateInputAvailability();
    return;
  }
  const p2p = sessions.filter((session) => session.mode === "p2p").length;
  const relay = sessions.filter((session) => session.mode === "relay").length;
  const waiting = sessions.length - p2p - relay;
  codeLabel.dataset.transport = `${sessions.length}/3台割当・P2P ${p2p}・リレー ${relay}${waiting ? `・接続中 ${waiting}` : ""}`;
  updateSlotCards();
  updateInputAvailability();
}

function stopHostSession(slot, { neutralize = true } = {}) {
  const session = hostSessions.get(slot);
  if (!session) {
    if (neutralize) sendNeutralToBridge(slot);
    return;
  }
  hostSessions.delete(slot);
  clearTimeout(session.disconnectTimer);
  if (session.channel) session.channel.onclose = null;
  if (session.peer) session.peer.onconnectionstatechange = null;
  try { session.channel?.close(); } catch { }
  try { session.peer?.close(); } catch { }
  if (neutralize) sendNeutralToBridge(slot);
  if (slot === selectedSlot) {
    resetInput();
    resetDigitalSession();
  }
  updateSessionTransportLabel();
}

function stopAllHostSessions() {
  for (const slot of [...hostSessions.keys()]) stopHostSession(slot);
}

function startRelayGuest(guestId, slot) {
  if (!validControllerSlot(slot)) return;
  stopHostSession(slot);
  if (slot === selectedSlot) {
    resetInput();
    resetDigitalSession();
  }
  hostSessions.set(slot, { guestId, slot, peer: null, channel: null, lastRelaySequence: -1, mode: "relay", disconnectTimer: null });
  updateSessionTransportLabel();
}

async function startHostPeer(base, code, guestId, slot) {
  if (!validControllerSlot(slot)) return;
  stopHostSession(slot);
  if (slot === selectedSlot) {
    resetInput();
    resetDigitalSession();
  }
  const session = {
    guestId, slot, peer: null, channel: null, lastRelaySequence: -1,
    mode: "connecting", disconnectTimer: null, pendingIce: [],
  };
  hostSessions.set(slot, session);
  updateSessionTransportLabel();
  const ice = await iceServers(base, code);
  if (hostSessions.get(slot) !== session) return;
  const hostPeer = new RTCPeerConnection({ iceServers: ice });
  const hostChannel = hostPeer.createDataChannel("input", DATA_CHANNEL_OPTIONS);
  session.peer = hostPeer;
  session.channel = hostChannel;

  hostChannel.onmessage = ({ data }) => {
    try {
      const message = JSON.parse(data);
      const forwarded = forwardInput(message, slot);
      if (Number.isSafeInteger(message._p2pSeq) && hostChannel.readyState === "open") {
        hostChannel.send(JSON.stringify({
          type: "input-ack",
          slot,
          seq: message._p2pSeq,
          edgeAck: forwarded ? highestDigitalEdgeSequence(message) : null,
        }));
      }
    } catch { }
  };
  hostChannel.onopen = () => {
    if (hostSessions.get(slot) !== session) return;
    session.mode = "p2p";
    updateSessionTransportLabel();
  };
  hostChannel.onclose = () => {
    if (hostSessions.get(slot) !== session) return;
    session.channel = null;
    session.mode = "relay";
    sendNeutralToBridge(slot);
    updateSessionTransportLabel();
  };
  const returnHostToRelay = () => {
    if (hostSessions.get(slot) !== session) return;
    clearTimeout(session.disconnectTimer);
    if (session.channel) session.channel.onclose = null;
    hostPeer.onconnectionstatechange = null;
    try { session.channel?.close(); } catch { }
    try { hostPeer.close(); } catch { }
    session.channel = null;
    session.peer = null;
    session.mode = "relay";
    sendNeutralToBridge(slot);
    updateSessionTransportLabel();
  };
  hostPeer.onconnectionstatechange = () => {
    if (hostSessions.get(slot) !== session) return;
    if (hostPeer.connectionState === "failed") returnHostToRelay();
    else if (hostPeer.connectionState === "disconnected") {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = setTimeout(() => {
        if (hostPeer.connectionState === "disconnected") returnHostToRelay();
      }, 1000);
    } else if (hostPeer.connectionState === "connected") clearTimeout(session.disconnectTimer);
  };
  hostPeer.onicecandidate = ({ candidate }) => candidate && signalSocket?.send(JSON.stringify({ type: "ice", guestId, slot, candidate }));
  await hostPeer.setLocalDescription(await hostPeer.createOffer());
  if (hostSessions.get(slot) === session && signalSocket?.readyState === WebSocket.OPEN) {
    signalSocket.send(JSON.stringify({ type: "offer", guestId, slot, offer: hostPeer.localDescription }));
  }
}

async function createHostSession() {
  signalSocket?.close();
  stopAllHostSessions();
  haptics.stop();
  renderParticipants([]);
  const baseInput = document.querySelector("#signal-base"), base = baseInput.value.replace(/\/$/, "");
  if (!/^https:\/\//.test(base)) { alert("HTTPSのCloudflare Worker URLを入力してください"); return; }
  localStorage.setItem("signalBase", base);
  hostTransportMode = normalizeTransportMode(document.querySelector("#transport-mode").value);
  localStorage.setItem("transportMode", hostTransportMode);
  const code = randomBase32(10), secret = randomHex(16);
  signalSocket = new WebSocket(websocketUrl(base, `/api/room/${code}?role=host&secret=${secret}`));
  const hostSignalSocket = signalSocket;
  signalSocket.onmessage = async ({ data }) => {
    if (signalSocket !== hostSignalSocket) return;
    const message = JSON.parse(data);
    if (message.type === "participants") renderParticipants(message.participants);
    else if (message.type === "control-released") {
      if (validControllerSlot(message.slot)) stopHostSession(message.slot);
    } else if (message.type === "peer-ready") {
      if (hostTransportMode === TRANSPORT_RELAY) startRelayGuest(message.guestId, message.slot);
      else await startHostPeer(base, code, message.guestId, message.slot);
    }
    else if (message.type === "answer" && validControllerSlot(message.slot)) {
      const session = hostSessions.get(message.slot);
      if (session?.guestId === message.guestId && session.peer) {
        await session.peer.setRemoteDescription(message.answer);
        await drainIceCandidates(session.peer, session.pendingIce);
      }
    } else if (message.type === "ice" && validControllerSlot(message.slot)) {
      const session = hostSessions.get(message.slot);
      if (session?.guestId === message.guestId && session.peer) {
        await addIceCandidateOrQueue(session.peer, message.candidate, session.pendingIce);
      }
    } else if (message.type === "input" && validControllerSlot(message.slot)) {
      const session = hostSessions.get(message.slot);
      if (!session || session.guestId !== message.guestId || session.channel?.readyState === "open") return;
      let forwarded = message.seq === session.lastRelaySequence;
      if (Number.isSafeInteger(message.seq) && message.seq > session.lastRelaySequence) {
        forwarded = forwardInput(message, message.slot);
        if (forwarded) {
          session.lastRelaySequence = message.seq;
          session.mode = "relay";
          updateSessionTransportLabel();
        }
      }
      hostSignalSocket.send(JSON.stringify({
        type: "input-ack", slot: message.slot, seq: message.seq,
        edgeAck: forwarded ? highestDigitalEdgeSequence(message) : null,
      }));
    }
  };
  signalSocket.onclose = () => {
    if (signalSocket !== hostSignalSocket) return;
    signalSocket = null;
    stopAllHostSessions(); haptics.stop(); renderParticipants([]);
    document.querySelector("#session-code").textContent = `${code}（セッション切断）`;
  };
  const link = buildGuestLink(base, code, hostTransportMode);
  const codeLabel = document.querySelector("#session-code"); codeLabel.textContent = code; codeLabel.dataset.transport = "遠隔操作未割当";
  const anchor = document.querySelector("#guest-link"); anchor.href = link; anchor.textContent = link;
  document.querySelector("#revoke-session").disabled = false;
}

document.querySelector("#signal-base").value = localStorage.getItem("signalBase") || "https://switch2-remote-signal.y52en.workers.dev";
document.querySelector("#transport-mode").value = normalizeTransportMode(localStorage.getItem("transportMode"));
document.querySelector("#new-session").onclick = createHostSession;
document.querySelector("#release-control").onclick = () => signalSocket?.send(JSON.stringify({ type: "release", slot: selectedSlot }));
document.querySelector("#revoke-session").onclick = () => {
  signalSocket?.send(JSON.stringify({ type: "revoke" }));
  stopAllHostSessions();
  resetInput();
  send();
  renderParticipants([]);
  document.querySelector("#session-code").textContent = "終了済み（新しいセッションを発行してください）";
};
document.querySelector("#join-session").onclick = connectGuest;
document.querySelector("#guest-name").value = localStorage.getItem("guestName") || "";
const guestNameInput = document.querySelector("#guest-name");
guestNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); connectGuest(); guestNameInput.blur(); }
});
if (remoteCode && guestNameInput.value.trim()) queueMicrotask(connectGuest);

function setButton(bit, pressed) {
  if (!inputEnabled()) return;
  state.buttons = pressed ? state.buttons | (1 << bit) : state.buttons & ~(1 << bit);
  document.querySelectorAll(`[data-button="${bit}"]`).forEach((button) => button.classList.toggle("active", pressed)); sendDigitalChange();
}
function combinedHat() {
  const up = heldHats.has(0), right = heldHats.has(2), down = heldHats.has(4), left = heldHats.has(6);
  if (up && right) return 1; if (right && down) return 3; if (down && left) return 5; if (left && up) return 7;
  if (up) return 0; if (right) return 2; if (down) return 4; if (left) return 6; return 8;
}
function setHat(direction, pressed) {
  if (!inputEnabled()) return;
  pressed ? heldHats.add(direction) : heldHats.delete(direction); state.hat = combinedHat();
  document.querySelectorAll(`[data-hat="${direction}"]`).forEach((button) => button.classList.toggle("active", pressed)); sendDigitalChange();
}
function setKeyboardStick(side, direction, pressed) {
  if (!inputEnabled()) return;
  const held = heldKeyboardSticks[side];
  pressed ? held.add(direction) : held.delete(direction);
  const horizontal = held.has("left") === held.has("right") ? 128 : held.has("left") ? 0 : 255;
  const vertical = held.has("up") === held.has("down") ? 128 : held.has("up") ? 0 : 255;
  if (side === "left") { state.lx = horizontal; state.ly = vertical; }
  else { state.rx = horizontal; state.ry = vertical; }
  send();
}
for (const button of document.querySelectorAll("[data-button], [data-hat]")) {
  const update = (pressed) => button.dataset.button !== undefined ? setButton(Number(button.dataset.button), pressed) : setHat(Number(button.dataset.hat), pressed);
  button.addEventListener("pointerdown", (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); update(true); });
  button.addEventListener("pointerup", () => update(false)); button.addEventListener("pointercancel", () => update(false));
  button.addEventListener("lostpointercapture", () => update(false));
}
const handleKeyboard = setupKeyboardBindings((action, pressed) => {
  if (action.type === "claim") {
    if (pressed && remoteCode && !canControl && signalSocket?.readyState === WebSocket.OPEN) {
      signalSocket.send(JSON.stringify({ type: "claim" }));
    }
    return;
  }
  if (!inputEnabled()) return;
  if (action.type === "hat") setHat(action.value, pressed);
  else if (action.type === "stick") setKeyboardStick(action.side, action.direction, pressed);
  else setButton(action.value, pressed);
});
function keyboard(event, pressed) {
  if (pressed && downKeys.has(event.code)) return;
  const handled = handleKeyboard(event, pressed);
  if (!pressed) downKeys.delete(event.code);
  if (!handled) return;
  if (pressed) downKeys.add(event.code);
}
addEventListener("keydown", (event) => keyboard(event, true));
addEventListener("keyup", (event) => keyboard(event, false));
const readGamepad = setupGamepadBindings((action, pressed) => {
  if (action.type === "claim" && pressed && remoteCode && !canControl && signalSocket?.readyState === WebSocket.OPEN) {
    signalSocket.send(JSON.stringify({ type: "claim" }));
  }
});
let previousGamepad = "";
function pollGamepad() {
  const pad = activeGamepad();
  const activeActions = readGamepad(pad);
  if (pad) {
    gamepadLabel.textContent = `ゲームパッド: ${pad.id}`;
    if (inputEnabled()) {
      const next = gamepadState(pad, activeActions);
      const serialized = JSON.stringify(next); if (serialized !== previousGamepad) {
        state = next; previousGamepad = serialized;
        const digitalChanged = digitalEdges.observe(state);
        send();
        if (digitalChanged) scheduleDigitalRetries();
      }
    }
  } else gamepadLabel.textContent = "ゲームパッド未接続";
  haptics.refresh();
  requestAnimationFrame(pollGamepad);
}
addEventListener("blur", () => { resetInput(); send(); });
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { haptics.stop(); resetInput(); send(); }
  if (!remoteCode && document.visibilityState === "visible" && localSocketReplaced) connect(true);
});
addEventListener("pagehide", () => { haptics.stop(); resetInput(); send(); });
if (remoteCode) {
  canControl = false; document.querySelector("#session-panel").hidden = true;
  document.querySelector("#controller-slots").hidden = true;
  document.querySelector("#top-control-bar").hidden = false;
  document.querySelector("#guest-panel").hidden = false; document.querySelector("#remote-code").textContent = remoteCode;
  document.querySelector("#remote-transport").textContent = transportModeLabel(remoteTransportMode);
  setControlEnabled(false);
} else {
  document.querySelector("#guest-panel").hidden = true;
  connect();
  renderParticipants([]);
  updateSlotCards();
  updateInputAvailability();
}
pollGamepad();

async function refreshDeviceDiagnostics() {
  if (remoteCode) {
    document.querySelector("#device-diagnostics").hidden = true;
    return;
  }
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const device = await response.json();
    controllerDiagnostics = device.esp32SerialConnected && Array.isArray(device.controllers) ? device.controllers : [];
    const selectedController = controllerDiagnostics[selectedSlot] ?? {};
    document.querySelector("#diag-browser").textContent = device.localControllerConnected ? "接続" : "切断";
    const serialPort = device.esp32SerialPort || "未設定";
    document.querySelector("#diag-serial").textContent = device.esp32SerialConnected
      ? `${serialPort} 接続`
      : `${serialPort}: ${device.esp32SerialError || "切断"}`;
    document.querySelector("#diag-frames").textContent = `${device.esp32SerialFramesWritten.toLocaleString()} / 破棄 ${device.esp32SerialFramesDropped.toLocaleString()}`;
    document.querySelector("#diag-queue").textContent = `${device.esp32SerialQueueBytes ?? 0} byte`;
    document.querySelector("#diag-input-latency").textContent = selectedController.inputLatencyMs == null ? "計測待ち" : `${selectedController.inputLatencyMs} ms`;
    document.querySelector("#diag-ble-interval").textContent = selectedController.connectionIntervalMs == null ? "接続待ち" : `${selectedController.connectionIntervalMs} ms`;
    document.querySelector("#diag-ble-queue").textContent = device.esp32BleQueueFree == null ? "計測待ち" : `${device.esp32BleQueueFree}/${device.esp32BleQueueCeiling}・待機 ${device.esp32BleCongestionSkips}`;
    updateSlotCards();
    if (!localSocketReplaced && device.localControllerConnected) {
      const readyCount = controllerDiagnostics.filter((entry) => entry.ready).length;
      status.textContent = `PC→ESP32接続済み・Switch ${readyCount}/3台`;
      status.className = readyCount ? "status online" : "status waiting";
    }
  } catch {
    document.querySelector("#diag-browser").textContent = "取得失敗";
  }
}
refreshDeviceDiagnostics();
setInterval(refreshDeviceDiagnostics, 1000);

function setupVirtualStick(element) {
  const side = element.dataset.stick;
  const ring = element.querySelector(".stick-ring"), knob = element.querySelector(".stick-knob");
  const xKey = side === "left" ? "lx" : "rx", yKey = side === "left" ? "ly" : "ry";
  let pointerId = null;
  function update(event) {
    const rect = ring.getBoundingClientRect();
    let x = (event.clientX - (rect.left + rect.width / 2)) / (rect.width * .42);
    let y = (event.clientY - (rect.top + rect.height / 2)) / (rect.height * .42);
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) { x /= magnitude; y /= magnitude; }
    state[xKey] = Math.round((x + 1) * 127.5);
    state[yKey] = Math.round((y + 1) * 127.5);
    knob.style.transform = `translate(${x * 54}%, ${y * 54}%)`;
    send();
  }
  function reset(event) {
    if (pointerId === null || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
    pointerId = null; state[xKey] = 128; state[yKey] = 128;
    knob.style.transform = ""; element.classList.remove("active"); send();
  }
  element.addEventListener("pointerdown", (event) => {
    if (pointerId !== null) return;
    event.preventDefault(); pointerId = event.pointerId; element.setPointerCapture(pointerId);
    element.classList.add("active"); update(event);
  });
  element.addEventListener("pointermove", (event) => { if (event.pointerId === pointerId) update(event); });
  element.addEventListener("pointerup", reset);
  element.addEventListener("pointercancel", reset);
  element.addEventListener("lostpointercapture", reset);
}
document.querySelectorAll(".controller-v2 [data-stick]").forEach(setupVirtualStick);
