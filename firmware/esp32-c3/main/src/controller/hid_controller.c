#include "controller/hid_controller.h"
#include "controller/hid_controller_pro2.h"
#include "device.h"
#include "runtime_status.h"
#include "utils.h"

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "freertos/queue.h"

#define HID_STATE_QUEUE_CAPACITY 32
#define HID_STATE_MAX_REPORT_SIZE 64

typedef struct {
    uint8_t report[HID_STATE_MAX_REPORT_SIZE];
} hid_state_snapshot_t;

typedef struct {
    bool hid_notify_pending;
    bool hid_report_dirty;
    uint16_t msys_free_ceiling;
    uint32_t hid_congestion_skips;
    uint32_t hid_pending_skips;
    uint32_t hid_notify_completions;
    TickType_t last_hid_send_tick;
    TickType_t hid_notify_started_tick;
    uint16_t hid_notify_free_before;
    TickType_t hid_congestion_started_tick;
    TickType_t hid_delivery_stall_started_tick;
    uint32_t hid_notify_buttons;
    bool hid_notify_buttons_valid;
    uint32_t hid_completed_buttons;
    bool hid_completed_buttons_valid;
    TickType_t hid_button_pressed_tick[24];
    uint32_t hid_pressed_tick_valid;
    TickType_t hid_last_host_input_tick;
    bool hid_host_input_seen;
    bool hid_host_input_timed_out;
    QueueHandle_t hid_state_queue;
    uint32_t hid_state_queue_drops;
    hid_state_snapshot_t hid_last_queued_state;
    size_t hid_last_queued_size;
    bool hid_last_queued_valid;
} hid_runtime_t;

#define CONTROLLER_HANDLE_INIT(SLOT) { \
    .ops = &controller_ops, .hid_ops = NULL, \
    .type = CONTROLLER_TYPE_PRO2, \
    .buffer = { .front_buffer = NULL, .back_buffer = NULL, .swap_request = 0 }, \
    .task_handle = NULL, .ns2_notification_handle = NS2_NOTIFICATION_HANDLE, \
    .conn_handle = BLE_HS_CONN_HANDLE_NONE, .slot = (SLOT), \
    .notify_enabled = false, .runtime = NULL \
}

controller_handle_t g_hid_controllers[CONTROLLER_SLOT_COUNT] = {
    CONTROLLER_HANDLE_INIT(0),
    CONTROLLER_HANDLE_INIT(1),
    CONTROLLER_HANDLE_INIT(2),
};

controller_handle_t *controller_hid_for_slot(uint8_t slot) {
    return slot < CONTROLLER_SLOT_COUNT ? &g_hid_controllers[slot] : NULL;
}

controller_handle_t *controller_hid_for_conn(uint16_t conn_handle) {
    if (conn_handle == BLE_HS_CONN_HANDLE_NONE) return NULL;
    for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
        if (g_hid_controllers[slot].conn_handle == conn_handle) {
            return &g_hid_controllers[slot];
        }
    }
    return NULL;
}

#define s_hid_notify_pending (rt->hid_notify_pending)
#define s_hid_report_dirty (rt->hid_report_dirty)
#define s_msys_free_ceiling (rt->msys_free_ceiling)
#define s_hid_congestion_skips (rt->hid_congestion_skips)
#define s_hid_pending_skips (rt->hid_pending_skips)
#define s_hid_notify_completions (rt->hid_notify_completions)
#define s_last_hid_send_tick (rt->last_hid_send_tick)
#define s_hid_notify_started_tick (rt->hid_notify_started_tick)
#define s_hid_notify_free_before (rt->hid_notify_free_before)
#define s_hid_congestion_started_tick (rt->hid_congestion_started_tick)
#define s_hid_delivery_stall_started_tick (rt->hid_delivery_stall_started_tick)
#define s_hid_notify_buttons (rt->hid_notify_buttons)
#define s_hid_notify_buttons_valid (rt->hid_notify_buttons_valid)
#define s_hid_completed_buttons (rt->hid_completed_buttons)
#define s_hid_completed_buttons_valid (rt->hid_completed_buttons_valid)
#define s_hid_button_pressed_tick (rt->hid_button_pressed_tick)
#define s_hid_pressed_tick_valid (rt->hid_pressed_tick_valid)
#define s_hid_last_host_input_tick (rt->hid_last_host_input_tick)
#define s_hid_host_input_seen (rt->hid_host_input_seen)
#define s_hid_host_input_timed_out (rt->hid_host_input_timed_out)
#define s_hid_state_queue (rt->hid_state_queue)
#define s_hid_state_queue_drops (rt->hid_state_queue_drops)
#define s_hid_last_queued_state (rt->hid_last_queued_state)
#define s_hid_last_queued_size (rt->hid_last_queued_size)
#define s_hid_last_queued_valid (rt->hid_last_queued_valid)

#define HID_KEEPALIVE_INTERVAL_MS 50
#define HID_NOTIFY_RECOVERY_MS 50
#define HID_NOTIFY_FORCE_RECOVERY_MS 250
#define HID_INPUT_STATE_OFFSET 2
#define HID_INPUT_STATE_SIZE 9
#define HID_BUTTON_STATE_SIZE 3
#define HID_MIN_DIGITAL_HOLD_MS 40
#define HID_HOST_INPUT_WATCHDOG_MS 1200
#define HID_DELIVERY_STALL_WATCHDOG_MS 500

static bool hid_input_state_equal(const uint8_t *left, const uint8_t *right,
                                  size_t report_size) {
    if (report_size >= HID_INPUT_STATE_OFFSET + HID_INPUT_STATE_SIZE) {
        return memcmp(left + HID_INPUT_STATE_OFFSET,
                      right + HID_INPUT_STATE_OFFSET,
                      HID_INPUT_STATE_SIZE) == 0;
    }
    return memcmp(left, right, report_size) == 0;
}

static uint32_t hid_report_buttons(const uint8_t *report, size_t report_size) {
    if (report == NULL ||
        report_size < HID_INPUT_STATE_OFFSET + HID_BUTTON_STATE_SIZE) {
        return 0;
    }
    return (uint32_t)report[HID_INPUT_STATE_OFFSET] |
           ((uint32_t)report[HID_INPUT_STATE_OFFSET + 1] << 8) |
           ((uint32_t)report[HID_INPUT_STATE_OFFSET + 2] << 16);
}

static void hid_report_set_buttons(uint8_t *report, size_t report_size,
                                   uint32_t buttons) {
    if (report == NULL ||
        report_size < HID_INPUT_STATE_OFFSET + HID_BUTTON_STATE_SIZE) {
        return;
    }
    report[HID_INPUT_STATE_OFFSET] = (uint8_t)buttons;
    report[HID_INPUT_STATE_OFFSET + 1] = (uint8_t)(buttons >> 8);
    report[HID_INPUT_STATE_OFFSET + 2] = (uint8_t)(buttons >> 16);
}

static void hid_reset_delivery_timing(hid_runtime_t *rt) {
    s_hid_congestion_started_tick = 0;
    s_hid_delivery_stall_started_tick = 0;
    s_hid_notify_buttons = 0;
    s_hid_notify_buttons_valid = false;
    s_hid_completed_buttons = 0;
    s_hid_completed_buttons_valid = false;
    memset(s_hid_button_pressed_tick, 0, sizeof(s_hid_button_pressed_tick));
    s_hid_pressed_tick_valid = 0;
}

static void hid_note_completed_buttons(hid_runtime_t *rt, TickType_t now) {
    if (!s_hid_notify_buttons_valid) return;
    uint32_t previous = s_hid_completed_buttons_valid
        ? s_hid_completed_buttons : 0;
    uint32_t pressed = s_hid_notify_buttons & ~previous;
    uint32_t released = previous & ~s_hid_notify_buttons;
    for (uint32_t bit = 0; bit < 24; bit++) {
        uint32_t mask = 1U << bit;
        if (pressed & mask) s_hid_button_pressed_tick[bit] = now;
    }
    s_hid_pressed_tick_valid =
        (s_hid_pressed_tick_valid | pressed) & ~released;
    s_hid_completed_buttons = s_hid_notify_buttons;
    s_hid_completed_buttons_valid = true;
}

static uint32_t hid_held_release_mask(hid_runtime_t *rt,
                                      uint32_t current_buttons,
                                      uint32_t next_buttons,
                                      TickType_t now) {
    uint32_t releases = current_buttons & ~next_buttons;
    uint32_t held = 0;
    TickType_t minimum = pdMS_TO_TICKS(HID_MIN_DIGITAL_HOLD_MS);
    for (uint32_t bit = 0; bit < 24; bit++) {
        uint32_t mask = 1U << bit;
        if ((releases & mask) != 0 &&
            (s_hid_pressed_tick_valid & mask) != 0 &&
            now - s_hid_button_pressed_tick[bit] < minimum) {
            held |= mask;
        }
    }
    return held;
}

static void hid_force_neutral(controller_handle_t *ctrl) {
    if (ctrl == NULL || ctrl->hid_ops == NULL ||
        ctrl->hid_ops->report_init == NULL ||
        ctrl->buffer.front_buffer == NULL ||
        ctrl->buffer.front_buffer->report == NULL) {
        return;
    }
    hid_runtime_t *rt = (hid_runtime_t *)ctrl->runtime;
    if (rt == NULL) return;
    uint8_t counter = ((uint8_t *)ctrl->buffer.front_buffer->report)[0];
    ctrl->hid_ops->report_init(ctrl->buffer.front_buffer);
    ((uint8_t *)ctrl->buffer.front_buffer->report)[0] = counter;
    if (s_hid_state_queue != NULL) {
        xQueueReset(s_hid_state_queue);
        runtime_status_set_hid_queue_depth(0);
    }
    s_hid_last_queued_size = 0;
    s_hid_last_queued_valid = false;
    hid_reset_delivery_timing(rt);
    __atomic_store_n(&s_hid_report_dirty, true, __ATOMIC_RELEASE);
}

void controller_hid_notify_complete(uint16_t conn_handle, uint16_t attr_handle,
                                    int status) {
    controller_handle_t *ctrl = controller_hid_for_conn(conn_handle);
    if (ctrl == NULL || ctrl->runtime == NULL) return;
    hid_runtime_t *rt = (hid_runtime_t *)ctrl->runtime;
    if (attr_handle == ctrl->ns2_notification_handle) {
        s_hid_notify_completions++;
        s_hid_delivery_stall_started_tick = 0;
        if (status != 0) {
            __atomic_store_n(&s_hid_report_dirty, true, __ATOMIC_RELEASE);
            runtime_status_note_hid_notify_failure();
        } else {
            hid_note_completed_buttons(rt, xTaskGetTickCount());
        }
        s_hid_notify_buttons_valid = false;
        __atomic_store_n(&s_hid_notify_pending, false, __ATOMIC_RELEASE);
    }
}

void controller_hid_notify_reset(controller_handle_t *ctrl) {
    if (ctrl == NULL || ctrl->runtime == NULL) return;
    hid_runtime_t *rt = (hid_runtime_t *)ctrl->runtime;
    __atomic_store_n(&s_hid_notify_pending, false, __ATOMIC_RELEASE);
    __atomic_store_n(&s_hid_report_dirty, true, __ATOMIC_RELEASE);
    s_msys_free_ceiling = 0;
    s_hid_congestion_skips = 0;
    s_last_hid_send_tick = 0;
    s_hid_notify_started_tick = 0;
    s_hid_notify_free_before = 0;
    hid_reset_delivery_timing(rt);
}

// HID report send task
static void controller_task(void *arg) {
    controller_handle_t *ctrl = (controller_handle_t *)arg;
    hid_runtime_t *rt = (hid_runtime_t *)ctrl->runtime;
    if (rt == NULL) {
        ctrl->task_handle = NULL;
        vTaskDelete(NULL);
        return;
    }
    TickType_t xLastWakeTime = xTaskGetTickCount();
    const TickType_t xInterval = pdMS_TO_TICKS(HID_REPORT_INTERVAL);

    ESP_LOGI(LOG_HID, "controller report task start, interval: %dms", HID_REPORT_INTERVAL);

    while (1) {
        // check if notification is enabled
        if (!ctrl->notify_enabled ||
            ctrl->conn_handle == BLE_HS_CONN_HANDLE_NONE) {
            ESP_LOGD(LOG_HID, "notification not enabled or no connection, skipping report send");
            xLastWakeTime = xTaskGetTickCount();
            vTaskDelay(pdMS_TO_TICKS(100));  // waiting for enable
            continue;
        }

        if (device_status_get(ctrl->slot) != DEV_READY) {
            ESP_LOGD(LOG_HID, "slot %u not ready, current status: %d",
                     ctrl->slot, device_status_get(ctrl->slot));
            xLastWakeTime = xTaskGetTickCount();
            vTaskDelay(pdMS_TO_TICKS(100));  // waiting for device ready
            continue;
        }

        if (ctrl->buffer.front_buffer != NULL) {
            if (ctrl->hid_ops == NULL || ctrl->hid_ops->next_report == NULL || ctrl->hid_ops->report_size == NULL) {
                ESP_LOGE(LOG_HID, "No valid hid device operations for type %d", ctrl->type);
                continue;
            }

            TickType_t now = xTaskGetTickCount();
            uint16_t free_blocks = (uint16_t)os_msys_num_free();
            if (free_blocks > s_msys_free_ceiling) s_msys_free_ceiling = free_blocks;
            runtime_status_set_ble_queue(free_blocks, s_msys_free_ceiling,
                                         s_hid_congestion_skips, s_hid_pending_skips,
                                         s_hid_notify_completions);

            if (s_hid_delivery_stall_started_tick != 0 &&
                now - s_hid_delivery_stall_started_tick >=
                    pdMS_TO_TICKS(HID_DELIVERY_STALL_WATCHDOG_MS)) {
                ESP_LOGW(LOG_HID,
                         "HID delivery stalled, forcing neutral report");
                __atomic_store_n(&s_hid_notify_pending, false,
                                 __ATOMIC_RELEASE);
                s_hid_notify_buttons_valid = false;
                hid_force_neutral(ctrl);
                runtime_status_note_hid_notify_recovery();
                s_msys_free_ceiling = free_blocks;
            }

            // Do not replace the front report until the preceding notify has
            // completed. This lets a failed notification retry the exact same
            // press or release instead of silently advancing to the next one.
            if (__atomic_load_n(&s_hid_notify_pending, __ATOMIC_ACQUIRE)) {
                TickType_t pending_age = now - s_hid_notify_started_tick;
                bool mbuf_released = s_hid_notify_free_before == 0 ||
                    free_blocks >= s_hid_notify_free_before;
                bool recover = (pending_age >= pdMS_TO_TICKS(HID_NOTIFY_RECOVERY_MS) &&
                                mbuf_released) ||
                    pending_age >= pdMS_TO_TICKS(HID_NOTIFY_FORCE_RECOVERY_MS);
                if (recover) {
                    bool expected = true;
                    if (__atomic_compare_exchange_n(&s_hid_notify_pending, &expected,
                                                    false, false,
                                                    __ATOMIC_ACQ_REL,
                                                    __ATOMIC_ACQUIRE)) {
                        __atomic_store_n(&s_hid_report_dirty, true, __ATOMIC_RELEASE);
                        runtime_status_note_hid_notify_recovery();
                    }
                } else {
                    if (pending_age >= pdMS_TO_TICKS(HID_NOTIFY_RECOVERY_MS)) {
                        s_hid_pending_skips++;
                    }
                    vTaskDelayUntil(&xLastWakeTime, xInterval);
                    continue;
                }
            }

            bool host_input_seen = __atomic_load_n(
                &s_hid_host_input_seen, __ATOMIC_ACQUIRE);
            TickType_t host_input_tick = __atomic_load_n(
                &s_hid_last_host_input_tick, __ATOMIC_ACQUIRE);
            bool host_input_timed_out = __atomic_load_n(
                &s_hid_host_input_timed_out, __ATOMIC_ACQUIRE);
            if (host_input_seen && !host_input_timed_out &&
                now - host_input_tick >=
                    pdMS_TO_TICKS(HID_HOST_INPUT_WATCHDOG_MS)) {
                // Recheck after observing the timeout so an input arriving at
                // the boundary cannot be erased by the safety reset.
                TickType_t latest_input_tick = __atomic_load_n(
                    &s_hid_last_host_input_tick, __ATOMIC_ACQUIRE);
                if (latest_input_tick == host_input_tick) {
                    ESP_LOGW(LOG_HID,
                             "host input watchdog expired, forcing neutral");
                    hid_force_neutral(ctrl);
                    __atomic_store_n(&s_hid_host_input_timed_out, true,
                                     __ATOMIC_RELEASE);
                    s_msys_free_ceiling = free_blocks;
                }
            }

            // Send every distinct committed state in order. In particular,
            // do not let a release overwrite a press that has not completed.
            if (!__atomic_load_n(&s_hid_report_dirty, __ATOMIC_ACQUIRE) &&
                s_hid_state_queue != NULL) {
                hid_state_snapshot_t snapshot;
                if (xQueuePeek(s_hid_state_queue, &snapshot, 0) == pdTRUE) {
                    size_t report_size = ctrl->hid_ops->report_size();
                    uint8_t *front =
                        (uint8_t *)ctrl->buffer.front_buffer->report;
                    uint32_t current_buttons =
                        hid_report_buttons(front, report_size);
                    uint32_t next_buttons =
                        hid_report_buttons(snapshot.report, report_size);
                    uint32_t held_releases = hid_held_release_mask(
                        rt, current_buttons, next_buttons, now);

                    if (held_releases != 0) {
                        // Apply new presses and analog values immediately, but
                        // keep only the too-young releases asserted. Leave the
                        // original snapshot at the queue front for its deadline.
                        hid_state_snapshot_t effective = snapshot;
                        hid_report_set_buttons(effective.report, report_size,
                                               next_buttons | held_releases);
                        if (!hid_input_state_equal(front, effective.report,
                                                   report_size)) {
                            uint8_t report_counter = front[0];
                            memcpy(front, effective.report, report_size);
                            front[0] = report_counter;
                            __atomic_store_n(&s_hid_report_dirty, true,
                                             __ATOMIC_RELEASE);
                        }
                    } else if (xQueueReceive(s_hid_state_queue, &snapshot, 0) ==
                               pdTRUE) {
                        runtime_status_note_hid_dequeue(ctrl->slot, snapshot.report,
                                                       report_size);
                        runtime_status_set_hid_queue_depth(
                            (uint32_t)uxQueueMessagesWaiting(
                                s_hid_state_queue));
                        uint8_t report_counter = front[0];
                        memcpy(front, snapshot.report, report_size);
                        front[0] = report_counter;
                        __atomic_store_n(&s_hid_report_dirty, true,
                                         __ATOMIC_RELEASE);
                    }
                }
            }

            // Backward-compatible fallback for controller types which cannot
            // use the fixed-size state queue.
            if (!__atomic_load_n(&s_hid_report_dirty, __ATOMIC_ACQUIRE) &&
                ctrl->buffer.swap_request) {
                // Ensure the latest values of swap_request and the contents of back_buffer are read.
                MEMORY_BARRIER();

                // Atomically swap front and back buffer pointers
                controller_hid_report_t* temp = ctrl->buffer.front_buffer;
                ctrl->buffer.front_buffer = ctrl->buffer.back_buffer;
                ctrl->buffer.back_buffer = temp;

                // Ensure the pointer swap operation completes before clearing the swap_request.
                MEMORY_BARRIER();

                // Clear swap request
                ctrl->buffer.swap_request = 0;
                __atomic_store_n(&s_hid_report_dirty, true, __ATOMIC_RELEASE);
            }

            bool keepalive_due = s_last_hid_send_tick == 0 ||
                now - s_last_hid_send_tick >= pdMS_TO_TICKS(HID_KEEPALIVE_INTERVAL_MS);
            if (!__atomic_load_n(&s_hid_report_dirty, __ATOMIC_ACQUIRE) &&
                !keepalive_due) {
                vTaskDelayUntil(&xLastWakeTime, xInterval);
                continue;
            }

            // Preserve the existing one-report mbuf backpressure. Recovery of
            // a missing completion is handled above without allowing stale
            // reports to accumulate in the controller queue.
            if (s_msys_free_ceiling != 0 && free_blocks < s_msys_free_ceiling) {
                s_hid_congestion_skips++;
                if (s_hid_congestion_started_tick == 0) {
                    s_hid_congestion_started_tick = now;
                }
                if (now - s_hid_congestion_started_tick <
                    pdMS_TO_TICKS(HID_NOTIFY_RECOVERY_MS)) {
                    vTaskDelayUntil(&xLastWakeTime, xInterval);
                    continue;
                }
                // A historical high-water mark must not block a release
                // forever if another BLE user permanently owns an mbuf.
                s_msys_free_ceiling = free_blocks;
                s_hid_congestion_started_tick = 0;
            } else {
                s_hid_congestion_started_tick = 0;
            }

            if (__atomic_exchange_n(&s_hid_notify_pending, true, __ATOMIC_ACQ_REL)) {
                vTaskDelayUntil(&xLastWakeTime, xInterval);
                continue;
            }
            s_hid_notify_started_tick = now;
            s_hid_notify_free_before = free_blocks;

            // Get report size for this device type
            size_t report_size = ctrl->hid_ops->report_size();

            // Use local buffer to avoid race condition with buffer swap
            // Copy data before potential buffer swap to ensure data integrity
            uint8_t report_buffer[report_size];
            uint8_t* next_report = ctrl->hid_ops->next_report(ctrl->buffer.front_buffer);
            memcpy(report_buffer, next_report, report_size);
            s_hid_notify_buttons = hid_report_buttons(report_buffer,
                                                      report_size);
            s_hid_notify_buttons_valid = true;
            if (s_hid_delivery_stall_started_tick == 0) {
                s_hid_delivery_stall_started_tick = now;
            }

            // Send report from local buffer - safe even if buffer swap occurs
            // Mark clean before the call so a synchronous failure callback can
            // make it dirty again without being overwritten on return.
            __atomic_store_n(&s_hid_report_dirty, false, __ATOMIC_RELEASE);
            int rc = gatt_notify(ctrl->conn_handle, ctrl->ns2_notification_handle,
                                    report_buffer, report_size);
            if (rc != 0) {
                s_hid_notify_buttons_valid = false;
                __atomic_store_n(&s_hid_notify_pending, false, __ATOMIC_RELEASE);
                __atomic_store_n(&s_hid_report_dirty, true, __ATOMIC_RELEASE);
                runtime_status_note_hid_notify_failure();
                if (rc == BLE_HS_ENOMEM) s_hid_congestion_skips++;
                ESP_LOGE(LOG_HID, "controller report send failed, rc: %d", rc);
                xLastWakeTime = xTaskGetTickCount();
            } else {
                runtime_status_note_ble_report(ctrl->slot, report_buffer,
                                               report_size);
                s_last_hid_send_tick = now;
            }

            if (rc == BLE_HS_ENOTCONN) {
                // yield briefly to let mbufs free up
                vTaskDelay(1);
            }
        }

        // precise interval
        vTaskDelayUntil(&xLastWakeTime, xInterval);
    }
}

static int controller_init_impl(controller_handle_t *ctrl, controller_type_t type) {
    if (ctrl == NULL) {
        return -1;
    }

    // Clean up any existing state first
    if (ctrl->ops != NULL && ctrl->ops->deinit != NULL) {
        ctrl->ops->deinit(ctrl);
    }

    // TODO JoyCon support
    ctrl->hid_ops = type == CONTROLLER_TYPE_PRO2 ? &controller_pro2_ops : NULL;
    if (ctrl->hid_ops == NULL) {
        ESP_LOGE(LOG_HID, "No valid hid device operations for type %d", type);
        return -1;
    }
    ctrl->type = type;

    ctrl->runtime = calloc(1, sizeof(hid_runtime_t));
    if (ctrl->runtime == NULL) {
        ESP_LOGE(LOG_HID, "allocate HID runtime failed for slot %u", ctrl->slot);
        return -1;
    }
    hid_runtime_t *rt = (hid_runtime_t *)ctrl->runtime;
    s_hid_report_dirty = true;

    // Allocate double buffer memory
    ctrl->buffer.front_buffer = (controller_hid_report_t*)malloc(sizeof(controller_hid_report_t));
    ctrl->buffer.back_buffer = (controller_hid_report_t*)malloc(sizeof(controller_hid_report_t));
    ctrl->buffer.swap_request = 0;

    if (ctrl->buffer.front_buffer == NULL || ctrl->buffer.back_buffer == NULL) {
        ESP_LOGE(LOG_HID, "malloc controller report double buffer memory failed");
        goto error;
    }

    memset(ctrl->buffer.front_buffer, 0, sizeof(controller_hid_report_t));
    memset(ctrl->buffer.back_buffer, 0, sizeof(controller_hid_report_t));

    ctrl->hid_ops->report_init(ctrl->buffer.front_buffer);
    ctrl->hid_ops->report_init(ctrl->buffer.back_buffer);

    if (ctrl->buffer.front_buffer->report == NULL || ctrl->buffer.back_buffer->report == NULL) {
        ESP_LOGE(LOG_HID, "controller report init failed");
        goto error;
    }

    if (ctrl->hid_ops->report_size() <= HID_STATE_MAX_REPORT_SIZE) {
        if (s_hid_state_queue == NULL) {
            s_hid_state_queue = xQueueCreate(HID_STATE_QUEUE_CAPACITY, sizeof(hid_state_snapshot_t));
        } else {
            xQueueReset(s_hid_state_queue);
        }
        if (s_hid_state_queue == NULL) {
            ESP_LOGE(LOG_HID, "create HID state queue failed");
            goto error;
        }
        s_hid_state_queue_drops = 0;
        s_hid_last_queued_size = 0;
        s_hid_last_queued_valid = false;
        runtime_status_set_hid_queue_depth(0);
    }

    return 0;

error:
    if (ctrl->ops != NULL && ctrl->ops->deinit != NULL) {
        ctrl->ops->deinit(ctrl);
    }
    return -1;
}

static void controller_deinit_impl(controller_handle_t *ctrl) {
    if (ctrl == NULL) {
        return;
    }

    if (ctrl->ops != NULL && ctrl->ops->stop_task != NULL) {
        ctrl->ops->stop_task(ctrl);
    }

    if (ctrl->buffer.front_buffer != NULL) {
        if (ctrl->buffer.front_buffer->report != NULL) {
            free(ctrl->buffer.front_buffer->report);
        }
        free(ctrl->buffer.front_buffer);
        ctrl->buffer.front_buffer = NULL;
    }
    if (ctrl->buffer.back_buffer != NULL) {
        if (ctrl->buffer.back_buffer->report != NULL) {
            free(ctrl->buffer.back_buffer->report);
        }
        free(ctrl->buffer.back_buffer);
        ctrl->buffer.back_buffer = NULL;
    }

    ctrl->buffer.swap_request = 0;
    ctrl->hid_ops = NULL;
    if (ctrl->runtime != NULL) {
        hid_runtime_t *rt = (hid_runtime_t *)ctrl->runtime;
        if (s_hid_state_queue != NULL) {
            vQueueDelete(s_hid_state_queue);
            s_hid_state_queue = NULL;
        }
        free(ctrl->runtime);
        ctrl->runtime = NULL;
    }
}

static int controller_start_task_impl(controller_handle_t *ctrl) {
    if (ctrl == NULL) {
        return -1;
    }

    if (ctrl->task_handle != NULL) {
        ESP_LOGW(LOG_HID, "controller report task already started");
        return 0;
    }

    if (ctrl->buffer.front_buffer == NULL || ctrl->buffer.back_buffer == NULL ||
        ctrl->buffer.front_buffer->report == NULL ||
        ctrl->buffer.back_buffer->report == NULL) {
        ESP_LOGE(LOG_HID, "controller not initialized");
        return -1;
    }
    controller_hid_notify_reset(ctrl);
    char task_name[16];
    snprintf(task_name, sizeof(task_name), "controller_%u", ctrl->slot);
    BaseType_t rc = xTaskCreate(controller_task, task_name, 4096, ctrl, 4, &ctrl->task_handle);
    if (rc != pdPASS) {
        ESP_LOGE(LOG_HID, "create controller report task failed, rc: %d", rc);
        return -1;
    }
    return 0;
}

static void controller_stop_task_impl(controller_handle_t *ctrl) {
    if (ctrl == NULL) {
        return;
    }

    if (ctrl->task_handle != NULL) {
        vTaskDelete(ctrl->task_handle);
        ctrl->task_handle = NULL;
    }
    controller_hid_notify_reset(ctrl);
}

static controller_hid_report_t* controller_get_back_buffer_impl(controller_handle_t *ctrl) {
    if (ctrl == NULL) {
        return NULL;
    }
    return ctrl->buffer.back_buffer;
}

static void controller_hid_commit_impl(controller_handle_t *ctrl) {
    if (ctrl == NULL || ctrl->runtime == NULL) {
        return;
    }
    hid_runtime_t *rt = (hid_runtime_t *)ctrl->runtime;
    __atomic_store_n(&s_hid_last_host_input_tick, xTaskGetTickCount(),
                     __ATOMIC_RELEASE);
    __atomic_store_n(&s_hid_host_input_seen, true, __ATOMIC_RELEASE);
    __atomic_store_n(&s_hid_host_input_timed_out, false, __ATOMIC_RELEASE);
    if (s_hid_state_queue != NULL && ctrl->hid_ops != NULL &&
        ctrl->hid_ops->report_size() <= HID_STATE_MAX_REPORT_SIZE) {
        hid_state_snapshot_t snapshot = {0};
        size_t report_size = ctrl->hid_ops->report_size();
        memcpy(snapshot.report, ctrl->buffer.back_buffer->report, report_size);
        if (s_hid_last_queued_valid && s_hid_last_queued_size == report_size &&
            hid_input_state_equal(snapshot.report,
                                  s_hid_last_queued_state.report,
                                  report_size)) {
            runtime_status_note_hid_duplicate();
            return;
        }
        if (xQueueSend(s_hid_state_queue, &snapshot, 0) != pdTRUE) {
            s_hid_state_queue_drops++;
            runtime_status_note_hid_enqueue(ctrl->slot, snapshot.report,
                                            report_size, true);
            ESP_LOGW(LOG_HID, "HID state queue full, dropped=%lu",
                     (unsigned long)s_hid_state_queue_drops);
        } else {
            memcpy(&s_hid_last_queued_state, &snapshot, sizeof(snapshot));
            s_hid_last_queued_size = report_size;
            s_hid_last_queued_valid = true;
            runtime_status_note_hid_enqueue(ctrl->slot, snapshot.report,
                                            report_size, false);
            runtime_status_set_hid_queue_depth(
                (uint32_t)uxQueueMessagesWaiting(s_hid_state_queue));
        }
        return;
    }
    MEMORY_BARRIER();
    ctrl->buffer.swap_request = 1;
}

static void controller_hid_reset_impl(controller_handle_t *ctrl) {
    if (ctrl == NULL || ctrl->runtime == NULL || ctrl->hid_ops == NULL ||
        ctrl->hid_ops->report_init == NULL) {
        return;
    }
    hid_runtime_t *rt = (hid_runtime_t *)ctrl->runtime;
    // Device report_init reuses an existing payload. This resets the report
    // without allocating on every reconnect or changing pointers under the
    // serial parser task.
    ctrl->hid_ops->report_init(ctrl->buffer.front_buffer);
    ctrl->hid_ops->report_init(ctrl->buffer.back_buffer);
    if (ctrl->buffer.front_buffer->report == NULL ||
        ctrl->buffer.back_buffer->report == NULL) {
        ESP_LOGE(LOG_HID, "controller report reset failed");
    }
    if (s_hid_state_queue != NULL) {
        xQueueReset(s_hid_state_queue);
        runtime_status_set_hid_queue_depth(0);
    }
    s_hid_last_queued_size = 0;
    s_hid_last_queued_valid = false;
    __atomic_store_n(&s_hid_host_input_seen, false, __ATOMIC_RELEASE);
    __atomic_store_n(&s_hid_host_input_timed_out, false, __ATOMIC_RELEASE);
    hid_reset_delivery_timing(rt);
}

const controller_ops_t controller_ops = {
    .name           = "controller",
    .init           = controller_init_impl,
    .deinit         = controller_deinit_impl,
    .start_task     = controller_start_task_impl,
    .stop_task      = controller_stop_task_impl,
    .get_back_buffer = controller_get_back_buffer_impl,
    .hid_commit     = controller_hid_commit_impl,
    .hid_reset      = controller_hid_reset_impl,
};
