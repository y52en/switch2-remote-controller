import test from "node:test";
import assert from "node:assert/strict";
import { createHapticsController, normalizeRumbleMessage } from "./public/haptics.js";

const message = (seq, strong = 0.5, weak = 0.25, duration = 40) => ({
  type: "rumble", seq, strong, weak, duration,
});

test("normalizes only well-formed bounded rumble events", () => {
  assert.deepEqual(normalizeRumbleMessage(message(1, 1.5, -1, 200)), {
    seq: 1, strong: 1, weak: 0, duration: 100,
  });
  assert.equal(normalizeRumbleMessage({ type: "input", seq: 1 }), null);
});

test("plays latest rumble, rejects stale events, and stops when disabled", () => {
  const effects = [], stored = new Map();
  const actuator = {
    effects: ["dual-rumble"],
    playEffect: (type, params) => { effects.push({ type, params }); return Promise.resolve("complete"); },
    reset: () => { effects.push({ reset: true }); return Promise.resolve("complete"); },
  };
  const controller = createHapticsController({
    getGamepad: () => ({ vibrationActuator: actuator }),
    storage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) },
  });
  assert.equal(controller.handle(message(2)), true);
  assert.equal(controller.handle(message(1)), false);
  assert.equal(effects.filter((effect) => effect.type === "dual-rumble").length, 1);
  assert.equal(controller.handle(message(3, 0, 0, 0)), true);
  assert.deepEqual(effects.at(-1), { reset: true });
  assert.equal(controller.handle(message(2, 1, 1)), false, "an older unordered effect cannot restart after stop");
  controller.setEnabled(false);
  assert.equal(stored.values().next().value, "0");
  assert.deepEqual(effects.at(-1), { reset: true });
  assert.equal(controller.handle(message(3)), false);
});

test("does not play effects while the page is hidden", () => {
  let played = false;
  const controller = createHapticsController({
    getGamepad: () => ({ vibrationActuator: { playEffect: () => { played = true; } } }),
    isVisible: () => false,
  });
  assert.equal(controller.handle(message(1)), false);
  assert.equal(played, true, "a zero-strength fallback is issued to stop any old effect");
});
