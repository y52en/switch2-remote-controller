import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeDigitalEdges, sanitizeState } from "./controller-state.mjs";

test("clamps untrusted browser state", () => {
  assert.deepEqual(sanitizeState({ buttons: 999999, hat: -1, lx: -20, ly: 999 }), {
    buttons: 65535, hat: 0, lx: 0, ly: 255, rx: 128, ry: 128,
  });
});

test("sanitizes compact digital edge history", () => {
  const parsed = sanitizeDigitalEdges({
    sid: "0123456789abcdef",
    edges: [[1, 0, 8, 128, 128, 128, 128], [0, 2, 8, 1, 2, 3, 4], ["bad"]],
  });
  assert.equal(parsed.highestSequence, 1);
  assert.deepEqual(
    parsed.edges.map(({ sequence, state }) => [sequence, state.buttons, state.hat]),
    [[0, 2, 8], [1, 0, 8]],
  );
  assert.deepEqual(sanitizeDigitalEdges({ sid: "bad", edges: [] }).edges, []);
});
