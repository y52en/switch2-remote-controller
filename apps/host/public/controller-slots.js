export const CONTROLLER_SLOT_COUNT = 3;

export function validControllerSlot(value) {
  return Number.isInteger(value) && value >= 0 && value < CONTROLLER_SLOT_COUNT;
}

export function controllerSlotLabel(slot) {
  return validControllerSlot(slot) ? `コントローラー ${slot + 1}` : "待機中";
}

export function participantForSlot(participants, slot) {
  if (!validControllerSlot(slot) || !Array.isArray(participants)) return null;
  return participants.find((participant) => participant?.active && participant.slot === slot) ?? null;
}

export function slotIsLocallyAvailable(participants, slot) {
  return validControllerSlot(slot) && !participantForSlot(participants, slot);
}
