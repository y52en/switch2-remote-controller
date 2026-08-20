#include "device.h"
#include "pro2.h"
#include "utils.h"
#include "controller/controller.h"

#include "esp_mac.h"
#include "esp_err.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "driver/usb_serial_jtag.h"

#include <stdio.h>
#include <stdint.h>

#include "nimble/ble.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"

#include "host/ble_gap.h"
#include "host/ble_att.h"
#include "host/util/util.h"

device_slot_state_t g_device_slots[CONTROLLER_SLOT_COUNT] = {
  [0 ... CONTROLLER_SLOT_COUNT - 1] = {
    .status = DEV_BOOT,
    .conn_handle = BLE_HS_CONN_HANDLE_NONE,
    .conn_interval = 0,
  },
};

static const char *device_status_name(device_status_t status) {
  switch (status) {
    case DEV_ADV_IND: return "advertising";
    case DEV_CONNECTED: return "connected";
    case DEV_READY: return "ready";
    case DEV_DISCONNECTED: return "disconnected";
    default: return "disconnected";
  }
}

static void device_slot_publish(uint8_t slot, int disconnect_reason) {
  const device_slot_state_t *state = &g_device_slots[slot];
  char line[64];
  int length = disconnect_reason >= 0
    ? snprintf(line, sizeof(line), "DS:%u:%s:%u:%d\n", slot,
               device_status_name(state->status), state->conn_interval,
               disconnect_reason)
    : snprintf(line, sizeof(line), "DS:%u:%s:%u\n", slot,
               device_status_name(state->status), state->conn_interval);
  if (length > 0 && length < (int)sizeof(line)) {
    usb_serial_jtag_write_bytes(line, (size_t)length, 0);
  }
}

void device_slot_update(uint8_t slot, device_status_t status,
    uint16_t conn_handle, uint16_t conn_interval, int disconnect_reason) {
  if (slot >= CONTROLLER_SLOT_COUNT) return;
  g_device_slots[slot].status = status;
  g_device_slots[slot].conn_handle = conn_handle;
  g_device_slots[slot].conn_interval = conn_interval;
  device_slot_publish(slot, disconnect_reason);
}

void device_status_set(uint8_t slot, device_status_t status) {
  if (slot >= CONTROLLER_SLOT_COUNT) return;
  device_slot_update(slot, status, g_device_slots[slot].conn_handle,
                     g_device_slots[slot].conn_interval, -1);
}

device_status_t device_status_get(uint8_t slot) {
  return slot < CONTROLLER_SLOT_COUNT ? g_device_slots[slot].status : DEV_BOOT;
}

int device_slot_from_conn(uint16_t conn_handle) {
  if (conn_handle == BLE_HS_CONN_HANDLE_NONE) return -1;
  for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
    if (g_device_slots[slot].conn_handle == conn_handle) return slot;
  }
  return -1;
}

void device_status_publish_all(void) {
  for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
    device_slot_publish(slot, -1);
  }
}

struct ble_store_value_sec* g_ltk_sec = NULL;

uint8_t g_adv_opcode = 0x00;

// **************** NVS ****************

static void nvs_init() {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
}

static esp_err_t ns2_addr_init(nvs_handle_t nvs_handle) {
  esp_err_t ret;
  ret = nvs_get_blob(nvs_handle, NVS_KEY_HOST_ADDR,
                     g_console_ns2s[0].ble_addr.val,
                     &(size_t){ESP_BD_ADDR_LEN});
  if (ret != ESP_OK) {
    ESP_LOGE(LOG_BLE_NVS, "Failed to get NS2 addr from NVS");
  } else {
    ESP_LOGI(LOG_BLE_NVS, "NS2 addr loaded from NVS");
    for (uint8_t slot = 1; slot < CONTROLLER_SLOT_COUNT; slot++) {
      memcpy(g_console_ns2s[slot].ble_addr.val,
             g_console_ns2s[0].ble_addr.val, ESP_BD_ADDR_LEN);
    }
  }
  return ret;
}

static esp_err_t device_info_init() {
    nvs_handle_t nvs_handle;
    esp_err_t ret;
    const char* pairing_ns = (g_controller_firmware.type == CONTROLLER_TYPE_PRO2) ? NVS_NAME_PAIRING_PRO2 : NVS_NAME_PAIRING_JC;
    ret = nvs_open(pairing_ns, NVS_READWRITE, &nvs_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(LOG_BLE_NVS, "Failed to open NVS namespace: %s", pairing_ns);
        return ret;
    }

    ret = controller_init(nvs_handle);
    if (ret != ESP_OK) {
      nvs_close(nvs_handle);
      return ret;
    }

    ret = ns2_addr_init(nvs_handle);
    if (ret == ESP_OK) {
        for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
          g_console_ns2s[slot].ble_addr.type = BLE_ADDR_PUBLIC;
        }
        // set ns2 address to manufacturer data (little endian)
        memcpy(&g_controller_firmware.manufacturer_data[12],
               g_console_ns2s[0].ble_addr.val, ESP_BD_ADDR_LEN);
        if (!g_controller_firmware.pairing_saved) {
          ESP_LOGW(LOG_BLE_NVS, "Host address exists without an LTK; pairing again");
          ret = ESP_ERR_NVS_NOT_FOUND;
        }
    } else {
        // An LTK without its peer address is not a usable bond and must never
        // be injected for the all-zero default peer during NimBLE sync.
        g_controller_firmware.pairing_saved = false;
    }
    nvs_close(nvs_handle);
    return ret;
}

// **************** BLE Stack ****************

static void bleprph_on_reset(int reason) {
  ESP_LOGW(LOG_APP, "BLE Host Resetting state; reason=%d", reason);
}

static uint8_t own_addr_type;

static void bleprph_on_sync(void) {
  ESP_ERROR_CHECK(ble_hs_util_ensure_addr(0));
  ESP_ERROR_CHECK(ble_hs_id_infer_auto(0, &own_addr_type));
  for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
    ESP_LOGI(LOG_APP, "controller slot %u address:", slot);
    log_print_addr(controller_address_re(slot));
  }

  // already paired, inject pairing info to BLE context
  if (g_controller_firmware.pairing_saved) {
    int rc = inject_pairing_info_to_ble_ctx(0);
    if (rc != 0) {
      ESP_LOGE(LOG_APP, "Failed to inject pairing info to BLE context");
    } else {
      ESP_LOGI(LOG_APP, "Pairing info injected to BLE context");
    }
  }

  ESP_ERROR_CHECK(
    ble_gap_set_prefered_default_le_phy(BLE_HCI_LE_PHY_2M_PREF_MASK, BLE_HCI_LE_PHY_2M_PREF_MASK)
  );

  ble_advertise_all();
}

void host_task(void *param) {
  nimble_port_run();
  nimble_port_freertos_deinit();
}

void ble_stack_init(void) {
    esp_err_t ret;
    nvs_init();

    // BLE Security
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_oob_data_flag = 0;
    ble_hs_cfg.sm_bonding = 1;            // Enable ESP-IDF Bonding Store Framework
    // Disable Standard Bonding process
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 0;
    ble_hs_cfg.sm_sc_only = 0;
    ble_hs_cfg.sm_sec_lvl = 2;
    ble_hs_cfg.sm_keypress = 0;
    ble_hs_cfg.sm_our_key_dist |= BLE_SM_PAIR_KEY_DIST_ENC;
    ble_hs_cfg.sm_their_key_dist |= BLE_SM_PAIR_KEY_DIST_ENC;

    ESP_LOGI(LOG_APP, "Device info init...");
    ret = device_info_init();
    if (ret == ESP_OK) {
      ESP_LOGI(LOG_APP, "Device info initialized");
      // set wake up mode
      g_adv_opcode = 0x81;
    } else {
      ESP_LOGW(LOG_APP, "No Pairing, will be paired later");
    }

    // nimble init
    ret = nimble_port_init();
    if (ret != ESP_OK) {
        ESP_LOGE(LOG_APP, "Failed to init nimble %d ", ret);
        return;
    }
    ret = ble_att_set_preferred_mtu(512);
    if (ret != 0) {
      ESP_LOGE(LOG_APP, "ble_att_set_preferred_mtu() failed %d ", ret);
      return;
    }

    // BLE Callback
    ble_hs_cfg.reset_cb = bleprph_on_reset;
    ble_hs_cfg.sync_cb = bleprph_on_sync;
    ble_hs_cfg.gatts_register_arg = device_gatt_svr_register_cb;
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;

    ESP_ERROR_CHECK(device_gatt_svr_init());

    // Bonding Store - set custom callbacks BEFORE calling ble_store_config_init()
    // This is required because ble_hs_init() may trigger store operations
    ble_hs_cfg.store_read_cb = custom_store_config_read;
    ble_hs_cfg.store_write_cb = custom_store_config_write;
    ble_store_config_init();

    // Nimble Start
    nimble_port_freertos_init(host_task);

    // TODO SCLI
}

// **************** BLE Advertise ****************

void ble_advertise(uint8_t slot) {
  int rc;
  if (slot >= CONTROLLER_SLOT_COUNT) return;
  if (g_controller_firmware.type == CONTROLLER_TYPE_JOYCON) {
    ESP_LOGE(LOG_APP, "Joycon not implemented");
    return;
  }
  device_slot_update(slot, DEV_ADV_IND, BLE_HS_CONN_HANDLE_NONE, 0, -1);

  if (ble_gap_ext_adv_active(slot)) {
    ESP_LOGI(LOG_APP, "Advertising instance %u already active", slot);
    return;
  }

  // reset adv params
  struct ble_gap_ext_adv_params ext_adv_params;
  memset(&ext_adv_params, 0, sizeof(ext_adv_params));
  ext_adv_params.legacy_pdu = 1;
  ext_adv_params.connectable = 1;
  ext_adv_params.scannable = 1;
  ext_adv_params.directed = 0;

  ext_adv_params.own_addr_type = slot == 0
    ? BLE_OWN_ADDR_PUBLIC : BLE_OWN_ADDR_RANDOM;
  ext_adv_params.primary_phy = BLE_HCI_LE_PHY_1M;
  ext_adv_params.secondary_phy = BLE_HCI_LE_PHY_1M;
  ext_adv_params.itvl_min = BLE_GAP_ADV_FAST_INTERVAL1_MIN; // 30ms
  ext_adv_params.itvl_max = BLE_GAP_ADV_FAST_INTERVAL1_MIN; // 30ms
  ext_adv_params.channel_map = BLE_GAP_ADV_DFLT_CHANNEL_MAP;
  ext_adv_params.sid = slot;
  // ext_adv_params.tx_power = 127;
  ext_adv_params.scan_req_notif = false;
  ext_adv_params.filter_policy = BLE_HCI_SCAN_FILT_NO_WL;

  rc = ble_gap_ext_adv_configure(slot, &ext_adv_params, NULL,
    handle_gap_event, (void *)(uintptr_t)slot);
  if (rc != 0) {
    ESP_LOGE(LOG_APP, "Error configuring advertising slot %u; rc=%d", slot, rc);
    return;
  }

  if (slot > 0) {
    ble_addr_t random_addr = { .type = BLE_ADDR_RANDOM };
    memcpy(random_addr.val, controller_address_re(slot), ESP_BD_ADDR_LEN);
    rc = ble_gap_ext_adv_set_addr(slot, &random_addr);
    if (rc != 0) {
      ESP_LOGE(LOG_APP, "Error setting random address for slot %u; rc=%d", slot, rc);
      return;
    }
  }

  // set manufacturer data
  ESP_LOGI(LOG_APP, "Setting manufacturer data for advertising");
  struct os_mbuf* adv_data;
  uint8_t m_len = sizeof(g_controller_firmware.manufacturer_data) + 5;
  uint8_t m_data[m_len];
  // Flags 0x01 LE General Discoverable + BR/EDR Not Supported
  uint8_t m_head[3] = { 0x02, 0x01, 0x06 };
  // Manufacturer Specific Data, len + 0xFF + manufacturer_data
  uint8_t m_size = sizeof(g_controller_firmware.manufacturer_data) + 1;
  uint8_t m_spec[2] = { m_size, 0xFF };
  memcpy(m_data, m_head, sizeof(m_head));
  memcpy(m_data + sizeof(m_head), m_spec, sizeof(m_spec));
  // TODO test wakeup flag
  if (g_adv_opcode != 0x00) {
    g_controller_firmware.manufacturer_data[11] = g_adv_opcode;
    // restart adv must set ns2 addr
    memcpy(&g_controller_firmware.manufacturer_data[12],
           g_console_ns2s[slot].ble_addr.val, ESP_BD_ADDR_LEN);
  }
  memcpy(m_data + sizeof(m_head) + sizeof(m_spec), g_controller_firmware.manufacturer_data, sizeof(g_controller_firmware.manufacturer_data));

  adv_data = os_msys_get_pkthdr(sizeof(m_data), 0);
  if (adv_data == NULL) {
    ESP_LOGE(LOG_APP, "Failed to allocate advertising data for slot %u", slot);
    return;
  }
  rc = os_mbuf_append(adv_data, m_data, sizeof(m_data));
  if (rc != 0) {
    ESP_LOGE(LOG_APP, "Error appending manufacturer data to mbuf; rc=%d", rc);
    os_mbuf_free_chain(adv_data);
    return;
  }
  rc = ble_gap_ext_adv_set_data(slot, adv_data);
  if (rc != 0) {
    ESP_LOGE(LOG_APP, "Error setting manufacturer data for advertising; rc=%d", rc);
    os_mbuf_free_chain(adv_data);
    return;
  }

  // start advertising
  rc = ble_gap_ext_adv_start(slot, 0, 0);
  if (rc != 0) {
    ESP_LOGE(LOG_APP, "Error enabling advertising slot %u; rc=%d", slot, rc);
    return;
  }
}

void ble_advertise_all(void) {
  for (uint8_t slot = 0; slot < CONTROLLER_SLOT_COUNT; slot++) {
    ble_advertise(slot);
  }
}

// **************** BLE Subscription ****************

g_subscribe_entry_t *g_subscribe_map = NULL;
void subscribe_entry_set(uint16_t handle, uint16_t conn_handle,
  bool notify_enabled, bool indicate_enabled) {
  g_subscribe_entry_t *entry;
  HASH_FIND(hh, g_subscribe_map, &handle, sizeof(uint16_t), entry);
  if (entry == NULL) {
    entry = (g_subscribe_entry_t*)malloc(sizeof(g_subscribe_entry_t));
    if (entry == NULL) {
      ESP_LOGE(LOG_APP, "Failed to allocate memory for subscribe entry");
      return;
    }
    entry->handle = handle;
    HASH_ADD(hh, g_subscribe_map, handle, sizeof(uint16_t), entry);
  }
  entry->state.conn_handle = conn_handle;
  entry->state.notify_enabled = notify_enabled;
  entry->state.indicate_enabled = indicate_enabled;
}
g_subscribe_state_t* subscribe_entry_get(uint16_t handle) {
  g_subscribe_entry_t *entry = NULL;
  HASH_FIND(hh, g_subscribe_map, &handle, sizeof(uint16_t), entry);
  return (entry == NULL) ? NULL : &entry->state;
}
void subscribe_entry_del(uint16_t handle) {
  g_subscribe_entry_t *entry = NULL;
  HASH_FIND(hh, g_subscribe_map, &handle, sizeof(uint16_t), entry);
  if (entry != NULL) {
    HASH_DEL(g_subscribe_map, entry);
    free(entry);
  }
}
void subscribe_map_destroy() {
  g_subscribe_entry_t *entry = NULL;
  g_subscribe_entry_t *tmp = NULL;
  HASH_ITER(hh, g_subscribe_map, entry, tmp) {
    HASH_DEL(g_subscribe_map, entry);
    free(entry);
  }
}

// **************** BLE Store ****************

int custom_store_config_read(int obj_type, const union ble_store_key *key,
    union ble_store_value *value) {
  int ret =  ble_store_config_read(obj_type, key, value);
  ESP_LOGD(LOG_APP, "custom_store_config_read, obj_type=%d", obj_type);
  if (ret != 0) {
    ESP_LOGE(LOG_APP, "sec read failed, reason=%02x", ret);
    log_print_addr(&key->sec.peer_addr.val);
  }
  switch(obj_type) {
    case BLE_STORE_OBJ_TYPE_OUR_SEC:
      ESP_LOGD(LOG_APP, "custom_store_config_read, BLE_STORE_OBJ_TYPE_OUR_SEC");
      log_print_addr(&key->sec.peer_addr.val);
      break;
    case BLE_STORE_OBJ_TYPE_PEER_SEC:
      ESP_LOGD(LOG_APP, "custom_store_config_read, BLE_STORE_OBJ_TYPE_PEER_SEC");
      log_print_addr(&key->sec.peer_addr.val);
      break;
    case BLE_STORE_OBJ_TYPE_CCCD:
      ESP_LOGD(LOG_APP, "custom_store_config_read, BLE_STORE_OBJ_TYPE_CCCD");
      ESP_LOGD(LOG_APP,
        "custom_store_config_read, val_handle=0x%04x, idx=%d",
        &key->cccd.chr_val_handle, &key->cccd.idx);
      break;
    case BLE_STORE_OBJ_TYPE_CSFC:
      ESP_LOGD(LOG_APP, "custom_store_config_read, BLE_STORE_OBJ_TYPE_CSFC");
      break;
    default:
      break;
  }
  return ret;
}

int custom_store_config_write(int obj_type, const union ble_store_value *val) {
  ESP_LOGD(LOG_APP, "custom_store_config_write, obj_type=%d", obj_type);
  switch(obj_type) {
    case BLE_STORE_OBJ_TYPE_OUR_SEC:
      ESP_LOGD(LOG_APP, "custom_store_config_write, BLE_STORE_OBJ_TYPE_OUR_SEC");
      log_print_addr(&val->sec.peer_addr.val);
      break;
    case BLE_STORE_OBJ_TYPE_PEER_SEC:
      ESP_LOGD(LOG_APP, "custom_store_config_write, BLE_STORE_OBJ_TYPE_PEER_SEC");
      log_print_addr(&val->sec.peer_addr.val);
      break;
    case BLE_STORE_OBJ_TYPE_CCCD:
      ESP_LOGD(LOG_APP, "custom_store_config_write, BLE_STORE_OBJ_TYPE_CCCD");
      ESP_LOGD(LOG_APP,
        "custom_store_config_write, val_handle=0x%04x",
        &val->cccd.chr_val_handle);
      break;
    default:
      break;
  }
  return ble_store_config_write(obj_type, val);
}

int custom_store_gen_key_cb(uint8_t key,struct ble_store_gen_key *gen_key, uint16_t conn_handle) {
  if (key == BLE_STORE_GEN_KEY_LTK && device_slot_from_conn(conn_handle) >= 0) {
        ESP_LOGD(LOG_APP, "call custom_store_gen_key_cb LTK");
        // Only intercept LTK generation and verify conn_handle ,wait testing
        // copy ltk to KEY generate callback function
        memcpy(g_controller_firmware.ltk, gen_key->ltk_periph, LTK_KEY_SIZE);
    }
    return -1;
}
