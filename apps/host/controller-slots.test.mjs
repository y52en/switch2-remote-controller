import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROLLER_SLOT_COUNT,
  controllerSlotLabel,
  createControllerStates,
  firstAvailableSlot,
  normalizeAssignments,
  sanitizeControllerSlot,
  sanitizeSlottedState,
} from "./controller-slots.mjs";

test("accepts exactly the three supported controller slots", () => {
  assert.equal(CONTROLLER_SLOT_COUNT, 3);
  assert.deepEqual([0, 1, 2].map(sanitizeControllerSlot), [0, 1, 2]);
  assert.equal(sanitizeControllerSlot(3), null);
  assert.equal(sanitizeControllerSlot("1"), 1);
  assert.equal(controllerSlotLabel(2), "コントローラー 3");
});

test("creates independent neutral states and sanitizes slotted input", () => {
  const states = createControllerStates();
  states[0].buttons = 1;
  assert.equal(states[1].buttons, 0);
  assert.deepEqual(sanitizeSlottedState({ slot: 2, state: { buttons: 8, lx: 999 } }), {
    slot: 2,
    state: { buttons: 8, hat: 8, lx: 255, ly: 128, rx: 128, ry: 128 },
  });
  assert.equal(sanitizeSlottedState({ slot: 7 }), null);
});

test("normalizes unique assignments and picks an available slot", () => {
  const assignments = normalizeAssignments({
    "0123456789abcdef": 1,
    "fedcba9876543210": 1,
    invalid: 2,
  });
  assert.deepEqual(assignments, { "0123456789abcdef": 1 });
  assert.equal(firstAvailableSlot(assignments, 2), 2);
  assert.equal(firstAvailableSlot({ a: 0, b: 1, c: 2 }), null);
});
