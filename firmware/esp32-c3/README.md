# ESP32-C3 firmware

This directory contains the integrated ESP32-C3 firmware source. It uses USB
Serial/JTAG for EasyCon input and Bluetooth LE for the console connection.

Build profiles:

- `esp32c3-headless`: default; no display code, SPI bus, or LCD GPIO setup.
- `esp32c3-2424s012c`: enables the GC9A01 status display and its board pins.

Runtime telemetry is independent of the display. Both profiles emit the same
bounded diagnostic lines over USB and retain the same input watchdog, delivery
recovery, and rumble behavior.

Use the root `scripts/firmware.py` wrapper rather than invoking a global
PlatformIO installation. The wrapper verifies and patches an isolated ESP-IDF
copy required for the experimental 5 ms connection interval.
