export const CONTROLLER_SLOT_COUNT = 3;

export function validSlot(value) {
  return Number.isInteger(value) && value >= 0 && value < CONTROLLER_SLOT_COUNT;
}

export function normalizeAssignments(value = {}) {
  const normalized = {};
  const occupied = new Set();
  for (const [guestId, slot] of Object.entries(value ?? {})) {
    if (!/^[0-9a-f]{16}$/.test(guestId) || !validSlot(slot) || occupied.has(slot)) continue;
    normalized[guestId] = slot;
    occupied.add(slot);
  }
  return normalized;
}

export function slotForGuest(assignments, guestId) {
  const slot = assignments?.[guestId];
  return validSlot(slot) ? slot : null;
}

export function guestForSlot(assignments, slot) {
  if (!validSlot(slot)) return null;
  return Object.entries(assignments ?? {}).find(([, assigned]) => assigned === slot)?.[0] ?? null;
}

export function firstAvailableSlot(assignments, preferred = null) {
  if (validSlot(preferred) && !guestForSlot(assignments, preferred)) return preferred;
  for (let slot = 0; slot < CONTROLLER_SLOT_COUNT; slot += 1) {
    if (!guestForSlot(assignments, slot)) return slot;
  }
  return null;
}

export function slotForClaim(assignments, guestId, requested = null) {
  const previous = slotForGuest(assignments, guestId);
  if (previous !== null) {
    if (!validSlot(requested) || requested === previous) return previous;
    return guestForSlot(assignments, requested) ? previous : requested;
  }
  if (validSlot(requested)) {
    return guestForSlot(assignments, requested) ? null : requested;
  }
  return firstAvailableSlot(assignments);
}

export function assignGuest(assignments, guestId, slot, { displace = false } = {}) {
  const next = normalizeAssignments(assignments);
  if (!/^[0-9a-f]{16}$/.test(guestId) || !validSlot(slot)) {
    return { assignments: next, slot: null, displacedGuestId: null };
  }
  const occupyingGuest = guestForSlot(next, slot);
  if (occupyingGuest && occupyingGuest !== guestId && !displace) {
    return { assignments: next, slot: slotForGuest(next, guestId), displacedGuestId: null };
  }
  const previousSlot = slotForGuest(next, guestId);
  if (previousSlot !== null) delete next[guestId];
  if (occupyingGuest && occupyingGuest !== guestId) delete next[occupyingGuest];
  next[guestId] = slot;
  return {
    assignments: next,
    slot,
    displacedGuestId: occupyingGuest && occupyingGuest !== guestId ? occupyingGuest : null,
  };
}

export function releaseSlot(assignments, slot) {
  const next = normalizeAssignments(assignments);
  const guestId = guestForSlot(next, slot);
  if (guestId) delete next[guestId];
  return { assignments: next, guestId };
}

export function releaseGuest(assignments, guestId) {
  const next = normalizeAssignments(assignments);
  const slot = slotForGuest(next, guestId);
  if (slot !== null) delete next[guestId];
  return { assignments: next, slot };
}
