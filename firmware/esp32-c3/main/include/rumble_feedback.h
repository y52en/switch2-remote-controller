#ifndef RUMBLE_FEEDBACK_H
#define RUMBLE_FEEDBACK_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RUMBLE_FEEDBACK_MAX_PACKET_SIZE 64

int rumble_feedback_init(void);
void rumble_feedback_note_packet(uint8_t slot, const uint8_t *packet, size_t length);

#ifdef __cplusplus
}
#endif

#endif
