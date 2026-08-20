#include <stdio.h>
#include "esp_log.h"
#include "nvs_flash.h"

#include "device.h"
#include "controller/hid_controller.h"
#include "transport/transport.h"
#include "protocol/protocol.h"
#include "ns2_codec.h"
#include "runtime_status.h"
#include "rumble_feedback.h"
#include "status_display.h"

void app_main(void)
{
    esp_log_level_set("*", ESP_LOG_WARN);
    #ifdef CONFIG_MCU_DEBUG
        esp_log_level_set(LOG_APP, ESP_LOG_DEBUG);
        esp_log_level_set(LOG_BLE_GAP, ESP_LOG_DEBUG);
        esp_log_level_set(LOG_BLE_GATT, ESP_LOG_DEBUG);
        esp_log_level_set(LOG_PROTOCOL, ESP_LOG_DEBUG);
        esp_log_level_set(LOG_TRANSPORT, ESP_LOG_DEBUG);
        esp_log_level_set(LOG_HID, ESP_LOG_DEBUG);
    #endif
    ESP_LOGI(LOG_APP, "Nintendo Switch Controller Emulator");
    ESP_LOGI(LOG_APP, "Starting initialization...");
    if (runtime_status_init() != 0) {
        ESP_LOGE(LOG_APP, "Failed to start runtime status task");
    }
    if (status_display_init() != 0) {
        ESP_LOGE(LOG_APP, "Failed to start optional status display");
    }

    // Initialize transport layer
    if (transport_init() == 0) {
        ESP_LOGI(LOG_APP, "Transport initialized successfully");
        if (transport_start() == 0) {
            ESP_LOGI(LOG_APP, "Transport protocol task started");
        } else {
            ESP_LOGE(LOG_APP, "Failed to start transport protocol task");
        }
    } else {
        ESP_LOGE(LOG_APP, "Failed to initialize transport, continuing without serial input");
    }

    if (rumble_feedback_init() != 0) {
        ESP_LOGE(LOG_APP, "Failed to start rumble feedback task");
    }

    // Determine controller type from NVS
    controller_type_init();

    // Initialize one independent HID state pipeline per BLE identity.
    for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
        controller_handle_t *controller = controller_hid_for_slot(slot);
        if (controller->ops->init(controller, g_controller_firmware.type) == 0) {
            ESP_LOGI(LOG_APP, "Controller slot %u initialized", slot);
        } else {
            ESP_LOGE(LOG_APP, "Failed to initialize controller slot %u", slot);
        }
    }

    // Initialize BLE stack
    ble_stack_init();
    ESP_LOGI(LOG_APP, "BLE stack initialized");

    // Keep the main task alive
    while (1) {
        runtime_status_update(device_status_get(0));
        vTaskDelay(pdMS_TO_TICKS(250));
    }
}
