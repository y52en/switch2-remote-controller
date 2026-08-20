#include "console.h"

console_ns2_t g_console_ns2s[CONTROLLER_SLOT_COUNT] = {
    [0 ... CONTROLLER_SLOT_COUNT - 1] = {
        .ble_addr = { .type = BLE_ADDR_PUBLIC, .val = { 0 } },
        .conn_handle = BLE_HS_CONN_HANDLE_NONE,
        .mtu = 512,
    },
};
