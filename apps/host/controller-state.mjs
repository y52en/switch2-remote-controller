export const NEUTRAL_STATE = Object.freeze({
  buttons: 0,
  hat: 8,
  lx: 128,
  ly: 128,
  rx: 128,
  ry: 128,
});

export function sanitizeState(value = {}) {
  const byte = (input, fallback) => Number.isFinite(input)
    ? Math.max(0, Math.min(255, Math.round(input)))
    : fallback;
  return {
    buttons: Number.isFinite(value.buttons)
      ? Math.max(0, Math.min(0xffff, Math.round(value.buttons)))
      : 0,
    hat: Number.isFinite(value.hat)
      ? Math.max(0, Math.min(8, Math.round(value.hat)))
      : 8,
    lx: byte(value.lx, 128),
    ly: byte(value.ly, 128),
    rx: byte(value.rx, 128),
    ry: byte(value.ry, 128),
  };
}

export function sanitizeDigitalEdges(message = {}) {
  if (!/^[0-9a-f]{16}$/.test(message.sid ?? "") || !Array.isArray(message.edges)) {
    return { sid: null, edges: [], highestSequence: null };
  }
  const edges = [];
  for (const row of message.edges.slice(-32)) {
    if (!Array.isArray(row) || row.length !== 7 ||
        !Number.isSafeInteger(row[0]) || row[0] < 0) continue;
    edges.push({
      sequence: row[0],
      state: sanitizeState({
        buttons: row[1], hat: row[2], lx: row[3], ly: row[4],
        rx: row[5], ry: row[6],
      }),
    });
  }
  edges.sort((left, right) => left.sequence - right.sequence);
  return {
    sid: message.sid,
    edges,
    highestSequence: edges.length ? edges.at(-1).sequence : null,
  };
}
