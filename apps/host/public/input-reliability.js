export const MAX_DIGITAL_EDGE_HISTORY = 32;

function copyState(state) {
  return {
    buttons: Number(state.buttons) || 0,
    hat: Number.isFinite(state.hat) ? Number(state.hat) : 8,
    lx: Number.isFinite(state.lx) ? Number(state.lx) : 128,
    ly: Number.isFinite(state.ly) ? Number(state.ly) : 128,
    rx: Number.isFinite(state.rx) ? Number(state.rx) : 128,
    ry: Number.isFinite(state.ry) ? Number(state.ry) : 128,
  };
}

function edgeRow(sequence, state) {
  const value = copyState(state);
  return [sequence, value.buttons, value.hat, value.lx, value.ly, value.rx, value.ry];
}

export class DigitalEdgeHistory {
  constructor(sessionId, initialState) {
    this.reset(sessionId, initialState);
  }

  reset(sessionId, initialState) {
    this.sessionId = sessionId;
    this.nextSequence = 0;
    this.edges = [];
    const state = copyState(initialState);
    this.lastButtons = state.buttons;
    this.lastHat = state.hat;
  }

  observe(state) {
    const value = copyState(state);
    if (value.buttons === this.lastButtons && value.hat === this.lastHat) return false;
    this.lastButtons = value.buttons;
    this.lastHat = value.hat;
    this.edges.push(edgeRow(this.nextSequence++, value));
    if (this.edges.length > MAX_DIGITAL_EDGE_HISTORY) this.edges.shift();
    return true;
  }

  envelope(state) {
    return {
      state: copyState(state),
      sid: this.sessionId,
      edges: this.edges.map((edge) => [...edge]),
    };
  }

  acknowledge(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return;
    this.edges = this.edges.filter((edge) => edge[0] > sequence);
  }
}

export function highestDigitalEdgeSequence(message) {
  if (!Array.isArray(message?.edges)) return null;
  let highest = null;
  for (const edge of message.edges) {
    if (!Array.isArray(edge) || edge.length !== 7 || !Number.isSafeInteger(edge[0]) || edge[0] < 0) continue;
    if (highest === null || edge[0] > highest) highest = edge[0];
  }
  return highest;
}
