file(GLOB_RECURSE srcs "main.c" "src/*.c")

list(FILTER srcs EXCLUDE REGEX "status_display_(gc9a01|none)\\.c$")
if(CONFIG_REMOTE_DISPLAY_GC9A01)
  list(APPEND srcs "src/display/status_display_gc9a01.c")
  set(display_requires esp_driver_gpio esp_driver_spi)
else()
  list(APPEND srcs "src/display/status_display_none.c")
  set(display_requires)
endif()

idf_component_register(SRCS "${srcs}"
  PRIV_REQUIRES bt nvs_flash mbedtls esp_driver_usb_serial_jtag ${display_requires}
  INCLUDE_DIRS "." "./include")
