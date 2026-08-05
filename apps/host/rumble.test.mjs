import test from "node:test";
import assert from "node:assert/strict";
import {
  RUMBLE_EFFECT_DURATION_MS,
  makeRumbleMessage,
  parseEsp32RumbleLine,
  validRumbleMessage,
} from "./rumble.mjs";

test("parses bounded ESP32 rumble diagnostics", () => {
  assert.deepEqual(parseEsp32RumbleLine("RV:42:1023:512"), {
    firmwareSequence: 42, strongRaw: 1023, weakRaw: 512,
  });
  assert.equal(parseEsp32RumbleLine("RV:1:1024:0"), null);
  assert.equal(parseEsp32RumbleLine("noise"), null);
});

test("normalizes rumble and makes stop events immediate", () => {
  const active = makeRumbleMessage(parseEsp32RumbleLine("RV:3:1023:0"), 7);
  assert.deepEqual(active, {
    type: "rumble", seq: 7, strong: 1, weak: 0, duration: RUMBLE_EFFECT_DURATION_MS,
  });
  const stopped = makeRumbleMessage(parseEsp32RumbleLine("RV:4:0:0"), 8);
  assert.equal(stopped.duration, 0);
  assert.equal(validRumbleMessage(active), true);
  assert.equal(validRumbleMessage({ ...active, strong: 2 }), false);
});
