# ESP32-C3 firmware

This directory contains the integrated ESP32-C3 firmware source. It uses USB
Serial/JTAG for EasyCon input and three Bluetooth LE controller identities for
the console connections.

Controller slots 0, 1, and 2 use separate legacy-format extended advertising
instances, BLE addresses, connection handles, HID queues, watchdogs, and rumble
feedback paths. The two additional addresses are deterministic random-static
addresses derived from the board address. Pairing derives one shared persisted
LTK across all three identities so it remains compatible with NimBLE's
peer-keyed bond store.

Build profiles:

- `esp32c3-headless`: default; no display code, SPI bus, or LCD GPIO setup.
- `esp32c3-2424s012c`: enables the GC9A01 status display and its board pins.

Runtime telemetry is independent of the display. Both profiles emit the same
bounded diagnostic lines over USB and retain the same input watchdog, delivery
recovery, and per-slot rumble behavior. Structured status lines include the slot
number (`DS:<slot>:...`, `DI:<slot>`, and `RV:<slot>:...`).

Use the root `scripts/firmware.py` wrapper rather than invoking a global
PlatformIO installation. The wrapper verifies and patches an isolated ESP-IDF
copy required for the experimental 5 ms connection interval.

The pure multi-controller address, slot, and shared-key logic can be checked
without the ESP-IDF toolchain:

```sh
cc -std=c11 -Wall -Wextra -Werror -pedantic -Imain/include \
  main/src/multi_controller.c test/native_multi_controller.c \
  -o /tmp/multi-controller-test && /tmp/multi-controller-test
```

Three active 5 ms links share one ESP32-C3 radio. Always validate pairing,
simultaneous input, disconnect/reconnect, rumble routing, and watchdog recovery
with all three controller slots on physical hardware before releasing a build.
