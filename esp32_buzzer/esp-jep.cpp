#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <sys/time.h>
#include <Adafruit_NeoPixel.h>
#include <WiFiManager.h>
#include <Preferences.h>
#include "esp_mac.h"
#include "esp_timer.h"
#include <driver/gpio.h>

#include "config.h"

// ============================================================================
// CONFIGURATION
// ============================================================================
char wsServerIp[SERVER_HOST_MAX_LEN] = DEFAULT_SERVER_HOST;
char playerId[PLAYER_ID_MAX_LEN]     = "";

// 443 for wss:// behind TLS, 8080 for a plain local server. See config.h.
const int WS_SERVER_PORT = DEFAULT_SERVER_PORT;

// Overwritten in setup() with the MAC-suffixed name from getPortalSsid().
char portalSsid[PORTAL_SSID_MAX_LEN] = BRAND_PORTAL_PREFIX;
const char* PORTAL_PASS              = PORTAL_PASSWORD;

#define BUTTON_PIN   18

// ---------------------------------------------------------------------------
// DO NOT use GPIO25 (or GPIO2) on an ESP32-WROOM-DA.
// Safe alternatives: 4, 13, 16, 17, 19, 21, 22, 23, 26, 27, 32, 33.
// ---------------------------------------------------------------------------
#define NEOPIXEL_PIN 4
#define NUM_PIXELS   1

#if (NEOPIXEL_PIN == 2) || (NEOPIXEL_PIN == 25)
#warning "NEOPIXEL_PIN conflicts with the ESP32-WROOM-DA RF antenna switch (GPIO2/GPIO25)."
#endif
#if (BUTTON_PIN == 2) || (BUTTON_PIN == 25)
#warning "BUTTON_PIN conflicts with the ESP32-WROOM-DA RF antenna switch (GPIO2/GPIO25)."
#endif

// How often the pixel is unconditionally re-driven even if nothing changed.
const unsigned long LED_REFRESH_MS = 400;

// Master brightness, 0-255.
const uint8_t LED_BRIGHTNESS = 50;

// ============================================================================
// SERIAL VERBOSITY
// ============================================================================
#define DEBUG_LEVEL_DEFAULT 0

uint8_t debugLevel = DEBUG_LEVEL_DEFAULT;

#define LOG_ERR(...) do { Serial.printf(__VA_ARGS__); } while (0)
#define LOG_EVT(...) do { if (debugLevel >= 1) Serial.printf(__VA_ARGS__); } while (0)
#define LOG_VRB(...) do { if (debugLevel >= 2) Serial.printf(__VA_ARGS__); } while (0)

void serviceSerialConsole() {
  while (Serial.available()) {
    int c = Serial.read();
    if (c >= '0' && c <= '2') {
      debugLevel = (uint8_t)(c - '0');
      Serial.printf("[LOG] Verbosity -> %u (%s)\n", debugLevel,
                    debugLevel == 0 ? "quiet" : (debugLevel == 1 ? "events" : "verbose"));
    }
  }
}

Adafruit_NeoPixel pixels(NUM_PIXELS, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
Preferences preferences;

bool shouldSaveConfig = false;

void saveConfigCallback() {
  shouldSaveConfig = true;
}

// ============================================================================
// GLOBAL STATE
// ============================================================================
WebSocketsClient webSocket;

volatile bool buttonPressed = false;
volatile uint64_t rawPressMicros = 0;
volatile unsigned long lastISRTime = 0;

bool isLockedOut = false;
unsigned long lockoutStartTime = 0;

int64_t clockOffsetMs = 0;

// The measured offset is only valid for the system clock that was in place
// when it was measured. SNTP lands asynchronously and can step the clock
// long after calibration - and steps it again on its periodic refresh - at
// which point the offset is counted twice and reaction times come back as
// an epoch. These record the clock/uptime relationship at calibration so a
// step can be detected.
int64_t calibEpochMs = 0;
uint32_t calibMillis = 0;
const int64_t CLOCK_STEP_TOLERANCE_MS = 3000;
bool isCalibrated = false;
bool wsConnected = false;

unsigned long lastPeriodicSyncMs = 0;
const unsigned long RESYNC_INTERVAL_MS = 60000;

// Calibration is a chain of three samples, each queued by the previous
// response. A single dropped packet used to break it permanently, leaving a
// buzzer that looked healthy and silently ignored every press. This is the
// watchdog that restarts a stalled burst.
unsigned long lastCalibAttemptMs = 0;
const unsigned long CALIB_RETRY_MS = 5000;

// Only accept the sample we are actually waiting for, so a late reply from
// an abandoned burst cannot be mixed into a newer one.
int inFlightSampleIndex = 0;

// A round ends on the buzzer 60s after the green light even if the host
// never resets. While a sequence is "active" the clock-step detector and
// periodic re-sync are both suppressed, so leaving it set indefinitely let
// the offset age unchecked.
const unsigned long ROUND_LINGER_MS = 60000;

// Identifies the round a schedule belongs to, so a sync burst still in
// flight cannot re-arm a buzzer that has already buzzed.
int64_t appliedGreenTime = 0;

// WiFi recovery escalation.
unsigned long wifiDownSinceMs = 0;
const unsigned long WIFI_RECONNECT_MS = 15000;
const unsigned long WIFI_REBOOT_MS = 60000;

// Deferred sync sends
int pendingSyncIndex = 0;
unsigned long pendingSyncAtMs = 0;

// Hardware millis() targets for the countdown
unsigned long greenLightMillis = 0;
unsigned long syncStartMillis = 0;

bool lightSequenceActive = false;
int currentLightState = -1;
bool hasBuzzedThisRound = false;

// Diagnostics
unsigned long lastHeartbeatMs = 0;
const unsigned long HEARTBEAT_MS = 5000;

struct SyncSample {
  double rtt;
  double offset;
  bool valid;
} samples[3];

// A clock step mid-burst makes (t3 - t0) negative, and the old code picked
// the LOWEST rtt - so the corrupt sample was actively preferred.
const double MIN_PLAUSIBLE_RTT_MS = 0.0;
const double MAX_PLAUSIBLE_RTT_MS = 2000.0;

// ============================================================================
// LED RENDERER
// ============================================================================
uint8_t ledR = 0, ledG = 0, ledB = 0;
bool ledDirty = true;
unsigned long lastLedWriteMs = 0;
const char* ledReason = "boot";

// Flash support. Error, countdown-3 and foul are all the same red, and a
// solid colour cannot distinguish them - a player who jumped the light saw
// no change at all. A flashing pattern separates the foul without needing a
// new colour.
bool ledFlashing = false;
unsigned long ledFlashStartMs = 0;
bool ledFlashPhaseOn = true;
unsigned long ledFlashOnMs = 0;
unsigned long ledFlashOffMs = 0;

void setLed(uint8_t r, uint8_t g, uint8_t b, const char* reason) {
  if (r == ledR && g == ledG && b == ledB && !ledFlashing) {
    // Same colour, but keep the reason current so the serial log and the
    // heartbeat still say which state we are actually in.
    ledReason = reason;
    return;
  }
  ledR = r; ledG = g; ledB = b;
  ledFlashing = false;
  ledDirty = true;
  ledReason = reason;
  LOG_EVT("[LED] -> rgb(%u,%u,%u)  (%s)\n", r, g, b, reason);
}

void setLedFlash(uint8_t r, uint8_t g, uint8_t b,
                 unsigned long onMs, unsigned long offMs, const char* reason) {
  ledR = r; ledG = g; ledB = b;
  ledFlashing = true;
  ledFlashOnMs = onMs;
  ledFlashOffMs = offMs;
  ledFlashStartMs = millis();
  ledFlashPhaseOn = true;
  ledDirty = true;
  ledReason = reason;
  LOG_EVT("[LED] -> rgb(%u,%u,%u) flashing %lu/%lu ms  (%s)\n",
          r, g, b, onMs, offMs, reason);
}

void renderLed() {
  unsigned long now = millis();

  bool showColour = true;
  if (ledFlashing) {
    unsigned long period = ledFlashOnMs + ledFlashOffMs;
    if (period == 0) period = 1;
    showColour = ((now - ledFlashStartMs) % period) < ledFlashOnMs;
    if (showColour != ledFlashPhaseOn) {
      ledFlashPhaseOn = showColour;
      ledDirty = true;
    }
  }

  if (!ledDirty && (now - lastLedWriteMs) < LED_REFRESH_MS) return;

  uint8_t r = showColour ? ledR : 0;
  uint8_t g = showColour ? ledG : 0;
  uint8_t b = showColour ? ledB : 0;

  for (int i = 0; i < NUM_PIXELS; i++) {
    pixels.setPixelColor(i, pixels.Color(r, g, b));
  }
  pixels.show();

  ledDirty = false;
  lastLedWriteMs = now;
}

#define LED_BOOT()      setLed(40, 40, 40,    "boot")
#define LED_PORTAL()    setLed(255, 150, 0,   "config portal")
#define LED_ERROR()     setLed(255, 0, 0,     "error/disconnected")
#define LED_STANDBY()   setLed(255, 0, 255,   "standby (connected)")
#define LED_WAIT()      setLed(0, 0, 255,     "wait phase")
#define LED_CD_RED()    setLed(255, 0, 0,     "countdown 3")
#define LED_CD_PURPLE() setLed(128, 0, 255,   "countdown 2")
#define LED_CD_ORANGE() setLed(255, 100, 0,   "countdown 1")
#define LED_LIVE()      setLed(0, 255, 0,     "LIVE")
#define LED_BUZZED()    setLed(58, 103, 173,  "buzzed")
// ~4 Hz red strobe, distinct from solid error red and solid countdown red.
const unsigned long FOUL_FLASH_ON_MS  = 120;
const unsigned long FOUL_FLASH_OFF_MS = 120;
#define LED_FOUL()      setLedFlash(255, 0, 0, FOUL_FLASH_ON_MS, FOUL_FLASH_OFF_MS, "early press (foul)")

int ledTestStep = -1;
unsigned long ledTestNextMs = 0;

void startLedTest() {
  ledTestStep = 0;
  ledTestNextMs = millis();
  LOG_EVT("[LED] Self-test starting\n");
}

bool serviceLedTest() {
  if (ledTestStep < 0) return false;
  if ((long)(millis() - ledTestNextMs) < 0) return true;

  switch (ledTestStep) {
    case 0: setLed(255, 0, 0,   "test red");    break;
    case 1: setLed(128, 0, 255, "test purple"); break;
    case 2: setLed(255, 100, 0, "test orange"); break;
    case 3: setLed(0, 255, 0,   "test green");  break;
    default:
      ledTestStep = -1;
      LOG_EVT("[LED] Self-test complete\n");
      if (!lightSequenceActive) {
        if (wsConnected) LED_STANDBY(); else LED_BOOT();
      }
      return false;
  }
  ledTestStep++;
  ledTestNextMs = millis() + 500;
  return true;
}

// ============================================================================
// HELPER: READ eFuse HARDWARE MAC ADDRESS
// ============================================================================
String getMacSuffix() {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char macSuffix[7];
  snprintf(macSuffix, sizeof(macSuffix), "%02X%02X%02X", mac[3], mac[4], mac[5]);
  return String(macSuffix);
}

String getDefaultPlayerId() {
  return BRAND_DEVICE_PREFIX "_" + getMacSuffix();
}

String getPortalSsid() {
  return BRAND_PORTAL_PREFIX "-" + getMacSuffix();
}

// ============================================================================
// INTERRUPT SERVICE ROUTINE
// ============================================================================
// gpio_get_level() is IRAM-resident; Arduino's digitalRead() is not, and
// can panic if a press lands while flash is busy (an NVS write, say).
static inline bool IRAM_ATTR buttonIsDownFromISR() {
  return gpio_get_level((gpio_num_t)BUTTON_PIN) == 0;
}

void IRAM_ATTR handleButtonInterrupt() {
  unsigned long nowMs = millis();
  if (!isLockedOut && (nowMs - lastISRTime > 200)) {
    if (buttonIsDownFromISR()) {
      rawPressMicros = esp_timer_get_time();
      buttonPressed = true;
      isLockedOut = true;
      lastISRTime = nowMs;
    }
  }
}

int64_t getEpochMillis64() {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return ((int64_t)tv.tv_sec * 1000LL) + ((int64_t)tv.tv_usec / 1000LL);
}

int64_t getEpochMicros64() {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return ((int64_t)tv.tv_sec * 1000000LL) + (int64_t)tv.tv_usec;
}

void startSyncSample(int index, bool isBackground = false) {
  if (isBackground) {
    lastPeriodicSyncMs = millis();
  }

  StaticJsonDocument<200> doc;
  doc["type"] = "SYNC_REQUEST";
  doc["t0"] = getEpochMillis64();
  doc["playerId"] = playerId;
  doc["sampleIndex"] = index;
  doc["isPeriodic"] = isBackground;
  doc["calibrated"] = isCalibrated;
  if (isCalibrated) doc["clockOffset"] = clockOffsetMs;

  inFlightSampleIndex = index;
  if (index == 1 && !isBackground) lastCalibAttemptMs = millis();

  String output;
  serializeJson(doc, output);
  webSocket.sendTXT(output);

  LOG_VRB("[SYNC] Sent SYNC_REQUEST (sample %d, periodic=%d)\n", index, isBackground ? 1 : 0);
}

void queueSyncSample(int index, unsigned long delayMs) {
  pendingSyncIndex = index;
  pendingSyncAtMs = millis() + delayMs;
}

// ============================================================================
// SCHEDULE HANDLING
// ============================================================================
void applySchedule(int64_t serverGreenTime) {
  // The server re-sends SCHEDULED_TIMER_START in reply to any SYNC_REQUEST
  // while a round is pending, so samples still in flight can land mid-round.
  // Re-applying the same round must refresh the timing without clearing the
  // buzz state, or a player who has already buzzed gets re-armed.
  bool sameRound = (appliedGreenTime != 0 && serverGreenTime == appliedGreenTime);

  int64_t nowEpoch = getEpochMillis64();
  int64_t msUntilGreen = serverGreenTime - (nowEpoch + clockOffsetMs);

  LOG_VRB("[SCHED] serverGreen=%lld nowEpoch=%lld offset=%lld -> msUntilGreen=%lld (calibrated=%d)\n",
                serverGreenTime, nowEpoch, clockOffsetMs, msUntilGreen, isCalibrated ? 1 : 0);

  if (msUntilGreen < 0 || msUntilGreen > 30000) {
    LOG_ERR("[SCHED] Implausible offset - falling back to fixed 8000 ms\n");
    msUntilGreen = 8000;
  }

  greenLightMillis = millis() + (unsigned long)msUntilGreen;
  syncStartMillis  = greenLightMillis - 3000;
  appliedGreenTime = serverGreenTime;

  lightSequenceActive = true;
  ledTestStep = -1;

  if (sameRound) {
    LOG_EVT("[EVENT] SCHEDULED_TIMER_START re-applied for the same round - "
            "timing refreshed, buzz state kept\n");
    return;
  }

  currentLightState = -1;
  hasBuzzedThisRound = false;
  buttonPressed = false;
  isLockedOut = (digitalRead(BUTTON_PIN) == LOW);

  LOG_EVT("[EVENT] SCHEDULED_TIMER_START applied - light sequence ARMED\n");
}

// ============================================================================
// WEBSOCKET EVENT HANDLER
// ============================================================================
// Connection stability diagnostics. A WebSocket that dies at a fixed
// interval points at an infrastructure timeout rather than the app; these
// counters turn "it drops periodically" into a measured number.
static uint32_t wsConnectedAtMs   = 0;
static uint32_t wsDisconnectCount = 0;

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED: {
      wsDisconnectCount++;
      uint32_t heldSec = wsConnectedAtMs ? (millis() - wsConnectedAtMs) / 1000 : 0;
      LOG_EVT("[WS] Disconnected. Held %lus, drop #%lu, RSSI %d dBm, heap %u\n",
              (unsigned long)heldSec, (unsigned long)wsDisconnectCount,
              WiFi.RSSI(), (unsigned)ESP.getFreeHeap());
      wsConnectedAtMs = 0;
      wsConnected = false;
      isCalibrated = false;
      lightSequenceActive = false;
      pendingSyncIndex = 0;
      LED_ERROR();
      break;
    }

    case WStype_CONNECTED:
      wsConnectedAtMs = millis();
      LOG_EVT("[WS] Connected over SSL! WiFi %s, RSSI %d dBm, heap %u\n",
              WiFi.status() == WL_CONNECTED ? "up" : "DOWN",
              WiFi.RSSI(), (unsigned)ESP.getFreeHeap());
      wsConnected = true;
      if (!lightSequenceActive) LED_STANDBY();
      queueSyncSample(1, 100);
      break;

    case WStype_TEXT: {
      LOG_VRB("[RX %u] %.*s\n", (unsigned)length, (int)length, (const char*)payload);

      StaticJsonDocument<1024> doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) {
        LOG_ERR("[RX] parse failed: %s\n", err.c_str());
        return;
      }

      const char* msgType = doc["type"];
      if (!msgType) return;

      if (strcmp(msgType, "SYNC_RESPONSE") == 0) {
        int64_t t3 = getEpochMillis64();
        int64_t t0 = doc["t0"].as<int64_t>();
        int64_t t1 = doc["t1"].as<int64_t>();
        int64_t t2 = doc["t2"].as<int64_t>();
        int sampleIndex = doc["sampleIndex"] | 0;
        bool isPeriodic = doc["isPeriodic"] | false;

        if (t0 <= 0 || t1 <= 0 || t2 <= 0 || t3 <= 0) return;

        double rtt = (double)((t3 - t0) - (t2 - t1));
        double offset = (double)(((t1 - t0) + (t2 - t3)) / 2.0);
        bool rttPlausible = (rtt >= MIN_PLAUSIBLE_RTT_MS && rtt <= MAX_PLAUSIBLE_RTT_MS);

        if (!isPeriodic && sampleIndex != inFlightSampleIndex) {
          LOG_VRB("[SYNC] Ignoring stale sample %d (waiting for %d)\n",
                  sampleIndex, inFlightSampleIndex);
          return;
        }

        if (isPeriodic) {
          if (!rttPlausible) {
            LOG_VRB("[SYNC] Discarding periodic sample, RTT %.1f ms implausible\n", rtt);
            return;
          }
          const double ALPHA = 0.25;
          clockOffsetMs = (int64_t)((ALPHA * offset) + ((1.0 - ALPHA) * (double)clockOffsetMs));
          calibEpochMs = getEpochMillis64();
          calibMillis = millis();
        } else {
          if (sampleIndex < 1 || sampleIndex > 3) return;
          samples[sampleIndex - 1] = { rtt, offset, rttPlausible };
          if (!rttPlausible) {
            LOG_VRB("[SYNC] Sample %d rejected, RTT %.1f ms implausible\n", sampleIndex, rtt);
          }

          if (sampleIndex < 3) {
            queueSyncSample(sampleIndex + 1, 50);
          } else {
            int bestIdx = -1;
            for (int i = 0; i < 3; i++) {
              if (!samples[i].valid) continue;
              if (bestIdx < 0 || samples[i].rtt < samples[bestIdx].rtt) bestIdx = i;
            }

            if (bestIdx < 0) {
              LOG_ERR("[SYNC] All three samples were implausible - restarting burst.\n");
              lastCalibAttemptMs = 0;   // let the watchdog retry immediately
              return;
            }

            clockOffsetMs = (int64_t)samples[bestIdx].offset;
            isCalibrated = true;
            lastPeriodicSyncMs = millis();
            calibEpochMs = getEpochMillis64();
            calibMillis = millis();

            LOG_EVT("[SYNC] Calibration complete. Offset: %lld ms (best RTT %.2f ms)\n",
                          clockOffsetMs, samples[bestIdx].rtt);
            if (llabs(clockOffsetMs) > 60000LL) {
              LOG_ERR("[SYNC] Offset is implausibly large - local clock is unset. "
                      "Waiting for NTP to land, then re-calibrating.\n");
            }

            if (!lightSequenceActive && !hasBuzzedThisRound) LED_STANDBY();
          }
        }
      }

      else if (strcmp(msgType, "SCHEDULED_TIMER_START") == 0) {
        applySchedule(doc["greenTargetTime"].as<int64_t>());
      }

      else if (strcmp(msgType, "CLOCK_ERROR") == 0) {
        LOG_ERR("[CLOCK] Server rejected our timestamp as implausible. Re-calibrating.\n");
        isCalibrated = false;
        clockOffsetMs = 0;
        pendingSyncIndex = 0;
        queueSyncSample(1, 50);
      }

      else if (strcmp(msgType, "PREMATURE_RESET") == 0) {
        hasBuzzedThisRound = false;
        buttonPressed = false;
        // isLockedOut is deliberately NOT cleared here. It used to be, which
        // re-armed the buzzer while the button was still physically down. The
        // contact bounce (or chatter) when that held button was released then
        // looked like a brand new press, and if it landed after green it
        // scored as a win - so pressing early and holding was a way to buzz
        // first. The lock now stays until the loop below sees the button
        // released and stable for 150 ms, and only a press that starts after
        // that can count.
        LOG_EVT("[EVENT] PREMATURE_RESET - re-armed once the button is released\n");

        if (lightSequenceActive && currentLightState <= 0) {
          currentLightState = -1;
        }
      }

      else if (strcmp(msgType, "ROUND_RESET") == 0) {
        LOG_EVT("[EVENT] ROUND_RESET\n");
        lightSequenceActive = false;
        currentLightState = -1;
        appliedGreenTime = 0;
        hasBuzzedThisRound = false;
        buttonPressed = false;
        isLockedOut = (digitalRead(BUTTON_PIN) == LOW);
        LED_STANDBY();
        queueSyncSample(1, 50);
      }

      else if (strcmp(msgType, "LED_TEST") == 0) {
        LOG_EVT("[EVENT] LED_TEST requested by host\n");
        if (!lightSequenceActive) startLedTest();
      }

      break;
    }

    default:
      break;
  }
}

// ============================================================================
// SETUP
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("\n=== BOOTING %s ===\n", BRAND_BOOT_BANNER);
  Serial.printf("Log level %u. Type 1 (events) or 2 (verbose) to raise it.\n", debugLevel);

  String defaultId = getDefaultPlayerId();
  String dynamicPortalSsid = getPortalSsid();
  dynamicPortalSsid.toCharArray(portalSsid, sizeof(portalSsid));

  preferences.begin("buzzer-config", false);

  String savedPlayerId = preferences.getString("player_id", defaultId);
  savedPlayerId.toCharArray(playerId, sizeof(playerId));
  playerId[sizeof(playerId) - 1] = '\0';

  String savedServerIp = preferences.getString("server_ip", DEFAULT_SERVER_HOST);
  savedServerIp.toCharArray(wsServerIp, sizeof(wsServerIp));
  wsServerIp[sizeof(wsServerIp) - 1] = '\0';

  pixels.begin();
  pixels.clear();
  pixels.show();
  pixels.setBrightness(LED_BRIGHTNESS);

  const uint32_t bootTest[4][3] = {{255,0,0},{128,0,255},{255,100,0},{0,255,0}};
  for (int i = 0; i < 4; i++) {
    pixels.setPixelColor(0, pixels.Color(bootTest[i][0], bootTest[i][1], bootTest[i][2]));
    pixels.show();
    delay(300);
  }
  LOG_EVT("[LED] Boot self-test done (red/purple/orange/green)\n");

  LED_BOOT();
  renderLed();

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  delay(100);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  WiFiManager wm;
  wm.setDebugOutput(false);
  wm.setSaveConfigCallback(saveConfigCallback);

  WiFiManagerParameter custom_player_id("player_id", "Player ID / Name", playerId, 32);
  WiFiManagerParameter custom_server_ip("server_ip", "WebSocket Server Host/IP", wsServerIp, 64);

  wm.addParameter(&custom_player_id);
  wm.addParameter(&custom_server_ip);

  if (digitalRead(BUTTON_PIN) == LOW) {
    LED_PORTAL();
    renderLed();
    wm.resetSettings();
    preferences.clear();
    delay(1500);
    LED_BOOT();
    renderLed();
    defaultId.toCharArray(playerId, sizeof(playerId));
    strcpy(wsServerIp, DEFAULT_SERVER_HOST);
  }

  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect(portalSsid, PORTAL_PASS)) {
    LED_ERROR();
    renderLed();
    delay(2000);
    ESP.restart();
  }

  LOG_EVT("[NET] WiFi up. IP: %s  Target: %s:%d\n",
                WiFi.localIP().toString().c_str(), wsServerIp, WS_SERVER_PORT);

  LOG_VRB("[LED] Post-WiFi pixel check on GPIO%d\n", NEOPIXEL_PIN);
  pixels.setPixelColor(0, pixels.Color(0, 0, 255));
  pixels.show();
  delay(400);
  ledDirty = true;

  if (shouldSaveConfig) {
    strncpy(playerId, custom_player_id.getValue(), sizeof(playerId) - 1);
    playerId[sizeof(playerId) - 1] = '\0';
    strncpy(wsServerIp, custom_server_ip.getValue(), sizeof(wsServerIp) - 1);
    wsServerIp[sizeof(wsServerIp) - 1] = '\0';
    preferences.putString("player_id", playerId);
    preferences.putString("server_ip", wsServerIp);
  }

  // --- SAFE NTP & CLOCK INITIALIZATION ---
  LOG_VRB("[NTP] Initializing epoch clock...\n");
  delay(200); // Allow LwIP thread locks to settle post-WiFiManager

  setenv("TZ", "UTC0", 1);
  tzset();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  time_t now = 0;
  int ntpRetry = 0;
  while (now < 1600000000 && ntpRetry < 10) {
    delay(300);
    time(&now);
    ntpRetry++;
  }

  if (now > 1600000000) {
    LOG_EVT("[NTP] Clock synchronized successfully. Epoch: %lld\n", (long long)now);
  } else {
    LOG_ERR("[NTP] Sync timed out - continuing with WS server clock offset.\n");
  }

  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), handleButtonInterrupt, FALLING);

  // --- SECURE WEBSOCKET INIT (WSS / PORT 443) ---
  webSocket.beginSSL(wsServerIp, WS_SERVER_PORT, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(3000);
  webSocket.enableHeartbeat(15000, 5000, 2);
}

// ============================================================================
// MAIN LOOP
// ============================================================================
void loop() {
  webSocket.loop();
  serviceSerialConsole();

  if (WiFi.status() != WL_CONNECTED) {
    if (wifiDownSinceMs == 0) {
      wifiDownSinceMs = millis();
      LOG_ERR("[NET] WiFi lost - waiting for auto-reconnect.\n");
    }
    unsigned long downFor = millis() - wifiDownSinceMs;

    // Escalate rather than sitting on red forever.
    if (downFor > WIFI_REBOOT_MS) {
      LOG_ERR("[NET] WiFi down %lus - restarting.\n", downFor / 1000);
      delay(100);
      ESP.restart();
    } else if (downFor > WIFI_RECONNECT_MS && (downFor % 5000) < 220) {
      LOG_ERR("[NET] WiFi down %lus - forcing reconnect.\n", downFor / 1000);
      WiFi.reconnect();
    }

    LED_ERROR();
    renderLed();
    delay(200);
    return;
  }
  if (wifiDownSinceMs != 0) {
    LOG_EVT("[NET] WiFi recovered after %lus\n", (millis() - wifiDownSinceMs) / 1000);
    wifiDownSinceMs = 0;
  }

  // End the round on the buzzer even if the host never resets, so the
  // clock-step detector and periodic re-sync below come back into play.
  if (lightSequenceActive && (long)(millis() - greenLightMillis) > (long)ROUND_LINGER_MS) {
    LOG_EVT("[EVENT] Round linger expired %lus after green - sequence ended\n",
            ROUND_LINGER_MS / 1000);
    lightSequenceActive = false;
    currentLightState = -1;
    if (!hasBuzzedThisRound && wsConnected) LED_STANDBY();
  }

  // Restart a calibration burst that stalled on a dropped response. Without
  // this, one lost packet left the buzzer permanently uncalibrated.
  if (wsConnected && !isCalibrated && pendingSyncIndex == 0 &&
      (millis() - lastCalibAttemptMs) > CALIB_RETRY_MS) {
    LOG_ERR("[SYNC] Calibration stalled - restarting burst.\n");
    queueSyncSample(1, 0);
    lastCalibAttemptMs = millis();
  }

  // If the system clock has stepped since calibration, every timestamp we
  // derive from it is wrong by the size of the step. Throw the offset away
  // and re-measure rather than reporting a nonsense reaction time.
  if (isCalibrated && !lightSequenceActive) {
    int64_t expectedEpoch = calibEpochMs + (int64_t)(millis() - calibMillis);
    int64_t drift = getEpochMillis64() - expectedEpoch;
    if (llabs(drift) > CLOCK_STEP_TOLERANCE_MS) {
      LOG_ERR("[CLOCK] System clock stepped %lld ms (NTP landed or refreshed). "
              "Discarding stale offset %lld ms and re-calibrating.\n",
              drift, clockOffsetMs);
      isCalibrated = false;
      clockOffsetMs = 0;
      pendingSyncIndex = 0;
      queueSyncSample(1, 50);
    }
  }

  if (pendingSyncIndex > 0 && (long)(millis() - pendingSyncAtMs) >= 0) {
    int idx = pendingSyncIndex;
    pendingSyncIndex = 0;
    startSyncSample(idx, false);
  }

  if (isCalibrated && !lightSequenceActive && (millis() - lastPeriodicSyncMs > RESYNC_INTERVAL_MS)) {
    startSyncSample(1, true);
  }

  bool testOwnsLed = serviceLedTest();

  if (!testOwnsLed && lightSequenceActive && !hasBuzzedThisRound) {
    int32_t msUntilLive = (int32_t)(greenLightMillis - millis());

    if (msUntilLive > 3000) {
      if (currentLightState != 0) { currentLightState = 0; LED_WAIT(); }
    }
    else if (msUntilLive > 2000) {
      if (currentLightState != 1) { currentLightState = 1; LED_CD_RED(); }
    }
    else if (msUntilLive > 1000) {
      if (currentLightState != 2) { currentLightState = 2; LED_CD_PURPLE(); }
    }
    else if (msUntilLive > 0) {
      if (currentLightState != 3) { currentLightState = 3; LED_CD_ORANGE(); }
    }
    else {
      if (currentLightState != 4) { currentLightState = 4; LED_LIVE(); }
    }
  }

  if (buttonPressed) {
    buttonPressed = false;

    if (digitalRead(BUTTON_PIN) == LOW || isLockedOut) {
      // Not gated on isCalibrated any more. A press must never be silently
      // swallowed; the server validates the timestamp and rejects it if the
      // offset is stale, which is better feedback than nothing happening.
      if (!hasBuzzedThisRound) {
        if (!isCalibrated) {
          LOG_ERR("[BUZZ] Sending while uncalibrated - server will arbitrate.\n");
        }

        // Read the uptime and epoch clocks back to back so the press time is
        // derived from one instant. Microseconds all the way: the old
        // millisecond arithmetic truncated twice and put two humans who
        // pressed within a millisecond of each other on an identical time.
        uint64_t conversionUptimeMicros = esp_timer_get_time();
        int64_t conversionEpochUs = getEpochMicros64();

        int64_t pressTimeUs = conversionEpochUs - (int64_t)(conversionUptimeMicros - rawPressMicros);
        int64_t pressTimeMs = pressTimeUs / 1000;   // kept for servers that predate clientPressTimeUs

        if (lightSequenceActive && (long)(millis() - syncStartMillis) >= 0) {
          hasBuzzedThisRound = true;
        }

        if (lightSequenceActive && (long)(millis() - greenLightMillis) < 0) {
          LED_FOUL();
        } else {
          LED_BUZZED();
        }

        StaticJsonDocument<300> doc;   // was 250; clientPressTimeUs added a field
        doc["type"] = "BUZZ";
        doc["playerId"] = playerId;
        doc["clientPressTime"] = pressTimeMs;
        doc["clientPressTimeUs"] = pressTimeUs;
        doc["clockOffset"] = clockOffsetMs;
        doc["calibrated"] = isCalibrated;

        String output;
        serializeJson(doc, output);
        webSocket.sendTXT(output);
      }
    } else {
      isLockedOut = false;
    }
  }

  if (isLockedOut && digitalRead(BUTTON_PIN) == HIGH) {
    if (lockoutStartTime == 0) {
      lockoutStartTime = millis();
    } else if (millis() - lockoutStartTime > 150) {
      isLockedOut = false;
      lockoutStartTime = 0;
    }
  } else if (digitalRead(BUTTON_PIN) == LOW) {
    lockoutStartTime = 0;
  }

  renderLed();

  if (debugLevel >= 2 && millis() - lastHeartbeatMs > HEARTBEAT_MS) {
    lastHeartbeatMs = millis();
    LOG_VRB("[HB] ws=%d cal=%d seq=%d state=%d buzzed=%d led=rgb(%u,%u,%u) msToGreen=%ld"
                  " up=%lus drops=%lu rssi=%d heap=%u\n",
                  wsConnected ? 1 : 0, isCalibrated ? 1 : 0, lightSequenceActive ? 1 : 0,
                  currentLightState, hasBuzzedThisRound ? 1 : 0,
                  ledR, ledG, ledB,
                  lightSequenceActive ? (long)(int32_t)(greenLightMillis - millis()) : 0L,
                  (unsigned long)(wsConnectedAtMs ? (millis() - wsConnectedAtMs) / 1000 : 0),
                  (unsigned long)wsDisconnectCount,
                  WiFi.RSSI(), (unsigned)ESP.getFreeHeap());
  }
}