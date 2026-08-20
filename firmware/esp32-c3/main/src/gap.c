#include "device.h"
#include "runtime_status.h"
#include "controller/hid_controller.h"
#include "utils.h"

#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/timers.h"

static TimerHandle_t s_restart_adv_timers[CONTROLLER_SLOT_COUNT];

static void restart_adv_timer_cb(TimerHandle_t timer) {
  uint8_t slot = (uint8_t)(uintptr_t)pvTimerGetTimerID(timer);
  ble_advertise(slot);
}

static uint8_t event_slot(void *arg, uint16_t conn_handle) {
  if (conn_handle != BLE_HS_CONN_HANDLE_NONE) {
    int mapped = device_slot_from_conn(conn_handle);
    if (mapped >= 0) return (uint8_t)mapped;
  }
  uint8_t advertised = (uint8_t)(uintptr_t)arg;
  return advertised < CONTROLLER_SLOT_COUNT ? advertised : 0;
}

static void print_conn_desc(struct ble_gap_conn_desc* desc) {
  ESP_LOGD(LOG_BLE_GAP, "handle=%d our_ota_addr_type=%d our_ota_addr=",
    desc->conn_handle, desc->our_ota_addr.type);
  log_print_addr(desc->our_ota_addr.val);
  ESP_LOGD(LOG_BLE_GAP, " our_id_addr_type=%d our_id_addr=",
    desc->our_id_addr.type);
  log_print_addr(desc->our_id_addr.val);
  ESP_LOGD(LOG_BLE_GAP, " peer_ota_addr_type=%d peer_ota_addr=",
    desc->peer_ota_addr.type);
  log_print_addr(desc->peer_ota_addr.val);
  ESP_LOGD(LOG_BLE_GAP, " peer_id_addr_type=%d peer_id_addr=",
    desc->peer_id_addr.type);
  log_print_addr(desc->peer_id_addr.val);
  ESP_LOGD(LOG_BLE_GAP, " conn_itvl=%d conn_latency=%d supervision_timeout=%d "
    "encrypted=%d authenticated=%d bonded=%d\n",
    desc->conn_itvl, desc->conn_latency,
    desc->supervision_timeout,
    desc->sec_state.encrypted,
    desc->sec_state.authenticated,
    desc->sec_state.bonded);
}

static void schedule_advertising_restart(uint8_t slot) {
  if (slot >= CONTROLLER_SLOT_COUNT) return;
  if (s_restart_adv_timers[slot] == NULL) {
    s_restart_adv_timers[slot] = xTimerCreate(
      "restart_adv", pdMS_TO_TICKS(3000), pdFALSE,
      (void *)(uintptr_t)slot, restart_adv_timer_cb);
  }
  if (s_restart_adv_timers[slot] != NULL) {
    xTimerReset(s_restart_adv_timers[slot], 0);
  }
}

int handle_gap_event(struct ble_gap_event* event, void* arg) {
  struct ble_gap_conn_desc desc;
  int rc;

  switch(event->type) {
    case BLE_GAP_EVENT_CONNECT: {
      uint8_t slot = event_slot(arg, event->connect.conn_handle);
      if (event->connect.status == 0) {
        rc = ble_gap_conn_find(event->connect.conn_handle, &desc);
        assert(rc == 0);
        print_conn_desc(&desc);
        runtime_status_set_ble_interval(desc.conn_itvl);
        g_console_ns2s[slot].ble_addr.type = desc.peer_ota_addr.type;
        memcpy(g_console_ns2s[slot].ble_addr.val, desc.peer_ota_addr.val,
               ESP_BD_ADDR_LEN);
        g_console_ns2s[slot].conn_handle = desc.conn_handle;
        controller_handle_t *ctrl = controller_hid_for_slot(slot);
        if (ctrl != NULL) {
          ctrl->conn_handle = desc.conn_handle;
          ctrl->notify_enabled = false;
        }
        device_slot_update(slot, DEV_CONNECTED, desc.conn_handle,
                           desc.conn_itvl, -1);
        ESP_LOGI(LOG_BLE_GAP,
                 "slot %u connected, set nintendo switch addr", slot);
        log_print_addr(g_console_ns2s[slot].ble_addr.val);

        struct ble_gap_upd_params params;
        memset(&params, 0, sizeof(params));
        params.itvl_min = 4;
        params.itvl_max = 4;
        params.latency = 0;
        params.supervision_timeout = desc.supervision_timeout;
        rc = ble_gap_update_params(desc.conn_handle, &params);
        if (rc != 0) {
          ESP_LOGE(LOG_BLE_GAP,
                   "slot %u connection parameter update failed, rc=%d",
                   slot, rc);
        }
        if (s_restart_adv_timers[slot] != NULL) {
          xTimerStop(s_restart_adv_timers[slot], 0);
        }
      } else {
        ESP_LOGE(LOG_BLE_GAP,
                 "slot %u connection failed, status=%d", slot,
                 event->connect.status);
        ble_advertise(slot);
      }
      return 0;
    }
    case BLE_GAP_EVENT_DISCONNECT: {
      uint16_t conn_handle = event->disconnect.conn.conn_handle;
      uint8_t slot = event_slot(arg, conn_handle);
      ESP_LOGI(LOG_BLE_GAP,
               "slot %u disconnected, reason=%d, restart advertising after 3s",
               slot, event->disconnect.reason);
      controller_handle_t *ctrl = controller_hid_for_slot(slot);
      if (ctrl != NULL) {
        ctrl->ops->stop_task(ctrl);
        ctrl->notify_enabled = false;
        ctrl->conn_handle = BLE_HS_CONN_HANDLE_NONE;
      }
      g_console_ns2s[slot].conn_handle = BLE_HS_CONN_HANDLE_NONE;
      device_slot_update(slot, DEV_DISCONNECTED, BLE_HS_CONN_HANDLE_NONE, 0,
                         event->disconnect.reason);
      schedule_advertising_restart(slot);
      return 0;
    }
    case BLE_GAP_EVENT_CONN_UPDATE: {
      uint8_t slot = event_slot(arg, event->conn_update.conn_handle);
      ESP_LOGD(LOG_BLE_GAP,
               "slot %u connection updated, handle=%d, status=%d", slot,
               event->conn_update.conn_handle, event->conn_update.status);
      if (ble_gap_conn_find(event->conn_update.conn_handle, &desc) == 0) {
        runtime_status_set_ble_interval(desc.conn_itvl);
        device_slot_update(slot, device_status_get(slot), desc.conn_handle,
                           desc.conn_itvl, -1);
      }
      return 0;
    }
    case BLE_GAP_EVENT_CONN_UPDATE_REQ:
      *event->conn_update_req.self_params = *event->conn_update_req.peer_params;
      return 0;
    case BLE_GAP_EVENT_ADV_COMPLETE:
      ESP_LOGI(LOG_BLE_GAP, "advertising complete for slot %u",
               (uint8_t)(uintptr_t)arg);
      return 0;
    case BLE_GAP_EVENT_ENC_CHANGE:
      rc = ble_gap_conn_find(event->enc_change.conn_handle, &desc);
      if (rc == 0) print_conn_desc(&desc);
      return 0;
    case BLE_GAP_EVENT_PASSKEY_ACTION:
      return 0;
    case BLE_GAP_EVENT_NOTIFY_TX:
      controller_hid_notify_complete(event->notify_tx.conn_handle,
                                     event->notify_tx.attr_handle,
                                     event->notify_tx.status);
      return 0;
    case BLE_GAP_EVENT_SUBSCRIBE: {
      uint8_t slot = event_slot(arg, event->subscribe.conn_handle);
      controller_handle_t *ctrl = controller_hid_for_slot(slot);
      ESP_LOGI(LOG_BLE_GAP,
        "slot %u subscribe event; conn_handle=0x%04x attr_handle=0x%04x "
        "reason=%d prevn=%d curn=%d previ=%d curi=%d",
        slot, event->subscribe.conn_handle, event->subscribe.attr_handle,
        event->subscribe.reason, event->subscribe.prev_notify,
        event->subscribe.cur_notify, event->subscribe.prev_indicate,
        event->subscribe.cur_indicate);
      if (ctrl != NULL &&
          event->subscribe.attr_handle == ctrl->ns2_notification_handle) {
        ctrl->notify_enabled = event->subscribe.cur_notify == 1;
        if (!ctrl->notify_enabled) {
          ctrl->ops->stop_task(ctrl);
        } else if (event->subscribe.prev_notify == 0) {
          ctrl->ops->stop_task(ctrl);
          ctrl->ops->hid_reset(ctrl);
          ctrl->ops->start_task(ctrl);
        }
      }
      return 0;
    }
    case BLE_GAP_EVENT_MTU: {
      uint8_t slot = event_slot(arg, event->mtu.conn_handle);
      g_console_ns2s[slot].mtu = event->mtu.value;
      return 0;
    }
    case BLE_GAP_EVENT_REPEAT_PAIRING:
      rc = ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc);
      assert(rc == 0);
      ble_store_util_delete_peer(&desc.peer_id_addr);
      return BLE_GAP_REPEAT_PAIRING_RETRY;
    // ESP-IDF 6.0.1's esp-nimble API intentionally exposes this historical
    // spelling; keep it until the pinned framework changes.
    case BLE_GAP_EVENT_PARING_COMPLETE:
    case BLE_GAP_EVENT_AUTHORIZE:
      return 0;
    default:
      break;
  }
  return 0;
}
