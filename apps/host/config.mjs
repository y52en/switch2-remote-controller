export function loadConfig(environment = process.env) {
  const esp32SerialPort = (environment.ESP32_SERIAL_PORT ?? "").trim();
  if (!esp32SerialPort) {
    throw new Error("ESP32_SERIAL_PORT is required; copy .env.example to .env and set the device path");
  }

  const httpPort = Number(environment.HTTP_PORT || 8787);
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error("HTTP_PORT must be an integer from 1 to 65535");
  }
  return { esp32SerialPort, httpPort };
}
