import assert from "node:assert/strict";
import test from "node:test";
import {
  EASYCON_BUTTON_MASK,
  encodeEasyConState,
} from "./easycon.mjs";

function decode(frame) {
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  const raw = Buffer.alloc(7);
  for (let output = 0; output < raw.length; output += 1) {
    while (bits < 8) {
      accumulator = accumulator * 128 + (frame[index++] & 0x7f);
      bits += 7;
    }
    bits -= 8;
    raw[output] = Math.floor(accumulator / (2 ** bits)) & 0xff;
    accumulator %= 2 ** bits;
  }
  return raw;
}

test("encodes the host state as an EasyCon HID frame", () => {
  const frame = encodeEasyConState({ buttons: 0x255a, hat: 6, lx: 1, ly: 127, rx: 128, ry: 255 });
  assert.equal(frame.length, 8);
  assert.equal(frame[7] & 0x80, 0x80);
  assert.deepEqual([...decode(frame)], [0x25, 0x5a, 6, 1, 127, 128, 255]);
});

test("encodes three controller slots without changing the frame size", () => {
  for (let slot = 0; slot < 3; slot += 1) {
    const raw = decode(encodeEasyConState({
      buttons: 0xffff, hat: 8, lx: 128, ly: 128, rx: 128, ry: 128,
    }, slot));
    const taggedButtons = (raw[0] << 8) | raw[1];
    assert.equal(taggedButtons >>> 14, slot);
    assert.equal(taggedButtons & EASYCON_BUTTON_MASK, EASYCON_BUTTON_MASK);
  }
  assert.throws(() => encodeEasyConState({}, 3), /controller slot/);
});
