import { CONTROLLER_SLOT_COUNT } from "./controller-slots.mjs";

export const ESP32_CONTROLLER_SLOT_COUNT = CONTROLLER_SLOT_COUNT;

export function initialEsp32ControllerStatus(slot) {
  return {
    slot,
    state: "disconnected",
    connected: false,
    ready: false,
    connectionIntervalUnits: null,
    disconnectReason: null,
    inputLatencyMs: null,
  };
}

export function parseEsp32ControllerStatus(line, currentControllers) {
  const match = /^DS:([0-2]):(advertising|connected|ready|disconnected):(\d+)(?::(\d+))?$/.exec(line);
  if (!match) return null;
  const slot = Number(match[1]);
  const state = match[2];
  const connectionIntervalUnits = Number(match[3]);
  const disconnectReason = match[4] === undefined ? null : Number(match[4]);
  if (!Number.isInteger(connectionIntervalUnits) || connectionIntervalUnits < 0 ||
      connectionIntervalUnits > 0xffff ||
      (disconnectReason !== null && (!Number.isInteger(disconnectReason) ||
        disconnectReason < 0 || disconnectReason > 0xffff))) return null;
  const previous = currentControllers?.[slot] ?? initialEsp32ControllerStatus(slot);
  const connected = state === "connected" || state === "ready";
  return {
    slot,
    controller: {
      ...previous,
      slot,
      state,
      connected,
      ready: state === "ready",
      connectionIntervalUnits: connectionIntervalUnits || null,
      disconnectReason,
    },
    becameConnected: connected && !previous.connected,
    becameDisconnected: state === "disconnected" && previous.connected,
    disconnectReason,
  };
}
