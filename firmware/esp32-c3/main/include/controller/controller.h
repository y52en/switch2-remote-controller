#ifndef _CONTROLLER_CONTROLLER_H_
#define _CONTROLLER_CONTROLLER_H_

#include <stdint.h>
#include <stdbool.h>

#include "nvs_flash.h"
#include "multi_controller.h"

// LTK Length
#define LTK_LEN                 16

// Manufacturer Data Length
#define MANUFACTURER_DATA_LEN   26

typedef enum {
    CONTROLLER_TYPE_PRO2,
    CONTROLLER_TYPE_JOYCON,
} controller_type_t;

typedef struct {
    uint8_t addr[ESP_BD_ADDR_LEN];
    uint8_t addr_re[ESP_BD_ADDR_LEN];
    uint8_t ltk[LTK_LEN];
    uint8_t ltk_re[LTK_LEN];
    uint8_t ltk_key_b1[LTK_KEY_SIZE];
    uint8_t manufacturer_data[MANUFACTURER_DATA_LEN];
    controller_type_t type;
    bool pairing_saved;
} controller_firmware_t;

extern controller_firmware_t g_controller_firmware;

int inject_pairing_info_to_ble_ctx(uint8_t slot);
void controller_addresses_init(void);
const uint8_t *controller_address_re(uint8_t slot);

// Read controller type from NVS (default PRO2)
void controller_type_init(void);

// Generic controller firmware init, dispatches to pro2/joycon
int controller_init(nvs_handle_t nvs_handle);

// Generic pairing info save, dispatches to pro2/joycon
int controller_pairing_info_save(uint8_t slot);

// Generic pairing info remove, dispatches to pro2/joycon
int controller_pairing_info_erase(void);

#endif // _CONTROLLER_CONTROLLER_H_
