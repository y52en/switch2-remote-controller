#include "rumble_feedback.h"

#include <stdbool.h>
#include <stdio.h>

#include "driver/usb_serial_jtag.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define RUMBLE_SEND_INTERVAL_MS 20
#define RUMBLE_STOP_POLL_MS 10
#define RUMBLE_INPUT_TIMEOUT_MS 80

static portMUX_TYPE s_rumble_lock = portMUX_INITIALIZER_UNLOCKED;
static TaskHandle_t s_rumble_task;
static uint16_t s_latest_strong;
static uint16_t s_latest_weak;
static uint16_t s_peak_strong;
static uint16_t s_peak_weak;
static TickType_t s_last_packet_tick;
static bool s_dirty;
static uint32_t s_sequence;

static uint16_t max_u16(uint16_t left, uint16_t right) {
    return left > right ? left : right;
}

static bool decode_motor(const uint8_t *packet, size_t length, size_t block_offset,
                         uint16_t *strong, uint16_t *weak) {
    if (block_offset >= length || (packet[block_offset] & 0xf0U) != 0x50U) return false;

    bool decoded = false;
    for (size_t sample = 0; sample < 3; sample++) {
        size_t offset = block_offset + 1 + sample * 5;
        if (offset + 5 > length) break;
        uint64_t packed = 0;
        for (size_t index = 0; index < 5; index++) {
            packed |= ((uint64_t)packet[offset + index]) << (index * 8);
        }
        *strong = max_u16(*strong, (uint16_t)((packed >> 10) & 0x3ffU));
        *weak = max_u16(*weak, (uint16_t)((packed >> 30) & 0x3ffU));
        decoded = true;
    }
    return decoded;
}

void rumble_feedback_note_packet(const uint8_t *packet, size_t length) {
    if (packet == NULL || length < 33) return;

    uint16_t strong = 0;
    uint16_t weak = 0;
    bool decoded = decode_motor(packet, length, 1, &strong, &weak);
    decoded = decode_motor(packet, length, 17, &strong, &weak) || decoded;
    if (!decoded) return;

    portENTER_CRITICAL(&s_rumble_lock);
    s_latest_strong = strong;
    s_latest_weak = weak;
    s_peak_strong = max_u16(s_peak_strong, strong);
    s_peak_weak = max_u16(s_peak_weak, weak);
    s_last_packet_tick = xTaskGetTickCount();
    s_dirty = true;
    portEXIT_CRITICAL(&s_rumble_lock);

    if (s_rumble_task != NULL) xTaskNotifyGive(s_rumble_task);
}

static bool send_feedback(uint16_t strong, uint16_t weak) {
    if (!usb_serial_jtag_is_connected()) return false;
    char line[40];
    int length = snprintf(line, sizeof(line), "RV:%lu:%u:%u\n",
                          (unsigned long)s_sequence++, strong, weak);
    if (length <= 0 || length >= (int)sizeof(line)) return false;
    return usb_serial_jtag_write_bytes(line, (size_t)length, 0) == length;
}

static void rumble_feedback_task(void *argument) {
    (void)argument;
    TickType_t last_send_tick = 0;
    bool last_sent_active = false;

    while (true) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(RUMBLE_STOP_POLL_MS));
        TickType_t now = xTaskGetTickCount();
        uint16_t strong = 0;
        uint16_t weak = 0;
        bool should_send = false;
        bool active_after_send = false;

        portENTER_CRITICAL(&s_rumble_lock);
        bool stale = s_last_packet_tick != 0 &&
            now - s_last_packet_tick >= pdMS_TO_TICKS(RUMBLE_INPUT_TIMEOUT_MS);
        bool latest_active = s_latest_strong != 0 || s_latest_weak != 0;

        if (stale) {
            s_latest_strong = 0;
            s_latest_weak = 0;
            s_peak_strong = 0;
            s_peak_weak = 0;
            s_dirty = false;
            if (last_sent_active) should_send = true;
        } else if (last_sent_active && !latest_active) {
            s_peak_strong = 0;
            s_peak_weak = 0;
            s_dirty = false;
            should_send = true;
        } else if (s_dirty && (s_peak_strong != 0 || s_peak_weak != 0) &&
                   now - last_send_tick >= pdMS_TO_TICKS(RUMBLE_SEND_INTERVAL_MS)) {
            strong = s_peak_strong;
            weak = s_peak_weak;
            s_peak_strong = 0;
            s_peak_weak = 0;
            s_dirty = false;
            should_send = true;
            // A very short impulse may already have ended. Its bounded browser
            // effect can finish naturally without a back-to-back stop frame.
            active_after_send = latest_active;
        } else if (s_dirty && !latest_active && s_peak_strong == 0 && s_peak_weak == 0) {
            s_dirty = false;
        }
        portEXIT_CRITICAL(&s_rumble_lock);

        if (!should_send) continue;
        if (send_feedback(strong, weak)) {
            last_send_tick = now;
            last_sent_active = active_after_send;
            continue;
        }

        // TX is non-blocking. Preserve only the newest/strongest state for a
        // later retry instead of ever waiting behind a full USB buffer.
        portENTER_CRITICAL(&s_rumble_lock);
        s_peak_strong = max_u16(s_peak_strong, strong);
        s_peak_weak = max_u16(s_peak_weak, weak);
        s_dirty = true;
        portEXIT_CRITICAL(&s_rumble_lock);
    }
}

int rumble_feedback_init(void) {
    if (s_rumble_task != NULL) return 0;
    BaseType_t result = xTaskCreate(rumble_feedback_task, "rumble_feedback", 3072,
                                    NULL, 1, &s_rumble_task);
    return result == pdPASS ? 0 : -1;
}
