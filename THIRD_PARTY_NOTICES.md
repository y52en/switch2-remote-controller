# Third-party notices

## ESP32-BLE5-NSController-Emulator

The firmware in `firmware/esp32-c3` is derived from
[zhantss/ESP32-BLE5-NSController-Emulator](https://github.com/zhantss/ESP32-BLE5-NSController-Emulator)
at commit `0ea0c62aeab2440c7f9c77f29cf87ffa3b4c192f`.

Copyright (c) 2024 Tss. Licensed under the MIT License. The original license is
preserved as `firmware/esp32-c3/LICENSE.upstream`. This project modifies the
ESP32-C3 transport, input delivery safety, runtime telemetry, rumble feedback,
and build configuration.

## Espressif ESP32-C3 Bluetooth controller library

`firmware/esp32-c3/third_party/esp32c3-bt-lib/libbtdm_app.a` comes from
[espressif/esp32c3-bt-lib](https://github.com/espressif/esp32c3-bt-lib) at
commit `0a08c4b32f3666003080b662a1a61794da24ff0f` and is distributed under the
Apache License 2.0. Its license is included beside the library.

The build tool applies narrowly scoped connection-interval compatibility
changes to a project-local ESP-IDF package. It never modifies a globally
installed framework.
