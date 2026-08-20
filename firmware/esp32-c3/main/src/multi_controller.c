#include "multi_controller.h"

#include <string.h>

bool multi_controller_decode_buttons(uint16_t packed, uint8_t *slot,
                                     uint16_t *buttons) {
    uint8_t decoded_slot = (uint8_t)(packed >> 14);
    if (decoded_slot >= CONTROLLER_SLOT_COUNT || slot == NULL || buttons == NULL) {
        return false;
    }
    *slot = decoded_slot;
    *buttons = packed & MULTI_CONTROLLER_BUTTON_MASK;
    return true;
}

void multi_controller_derive_random_address(const uint8_t base_re[ESP_BD_ADDR_LEN],
                                            uint8_t slot,
                                            uint8_t out_re[ESP_BD_ADDR_LEN]) {
    if (base_re == NULL || out_re == NULL) return;
    memcpy(out_re, base_re, ESP_BD_ADDR_LEN);
    if (slot == 0) return;
    out_re[0] ^= (uint8_t)(0x31U * slot);
    out_re[5] |= 0xC0U;
}

void multi_controller_derive_b1(const uint8_t target_ltk[LTK_KEY_SIZE],
                                const uint8_t a1[LTK_KEY_SIZE],
                                uint8_t b1[LTK_KEY_SIZE]) {
    if (target_ltk == NULL || a1 == NULL || b1 == NULL) return;
    for (uint8_t index = 0; index < LTK_KEY_SIZE; index++) {
        b1[index] = a1[index] ^ target_ltk[LTK_KEY_SIZE - index - 1];
    }
}
