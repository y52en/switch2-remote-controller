import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.mjs";

test("loads the ESP32 serial port and default HTTP port", () => {
  assert.deepEqual(loadConfig({ ESP32_SERIAL_PORT: " COM3 " }), {
    esp32SerialPort: "COM3",
    httpPort: 8787,
  });
});

test("accepts Unix device paths and validates the HTTP port", () => {
  assert.deepEqual(loadConfig({
    ESP32_SERIAL_PORT: "/dev/ttyACM0",
    HTTP_PORT: "9000",
  }), { esp32SerialPort: "/dev/ttyACM0", httpPort: 9000 });
  assert.throws(() => loadConfig({ ESP32_SERIAL_PORT: "COM3", HTTP_PORT: "0" }), /HTTP_PORT/);
});

test("requires an explicit serial port", () => {
  assert.throws(() => loadConfig({}), /ESP32_SERIAL_PORT/);
});
