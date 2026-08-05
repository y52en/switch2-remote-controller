const RAW_SIZE = 7;
const ENCODED_SIZE = 8;

export function encodeEasyConState(state) {
  const buttons = Number(state.buttons) & 0xffff;
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
