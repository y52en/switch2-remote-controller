import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SerialPort } from "serialport";
import dotenv from "dotenv";
import { loadConfig } from "./config.mjs";
import { sanitizeDigitalEdges, sanitizeState } from "./controller-state.mjs";
import {
  CONTROLLER_SLOT_COUNT,
  createControllerStates,
  sanitizeControllerSlot,
} from "./controller-slots.mjs";
import { encodeEasyConState } from "./easycon.mjs";
import { initialEsp32ControllerStatus, parseEsp32ControllerStatus } from "./esp32-status.mjs";
import { allowedLocalControlOrigin } from "./local-control-origin.mjs";
import { makeRumbleMessage, parseEsp32RumbleLine } from "./rumble.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, ".env"), quiet: true });
const config = loadConfig();

let currentStates = createControllerStates();
let lastBrowserInput = 0;
let browserMessagesReceived = 0;
let esp32SerialFramesWritten = 0;
let esp32SerialFramesDropped = 0;
let esp32SerialFramesCoalesced = 0;
let browserDigitalEdgesAccepted = 0;
let esp32DigitalEdgeFramesQueued = 0;
let esp32DigitalEdgeFramesWritten = 0;
let esp32DigitalEdgeFramesDropped = 0;
let esp32BootCount = 0;
let esp32LastReset = null;
let esp32LogTail = "";
let esp32UsesSlottedStatus = false;
const lastBrowserStateChange = Array(CONTROLLER_SLOT_COUNT).fill(0);
const esp32LastInputLatencyMsBySlot = Array(CONTROLLER_SLOT_COUNT).fill(null);
const controllerStatus = Array.from(
  { length: CONTROLLER_SLOT_COUNT },
  (_, slot) => initialEsp32ControllerStatus(slot),
);
let esp32InputStateChanges = 0;
let esp32BleConnIntervalUnits = null;
let esp32BleConnects = 0;
let esp32BleDisconnects = 0;
let esp32BleLastDisconnectReason = null;
let esp32HidSubscribes = 0;
let esp32HidUnsubscribes = 0;
let esp32HidTaskStarts = 0;
let esp32BleQueueFree = null;
let esp32BleQueueCeiling = null;
let esp32BleCongestionSkips = 0;
let esp32BlePendingSkips = 0;
let esp32BleNotifyCompletions = 0;
let esp32InputTransitions = null;
let esp32InputPresses = null;
let esp32InputReleases = null;
let esp32HidFramesEnqueued = null;
let esp32HidEnqueueTransitions = null;
let esp32HidFramesDequeued = null;
let esp32HidDequeueTransitions = null;
let esp32HidQueueDrops = null;
let esp32HidDuplicateStates = null;
let esp32HidQueueDepth = null;
let esp32HidQueueHighWater = null;
let esp32HidNotifyFailures = null;
let esp32HidNotifyRecoveries = null;
let esp32BleNotifications = null;
let esp32BleInputTransitions = null;
let esp32RumbleFramesReceived = 0;
let rumbleSequence = 1;
const neutralRumble = (slot) => ({ type: "rumble", slot, seq: 0, strong: 0, weak: 0, duration: 0 });
const currentRumbles = Array.from({ length: CONTROLLER_SLOT_COUNT }, (_, slot) => neutralRumble(slot));
let localControllerSocket = null;
let esp32Serial = null;
let esp32SerialError = null;
const pendingEsp32Frames = Array(CONTROLLER_SLOT_COUNT).fill(null);
let nextPendingEsp32Slot = 0;
const esp32EdgeFrames = [];
const lastDigitalEdgeBySession = new Map();
let esp32SerialWriteInFlight = false;
let lastEsp32Keepalive = 0;

const ESP32_EDGE_QUEUE_LIMIT = 64;

function publishRumble(raw) {
  const message = makeRumbleMessage(raw, rumbleSequence++);
  if (!message) return;
  currentRumbles[message.slot] = message;
  esp32RumbleFramesReceived += 1;
  const socket = localControllerSocket;
  if (socket?.readyState === 1) {
    try { socket.send(JSON.stringify(message)); } catch { }
  }
}

function stopRumble(slot) {
  const current = currentRumbles[slot];
  if (current.strong === 0 && current.weak === 0) return;
  publishRumble({ slot, firmwareSequence: 0, strongRaw: 0, weakRaw: 0 });
}

function sameState(left, right) {
  return left.buttons === right.buttons && left.hat === right.hat &&
    left.lx === right.lx && left.ly === right.ly && left.rx === right.rx && left.ry === right.ry;
}

function pumpEsp32Serial() {
  const serial = esp32Serial;
  if (!serial?.isOpen || esp32SerialWriteInFlight ||
      (!esp32EdgeFrames.length && !pendingEsp32Frames.some(Boolean))) return;

  const isDigitalEdge = esp32EdgeFrames.length > 0;
  let frame;
  if (isDigitalEdge) {
    frame = esp32EdgeFrames.shift();
  } else {
    for (let offset = 0; offset < CONTROLLER_SLOT_COUNT; offset += 1) {
      const slot = (nextPendingEsp32Slot + offset) % CONTROLLER_SLOT_COUNT;
      if (!pendingEsp32Frames[slot]) continue;
      frame = pendingEsp32Frames[slot];
      pendingEsp32Frames[slot] = null;
      nextPendingEsp32Slot = (slot + 1) % CONTROLLER_SLOT_COUNT;
      break;
    }
  }
  if (!frame) return;
  esp32SerialWriteInFlight = true;
  serial.write(frame, (writeError) => {
    if (writeError) {
      esp32SerialError = writeError.message;
      esp32SerialFramesDropped += 1;
    } else {
      esp32SerialFramesWritten += 1;
      if (isDigitalEdge) esp32DigitalEdgeFramesWritten += 1;
    }
    // SerialPort completes one overlapped write at a time. Keep at most one
    // newer frame while it is pending; calling drain() here adds a Windows USB
    // flush delay of roughly 20 ms and needlessly limits this 8-byte stream.
    esp32SerialWriteInFlight = false;
    setImmediate(pumpEsp32Serial);
  });
}

function queueEsp32State(slot, state, countCoalesced = true) {
  if (!esp32Serial?.isOpen) return;
  if (pendingEsp32Frames[slot] && countCoalesced) esp32SerialFramesCoalesced += 1;
  pendingEsp32Frames[slot] = encodeEasyConState(state, slot);
  pumpEsp32Serial();
}

function queueEsp32Edges(slot, states) {
  if (!esp32Serial?.isOpen) return;
  for (let index = 0; index < states.length; index += 1) {
    const state = states[index];
    if (esp32EdgeFrames.length >= ESP32_EDGE_QUEUE_LIMIT) {
      esp32SerialFramesDropped += 1;
      esp32DigitalEdgeFramesDropped += states.length - index;
      break;
    }
    esp32EdgeFrames.push(encodeEasyConState(state, slot));
    esp32DigitalEdgeFramesQueued += 1;
  }
  pumpEsp32Serial();
}

function acceptDigitalEdges(message) {
  const parsed = sanitizeDigitalEdges(message);
  if (!parsed.sid) return { states: [], sid: null, edgeAck: null };
  const previous = lastDigitalEdgeBySession.get(parsed.sid) ?? -1;
  const accepted = parsed.edges.filter((edge) => edge.sequence > previous);
  if (parsed.highestSequence !== null && parsed.highestSequence > previous) {
    lastDigitalEdgeBySession.set(parsed.sid, parsed.highestSequence);
    if (lastDigitalEdgeBySession.size > 64) lastDigitalEdgeBySession.delete(lastDigitalEdgeBySession.keys().next().value);
  }
  return { states: accepted.map((edge) => edge.state), sid: parsed.sid, edgeAck: parsed.highestSequence };
}

function openEsp32Serial() {
  if (!config.esp32SerialPort || esp32Serial) return;
  const serial = new SerialPort({ path: config.esp32SerialPort, baudRate: 115200, autoOpen: false });
  esp32Serial = serial;
  serial.open((error) => {
    if (error) {
      esp32SerialError = error.message;
      esp32Serial = null;
      setTimeout(openEsp32Serial, 2000).unref();
      return;
    }
    esp32SerialError = null;
    console.log(`ESP32 BLE controller: ${config.esp32SerialPort}`);
    currentStates.forEach((state, slot) => queueEsp32State(slot, state));
  });
  serial.on("error", (error) => { esp32SerialError = error.message; });
  serial.on("data", (data) => {
    const lines = (esp32LogTail + data.toString("utf8")).split(/\r?\n/);
    esp32LogTail = (lines.pop() || "").slice(-2048);
    for (const line of lines) {
      const rumble = parseEsp32RumbleLine(line);
      if (rumble) {
        publishRumble(rumble);
        continue;
      }
      const reset = line.match(/rst:([^,\r\n]+)/);
      if (reset) {
        esp32BootCount += 1;
        esp32LastReset = reset[1].trim();
      }
      const inputAccepted = line.match(/^DI(?::([0-2]))?$/);
      if (inputAccepted) {
        const slot = Number(inputAccepted[1] ?? 0);
        if (lastBrowserStateChange[slot]) {
          const latency = Date.now() - lastBrowserStateChange[slot];
          esp32LastInputLatencyMsBySlot[slot] = latency;
          controllerStatus[slot].inputLatencyMs = latency;
          lastBrowserStateChange[slot] = 0;
        }
        esp32InputStateChanges += 1;
      }
      const slotState = parseEsp32ControllerStatus(line, controllerStatus);
      if (slotState) {
        esp32UsesSlottedStatus = true;
        controllerStatus[slotState.slot] = slotState.controller;
        if (slotState.becameConnected) esp32BleConnects += 1;
        if (slotState.becameDisconnected) esp32BleDisconnects += 1;
        if (slotState.disconnectReason !== null) {
          esp32BleLastDisconnectReason = slotState.disconnectReason;
        }
      }
      if (!esp32UsesSlottedStatus && line.includes("connected, set nintendo switch addr")) esp32BleConnects += 1;
      const disconnect = line.match(/disconnected, reason=(\d+)/);
      if (disconnect && !esp32UsesSlottedStatus) {
        esp32BleDisconnects += 1;
        esp32BleLastDisconnectReason = Number(disconnect[1]);
      }
      const subscribe = line.match(/subscribe event;.*attr_handle=0x00(?:0e|0E).*prevn=(\d+) curn=(\d+)/);
      if (subscribe) {
        if (Number(subscribe[2]) === 1 && Number(subscribe[1]) === 0) esp32HidSubscribes += 1;
        if (Number(subscribe[2]) === 0 && Number(subscribe[1]) === 1) esp32HidUnsubscribes += 1;
      }
      if (line.includes("controller report task start")) esp32HidTaskStarts += 1;
      const connection = line.match(/^DC:(\d+)$/);
      if (connection) esp32BleConnIntervalUnits = Number(connection[1]);
      const queue = line.match(/^DQ:(\d+):(\d+):(\d+)(?::(\d+):(\d+))?$/);
      if (queue) {
        esp32BleQueueFree = Number(queue[1]);
        esp32BleQueueCeiling = Number(queue[2]);
        esp32BleCongestionSkips = Number(queue[3]);
        if (queue[4] !== undefined) esp32BlePendingSkips = Number(queue[4]);
        if (queue[5] !== undefined) esp32BleNotifyCompletions = Number(queue[5]);
      }
      const input = line.match(/^DX:(\d+):(\d+):(\d+)$/);
      if (input) {
        esp32InputTransitions = Number(input[1]);
        esp32InputPresses = Number(input[2]);
        esp32InputReleases = Number(input[3]);
      }
      const hid = line.match(/^DH:(\d+):(\d+):(\d+):(\d+):(\d+)$/);
      if (hid) {
        esp32HidFramesEnqueued = Number(hid[1]);
        esp32HidEnqueueTransitions = Number(hid[2]);
        esp32HidFramesDequeued = Number(hid[3]);
        esp32HidDequeueTransitions = Number(hid[4]);
        esp32HidQueueDrops = Number(hid[5]);
      }
      const notify = line.match(/^DB:(\d+):(\d+)$/);
      if (notify) {
        esp32BleNotifications = Number(notify[1]);
        esp32BleInputTransitions = Number(notify[2]);
      }
      const reliability = line.match(/^DR:(\d+):(\d+):(\d+):(\d+):(\d+)$/);
      if (reliability) {
        esp32HidDuplicateStates = Number(reliability[1]);
        esp32HidQueueDepth = Number(reliability[2]);
        esp32HidQueueHighWater = Number(reliability[3]);
        esp32HidNotifyFailures = Number(reliability[4]);
        esp32HidNotifyRecoveries = Number(reliability[5]);
      }
    }
  });
  serial.on("close", () => {
    if (esp32Serial === serial) esp32Serial = null;
    esp32UsesSlottedStatus = false;
    for (let slot = 0; slot < CONTROLLER_SLOT_COUNT; slot += 1) {
      stopRumble(slot);
      pendingEsp32Frames[slot] = null;
      controllerStatus[slot] = {
        ...controllerStatus[slot], state: "disconnected", connected: false, ready: false,
      };
    }
    esp32EdgeFrames.length = 0;
    esp32SerialWriteInFlight = false;
    setTimeout(openEsp32Serial, 2000).unref();
  });
}

openEsp32Serial();

function sendState(slot, state = currentStates[slot], sendSerial = true) {
  if (sendSerial && esp32Serial?.isOpen) {
    queueEsp32State(slot, state);
  }
}

// Keep the ESP32 watchdog fresh while a local controller page is connected.
setInterval(() => {
  if (localControllerSocket?.readyState === 1 && Date.now() - lastEsp32Keepalive >= 500) {
    lastEsp32Keepalive = Date.now();
    currentStates.forEach((state, slot) => queueEsp32State(slot, state, false));
  }
}, 10).unref();

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);
const publicDir = path.join(here, "public");
const server = http.createServer((request, response) => {
  if (request.url === "/api/status") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      browserMessagesReceived,
      browserDigitalEdgesAccepted,
      lastBrowserInputAgeMs: lastBrowserInput ? Date.now() - lastBrowserInput : null,
      localControllerConnected: localControllerSocket?.readyState === 1,
      esp32SerialPort: config.esp32SerialPort || null,
      esp32SerialConnected: esp32Serial?.isOpen === true,
      esp32SerialError,
      esp32SerialFramesWritten,
      esp32SerialFramesDropped,
      esp32SerialFramesCoalesced,
      esp32DigitalEdgeFramesQueued,
      esp32DigitalEdgeFramesWritten,
      esp32DigitalEdgeFramesDropped,
      esp32SerialQueueBytes: esp32Serial ? esp32Serial.writableLength + pendingEsp32Frames.filter(Boolean).length * 8 + esp32EdgeFrames.length * 8 : null,
      esp32BootCount,
      esp32LastReset,
      esp32LastInputLatencyMs: esp32LastInputLatencyMsBySlot[0],
      esp32InputStateChanges,
      esp32BleConnIntervalUnits,
      esp32BleConnIntervalMs: esp32BleConnIntervalUnits == null ? null : esp32BleConnIntervalUnits * 1.25,
      esp32BleConnects,
      esp32BleDisconnects,
      esp32BleLastDisconnectReason,
      esp32HidSubscribes,
      esp32HidUnsubscribes,
      esp32HidTaskStarts,
      esp32BleQueueFree,
      esp32BleQueueCeiling,
      esp32BleCongestionSkips,
      esp32BlePendingSkips,
      esp32BleNotifyCompletions,
      esp32InputTransitions,
      esp32InputPresses,
      esp32InputReleases,
      esp32HidFramesEnqueued,
      esp32HidEnqueueTransitions,
      esp32HidFramesDequeued,
      esp32HidDequeueTransitions,
      esp32HidQueueDrops,
      esp32HidDuplicateStates,
      esp32HidQueueDepth,
      esp32HidQueueHighWater,
      esp32HidNotifyFailures,
      esp32HidNotifyRecoveries,
      esp32BleNotifications,
      esp32BleInputTransitions,
      esp32RumbleFramesReceived,
      currentRumble: currentRumbles[0],
      controllerCount: CONTROLLER_SLOT_COUNT,
      controllers: controllerStatus.map((controller, slot) => ({
        ...controller,
        connectionIntervalMs: controller.connectionIntervalUnits == null
          ? null : controller.connectionIntervalUnits * 1.25,
        currentRumble: currentRumbles[slot],
      })),
    }));
    return;
  }
  const pathname = request.url === "/" ? "/index.html" : new URL(request.url, "http://localhost").pathname;
  const candidate = path.resolve(publicDir, `.${pathname}`);
  if (!candidate.startsWith(`${publicDir}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  fs.readFile(candidate, (error, data) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": mime.get(path.extname(candidate)) || "application/octet-stream" });
    response.end(data);
  });
});

const websocket = new WebSocketServer({ server, path: "/control", maxPayload: 2048 });
websocket.on("connection", (socket, request) => {
  // The local bridge is intentionally loopback-only. Remote users terminate at the host browser via WebRTC.
  if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
    socket.close(1008, "local clients only");
    return;
  }
  if (!allowedLocalControlOrigin(request.headers.origin, config.httpPort)) {
    socket.close(1008, "invalid local origin");
    return;
  }
  // Keep the first tab stable. Reconnecting background tabs are rejected and
  // cannot create an ownership loop. A user gesture can explicitly take over.
  const takeover = new URL(request.url, "http://localhost").searchParams.get("takeover") === "1";
  if (localControllerSocket?.readyState === 1) {
    if (!takeover) {
      socket.close(4001, "controller is active in another tab");
      return;
    }
    const previousSocket = localControllerSocket;
    localControllerSocket = socket;
    previousSocket.close(4001, "controller moved by explicit takeover");
  } else {
    localControllerSocket = socket;
  }
  if (socket.readyState === 1) {
    for (const rumble of currentRumbles) socket.send(JSON.stringify(rumble));
  }
  socket.bridgeAlive = true;
  socket.on("pong", () => { socket.bridgeAlive = true; });
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type !== "input") return;
      const slot = sanitizeControllerSlot(message.slot);
      if (slot === null) {
        socket.close(1008, "invalid controller slot");
        return;
      }
      const nextState = sanitizeState(message.state);
      const stateChanged = JSON.stringify(nextState) !== JSON.stringify(currentStates[slot]);
      if (stateChanged) {
        lastBrowserStateChange[slot] = Date.now();
      }
      const digital = acceptDigitalEdges(message);
      if (digital.states.length) {
        browserDigitalEdgesAccepted += digital.states.length;
        lastBrowserStateChange[slot] = Date.now();
        queueEsp32Edges(slot, digital.states);
      }
      currentStates[slot] = nextState;
      lastBrowserInput = Date.now();
      browserMessagesReceived += 1;
      const finalEdgeState = digital.states.at(-1);
      const finalStateAlreadyQueued = finalEdgeState && sameState(finalEdgeState, currentStates[slot]);
      // Analog states remain latest-value-wins. Digital transitions are queued
      // separately above, so a release can never overwrite an unsent press.
      sendState(slot, currentStates[slot], stateChanged && !finalStateAlreadyQueued);
      if (digital.sid && digital.edgeAck !== null && socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "edge-ack", sid: digital.sid, edgeAck: digital.edgeAck }));
      }
    } catch {
      socket.close(1003, "invalid message");
    }
  });
  socket.on("close", () => {
    if (socket !== localControllerSocket) return;
    localControllerSocket = null;
    currentStates = createControllerStates();
    lastBrowserInput = 0;
    currentStates.forEach((state, slot) => sendState(slot, state));
  });
});

setInterval(() => {
  const socket = localControllerSocket;
  if (!socket || socket.readyState !== 1) return;
  if (!socket.bridgeAlive) {
    socket.terminate();
    return;
  }
  socket.bridgeAlive = false;
  socket.ping();
}, 1000).unref();

server.listen(config.httpPort, "127.0.0.1", () => {
  console.log(`Controller host: http://127.0.0.1:${config.httpPort}`);
  console.log(`ESP32 serial port: ${config.esp32SerialPort}`);
});

function shutdown() {
  currentStates = createControllerStates();
  currentStates.forEach((state, slot) => sendState(slot, state));
  setTimeout(() => process.exit(0), 30);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
