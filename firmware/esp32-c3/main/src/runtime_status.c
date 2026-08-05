#include "runtime_status.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define STATUS_TASK_PRIORITY (tskIDLE_PRIORITY + 1)
#define STATUS_TASK_STACK_SIZE 3072
#define STATUS_PERIOD_MS 1000

static TaskHandle_t status_task_handle;
static int published_device_status;
static uint32_t published_input_tick;
static uint32_t published_buttons_hat;
static uint32_t published_sticks;
static bool published_have_input;
static uint8_t last_input_state[7];
static bool have_last_input_state;

static uint16_t ble_interval_units;
static uint16_t ble_queue_free;
static uint16_t ble_queue_ceiling;
static uint32_t ble_congestion_skips;
static uint32_t ble_pending_skips;
static uint32_t ble_notify_completions;
static uint32_t input_state_changes;
static uint32_t input_presses;
static uint32_t input_releases;
static uint32_t hid_enqueued;
static uint32_t hid_enqueue_changes;
static uint32_t hid_dequeued;
static uint32_t hid_dequeue_changes;
static uint32_t hid_drops;
static uint32_t hid_duplicates;
static uint32_t hid_queue_depth;
static uint32_t hid_queue_high_water;
static uint32_t hid_notify_failures;
static uint32_t hid_notify_recoveries;
static uint32_t ble_notifications;
static uint32_t ble_input_changes;

static uint8_t hid_enqueue_state[9];
static uint8_t hid_dequeue_state[9];
static uint8_t ble_notify_state[9];
static bool have_hid_enqueue_state;
static bool have_hid_dequeue_state;
static bool have_ble_notify_state;

static uint32_t load_u32(const uint32_t *value) {
    return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static uint16_t load_u16(const uint16_t *value) {
    return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static bool load_bool(const bool *value) {
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

static void diagnostic_line(const char *line, size_t length) {
    usb_serial_jtag_write_bytes(line, length, 0);
}

static bool report_input_state(const uint8_t *report, size_t report_size,
                               uint8_t output[9]) {
    if (report == NULL || report_size < 11) return false;
    memcpy(output, report + 2, 9);
    return true;
}

static bool note_report_change(const uint8_t *report, size_t report_size,
                               uint8_t previous[9], bool *have_previous) {
    uint8_t next[9];
    if (!report_input_state(report, report_size, next)) return false;
    bool changed = *have_previous && memcmp(previous, next, sizeof(next)) != 0;
    memcpy(previous, next, sizeof(next));
    *have_previous = true;
    return changed;
}

void runtime_status_get_snapshot(runtime_status_snapshot_t *snapshot) {
    if (snapshot == NULL) return;
    uint32_t input_tick = load_u32(&published_input_tick);
    uint32_t now_tick = (uint32_t)xTaskGetTickCount();
    uint32_t buttons_hat = load_u32(&published_buttons_hat);
    uint32_t sticks = load_u32(&published_sticks);

    snapshot->device_status = __atomic_load_n(&published_device_status, __ATOMIC_RELAXED);
    snapshot->have_input = load_bool(&published_have_input);
    snapshot->input_age_ms = (now_tick - input_tick) * portTICK_PERIOD_MS;
    snapshot->buttons = (uint16_t)buttons_hat;
    snapshot->hat = (uint8_t)(buttons_hat >> 16);
    snapshot->lx = (uint8_t)sticks;
    snapshot->ly = (uint8_t)(sticks >> 8);
    snapshot->rx = (uint8_t)(sticks >> 16);
    snapshot->ry = (uint8_t)(sticks >> 24);
    snapshot->ble_interval_units = load_u16(&ble_interval_units);
    snapshot->ble_queue_free = load_u16(&ble_queue_free);
    snapshot->ble_queue_ceiling = load_u16(&ble_queue_ceiling);
    snapshot->ble_congestion_skips = load_u32(&ble_congestion_skips);
    snapshot->ble_pending_skips = load_u32(&ble_pending_skips);
    snapshot->ble_notify_completions = load_u32(&ble_notify_completions);
    snapshot->input_state_changes = load_u32(&input_state_changes);
    snapshot->input_presses = load_u32(&input_presses);
    snapshot->input_releases = load_u32(&input_releases);
    snapshot->hid_enqueued = load_u32(&hid_enqueued);
    snapshot->hid_enqueue_changes = load_u32(&hid_enqueue_changes);
    snapshot->hid_dequeued = load_u32(&hid_dequeued);
    snapshot->hid_dequeue_changes = load_u32(&hid_dequeue_changes);
    snapshot->hid_drops = load_u32(&hid_drops);
    snapshot->hid_duplicates = load_u32(&hid_duplicates);
    snapshot->hid_queue_depth = load_u32(&hid_queue_depth);
    snapshot->hid_queue_high_water = load_u32(&hid_queue_high_water);
    snapshot->hid_notify_failures = load_u32(&hid_notify_failures);
    snapshot->hid_notify_recoveries = load_u32(&hid_notify_recoveries);
    snapshot->ble_notifications = load_u32(&ble_notifications);
    snapshot->ble_input_changes = load_u32(&ble_input_changes);
}

static void emit_diagnostics(void) {
    runtime_status_snapshot_t status;
    runtime_status_get_snapshot(&status);
    if (status.ble_interval_units == 0) return;

    char line[96];
    int length = snprintf(line, sizeof(line), "DC:%u\n", status.ble_interval_units);
    if (length > 0) diagnostic_line(line, (size_t)length);
    length = snprintf(line, sizeof(line), "DQ:%u:%u:%lu:%lu:%lu\n",
                      status.ble_queue_free, status.ble_queue_ceiling,
                      (unsigned long)status.ble_congestion_skips,
                      (unsigned long)status.ble_pending_skips,
                      (unsigned long)status.ble_notify_completions);
    if (length > 0) diagnostic_line(line, (size_t)length);
    length = snprintf(line, sizeof(line), "DX:%lu:%lu:%lu\n",
                      (unsigned long)status.input_state_changes,
                      (unsigned long)status.input_presses,
                      (unsigned long)status.input_releases);
    if (length > 0) diagnostic_line(line, (size_t)length);
    length = snprintf(line, sizeof(line), "DH:%lu:%lu:%lu:%lu:%lu\n",
                      (unsigned long)status.hid_enqueued,
                      (unsigned long)status.hid_enqueue_changes,
                      (unsigned long)status.hid_dequeued,
                      (unsigned long)status.hid_dequeue_changes,
                      (unsigned long)status.hid_drops);
    if (length > 0) diagnostic_line(line, (size_t)length);
    length = snprintf(line, sizeof(line), "DB:%lu:%lu\n",
                      (unsigned long)status.ble_notifications,
                      (unsigned long)status.ble_input_changes);
    if (length > 0) diagnostic_line(line, (size_t)length);
    length = snprintf(line, sizeof(line), "DR:%lu:%lu:%lu:%lu:%lu\n",
                      (unsigned long)status.hid_duplicates,
                      (unsigned long)status.hid_queue_depth,
                      (unsigned long)status.hid_queue_high_water,
                      (unsigned long)status.hid_notify_failures,
                      (unsigned long)status.hid_notify_recoveries);
    if (length > 0) diagnostic_line(line, (size_t)length);
}

static void status_task(void *argument) {
    (void)argument;
    TickType_t last_wake = xTaskGetTickCount();
    while (true) {
        emit_diagnostics();
        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(STATUS_PERIOD_MS));
    }
}

int runtime_status_init(void) {
    if (status_task_handle != NULL) return 0;
    BaseType_t result = xTaskCreate(status_task, "runtime_status",
                                    STATUS_TASK_STACK_SIZE, NULL,
                                    STATUS_TASK_PRIORITY, &status_task_handle);
    return result == pdPASS ? 0 : -1;
}

void runtime_status_note_input_state(uint16_t buttons, uint8_t hat,
                                     uint8_t lx, uint8_t ly,
                                     uint8_t rx, uint8_t ry) {
    __atomic_store_n(&published_input_tick, (uint32_t)xTaskGetTickCount(), __ATOMIC_RELAXED);
    __atomic_store_n(&published_buttons_hat,
                     (uint32_t)buttons | ((uint32_t)(hat & 0x0f) << 16),
                     __ATOMIC_RELAXED);
    __atomic_store_n(&published_sticks,
                     (uint32_t)lx | ((uint32_t)ly << 8) |
                     ((uint32_t)rx << 16) | ((uint32_t)ry << 24),
                     __ATOMIC_RELAXED);
    __atomic_store_n(&published_have_input, true, __ATOMIC_RELEASE);

    uint8_t next[] = {buttons >> 8, buttons, hat, lx, ly, rx, ry};
    if (!have_last_input_state || memcmp(last_input_state, next, sizeof(next)) != 0) {
        if (have_last_input_state) {
            uint16_t previous_buttons =
                ((uint16_t)last_input_state[0] << 8) | last_input_state[1];
            uint32_t presses = (uint32_t)__builtin_popcount(
                (unsigned int)(buttons & ~previous_buttons));
            uint32_t releases = (uint32_t)__builtin_popcount(
                (unsigned int)(previous_buttons & ~buttons));
            uint8_t previous_hat = last_input_state[2] & 0x0f;
            uint8_t next_hat = hat & 0x0f;
            if (previous_hat != next_hat) {
                if (previous_hat != 8) releases++;
                if (next_hat != 8) presses++;
            }
            __atomic_fetch_add(&input_state_changes, 1, __ATOMIC_RELAXED);
            __atomic_fetch_add(&input_presses, presses, __ATOMIC_RELAXED);
            __atomic_fetch_add(&input_releases, releases, __ATOMIC_RELAXED);
        }
        memcpy(last_input_state, next, sizeof(next));
        have_last_input_state = true;
        diagnostic_line("DI\n", 3);
    }
}

void runtime_status_set_ble_interval(uint16_t interval_units) {
    __atomic_store_n(&ble_interval_units, interval_units, __ATOMIC_RELAXED);
    char line[16];
    int length = snprintf(line, sizeof(line), "DC:%u\n", interval_units);
    if (length > 0) diagnostic_line(line, (size_t)length);
}

void runtime_status_set_ble_queue(uint16_t free_blocks, uint16_t ceiling,
                                  uint32_t congestion_skips,
                                  uint32_t pending_skips,
                                  uint32_t notify_completions) {
    __atomic_store_n(&ble_queue_free, free_blocks, __ATOMIC_RELAXED);
    __atomic_store_n(&ble_queue_ceiling, ceiling, __ATOMIC_RELAXED);
    __atomic_store_n(&ble_congestion_skips, congestion_skips, __ATOMIC_RELAXED);
    __atomic_store_n(&ble_pending_skips, pending_skips, __ATOMIC_RELAXED);
    __atomic_store_n(&ble_notify_completions, notify_completions, __ATOMIC_RELAXED);
}

void runtime_status_note_hid_enqueue(const uint8_t *report, size_t report_size,
                                     bool dropped) {
    if (dropped) {
        __atomic_fetch_add(&hid_drops, 1, __ATOMIC_RELAXED);
        return;
    }
    __atomic_fetch_add(&hid_enqueued, 1, __ATOMIC_RELAXED);
    if (note_report_change(report, report_size, hid_enqueue_state,
                           &have_hid_enqueue_state)) {
        __atomic_fetch_add(&hid_enqueue_changes, 1, __ATOMIC_RELAXED);
    }
}

void runtime_status_note_hid_dequeue(const uint8_t *report, size_t report_size) {
    __atomic_fetch_add(&hid_dequeued, 1, __ATOMIC_RELAXED);
    if (note_report_change(report, report_size, hid_dequeue_state,
                           &have_hid_dequeue_state)) {
        __atomic_fetch_add(&hid_dequeue_changes, 1, __ATOMIC_RELAXED);
    }
}

void runtime_status_note_ble_report(const uint8_t *report, size_t report_size) {
    __atomic_fetch_add(&ble_notifications, 1, __ATOMIC_RELAXED);
    if (note_report_change(report, report_size, ble_notify_state,
                           &have_ble_notify_state)) {
        __atomic_fetch_add(&ble_input_changes, 1, __ATOMIC_RELAXED);
    }
}

void runtime_status_note_hid_duplicate(void) {
    __atomic_fetch_add(&hid_duplicates, 1, __ATOMIC_RELAXED);
}

void runtime_status_set_hid_queue_depth(uint32_t depth) {
    __atomic_store_n(&hid_queue_depth, depth, __ATOMIC_RELAXED);
    uint32_t observed = load_u32(&hid_queue_high_water);
    while (depth > observed &&
           !__atomic_compare_exchange_n(&hid_queue_high_water, &observed, depth,
                                        true, __ATOMIC_RELAXED,
                                        __ATOMIC_RELAXED)) {
    }
}

void runtime_status_note_hid_notify_failure(void) {
    __atomic_fetch_add(&hid_notify_failures, 1, __ATOMIC_RELAXED);
}

void runtime_status_note_hid_notify_recovery(void) {
    __atomic_fetch_add(&hid_notify_recoveries, 1, __ATOMIC_RELAXED);
}

void runtime_status_update(int device_status) {
    __atomic_store_n(&published_device_status, device_status, __ATOMIC_RELAXED);
}
