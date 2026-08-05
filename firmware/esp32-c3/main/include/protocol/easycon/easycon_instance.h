#ifndef EASYCON_INSTANCE_H
#define EASYCON_INSTANCE_H

#include "protocol/protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Pre-configured EasyCon protocol instance.
 *
 * Contains all EasyCon parsers registered in the recommended order:
 * hello -> short cmd -> simple cmd -> slice -> hid.
 */
extern protocol_instance_t easycon_protocol_instance;

#ifdef __cplusplus
}
#endif

#endif // EASYCON_INSTANCE_H
