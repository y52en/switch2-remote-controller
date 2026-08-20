#include "status_display.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "runtime_status.h"
#include "device.h"

#define LCD_HOST SPI2_HOST
#define LCD_RST ((gpio_num_t)CONFIG_REMOTE_LCD_RST_PIN)
#define LCD_DC ((gpio_num_t)CONFIG_REMOTE_LCD_DC_PIN)
#define LCD_BL ((gpio_num_t)CONFIG_REMOTE_LCD_BL_PIN)
#define LCD_SCK CONFIG_REMOTE_LCD_SCK_PIN
#define LCD_MOSI CONFIG_REMOTE_LCD_MOSI_PIN
#define LCD_CS CONFIG_REMOTE_LCD_CS_PIN
#define LCD_W 240
#define LCD_H 240

#define BLACK 0x0000
#define WHITE 0xffff
#define CYAN 0x07ff
#define GREEN 0x07e0
#define YELLOW 0xffe0
#define RED 0xf800

// Input, protocol, and BLE tasks run at priority 4. Display work is deliberately
// kept at priority 1 and split into short transfers so it can always be
// preempted by the latency-sensitive path.
#define DISPLAY_TASK_PRIORITY (tskIDLE_PRIORITY + 1)
#define DISPLAY_TASK_STACK_SIZE 4096
#define DISPLAY_PERIOD_MS 250
#define DISPLAY_LINES_PER_PERIOD 2
#define LCD_TX_CHUNK_BYTES 512
#define STATUS_LINE_COUNT 10
#define STATUS_LINE_X 8
#define STATUS_LINE_W 224
#define STATUS_LINE_H 16
#define STATUS_TEXT_CAPACITY 32

typedef struct {
    char text[STATUS_TEXT_CAPACITY];
    uint16_t color;
    uint8_t scale;
} status_line_t;

static spi_device_handle_t lcd;
static TaskHandle_t display_task_handle;

static status_line_t desired_lines[STATUS_LINE_COUNT];
static status_line_t rendered_lines[STATUS_LINE_COUNT];
static uint8_t next_line_to_render;
static uint8_t line_pixels[STATUS_LINE_W * STATUS_LINE_H * 2];

static const uint8_t status_line_y[STATUS_LINE_COUNT] = {
    15, 39, 61, 84, 107, 130, 153, 176, 198, 216,
};

static void tx(bool data_mode, const void *data, size_t len) {
    if (!lcd || data == NULL || len == 0) return;
    gpio_set_level(LCD_DC, data_mode);
    const uint8_t *cursor = (const uint8_t *)data;
    while (len > 0) {
        size_t part = len > LCD_TX_CHUNK_BYTES ? LCD_TX_CHUNK_BYTES : len;
        spi_transaction_t transaction = {
            .length = part * 8,
            .tx_buffer = cursor,
        };
        if (spi_device_polling_transmit(lcd, &transaction) != ESP_OK) return;
        cursor += part;
        len -= part;
    }
}

static void command(uint8_t cmd, const uint8_t *data, size_t len) {
    tx(false, &cmd, 1);
    if (data && len) tx(true, data, len);
}

static void window(int x0, int y0, int x1, int y1) {
    uint8_t x[] = {x0 >> 8, x0, x1 >> 8, x1};
    uint8_t y[] = {y0 >> 8, y0, y1 >> 8, y1};
    command(0x2a, x, sizeof(x));
    command(0x2b, y, sizeof(y));
    command(0x2c, NULL, 0);
}

static void fill_rect(int x, int y, int w, int h, uint16_t color) {
    if (w <= 0 || h <= 0 || x >= LCD_W || y >= LCD_H) return;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > LCD_W) w = LCD_W - x;
    if (y + h > LCD_H) h = LCD_H - y;
    uint8_t pixels[LCD_TX_CHUNK_BYTES];
    for (size_t i = 0; i < sizeof(pixels); i += 2) {
        pixels[i] = color >> 8;
        pixels[i + 1] = color;
    }
    window(x, y, x + w - 1, y + h - 1);
    int remaining = w * h;
    while (remaining > 0) {
        int count = remaining > (LCD_TX_CHUNK_BYTES / 2)
                        ? (LCD_TX_CHUNK_BYTES / 2)
                        : remaining;
        tx(true, pixels, count * 2);
        remaining -= count;
    }
}

static const uint8_t *glyph(char c) {
    static const uint8_t space[5] = {0};
    static const uint8_t punctuation[][5] = {
        {0x00,0x60,0x60,0x00,0x00}, // .
        {0x00,0x80,0x60,0x00,0x00}, // ,
        {0x08,0x08,0x08,0x08,0x08}, // -
        {0x20,0x10,0x08,0x04,0x02}, // /
        {0x00,0x36,0x36,0x00,0x00}, // :
    };
    static const uint8_t digits[][5] = {
        {0x3e,0x51,0x49,0x45,0x3e}, {0x00,0x42,0x7f,0x40,0x00},
        {0x42,0x61,0x51,0x49,0x46}, {0x21,0x41,0x45,0x4b,0x31},
        {0x18,0x14,0x12,0x7f,0x10}, {0x27,0x45,0x45,0x45,0x39},
        {0x3c,0x4a,0x49,0x49,0x30}, {0x01,0x71,0x09,0x05,0x03},
        {0x36,0x49,0x49,0x49,0x36}, {0x06,0x49,0x49,0x29,0x1e},
    };
    static const uint8_t letters[][5] = {
        {0x7e,0x11,0x11,0x11,0x7e}, {0x7f,0x49,0x49,0x49,0x36},
        {0x3e,0x41,0x41,0x41,0x22}, {0x7f,0x41,0x41,0x22,0x1c},
        {0x7f,0x49,0x49,0x49,0x41}, {0x7f,0x09,0x09,0x09,0x01},
        {0x3e,0x41,0x49,0x49,0x7a}, {0x7f,0x08,0x08,0x08,0x7f},
        {0x00,0x41,0x7f,0x41,0x00}, {0x20,0x40,0x41,0x3f,0x01},
        {0x7f,0x08,0x14,0x22,0x41}, {0x7f,0x40,0x40,0x40,0x40},
        {0x7f,0x02,0x0c,0x02,0x7f}, {0x7f,0x04,0x08,0x10,0x7f},
        {0x3e,0x41,0x41,0x41,0x3e}, {0x7f,0x09,0x09,0x09,0x06},
        {0x3e,0x41,0x51,0x21,0x5e}, {0x7f,0x09,0x19,0x29,0x46},
        {0x46,0x49,0x49,0x49,0x31}, {0x01,0x01,0x7f,0x01,0x01},
        {0x3f,0x40,0x40,0x40,0x3f}, {0x1f,0x20,0x40,0x20,0x1f},
        {0x3f,0x40,0x38,0x40,0x3f}, {0x63,0x14,0x08,0x14,0x63},
        {0x07,0x08,0x70,0x08,0x07}, {0x61,0x51,0x49,0x45,0x43},
    };
    if (c >= '0' && c <= '9') return digits[c - '0'];
    if (c >= 'A' && c <= 'Z') return letters[c - 'A'];
    switch (c) {
        case '.': return punctuation[0];
        case ',': return punctuation[1];
        case '-': return punctuation[2];
        case '/': return punctuation[3];
        case ':': return punctuation[4];
        default: return space;
    }
}

static void text_center(const char *value, int y, uint16_t color, int scale) {
    int width = (int)strlen(value) * 6 * scale;
    int x = (LCD_W - width) / 2;
    for (; *value; value++, x += 6 * scale) {
        const uint8_t *g = glyph(*value);
        for (int col = 0; col < 5; col++) {
            uint8_t bits = g[col];
            for (int row = 0; row < 8; row++) {
                if (bits & (1U << row)) {
                    fill_rect(x + col * scale, y + row * scale,
                              scale, scale, color);
                }
            }
        }
    }
}

static void init_panel(void) {
    const struct { uint8_t cmd; uint8_t len; uint8_t data[12]; } init[] = {
        {0xef,0,{0}}, {0xeb,1,{0x14}}, {0xfe,0,{0}}, {0xef,0,{0}},
        {0xeb,1,{0x14}}, {0x84,1,{0x40}}, {0x85,1,{0xff}}, {0x86,1,{0xff}},
        {0x87,1,{0xff}}, {0x88,1,{0x0a}}, {0x89,1,{0x21}}, {0x8a,1,{0x00}},
        {0x8b,1,{0x80}}, {0x8c,1,{0x01}}, {0x8d,1,{0x01}}, {0x8e,1,{0xff}},
        {0x8f,1,{0xff}}, {0xb6,2,{0x00,0x20}}, {0x36,1,{0x08}}, {0x3a,1,{0x05}},
        {0x90,4,{0x08,0x08,0x08,0x08}}, {0xbd,1,{0x06}}, {0xbc,1,{0x00}},
        {0xff,3,{0x60,0x01,0x04}}, {0xc3,1,{0x13}}, {0xc4,1,{0x13}},
        {0xc9,1,{0x22}}, {0xbe,1,{0x11}}, {0xe1,2,{0x10,0x0e}},
        {0xdf,3,{0x21,0x0c,0x02}}, {0xf0,6,{0x45,0x09,0x08,0x08,0x26,0x2a}},
        {0xf1,6,{0x43,0x70,0x72,0x36,0x37,0x6f}},
        {0xf2,6,{0x45,0x09,0x08,0x08,0x26,0x2a}},
        {0xf3,6,{0x43,0x70,0x72,0x36,0x37,0x6f}}, {0xed,2,{0x1b,0x0b}},
        {0xae,1,{0x77}}, {0xcd,1,{0x63}},
        {0x70,9,{0x07,0x07,0x04,0x0e,0x0f,0x09,0x07,0x08,0x03}},
        {0xe8,1,{0x34}},
        {0x62,12,{0x18,0x0d,0x71,0xed,0x70,0x70,0x18,0x0f,0x71,0xef,0x70,0x70}},
        {0x63,12,{0x18,0x11,0x71,0xf1,0x70,0x70,0x18,0x13,0x71,0xf3,0x70,0x70}},
        {0x64,7,{0x28,0x29,0xf1,0x01,0xf1,0x00,0x07}},
        {0x66,10,{0x3c,0x00,0xcd,0x67,0x45,0x45,0x10,0x00,0x00,0x00}},
        {0x67,10,{0x00,0x3c,0x00,0x00,0x00,0x01,0x54,0x10,0x32,0x98}},
        {0x74,7,{0x10,0x85,0x80,0x00,0x00,0x4e,0x00}}, {0x98,2,{0x3e,0x07}},
        {0x35,0,{0}}, {0x21,0,{0}}, {0x11,0,{0}}
    };
    for (size_t i = 0; i < sizeof(init) / sizeof(init[0]); i++) {
        command(init[i].cmd, init[i].data, init[i].len);
    }
    vTaskDelay(pdMS_TO_TICKS(120));
    command(0x29, NULL, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
}

static void set_line(size_t index, const char *text, uint16_t color, int scale) {
    if (index >= STATUS_LINE_COUNT) return;
    snprintf(desired_lines[index].text, sizeof(desired_lines[index].text),
             "%s", text);
    desired_lines[index].color = color;
    desired_lines[index].scale = (uint8_t)scale;
}

static bool line_is_dirty(size_t index) {
    return desired_lines[index].color != rendered_lines[index].color ||
           desired_lines[index].scale != rendered_lines[index].scale ||
           strcmp(desired_lines[index].text, rendered_lines[index].text) != 0;
}

static void render_line(size_t index) {
    const status_line_t *line = &desired_lines[index];
    memset(line_pixels, 0, sizeof(line_pixels));

    int scale = line->scale == 1 ? 1 : 2;
    int text_width = (int)strlen(line->text) * 6 * scale;
    int x = (STATUS_LINE_W - text_width) / 2;
    int y = (STATUS_LINE_H - 8 * scale) / 2;
    uint8_t high = line->color >> 8;
    uint8_t low = line->color;

    for (const char *value = line->text; *value; value++, x += 6 * scale) {
        const uint8_t *g = glyph(*value);
        for (int col = 0; col < 5; col++) {
            uint8_t bits = g[col];
            for (int row = 0; row < 8; row++) {
                if (!(bits & (1U << row))) continue;
                for (int dx = 0; dx < scale; dx++) {
                    for (int dy = 0; dy < scale; dy++) {
                        int px = x + col * scale + dx;
                        int py = y + row * scale + dy;
                        if (px < 0 || px >= STATUS_LINE_W ||
                            py < 0 || py >= STATUS_LINE_H) continue;
                        size_t offset = ((size_t)py * STATUS_LINE_W + px) * 2;
                        line_pixels[offset] = high;
                        line_pixels[offset + 1] = low;
                    }
                }
            }
        }
    }

    window(STATUS_LINE_X, status_line_y[index],
           STATUS_LINE_X + STATUS_LINE_W - 1,
           status_line_y[index] + STATUS_LINE_H - 1);
    tx(true, line_pixels, sizeof(line_pixels));
    rendered_lines[index] = *line;
}

static void flush_dashboard(void) {
    int rendered = 0;
    for (int checked = 0;
         checked < STATUS_LINE_COUNT && rendered < DISPLAY_LINES_PER_PERIOD;
         checked++) {
        size_t index = next_line_to_render;
        next_line_to_render = (next_line_to_render + 1) % STATUS_LINE_COUNT;
        if (!line_is_dirty(index)) continue;
        render_line(index);
        rendered++;
    }
}

static void short_count(uint32_t value, char output[8]) {
    if (value < 10000) {
        snprintf(output, 8, "%lu", (unsigned long)value);
    } else if (value < 1000000) {
        snprintf(output, 8, "%luK", (unsigned long)(value / 1000));
    } else {
        uint32_t millions = value / 1000000;
        if (millions > 999) millions = 999;
        snprintf(output, 8, "%luM", (unsigned long)millions);
    }
}

static void update_dashboard(void) {
    char line[STATUS_TEXT_CAPACITY];
    char first_count[8];
    char second_count[8];
    char third_count[8];
    runtime_status_snapshot_t status;
    runtime_status_get_snapshot(&status);
    bool input_live = status.have_input && status.input_age_ms < 1000;
    uint32_t input_age_ms = status.input_age_ms;
    uint16_t buttons = status.have_input ? status.buttons : 0;
    uint8_t hat = status.have_input ? status.hat : 8;
    uint8_t lx = status.have_input ? status.lx : 128;
    uint8_t ly = status.have_input ? status.ly : 128;
    uint8_t rx = status.have_input ? status.rx : 128;
    uint8_t ry = status.have_input ? status.ry : 128;
    bool controls_active = buttons != 0 || hat != 8 ||
                           lx < 124 || lx > 132 || ly < 124 || ly > 132 ||
                           rx < 124 || rx > 132 || ry < 124 || ry > 132;

    set_line(0, "SWITCH 2", CYAN, 2);
    if (status.device_status == DEV_READY) set_line(1, "BLE READY", GREEN, 2);
    else if (status.device_status == DEV_ADV_IND ||
             status.device_status == DEV_CONNECTED) set_line(1, "BLE PAIR", YELLOW, 2);
    else set_line(1, "BLE BOOT", RED, 2);

    uint16_t interval = status.ble_interval_units;
    if (interval == 0) {
        set_line(2, "LINK --", WHITE, 2);
    } else {
        uint32_t tenths = ((uint32_t)interval * 125 + 5) / 10;
        snprintf(line, sizeof(line), "LINK %lu.%luMS",
                 (unsigned long)(tenths / 10),
                 (unsigned long)(tenths % 10));
        set_line(2, line, interval == 4 ? GREEN : YELLOW, 2);
    }

    if (input_live) {
        if (input_age_ms > 999) input_age_ms = 999;
        snprintf(line, sizeof(line), "PC LIVE %03luMS",
                 (unsigned long)input_age_ms);
        set_line(3, line, CYAN, 2);
    } else {
        set_line(3, "PC WAIT", WHITE, 2);
    }

    snprintf(line, sizeof(line), "B%04X H%u", buttons, hat);
    set_line(4, line, controls_active ? YELLOW : WHITE, 2);
    snprintf(line, sizeof(line), "L%03u,%03u R%03u,%03u", lx, ly, rx, ry);
    set_line(5, line, controls_active ? CYAN : WHITE, 2);

    uint32_t queue_depth = status.hid_queue_depth;
    uint32_t queue_peak = status.hid_queue_high_water;
    uint16_t queue_free = status.ble_queue_free;
    uint16_t queue_ceiling = status.ble_queue_ceiling;
    snprintf(line, sizeof(line), "Q%lu P%lu M%u/%u",
             (unsigned long)queue_depth, (unsigned long)queue_peak,
             queue_free, queue_ceiling);
    set_line(6, line,
             queue_depth != 0 || (queue_ceiling && queue_free < queue_ceiling)
                 ? YELLOW : WHITE,
             2);

    uint32_t drops = status.hid_drops;
    uint32_t failures = status.hid_notify_failures;
    uint32_t recoveries = status.hid_notify_recoveries;
    short_count(drops, first_count);
    short_count(failures, second_count);
    short_count(recoveries, third_count);
    snprintf(line, sizeof(line), "D%s F%s R%s",
             first_count, second_count, third_count);
    set_line(7, line, drops || failures ? RED : GREEN, 2);

    short_count(status.input_state_changes, first_count);
    short_count(status.ble_input_changes, second_count);
    snprintf(line, sizeof(line), "IN%s OUT%s", first_count, second_count);
    set_line(8, line, CYAN, 2);

    uint32_t congestion = status.ble_congestion_skips;
    uint32_t pending = status.ble_pending_skips;
    short_count(congestion, first_count);
    short_count(pending, second_count);
    short_count(status.hid_duplicates, third_count);
    snprintf(line, sizeof(line), "SK%s/%s DU%s",
             first_count, second_count, third_count);
    set_line(9, line, congestion || pending ? YELLOW : WHITE, 1);
}

static void display_task(void *argument) {
    (void)argument;
    TickType_t last_wake = xTaskGetTickCount();
    while (true) {
        update_dashboard();
        flush_dashboard();
        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(DISPLAY_PERIOD_MS));
    }
}

int status_display_init(void) {
    gpio_config_t pins = {
        .pin_bit_mask = (1ULL << LCD_RST) | (1ULL << LCD_DC) | (1ULL << LCD_BL),
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&pins);
    gpio_set_level(LCD_BL, 1);
    gpio_set_level(LCD_RST, 1); vTaskDelay(pdMS_TO_TICKS(50));
    gpio_set_level(LCD_RST, 0); vTaskDelay(pdMS_TO_TICKS(50));
    gpio_set_level(LCD_RST, 1); vTaskDelay(pdMS_TO_TICKS(150));
    spi_bus_config_t bus = {
        .mosi_io_num = LCD_MOSI,
        .miso_io_num = -1,
        .sclk_io_num = LCD_SCK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = LCD_TX_CHUNK_BYTES,
    };
    if (spi_bus_initialize(LCD_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK) return -1;
    spi_device_interface_config_t device = {
        .clock_speed_hz = 40000000,
        .mode = 0,
        .spics_io_num = LCD_CS,
        .queue_size = 1,
    };
    if (spi_bus_add_device(LCD_HOST, &device, &lcd) != ESP_OK) {
        lcd = NULL;
        return -1;
    }
    init_panel();
    fill_rect(0, 0, LCD_W, LCD_H, BLACK);
    text_center("SWITCH 2", 52, CYAN, 3);
    text_center("BOOT", 105, YELLOW, 4);
    text_center("DISPLAY", 168, WHITE, 2);

    BaseType_t result = xTaskCreate(display_task, "status_display",
                                    DISPLAY_TASK_STACK_SIZE, NULL,
                                    DISPLAY_TASK_PRIORITY, &display_task_handle);
    return result == pdPASS ? 0 : -1;
}
