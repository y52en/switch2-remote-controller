import test from "node:test";
import assert from "node:assert/strict";
import {
  DATA_CHANNEL_OPTIONS,
  TRANSPORT_P2P,
  TRANSPORT_RELAY,
  buildGuestLink,
  normalizeTransportMode,
  transportModeLabel,
} from "./public/transport.js";

test("normalizes transport modes without accepting arbitrary values", () => {
  assert.equal(normalizeTransportMode(TRANSPORT_RELAY), TRANSPORT_RELAY);
  assert.equal(normalizeTransportMode(TRANSPORT_P2P), TRANSPORT_P2P);
  assert.equal(normalizeTransportMode("unexpected"), TRANSPORT_P2P);
  assert.equal(normalizeTransportMode(null), TRANSPORT_P2P);
});

test("builds a guest link carrying the selected transport", () => {
  assert.equal(
    buildGuestLink("https://switch2.example/old/path", "ABCDEFG234", TRANSPORT_RELAY),
    "https://switch2.example/?remote=ABCDEFG234&transport=relay",
  );
});

test("uses an explicitly negotiated low-latency data channel", () => {
  assert.deepEqual(DATA_CHANNEL_OPTIONS, {
    negotiated: true,
    id: 0,
    ordered: false,
    maxRetransmits: 0,
  });
  assert.equal(transportModeLabel(TRANSPORT_P2P), "P2P優先");
  assert.equal(transportModeLabel(TRANSPORT_RELAY), "リレー固定");
});
