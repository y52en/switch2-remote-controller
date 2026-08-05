#ifndef RUNTIME_STATUS_H
#define RUNTIME_STATUS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    int device_status;
    bool have_input;
    uint32_t input_age_ms;
    uint16_t buttons;
    uint8_t hat;
    uint8_t lx;
    uint8_t ly;
    uint8_t rx;
    uint8_t ry;
    uint16_t ble_interval_units;
    uint16_t ble_queue_free;
    uint16_t ble_queue_ceiling;
    uint32_t ble_congestion_skips;
    uint32_t ble_pending_skips;
    uint32_t ble_notify_completions;
    uint32_t input_state_changes;
    uint32_t input_presses;
    uint32_t input_releases;
    uint32_t hid_enqueued;
    uint32_t hid_enqueue_changes;
    uint32_t hid_dequeued;
    uint32_t hid_dequeue_changes;
    uint32_t hid_drops;
    uint32_t hid_duplicates;
    uint32_t hid_queue_depth;
    uint32_t hid_queue_high_water;
    uint32_t hid_notify_failures;
    uint32_t hid_notify_recoveries;
    uint32_t ble_notifications;
    uint32_t ble_input_changes;
} runtime_status_snapshot_t;

int runtime_status_init(void);
void runtime_status_get_snapshot(runtime_status_snapshot_t *snapshot);
void runtime_status_note_input_state(uint16_t buttons, uint8_t hat,
                                     uint8_t lx, uint8_t ly,
                                     uint8_t rx, uint8_t ry);
void runtime_status_set_ble_interval(uint16_t interval_units);
void runtime_status_set_ble_queue(uint16_t free_blocks, uint16_t ceiling,
                                  uint32_t congestion_skips,
                                  uint32_t pending_skips,
                                  uint32_t notify_completions);
void runtime_status_note_hid_enqueue(const uint8_t *report, size_t report_size,
                                     bool dropped);
void runtime_status_note_hid_dequeue(const uint8_t *report, size_t report_size);
void runtime_status_note_ble_report(const uint8_t *report, size_t report_size);
void runtime_status_note_hid_duplicate(void);
void runtime_status_set_hid_queue_depth(uint32_t depth);
void runtime_status_note_hid_notify_failure(void);
void runtime_status_note_hid_notify_recovery(void);
void runtime_status_update(int device_status);

#endif
