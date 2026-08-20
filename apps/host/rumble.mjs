import { CONTROLLER_SLOT_COUNT } from "./controller-slots.mjs";

export const RUMBLE_RAW_MAX = 1023;
export const RUMBLE_EFFECT_DURATION_MS = 40;
export const RUMBLE_CONTROLLER_SLOT_COUNT = CONTROLLER_SLOT_COUNT;

export function parseEsp32RumbleLine(line) {
  const match = /^RV:(?:(\d+):)?(\d+):(\d+):(\d+)$/.exec(line.trim());
  if (!match) return null;
  const slot = match[1] === undefined ? 0 : Number(match[1]);
  const firmwareSequence = Number(match[2]);
  const strongRaw = Number(match[3]);
  const weakRaw = Number(match[4]);
  if (!Number.isInteger(slot) || slot < 0 || slot >= RUMBLE_CONTROLLER_SLOT_COUNT ||
      !Number.isSafeInteger(firmwareSequence) ||
      !Number.isInteger(strongRaw) || strongRaw < 0 || strongRaw > RUMBLE_RAW_MAX ||
      !Number.isInteger(weakRaw) || weakRaw < 0 || weakRaw > RUMBLE_RAW_MAX) return null;
  return { slot, firmwareSequence, strongRaw, weakRaw };
}

export function makeRumbleMessage(raw, sequence) {
  if (!raw || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  return {
    type: "rumble",
    slot: raw.slot ?? 0,
    seq: sequence,
    strong: raw.strongRaw / RUMBLE_RAW_MAX,
    weak: raw.weakRaw / RUMBLE_RAW_MAX,
    duration: raw.strongRaw === 0 && raw.weakRaw === 0 ? 0 : RUMBLE_EFFECT_DURATION_MS,
  };
}

export function validRumbleMessage(message) {
  return message?.type === "rumble" &&
    Number.isInteger(message.slot) && message.slot >= 0 &&
    message.slot < RUMBLE_CONTROLLER_SLOT_COUNT &&
    Number.isSafeInteger(message.seq) && message.seq >= 0 &&
    Number.isFinite(message.strong) && message.strong >= 0 && message.strong <= 1 &&
    Number.isFinite(message.weak) && message.weak >= 0 && message.weak <= 1 &&
    Number.isInteger(message.duration) && message.duration >= 0 && message.duration <= 100;
}
