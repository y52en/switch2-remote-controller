import { NEUTRAL_STATE, sanitizeState } from "./controller-state.mjs";

export const CONTROLLER_SLOT_COUNT = 3;

export function sanitizeControllerSlot(value, fallback = null) {
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= 0 && slot < CONTROLLER_SLOT_COUNT
    ? slot
    : fallback;
}

export function controllerSlotLabel(slot) {
  const value = sanitizeControllerSlot(slot);
  return value === null ? "待機中" : `コントローラー ${value + 1}`;
}

export function createControllerStates() {
  return Array.from({ length: CONTROLLER_SLOT_COUNT }, () => ({ ...NEUTRAL_STATE }));
}

export function sanitizeSlottedState(message = {}) {
  const slot = sanitizeControllerSlot(message.slot);
  if (slot === null) return null;
  return { slot, state: sanitizeState(message.state) };
}

export function firstAvailableSlot(assignments, preferred = null) {
  const occupied = new Set(Object.values(assignments ?? {}).filter(Number.isInteger));
  const requested = sanitizeControllerSlot(preferred);
  if (requested !== null && !occupied.has(requested)) return requested;
  for (let slot = 0; slot < CONTROLLER_SLOT_COUNT; slot += 1) {
    if (!occupied.has(slot)) return slot;
  }
  return null;
}

export function normalizeAssignments(value = {}) {
  const result = {};
  const usedSlots = new Set();
  for (const [guestId, rawSlot] of Object.entries(value ?? {})) {
    if (!/^[0-9a-f]{16}$/.test(guestId)) continue;
    const slot = sanitizeControllerSlot(rawSlot);
    if (slot === null || usedSlots.has(slot)) continue;
    result[guestId] = slot;
    usedSlots.add(slot);
  }
  return result;
}
