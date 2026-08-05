#include "device.h"
#include "runtime_status.h"
#include "controller/hid_controller.h"
#include "utils.h"

#include "freertos/FreeRTOS.h"
#include "freertos/timers.h"

static TimerHandle_t s_restart_adv_timer = NULL;

static void restart_adv_timer_cb(TimerHandle_t xTimer) {
  ble_advertise();
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

int handle_gap_event(struct ble_gap_event* event, void* arg) {
  struct ble_gap_conn_desc desc;
  int rc;

  switch(event->type) {
    case BLE_GAP_EVENT_CONNECT:
      if (event->connect.status == 0) {
        rc = ble_gap_conn_find(event->connect.conn_handle, &desc);
        assert(rc == 0);
        print_conn_desc(&desc);
        runtime_status_set_ble_interval(desc.conn_itvl);
        if (g_device_status == DEV_ADV_IND) {
          g_console_ns2.ble_addr.type = desc.peer_ota_addr.type;
          memcpy(g_console_ns2.ble_addr.val, desc.peer_ota_addr.val, 6);
          ESP_LOGI(LOG_BLE_GAP, "connected, set nintendo switch addr, addr=");
          log_print_addr(g_console_ns2.ble_addr.val);
          struct ble_gap_upd_params params;
          memset(&params, 0, sizeof(params));
          // ESP-IDF 5.5.3, maybe esp-idf support min connection interval
          // Switch 2 operates at 5 ms (4 * 1.25 ms). A broad maximum here
          // allowed the initial interval, sometimes close to one second.
          params.itvl_min = 4;
          params.itvl_max = 4;
          params.latency = 0;
          params.supervision_timeout = desc.supervision_timeout;
          rc = ble_gap_update_params(event->connect.conn_handle, &params);
          if (rc != 0) {
            ESP_LOGE(LOG_BLE_GAP, "failed to update connection parameters, rc=%d", rc);
          }
        } else {
          ESP_LOGE(LOG_BLE_GAP, "device not ready, reset device");
          device_status_set(DEV_BOOT);
        }
        // cancel pending restart advertising timer
        if (s_restart_adv_timer != NULL) {
          xTimerStop(s_restart_adv_timer, 0);
        }
      } else {
        // failed, restart advertising
        ESP_LOGE(LOG_BLE_GAP, "connection failed, status=%d, restart advertising",
          event->connect.status);
        ble_advertise();
      }
      return 0;
    case BLE_GAP_EVENT_DISCONNECT:
      ESP_LOGI(LOG_BLE_GAP, "disconnected, reason=%d, restart advertising after 5s", event->disconnect.reason);
      if (s_restart_adv_timer == NULL) {
        s_restart_adv_timer = xTimerCreate("restart_adv", pdMS_TO_TICKS(3000), pdFALSE, NULL, restart_adv_timer_cb);
      }
      if (s_restart_adv_timer != NULL) {
        xTimerReset(s_restart_adv_timer, 0);
      }
      // stop hid task
      g_hid_controller.ops->stop_task(&g_hid_controller);
      return 0;
    case BLE_GAP_EVENT_CONN_UPDATE:
      ESP_LOGD(LOG_BLE_GAP, "connection updated, conn_handle=%d, status=%d",
        event->conn_update.conn_handle, event->conn_update.status);
      if (ble_gap_conn_find(event->conn_update.conn_handle, &desc) == 0)
        runtime_status_set_ble_interval(desc.conn_itvl);
      return 0;
    case BLE_GAP_EVENT_CONN_UPDATE_REQ:
      ESP_LOGD(LOG_BLE_GAP, "connection update request, conn_handle=%d", event->conn_update_req.conn_handle);
      // set conn params
      *event->conn_update_req.self_params = *event->conn_update_req.peer_params;
      return 0;
    case BLE_GAP_EVENT_ADV_COMPLETE:
      ESP_LOGI(LOG_BLE_GAP, "adv complete");
      return 0;
    case BLE_GAP_EVENT_ENC_CHANGE:
      ESP_LOGI(LOG_BLE_GAP, "encryption change event; status=%d ", event->enc_change.status);
      rc = ble_gap_conn_find(event->enc_change.conn_handle, &desc);
      assert(rc == 0);
      print_conn_desc(&desc);
      return 0;
    case BLE_GAP_EVENT_PASSKEY_ACTION:
      ESP_LOGD(LOG_BLE_GAP, "passkey action event; action=%d", event->passkey.params.action);
      return 0;
    case BLE_GAP_EVENT_NOTIFY_TX:
      ESP_LOGD(LOG_BLE_GAP, "notify_tx event; conn_handle=%d attr_handle=%d "
        "status=%d is_indication=%d",
        event->notify_tx.conn_handle,
        event->notify_tx.attr_handle,
        event->notify_tx.status,
        event->notify_tx.indication);
      controller_hid_notify_complete(event->notify_tx.attr_handle,
                                     event->notify_tx.status);
      return 0;
    case BLE_GAP_EVENT_SUBSCRIBE:
      ESP_LOGI(LOG_BLE_GAP, "subscribe event; conn_handle=0x00%02x attr_handle=0x00%02x "
        "reason=%d prevn=%d curn=%d previ=%d curi=%d\n",
        event->subscribe.conn_handle,
        event->subscribe.attr_handle,
        event->subscribe.reason,
        event->subscribe.prev_notify,
        event->subscribe.cur_notify,
        event->subscribe.prev_indicate,
        event->subscribe.cur_indicate);
      // cccd subscribe
      subscribe_entry_set(event->subscribe.attr_handle,
        event->subscribe.conn_handle,
        event->subscribe.cur_notify == 1,
        event->subscribe.cur_indicate == 1);

      if (event->subscribe.attr_handle == g_hid_controller.ns2_notification_handle) {
        if (event->subscribe.cur_notify == 0) {
          g_hid_controller.ops->stop_task(&g_hid_controller);
        } else if (event->subscribe.cur_notify == 1 &&
                   event->subscribe.prev_notify == 0) {
          // Stop before resetting buffers so the report task can never race a
          // rapid unsubscribe/resubscribe sequence.
          g_hid_controller.ops->stop_task(&g_hid_controller);
          g_hid_controller.ops->hid_reset(&g_hid_controller);
          g_hid_controller.ops->start_task(&g_hid_controller);
        }
      }
      break;
    case BLE_GAP_EVENT_MTU:
      ESP_LOGD(LOG_BLE_GAP, "mtu changed, conn_handle=%d, channel_id=%d, mtu=%d",
        event->mtu.conn_handle, event->mtu.channel_id, event->mtu.value);
      return 0;
    case BLE_GAP_EVENT_REPEAT_PAIRING:
      rc = ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc);
      assert(rc == 0);
      ble_store_util_delete_peer(&desc.peer_id_addr);
      return BLE_GAP_REPEAT_PAIRING_RETRY;
    case BLE_GAP_EVENT_PARING_COMPLETE:
      ESP_LOGD(LOG_BLE_GAP, "paring complete event; status=%d",
        event->pairing_complete.status);
      return 0;
    case BLE_GAP_EVENT_AUTHORIZE:
      ESP_LOGD(LOG_BLE_GAP, "authorize event; conn_handle=%d", event->authorize.conn_handle);
      return 0;
    default:
      break;
  }
  return 0;
}
