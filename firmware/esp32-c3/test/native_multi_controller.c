#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "multi_controller.h"

static void test_slot_decode(void) {
    for (uint8_t expected_slot = 0; expected_slot < CONTROLLER_SLOT_COUNT;
         expected_slot++) {
        uint8_t slot = 0xff;
        uint16_t buttons = 0;
        uint16_t packed = (uint16_t)((expected_slot << 14) | 0x2A55U);
        assert(multi_controller_decode_buttons(packed, &slot, &buttons));
        assert(slot == expected_slot);
        assert(buttons == 0x2A55U);
    }
    uint8_t slot;
    uint16_t buttons;
    assert(!multi_controller_decode_buttons(0xC000U, &slot, &buttons));
}

static void test_unique_random_static_addresses(void) {
    const uint8_t base[ESP_BD_ADDR_LEN] = {0x01, 0x02, 0x03, 0x8c, 0x81, 0x78};
    uint8_t addresses[CONTROLLER_SLOT_COUNT][ESP_BD_ADDR_LEN];
    for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
        multi_controller_derive_random_address(base, slot, addresses[slot]);
    }
    assert(memcmp(addresses[0], base, ESP_BD_ADDR_LEN) == 0);
    assert((addresses[1][5] & 0xC0U) == 0xC0U);
    assert((addresses[2][5] & 0xC0U) == 0xC0U);
    assert(memcmp(addresses[0], addresses[1], ESP_BD_ADDR_LEN) != 0);
    assert(memcmp(addresses[1], addresses[2], ESP_BD_ADDR_LEN) != 0);
}

static void test_shared_ltk_derivation(void) {
    uint8_t target[LTK_KEY_SIZE];
    uint8_t a1[CONTROLLER_SLOT_COUNT][LTK_KEY_SIZE];
    for (uint8_t index = 0; index < LTK_KEY_SIZE; index++) {
        target[index] = (uint8_t)(0xA0U + index);
        for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
            a1[slot][index] = (uint8_t)(slot * 0x31U + index * 7U);
        }
    }
    for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
        uint8_t b1[LTK_KEY_SIZE];
        multi_controller_derive_b1(target, a1[slot], b1);
        for (uint8_t index = 0; index < LTK_KEY_SIZE; index++) {
            uint8_t reconstructed =
                a1[slot][LTK_KEY_SIZE - index - 1] ^
                b1[LTK_KEY_SIZE - index - 1];
            assert(reconstructed == target[index]);
        }
    }
}

int main(void) {
    test_slot_decode();
    test_unique_random_static_addresses();
    test_shared_ltk_derivation();
    return 0;
}
