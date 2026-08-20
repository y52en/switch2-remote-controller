import assert from "node:assert/strict";
import test from "node:test";
import {
  ESP32_CONTROLLER_SLOT_COUNT,
  initialEsp32ControllerStatus,
  parseEsp32ControllerStatus,
} from "./esp32-status.mjs";

const statuses = () => Array.from(
  { length: ESP32_CONTROLLER_SLOT_COUNT },
  (_, slot) => initialEsp32ControllerStatus(slot),
);

test("tracks three structured BLE statuses without recounting periodic updates", () => {
  const controllers = statuses();
  const connected = parseEsp32ControllerStatus("DS:1:connected:4", controllers);
  assert.equal(connected.slot, 1);
  assert.equal(connected.becameConnected, true);
  assert.equal(connected.controller.connectionIntervalUnits, 4);
  controllers[1] = connected.controller;

  const ready = parseEsp32ControllerStatus("DS:1:ready:4", controllers);
  assert.equal(ready.becameConnected, false);
  controllers[1] = ready.controller;
  const periodic = parseEsp32ControllerStatus("DS:1:ready:4", controllers);
  assert.equal(periodic.becameConnected, false);
  assert.equal(periodic.becameDisconnected, false);
});

test("records a bounded disconnect reason only on a valid slot line", () => {
  const controllers = statuses();
  controllers[2] = {
    ...controllers[2], state: "ready", connected: true, ready: true,
  };
  const disconnected = parseEsp32ControllerStatus("DS:2:disconnected:0:19", controllers);
  assert.equal(disconnected.becameDisconnected, true);
  assert.equal(disconnected.disconnectReason, 19);
  assert.equal(disconnected.controller.connected, false);
  assert.equal(parseEsp32ControllerStatus("DS:3:ready:4", controllers), null);
  assert.equal(parseEsp32ControllerStatus("DS:2:ready:65536", controllers), null);
  assert.equal(parseEsp32ControllerStatus("DS:2:disconnected:0:65536", controllers), null);
  assert.equal(parseEsp32ControllerStatus("unstructured", controllers), null);
});
