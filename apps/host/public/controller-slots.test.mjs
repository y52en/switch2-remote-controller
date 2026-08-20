import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROLLER_SLOT_COUNT,
  controllerSlotLabel,
  participantForSlot,
  slotIsLocallyAvailable,
  validControllerSlot,
} from "./controller-slots.js";

test("exposes exactly three controller slots", () => {
  assert.equal(CONTROLLER_SLOT_COUNT, 3);
  assert.equal(validControllerSlot(0), true);
  assert.equal(validControllerSlot(2), true);
  assert.equal(validControllerSlot(3), false);
  assert.equal(validControllerSlot("1"), false);
  assert.equal(controllerSlotLabel(0), "コントローラー 1");
  assert.equal(controllerSlotLabel(null), "待機中");
});

test("finds remote ownership without treating malformed rows as assignments", () => {
  const participants = [
    { id: "a", active: true, slot: 1 },
    { id: "b", active: false, slot: 2 },
    { id: "c", active: true, slot: 7 },
  ];
  assert.equal(participantForSlot(participants, 1)?.id, "a");
  assert.equal(participantForSlot(participants, 2), null);
  assert.equal(slotIsLocallyAvailable(participants, 0), true);
  assert.equal(slotIsLocallyAvailable(participants, 1), false);
});
