import { CONTROLLER_SLOT_COUNT } from "./controller-slots.mjs";

const RAW_SIZE = 7;
const ENCODED_SIZE = 8;
export const EASYCON_CONTROLLER_SLOT_COUNT = CONTROLLER_SLOT_COUNT;
export const EASYCON_BUTTON_MASK = 0x3fff;

export function encodeEasyConState(state, slot = 0) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= EASYCON_CONTROLLER_SLOT_COUNT) {
    throw new RangeError(`controller slot must be from 0 to ${EASYCON_CONTROLLER_SLOT_COUNT - 1}`);
  }
  // EasyCon has two unused button bits. Carry the virtual-controller slot in
  // those bits so the on-wire frame remains eight bytes and old slot-0 hosts
  // remain compatible with the new firmware.
  const buttons = (Number(state.buttons) & EASYCON_BUTTON_MASK) | (slot << 14);
  const raw = Uint8Array.of(
    buttons >>> 8,
    buttons,
    Number(state.hat) & 0x0f,
    Number(state.lx) & 0xff,
    Number(state.ly) & 0xff,
    Number(state.rx) & 0xff,
    Number(state.ry) & 0xff,
  );
  const encoded = Buffer.alloc(ENCODED_SIZE);
  let accumulator = 0;
  let bits = 0;
  let output = 0;
  for (const value of raw) {
    accumulator = accumulator * 256 + value;
    bits += 8;
    while (bits >= 7) {
      bits -= 7;
      encoded[output++] = Math.floor(accumulator / (2 ** bits)) & 0x7f;
      accumulator %= 2 ** bits;
    }
  }
  if (output !== ENCODED_SIZE || bits !== 0 || raw.length !== RAW_SIZE) {
    throw new Error("EasyCon frame encoding failed");
  }
  encoded[ENCODED_SIZE - 1] |= 0x80;
  return encoded;
}
