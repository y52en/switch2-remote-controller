import assert from "node:assert/strict";
import test from "node:test";
import { DigitalEdgeHistory, highestDigitalEdgeSequence } from "./public/input-reliability.js";

const neutral = () => ({ buttons: 0, hat: 8, lx: 128, ly: 128, rx: 128, ry: 128 });

test("keeps press and release edges until they are acknowledged", () => {
  const history = new DigitalEdgeHistory("0123456789abcdef", neutral());
  const pressed = { ...neutral(), buttons: 2 };
  assert.equal(history.observe(pressed), true);
  assert.equal(history.observe(pressed), false);
  assert.equal(history.observe(neutral()), true);
  assert.deepEqual(history.envelope(neutral()).edges.map((edge) => edge.slice(0, 3)), [[0, 2, 8], [1, 0, 8]]);
  history.acknowledge(0);
  assert.deepEqual(history.envelope(neutral()).edges.map((edge) => edge[0]), [1]);
});

test("reports the highest valid edge sequence", () => {
  assert.equal(highestDigitalEdgeSequence({ edges: [[3, 1, 8, 128, 128, 128, 128], [4, 0, 8, 128, 128, 128, 128]] }), 4);
  assert.equal(highestDigitalEdgeSequence({ edges: [["bad"]] }), null);
});
