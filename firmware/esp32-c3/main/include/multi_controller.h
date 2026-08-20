#ifndef MULTI_CONTROLLER_H
#define MULTI_CONTROLLER_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef ESP_BD_ADDR_LEN
#define ESP_BD_ADDR_LEN 6
#endif
#ifndef LTK_KEY_SIZE
#define LTK_KEY_SIZE 16
#endif
#define CONTROLLER_SLOT_COUNT 3
#define MULTI_CONTROLLER_BUTTON_MASK 0x3FFFU

bool multi_controller_decode_buttons(uint16_t packed, uint8_t *slot,
                                     uint16_t *buttons);
void multi_controller_derive_random_address(const uint8_t base_re[ESP_BD_ADDR_LEN],
                                            uint8_t slot,
                                            uint8_t out_re[ESP_BD_ADDR_LEN]);
void multi_controller_derive_b1(const uint8_t target_ltk[LTK_KEY_SIZE],
                                const uint8_t a1[LTK_KEY_SIZE],
                                uint8_t b1[LTK_KEY_SIZE]);

#ifdef __cplusplus
}
#endif

#endif
