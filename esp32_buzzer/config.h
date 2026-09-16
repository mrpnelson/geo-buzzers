// ============================================================================
// config.h - deployment and branding configuration for the buzzer firmware
//
// Everything organization-specific lives here so the same firmware can be
// rebuilt for a different team without touching esp-jep.cpp.
//
// Every value is wrapped in #ifndef, so it can also be supplied from the
// build instead of edited here. With PlatformIO:
//
//   build_flags =
//     -DDEFAULT_SERVER_HOST='"acmebuzz.example.org"'
//     -DBRAND_ORG_NAME='"Acme"'
//
// Place this file next to esp-jep.cpp in the sketch folder.
// ============================================================================
#pragma once

// ----------------------------------------------------------------------------
// SERVER
// The host the buzzer connects to out of the box. A device can be pointed
// somewhere else at runtime via the WiFi setup portal, which takes priority;
// this is the default and the value restored by a hardware factory reset.
// ----------------------------------------------------------------------------
#ifndef DEFAULT_SERVER_HOST
#define DEFAULT_SERVER_HOST "acmebuzz.example.org"
#endif

// 443 for wss:// behind TLS (Cloud Run), 8080 for a plain local server.
#ifndef DEFAULT_SERVER_PORT
#define DEFAULT_SERVER_PORT 443
#endif

// ----------------------------------------------------------------------------
// BRANDING
// ----------------------------------------------------------------------------

// Printed once over serial at boot.
#ifndef BRAND_BOOT_BANNER
#define BRAND_BOOT_BANNER "ACME BUZZER"
#endif

// Prefix for a device's default player id, e.g. "ACME_Buzzer_A1B2C3".
// Avoid "Virtual" and "Mobile": the server treats those prefixes as web
// buzzers and gates them behind the host's web-buzzer toggle.
#ifndef BRAND_DEVICE_PREFIX
#define BRAND_DEVICE_PREFIX "ACME_Buzzer"
#endif

// Prefix for the WiFi setup access point, e.g. "ACME-Buzzer-Setup-A1B2C3".
#ifndef BRAND_PORTAL_PREFIX
#define BRAND_PORTAL_PREFIX "ACME-Buzzer-Setup"
#endif

// ----------------------------------------------------------------------------
// SETUP PORTAL PASSWORD
//
// This is the WPA2 password for the temporary setup access point the device
// raises when it has no WiFi credentials. Note what it is and is not:
//   - It is compiled into every device built from this config, so all of
//     your buzzers share it.
//   - A macro in a header is not secret storage. If this repository is
//     public, supply it from the build environment instead of editing it
//     here, and keep it out of version control.
//   - WPA2 requires at least 8 characters.
// ----------------------------------------------------------------------------
#ifndef PORTAL_PASSWORD
#define PORTAL_PASSWORD "acmelovesjeopardy"
#endif

// ----------------------------------------------------------------------------
// BUFFER SIZES
// Declared here so the checks below can verify the values above actually fit.
// ----------------------------------------------------------------------------
#ifndef SERVER_HOST_MAX_LEN
#define SERVER_HOST_MAX_LEN 64
#endif

#ifndef PLAYER_ID_MAX_LEN
#define PLAYER_ID_MAX_LEN 32
#endif

#ifndef PORTAL_SSID_MAX_LEN
#define PORTAL_SSID_MAX_LEN 32
#endif

// ----------------------------------------------------------------------------
// COMPILE-TIME CHECKS
// The firmware copies these strings into fixed buffers with toCharArray() and
// strncpy(), which truncate silently. A name that is too long would otherwise
// only show up as a device that mysteriously fails to connect, so fail the
// build instead. The MAC suffix adds a separator plus 6 hex characters.
// ----------------------------------------------------------------------------
static_assert(sizeof(DEFAULT_SERVER_HOST) <= SERVER_HOST_MAX_LEN,
              "DEFAULT_SERVER_HOST is too long for SERVER_HOST_MAX_LEN.");

static_assert(sizeof(BRAND_DEVICE_PREFIX) + 7 <= PLAYER_ID_MAX_LEN,
              "BRAND_DEVICE_PREFIX is too long: prefix + '_' + 6 hex chars must fit PLAYER_ID_MAX_LEN.");

static_assert(sizeof(BRAND_PORTAL_PREFIX) + 7 <= PORTAL_SSID_MAX_LEN,
              "BRAND_PORTAL_PREFIX is too long: prefix + '-' + 6 hex chars must fit PORTAL_SSID_MAX_LEN.");

// A 32-character SSID is the 802.11 limit.
static_assert(PORTAL_SSID_MAX_LEN <= 32,
              "PORTAL_SSID_MAX_LEN cannot exceed the 32-character 802.11 SSID limit.");

static_assert(sizeof(PORTAL_PASSWORD) >= 9,
              "PORTAL_PASSWORD must be at least 8 characters for WPA2.");

static_assert(DEFAULT_SERVER_PORT > 0 && DEFAULT_SERVER_PORT <= 65535,
              "DEFAULT_SERVER_PORT must be a valid TCP port.");
