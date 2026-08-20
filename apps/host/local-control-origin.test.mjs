import assert from "node:assert/strict";
import test from "node:test";
import { allowedLocalControlOrigin } from "./local-control-origin.mjs";

test("accepts the host UI and origin-less native loopback clients", () => {
  assert.equal(allowedLocalControlOrigin("http://127.0.0.1:8787", 8787), true);
  assert.equal(allowedLocalControlOrigin("http://localhost:8787", 8787), true);
  assert.equal(allowedLocalControlOrigin("http://[::1]:8787", 8787), true);
  assert.equal(allowedLocalControlOrigin(undefined, 8787), true);
});

test("rejects cross-site, mismatched-port, and opaque browser origins", () => {
  assert.equal(allowedLocalControlOrigin("https://example.com", 8787), false);
  assert.equal(allowedLocalControlOrigin("http://127.0.0.1:9999", 8787), false);
  assert.equal(allowedLocalControlOrigin("null", 8787), false);
});
