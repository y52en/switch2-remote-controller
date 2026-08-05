export const TRANSPORT_P2P = "p2p";
export const TRANSPORT_RELAY = "relay";

export const DATA_CHANNEL_OPTIONS = Object.freeze({
  negotiated: true,
  id: 0,
  ordered: false,
  maxRetransmits: 0,
});

export const DATA_CHANNEL_HIGH_WATER = 16 * 1024;
export const DATA_CHANNEL_LOW_WATER = 4 * 1024;
export const P2P_ACK_TIMEOUT_MS = 3000;

export function normalizeTransportMode(value) {
  return value === TRANSPORT_RELAY ? TRANSPORT_RELAY : TRANSPORT_P2P;
}

export function transportModeLabel(mode) {
  return normalizeTransportMode(mode) === TRANSPORT_RELAY ? "リレー固定" : "P2P優先";
}

export function buildGuestLink(base, code, mode) {
  const url = new URL("/", base);
  url.searchParams.set("remote", code);
  url.searchParams.set("transport", normalizeTransportMode(mode));
  return url.href;
}
