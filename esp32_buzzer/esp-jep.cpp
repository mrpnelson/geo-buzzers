#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <sys/time.h>
#include <Adafruit_NeoPixel.h>
#include <WiFiManager.h>
#include <Preferences.h>
#include "esp_mac.h"
#include "esp_timer.h"

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
bool isCalibrated = false;
bool wsConnected = false;

unsigned long lastPeriodicSyncMs = 0;
const unsigned long RESYNC_INTERVAL_MS = 60000;

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
} samples[3];

// ============================================================================
// LED RENDERER
// ============================================================================
uint8_t ledR = 0, ledG = 0, ledB = 0;
bool ledDirty = true;
unsigned long lastLedWriteMs = 0;
const char* ledReason = "boot";

void setLed(uint8_t r, uint8_t g, uint8_t b, const char* reason) {
  if (r == ledR && g == ledG && b == ledB) return;
  ledR = r; ledG = g; ledB = b;
  ledDirty = true;
  ledReason = reason;
  LOG_EVT("[LED] -> rgb(%u,%u,%u)  (%s)\n", r, g, b, reason);
}

void renderLed() {
  unsigned long now = millis();
  if (!ledDirty && (now - lastLedWriteMs) < LED_REFRESH_MS) return;

  for (int i = 0; i < NUM_PIXELS; i++) {
    pixels.setPixelColor(i, pixels.Color(ledR, ledG, ledB));
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
#define LED_FOUL()      setLed(255, 0, 0,     "early press")

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
void IRAM_ATTR handleButtonInterrupt() {
  unsigned long nowMs = millis();
  if (!isLockedOut && (nowMs - lastISRTime > 200)) {
    if (digitalRead(BUTTON_PIN) == LOW) {
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

  lightSequenceActive = true;
  currentLightState = -1;
  hasBuzzedThisRound = false;
  buttonPressed = false;
  isLockedOut = (digitalRead(BUTTON_PIN) == LOW);
  ledTestStep = -1;

  LOG_EVT("[EVENT] SCHEDULED_TIMER_START applied - light sequence ARMED\n");
}

// ============================================================================
// WEBSOCKET EVENT HANDLER
// ============================================================================
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      LOG_EVT("[WS] Disconnected from server.\n");
      wsConnected = false;
      isCalibrated = false;
      lightSequenceActive = false;
      pendingSyncIndex = 0;
      LED_ERROR();
      break;

    case WStype_CONNECTED:
      LOG_EVT("[WS] Connected over SSL! Queuing clock sync...\n");
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

        if (isPeriodic) {
          const double ALPHA = 0.25;
          clockOffsetMs = (int64_t)((ALPHA * offset) + ((1.0 - ALPHA) * (double)clockOffsetMs));
        } else {
          if (sampleIndex < 1 || sampleIndex > 3) return;
          samples[sampleIndex - 1] = { rtt, offset };

          if (sampleIndex < 3) {
            queueSyncSample(sampleIndex + 1, 50);
          } else {
            int bestIdx = 0;
            for (int i = 1; i < 3; i++) {
              if (samples[i].rtt < samples[bestIdx].rtt) bestIdx = i;
            }
            clockOffsetMs = (int64_t)samples[bestIdx].offset;
            isCalibrated = true;
            lastPeriodicSyncMs = millis();

            LOG_EVT("[SYNC] Calibration complete. Offset: %lld ms (best RTT %.2f ms)\n",
                          clockOffsetMs, samples[bestIdx].rtt);

            if (!lightSequenceActive && !hasBuzzedThisRound) LED_STANDBY();
          }
        }
      }

      else if (strcmp(msgType, "SCHEDULED_TIMER_START") == 0) {
        applySchedule(doc["greenTargetTime"].as<int64_t>());
      }

      else if (strcmp(msgType, "PREMATURE_RESET") == 0) {
        hasBuzzedThisRound = false;
        isLockedOut = false;
        buttonPressed = false;
        LOG_EVT("[EVENT] PREMATURE_RESET - re-armed\n");

        if (lightSequenceActive && currentLightState <= 0) {
          currentLightState = -1;
        }
      }

      else if (strcmp(msgType, "ROUND_RESET") == 0) {
        LOG_EVT("[EVENT] ROUND_RESET\n");
        lightSequenceActive = false;
        currentLightState = 0;
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
    LED_ERROR();
    renderLed();
    delay(200);
    return;
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
      if (isCalibrated && !hasBuzzedThisRound) {

        uint64_t conversionUptimeMicros = esp_timer_get_time();
        int64_t conversionEpochMs = getEpochMillis64();

        double timeSincePressMs = (double)(conversionUptimeMicros - rawPressMicros) / 1000.0;
        int64_t pressTimeMs = conversionEpochMs - (int64_t)timeSincePressMs;

        if (lightSequenceActive && (long)(millis() - syncStartMillis) >= 0) {
          hasBuzzedThisRound = true;
        }

        if (lightSequenceActive && (long)(millis() - greenLightMillis) < 0) {
          LED_FOUL();
        } else {
          LED_BUZZED();
        }

        StaticJsonDocument<250> doc;
        doc["type"] = "BUZZ";
        doc["playerId"] = playerId;
        doc["clientPressTime"] = pressTimeMs;
        doc["clockOffset"] = clockOffsetMs;
        doc["rawPressTime"] = (double)(conversionUptimeMicros) / 1000.0;

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
    LOG_VRB("[HB] ws=%d cal=%d seq=%d state=%d buzzed=%d led=rgb(%u,%u,%u) msToGreen=%ld\n",
                  wsConnected ? 1 : 0, isCalibrated ? 1 : 0, lightSequenceActive ? 1 : 0,
                  currentLightState, hasBuzzedThisRound ? 1 : 0,
                  ledR, ledG, ledB,
                  lightSequenceActive ? (long)(int32_t)(greenLightMillis - millis()) : 0L);
  }
}