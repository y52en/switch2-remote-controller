#include "rumble_feedback.h"

#include <stdbool.h>
#include <stdio.h>

#include "driver/usb_serial_jtag.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "controller/controller.h"

#define RUMBLE_SEND_INTERVAL_MS 20
#define RUMBLE_STOP_POLL_MS 10
#define RUMBLE_INPUT_TIMEOUT_MS 80

static portMUX_TYPE s_rumble_lock = portMUX_INITIALIZER_UNLOCKED;
static TaskHandle_t s_rumble_task;
typedef struct {
    uint16_t latest_strong;
    uint16_t latest_weak;
    uint16_t peak_strong;
    uint16_t peak_weak;
    TickType_t last_packet_tick;
    TickType_t last_send_tick;
    bool dirty;
    bool last_sent_active;
} rumble_state_t;

static rumble_state_t s_rumbles[CONTROLLER_SLOT_COUNT];
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

void rumble_feedback_note_packet(uint8_t slot, const uint8_t *packet,
                                 size_t length) {
    if (slot >= CONTROLLER_SLOT_COUNT || packet == NULL || length < 33) return;

    uint16_t strong = 0;
    uint16_t weak = 0;
    bool decoded = decode_motor(packet, length, 1, &strong, &weak);
    decoded = decode_motor(packet, length, 17, &strong, &weak) || decoded;
    if (!decoded) return;

    rumble_state_t *state = &s_rumbles[slot];
    portENTER_CRITICAL(&s_rumble_lock);
    state->latest_strong = strong;
    state->latest_weak = weak;
    state->peak_strong = max_u16(state->peak_strong, strong);
    state->peak_weak = max_u16(state->peak_weak, weak);
    state->last_packet_tick = xTaskGetTickCount();
    state->dirty = true;
    portEXIT_CRITICAL(&s_rumble_lock);

    if (s_rumble_task != NULL) xTaskNotifyGive(s_rumble_task);
}

static bool send_feedback(uint8_t slot, uint16_t strong, uint16_t weak) {
    if (!usb_serial_jtag_is_connected()) return false;
    char line[40];
    int length = snprintf(line, sizeof(line), "RV:%u:%lu:%u:%u\n",
                          slot, (unsigned long)s_sequence++, strong, weak);
    if (length <= 0 || length >= (int)sizeof(line)) return false;
    return usb_serial_jtag_write_bytes(line, (size_t)length, 0) == length;
}

static void rumble_feedback_task(void *argument) {
    (void)argument;

    while (true) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(RUMBLE_STOP_POLL_MS));
        TickType_t now = xTaskGetTickCount();
        for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
            rumble_state_t *state = &s_rumbles[slot];
            uint16_t strong = 0;
            uint16_t weak = 0;
            bool should_send = false;
            bool active_after_send = false;

            portENTER_CRITICAL(&s_rumble_lock);
            bool stale = state->last_packet_tick != 0 &&
                now - state->last_packet_tick >= pdMS_TO_TICKS(RUMBLE_INPUT_TIMEOUT_MS);
            bool latest_active = state->latest_strong != 0 || state->latest_weak != 0;

            if (stale) {
                state->latest_strong = 0;
                state->latest_weak = 0;
                state->peak_strong = 0;
                state->peak_weak = 0;
                state->dirty = false;
                if (state->last_sent_active) should_send = true;
            } else if (state->last_sent_active && !latest_active) {
                state->peak_strong = 0;
                state->peak_weak = 0;
                state->dirty = false;
                should_send = true;
            } else if (state->dirty &&
                       (state->peak_strong != 0 || state->peak_weak != 0) &&
                       now - state->last_send_tick >=
                           pdMS_TO_TICKS(RUMBLE_SEND_INTERVAL_MS)) {
                strong = state->peak_strong;
                weak = state->peak_weak;
                state->peak_strong = 0;
                state->peak_weak = 0;
                state->dirty = false;
                should_send = true;
                active_after_send = latest_active;
            } else if (state->dirty && !latest_active &&
                       state->peak_strong == 0 && state->peak_weak == 0) {
                state->dirty = false;
            }
            portEXIT_CRITICAL(&s_rumble_lock);

            if (!should_send) continue;
            if (send_feedback(slot, strong, weak)) {
                state->last_send_tick = now;
                state->last_sent_active = active_after_send;
                continue;
            }

            portENTER_CRITICAL(&s_rumble_lock);
            state->peak_strong = max_u16(state->peak_strong, strong);
            state->peak_weak = max_u16(state->peak_weak, weak);
            state->dirty = true;
            portEXIT_CRITICAL(&s_rumble_lock);
        }
    }
}

int rumble_feedback_init(void) {
    if (s_rumble_task != NULL) return 0;
    BaseType_t result = xTaskCreate(rumble_feedback_task, "rumble_feedback", 3072,
                                    NULL, 1, &s_rumble_task);
    return result == pdPASS ? 0 : -1;
}
