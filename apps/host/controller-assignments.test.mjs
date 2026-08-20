import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROLLER_SLOT_COUNT,
  assignGuest,
  firstAvailableSlot,
  guestForSlot,
  normalizeAssignments,
  releaseGuest,
  releaseSlot,
  slotForClaim,
  slotForGuest,
} from "../../services/signaling/src/controller-assignments.js";

const alice = "aaaaaaaaaaaaaaaa";
const bob = "bbbbbbbbbbbbbbbb";
const carol = "cccccccccccccccc";

test("maintains one guest per each of three controller slots", () => {
  assert.equal(CONTROLLER_SLOT_COUNT, 3);
  let assignments = {};
  for (const guestId of [alice, bob, carol]) {
    const slot = firstAvailableSlot(assignments);
    ({ assignments } = assignGuest(assignments, guestId, slot));
  }
  assert.deepEqual(assignments, { [alice]: 0, [bob]: 1, [carol]: 2 });
  assert.equal(firstAvailableSlot(assignments), null);
  assert.equal(guestForSlot(assignments, 1), bob);
  assert.equal(slotForGuest(assignments, carol), 2);
});

test("rejects accidental displacement but permits an explicit host handoff", () => {
  const initial = { [alice]: 0, [bob]: 1 };
  assert.deepEqual(assignGuest(initial, bob, 0).assignments, initial);
  const moved = assignGuest(initial, bob, 0, { displace: true });
  assert.deepEqual(moved.assignments, { [bob]: 0 });
  assert.equal(moved.displacedGuestId, alice);
});

test("releases by controller or guest and drops malformed persisted data", () => {
  const normalized = normalizeAssignments({ [alice]: 0, [bob]: 0, invalid: 2, [carol]: 7 });
  assert.deepEqual(normalized, { [alice]: 0 });
  assert.deepEqual(releaseSlot({ [alice]: 0, [bob]: 1 }, 0), {
    assignments: { [bob]: 1 }, guestId: alice,
  });
  assert.deepEqual(releaseGuest({ [alice]: 0, [bob]: 1 }, bob), {
    assignments: { [alice]: 0 }, slot: 1,
  });
});

test("retains an active guest's slot when no different slot is requested", () => {
  const assignments = { [alice]: 0, [bob]: 1 };
  assert.equal(slotForGuest(assignments, alice), 0);
  assert.equal(firstAvailableSlot(assignments), 2);
  assert.equal(slotForClaim(assignments, alice), 0);
  assert.equal(slotForClaim(assignments, alice, 2), 2);
  assert.equal(slotForClaim(assignments, alice, 1), 0);
  assert.equal(slotForClaim(assignments, carol, 1), null);
  assert.deepEqual(assignGuest(assignments, alice, 0).assignments, assignments);
});
