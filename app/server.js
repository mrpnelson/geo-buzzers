const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const WebSocket = require('ws');
const parseArgs = require('minimist');

// ====================================================================
// BRANDING CONFIGURATION
// Everything organization-specific lives in config.json. These are the
// fallbacks used when a key is missing, so a partial config file is fine
// and a deleted one still boots with neutral, unbranded text.
//
// Strings may use tokens, resolved once at startup:
//   {org}         organizationName               e.g. "Acme"
//   {product}     productName                    e.g. "Quiz Night!"
//   {productBase} productName minus trailing !?. e.g. "Quiz Night"
//   {app}         "{org} {product}"              e.g. "Acme Quiz Night!"
//   {appBase}     "{org} {productBase}"          e.g. "Acme Quiz Night"
// ====================================================================
const DEFAULT_CONFIG = {
  brand: {
    organizationName: '',
    // A game-name placeholder, since the copy templates below read as
    // "<product> Buzzer Console Portal" / "<product> Host Console".
    productName: 'Quiz',
    mascot: '🔔',
    accentColor: '#ff6900',
    storagePrefix: 'buzzer'
  },
  portal: {
    title: '{app} Portal',
    heading: '{app}',
    subtitle: '{productBase} Buzzer Console Portal',
    footer: '{appBase} System • Hardware & Cloud Synchronized'
  },
  pages: {
    host:    { title: '{app} Host Console',        heading: '{app} Host Console' },
    mobile:  { title: '{app} Mobile Host Console', heading: 'Host Mobile' },
    tv:      { title: '{app} TV Display',          heading: '{app}' },
    virtual: { title: '{org} Virtual Buzzer',      heading: 'Virtual Buzzer' }
  }
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Only overwrite keys the config file actually supplies.
function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isPlainObject(override)) return out;
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined || v === null) continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function resolveTokens(cfg) {
  const b = cfg.brand || {};
  const org = String(b.organizationName || '').trim();
  const product = String(b.productName || '').trim();
  const productBase = product.replace(/[!?.]+$/, '').trim();

  const tokens = {
    org,
    product,
    productBase,
    app: [org, product].filter(Boolean).join(' '),
    appBase: [org, productBase].filter(Boolean).join(' ')
  };

  const fill = (val) => {
    if (typeof val === 'string') {
      return val.replace(/\{(org|product|productBase|app|appBase)\}/g,
        (match, key) => tokens[key]).replace(/\s+/g, ' ').trim();
    }
    if (isPlainObject(val)) {
      const out = {};
      for (const [k, v] of Object.entries(val)) out[k] = fill(v);
      return out;
    }
    return val;
  };

  // Brand values are literals, never templates - only the display copy
  // gets token substitution.
  return { brand: cfg.brand, portal: fill(cfg.portal), pages: fill(cfg.pages) };
}

function loadConfig() {
  const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
  let fileConfig = {};

  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`[CONFIG] Branding loaded from ${configPath}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`[CONFIG] No config file at ${configPath} - using built-in defaults.`);
    } else {
      console.error(`[CONFIG] Could not use ${configPath} (${err.message}) - using built-in defaults.`);
    }
  }

  return resolveTokens(deepMerge(DEFAULT_CONFIG, fileConfig));
}

const CONFIG = loadConfig();

function escapeHtml(str) {
  return String(str === undefined || str === null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escape so the payload cannot break out of the <script> element it lands in.
function toInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// The pages are static files, so branding is injected as window.APP_CONFIG
// just before </head>. That runs before each page's own script, which
// matters for virtual.html: it reads its localStorage keys at top level and
// those keys are derived from the configured storage prefix.
const PAGE_FILES = { host: 'main.html', mobile: 'mobile.html', tv: 'tv.html', virtual: 'virtual.html' };
const pageCache = new Map();

function renderPage(pageKey) {
  if (pageCache.has(pageKey)) return pageCache.get(pageKey);

  const filePath = path.join(__dirname, 'public', PAGE_FILES[pageKey]);
  let html = fs.readFileSync(filePath, 'utf8');

  const payload = { brand: CONFIG.brand, page: CONFIG.pages[pageKey] || {} };
  const tag = `<script>window.APP_CONFIG=${toInlineJson(payload)};</script>`;

  if (html.includes('</head>')) {
    html = html.replace('</head>', `  ${tag}\n</head>`);
  } else {
    console.warn(`[CONFIG] ${PAGE_FILES[pageKey]} has no </head>; branding not injected.`);
  }

  pageCache.set(pageKey, html);
  return html;
}

function sendPage(res, pageKey) {
  try {
    res.type('html').send(renderPage(pageKey));
  } catch (err) {
    console.error(`[HTTP] Failed to serve ${PAGE_FILES[pageKey]}: ${err.message}`);
    res.status(500).send('Page unavailable. Check the server logs.');
  }
}

// Parse CLI arguments (--pin=1234) or environment variables
const args = parseArgs(process.argv.slice(2));
const ADMIN_PIN = args.pin || process.env.ADMIN_PIN || null;

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const GRACE_TOLERANCE_MS = 120;
// How far the server's own receive time may sit outside the light sequence
// before we stop believing a press really happened during the countdown.
const ARRIVAL_TOLERANCE_MS = 1000;

let gameState = {
  timerStarted: false,
  timerStartTime: null, 
  syncStartTime: null,  
  buzzes: [],
  fouls: [],
  connectedDevices: new Map(),
  deviceMappings: new Map(),
  bcpEnabled: false, // NEW: BCP Web Buzzer Control (Off by default)
  virtualBuzzersEnabled: false, // NEW: Default to disabled
  teams: {
    1: { teamName: 'Team 1' },
    2: { teamName: 'Team 2' },
    3: { teamName: 'Team 3' },
    4: { teamName: 'Team 4' }
  }
};

// ============================================================================
// REST API ROUTES & PORTAL LANDING HUB
// ============================================================================

// Check if server is running with PIN protection
app.get('/api/auth-status', (req, res) => {
  res.json({ pinRequired: !!ADMIN_PIN });
});

// Verify PIN REST endpoint
app.post('/api/verify-pin', (req, res) => {
  const { pin } = req.body;
  if (!ADMIN_PIN || String(pin) === String(ADMIN_PIN)) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, error: 'Invalid PIN' });
});

// Root Landing Page Portal (Served at GET /)
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escapeHtml(CONFIG.portal.title)}</title>
      <style>
        :root {
          --bg-dark: #161719;
          --card-bg: #222426;
          --card-border: #34373b;
          --accent-orange: ${escapeHtml(CONFIG.brand.accentColor)};
          --text-white: #ffffff;
          --text-muted: #9ea0a4;
          --text-sub: #8a8d91;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          background: radial-gradient(circle at center top, #2d2016 0%, var(--bg-dark) 65%);
          color: var(--text-white);
          font-family: system-ui, -apple-system, sans-serif;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          padding: 30px 20px;
        }

        header {
          text-align: center;
          margin-bottom: 40px;
        }

        h1 {
          color: var(--accent-orange);
          font-size: 2.5rem;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 8px;
        }

        .subtitle {
          color: var(--text-sub);
          font-size: 1rem;
          font-weight: 500;
        }

        .portal-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          grid-auto-rows: 1fr;
          gap: 24px;
          max-width: 760px;
          width: 100%;
          margin-bottom: 40px;
        }

        .portal-card {
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: 16px;
          padding: 36px 24px 28px 24px;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
          transition: transform 0.2s ease, border-color 0.2s ease;
        }

        .portal-card:hover {
          transform: translateY(-4px);
          border-color: #4a4e54;
        }

        .card-icon {
          font-size: 2.8rem;
          margin-bottom: 20px;
          line-height: 1;
        }

        .card-title {
          font-size: 1.25rem;
          font-weight: 800;
          color: var(--text-white);
          margin-bottom: 12px;
        }

        .card-desc {
          font-size: 0.88rem;
          color: #a0a3a8;
          line-height: 1.45;
          margin-bottom: 28px;
          flex-grow: 1;
        }

        .btn-launch {
          display: inline-block;
          padding: 10px 24px;
          border-radius: 20px;
          background: #2b2e31;
          color: #d0d3d8;
          border: 1px solid #3d4146;
          text-decoration: none;
          font-size: 0.75rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          transition: all 0.2s ease;
        }

        .btn-launch:hover {
          background: var(--accent-orange);
          color: #ffffff;
          border-color: var(--accent-orange);
          box-shadow: 0 4px 14px rgba(255, 105, 0, 0.35);
        }

        footer {
          color: #585b60;
          font-size: 0.8rem;
          font-weight: 600;
          letter-spacing: 0.02em;
        }

        @media (max-width: 820px) {
          .portal-grid {
            grid-template-columns: 1fr;
            grid-auto-rows: auto;
            max-width: 420px;
            gap: 16px;
          }
          .portal-card { padding: 24px 20px 20px 20px; }
          .card-icon { font-size: 2.2rem; margin-bottom: 12px; }
          .card-desc { margin-bottom: 20px; }
          h1 { font-size: 2rem; }
        }
      </style>
    </head>
    <body>

      <header>
        <h1>${escapeHtml(CONFIG.portal.heading)}</h1>
        <div class="subtitle">${escapeHtml(CONFIG.portal.subtitle)}</div>
      </header>

      <div class="portal-grid">
        <div class="portal-card">
          <div class="card-icon">💻</div>
          <div class="card-title">Web Console</div>
          <div class="card-desc">Full control panel with live reaction times, player assignment mapping, and event logs.</div>
          <a href="/host" class="btn-launch">LAUNCH MAIN</a>
        </div>

        <div class="portal-card">
          <div class="card-icon">📲</div>
          <div class="card-title">Mobile Console</div>
          <div class="card-desc">Host controls, team naming, and buzzer assignment in a layout built for phones and tablets.</div>
          <a href="/mm" class="btn-launch">LAUNCH MOBILE</a>
        </div>

        <div class="portal-card">
          <div class="card-icon">📺</div>
          <div class="card-title">Venue TV Display</div>
          <div class="card-desc">High-contrast, large-format layout designed for 1080p monitors, TVs, and projectors.</div>
          <a href="/tv" class="btn-launch">LAUNCH TV VIEW</a>
        </div>

        <div class="portal-card">
          <div class="card-icon">🔔</div>
          <div class="card-title">Virtual Buzzer</div>
          <div class="card-desc">Play without hardware. Turn a phone into a synchronized buzzer once the host enables web buzzers.</div>
          <a href="/virtual" class="btn-launch">LAUNCH VIRTUAL</a>
        </div>
      </div>

      <footer>
        ${escapeHtml(CONFIG.portal.footer)}
      </footer>

    </body>
    </html>
  `);
});

// Explicit Page Endpoints
app.get('/tv', (req, res) => sendPage(res, 'tv'));
app.get('/host', (req, res) => sendPage(res, 'host'));
app.get('/mm', (req, res) => sendPage(res, 'mobile')); // Mobile management console
app.get('/virtual', (req, res) => sendPage(res, 'virtual'));

// Direct .html paths resolve to the same branded output; without these,
// express.static below would hand back the raw, unbranded file.
app.get('/tv.html', (req, res) => sendPage(res, 'tv'));
app.get('/main.html', (req, res) => sendPage(res, 'host'));
app.get('/mobile.html', (req, res) => sendPage(res, 'mobile'));
app.get('/virtual.html', (req, res) => sendPage(res, 'virtual'));

// Read-only view of the resolved branding, handy for debugging a deployment.
app.get('/api/config', (req, res) => res.json(CONFIG));

// Serve static assets without auto-serving index.html on root
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Helper to check PIN authorization on incoming WS admin messages
function isAuthorized(providedPin) {
  if (!ADMIN_PIN) return true;
  return String(providedPin) === String(ADMIN_PIN);
}

console.log(`\n==================================================`);
console.log(`Buzzer Server running on port ${PORT}`);
if (ADMIN_PIN) {
  console.log(`[AUTH] Host actions locked behind PIN: ${ADMIN_PIN}`);
} else {
  console.log(`[AUTH] Running WITHOUT PIN protection (Pass --pin=XXXX to lock)`);
}
console.log(`==================================================\n`);

// Ping/Pong Keep-Alive check (30 seconds)
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      handleSocketDisconnect(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

function handleSocketDisconnect(ws) {
  let removed = false;
  
  if (ws.hardwareId && gameState.connectedDevices.has(ws.hardwareId)) {
    console.log(`[NET] Device disconnected: ${ws.hardwareId}`);
    gameState.connectedDevices.delete(ws.hardwareId);
    removed = true;
  } else {
    for (const [hwId, device] of gameState.connectedDevices.entries()) {
      if (device.socket === ws) {
        console.log(`[NET] Device disconnected (via lookup): ${hwId}`);
        gameState.connectedDevices.delete(hwId);
        removed = true;
        break;
      }
    }
  }

  if (removed) {
    broadcastDeviceList();
  }
}

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  console.log(`[NET] New WebSocket client connected from ${clientIp}`);
  broadcastDeviceList();

  ws.on('message', (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage);
      handleMessage(ws, data);
    } catch (err) {
      console.error(`[ERROR] Failed to parse JSON payload from ${clientIp}:`, err.message);
    }
  });

  ws.on('close', () => {
    handleSocketDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error(`[NET] Socket error on client ${ws.hardwareId || clientIp}:`, err.message);
    handleSocketDisconnect(ws);
  });
});

function handleMessage(ws, data) {
  // Only strict host game controls are locked behind the PIN. UPDATE_MAPPINGS is now allowed.
  const adminTypes = ['START_TIMER', 'LED_TEST', 'RESET_ROUND', 'TOGGLE_VIRTUAL', 'TOGGLE_BCP']; // Added TOGGLE_VIRTUAL & TOGGLE_BCP
  if (adminTypes.includes(data.type)) {
    if (!isAuthorized(data.pin)) {
      console.warn(`[AUTH] Unauthorized attempt for action '${data.type}'`);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Unauthorized: Invalid PIN' }));
      }
      return;
    }
  }

  switch (data.type) {
    case 'SYNC_REQUEST': {
      const t1 = Date.now();
      const t2 = Date.now();

      if (data.playerId && typeof data.playerId === 'string') {
        const cleanId = data.playerId.trim().substring(0, 32);
        const isVirtual = cleanId.startsWith('Virtual_') || cleanId.startsWith('Mobile_');
        
        // Strict BCP Gate: Block web buzzers entirely if BCP is off
        if (isVirtual && !gameState.bcpEnabled) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Web buzzers are currently disabled by the host.' }));
            ws.close();
          }
          return;
        }

        const isNew = !gameState.connectedDevices.has(cleanId);
        ws.hardwareId = cleanId;

        gameState.connectedDevices.set(cleanId, {
          socket: ws,
          hardwareId: cleanId,
          clockOffset: 0,
          videoDelayMs: typeof data.videoDelayMs === 'number' ? data.videoDelayMs : 0
        });
        
        if (!gameState.deviceMappings.has(cleanId)) {
          // Identify virtual buzzers to apply global disable flag upon initial connect
          gameState.deviceMappings.set(cleanId, {
            displayName: cleanId,
            teamId: (isVirtual && !gameState.virtualBuzzersEnabled) ? 'ignore' : 'unassigned',
            previousTeamId: 'unassigned' // Store what team they belong to if disabled
          });
        }

        if (isNew) {
          console.log(`[SYNC] Registered new device: ${cleanId}`);
          broadcastDeviceList();
        }
      }

      ws.send(JSON.stringify({
        type: 'SYNC_RESPONSE',
        t0: data.t0,
        t1: t1,
        t2: t2,
        sampleIndex: data.sampleIndex,
        isPeriodic: data.isPeriodic || false
      }));

      if (gameState.timerStarted && gameState.timerStartTime && Date.now() < gameState.timerStartTime) {
        ws.send(JSON.stringify({
          type: 'SCHEDULED_TIMER_START',
          syncStartTime: gameState.syncStartTime,
          greenTargetTime: gameState.timerStartTime
        }));
      }
      break;
    }

    case 'TOGGLE_BCP': {
      gameState.bcpEnabled = !!data.bcpEnabled;
      console.log(`[CONFIG] BCP (Web Buzzer Check-in) Enabled: ${gameState.bcpEnabled}`);
      
      // If toggled off, immediately disconnect and prune all virtual buzzers
      if (!gameState.bcpEnabled) {
        for (const [hwId, device] of gameState.connectedDevices.entries()) {
          if (hwId.startsWith('Virtual_') || hwId.startsWith('Mobile_')) {
            if (device.socket && device.socket.readyState === WebSocket.OPEN) {
              device.socket.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Host disabled web buzzers.' }));
              device.socket.close();
            }
            gameState.connectedDevices.delete(hwId);
          }
        }
      }
      broadcastDeviceList();
      break;
    }

    case 'UPDATE_MAPPINGS': {
      if (data.mappings && typeof data.mappings === 'object') {
        for (const [hwId, mapData] of Object.entries(data.mappings)) {
          if (mapData && mapData.displayName) {
            const existingMapping = gameState.deviceMappings.get(hwId) || {};
            
            // Preserve the team assignment if it already exists and the incoming request didn't specify one
            let finalTeam = existingMapping.teamId || 'unassigned';
            if (mapData.teamId && mapData.teamId !== 'unassigned') {
              finalTeam = mapData.teamId;
            }

            // Override virtual buzzer team assignments if they are globally disabled
            const isVirtual = hwId.startsWith('Virtual_') || hwId.startsWith('Mobile_');
            if (isVirtual && !gameState.virtualBuzzersEnabled) {
              existingMapping.previousTeamId = (finalTeam !== 'ignore') ? finalTeam : (existingMapping.previousTeamId || 'unassigned');
              finalTeam = 'ignore';
            }

            gameState.deviceMappings.set(hwId, {
              displayName: String(mapData.displayName).trim().substring(0, 24),
              teamId: String(finalTeam),
              previousTeamId: existingMapping.previousTeamId || 'unassigned'
            });
          }
        }
      }
      if (data.teams && typeof data.teams === 'object') {
        for (const [tId, tName] of Object.entries(data.teams)) {
          if (gameState.teams[tId] && typeof tName === 'string') {
            gameState.teams[tId].teamName = tName.trim().substring(0, 24);
          }
        }
      }
      broadcastDeviceList();
      break;
    }

    case 'TOGGLE_VIRTUAL': {
      gameState.virtualBuzzersEnabled = !gameState.virtualBuzzersEnabled;
      console.log(`[CONFIG] Virtual buzzers participation enabled: ${gameState.virtualBuzzersEnabled}`);
      
      for (const [hwId, mapping] of gameState.deviceMappings.entries()) {
        const isVirtual = hwId.startsWith('Virtual_') || hwId.startsWith('Mobile_');
        if (isVirtual) {
          if (!gameState.virtualBuzzersEnabled) {
            // Disabling: Save their spot and hide them
            if (mapping.teamId !== 'ignore') {
              mapping.previousTeamId = mapping.teamId;
              mapping.teamId = 'ignore';
            }
          } else {
            // Enabling: Put them back where they were (or unassigned if new)
            if (mapping.teamId === 'ignore') {
              mapping.teamId = mapping.previousTeamId || 'unassigned';
            }
          }
        }
      }
      broadcastDeviceList();
      break;
    }

    case 'START_TIMER': {
      if (gameState.timerStarted) return;

      const now = Date.now();
      const syncStartTime = now + 5000;             
      const greenTargetTime = syncStartTime + 3000; 
      
      gameState.timerStarted = true;
      gameState.syncStartTime = syncStartTime;
      gameState.timerStartTime = greenTargetTime;
      gameState.buzzes = [];
      gameState.fouls = [];

      console.log(`\n[ROUND START] Host initiated open buzzers!`);

      broadcast({
        type: 'SCHEDULED_TIMER_START',
        syncStartTime: syncStartTime,
        greenTargetTime: greenTargetTime
      });
      break;
    }

    case 'LED_TEST': {
      console.log(`[TEST] Host requested buzzer LED self-test`);
      broadcast({ type: 'LED_TEST' });
      break;
    }

    case 'RESET_ROUND': {
      gameState.timerStarted = false;
      gameState.syncStartTime = null;
      gameState.timerStartTime = null;
      gameState.buzzes = [];
      gameState.fouls = [];
      
      console.log(`\n--- ROUND RESET BY HOST ---\n`);
      broadcast({ type: 'ROUND_RESET' });
      break;
    }

    case 'BUZZ': {
      const hwId = data.playerId;
      if (!hwId) return;

      // The server's own clock is the only timestamp no client can influence.
      const serverArrivalTime = Date.now();

      broadcast({ type: 'BUTTON_PRESS_FLASH', hardwareId: hwId });

      const mapping = gameState.deviceMappings.get(hwId) || { displayName: hwId, teamId: 'unassigned' };
      if (mapping.teamId === 'ignore' || mapping.teamId === 'unassigned') return;

      const rawPressTime = Number(data.clientPressTime);
      const clockOffset = Number(data.clockOffset) || 0;
      if (isNaN(rawPressTime)) return;

      const teamMeta = gameState.teams[mapping.teamId] || { teamName: `Team ${mapping.teamId}` };

      const device = gameState.connectedDevices.get(hwId);
      if (device) device.clockOffset = clockOffset;

      const videoDelayMs = Number(data.videoDelayMs) || 0;
      const trueBuzzServerTime = rawPressTime + clockOffset - videoDelayMs;

      if (!gameState.timerStarted || !gameState.syncStartTime || trueBuzzServerTime < gameState.syncStartTime) {
        sendPrematureNudge(ws, hwId, mapping, teamMeta);
        return;
      }

      const alreadyBuzzed = gameState.buzzes.some(b => b.hardwareId === hwId);
      const alreadyFouled = gameState.fouls.some(f => f.hardwareId === hwId);
      if (alreadyBuzzed || alreadyFouled) return;

      let reactionTimeMs = trueBuzzServerTime - gameState.timerStartTime;

      if ((trueBuzzServerTime + GRACE_TOLERANCE_MS) < gameState.timerStartTime) {
        // A foul is only real if the press physically happened during the 3s
        // light sequence. trueBuzzServerTime is derived from the device's own
        // clock and its self-reported offset, so an uncalibrated or wrong
        // clock could otherwise manufacture a foul during the sync window.
        // Cross-check against the server's own receive time before penalising.
        const arrivalInLightSequence =
          serverArrivalTime >= (gameState.syncStartTime - ARRIVAL_TOLERANCE_MS) &&
          serverArrivalTime <= (gameState.timerStartTime + ARRIVAL_TOLERANCE_MS);

        if (!arrivalInLightSequence) {
          console.log(`[FOUL?] Ignored foul for ${hwId}: claimed countdown press but arrived ${serverArrivalTime - gameState.syncStartTime}ms into the sequence window. Treating as premature.`);
          sendPrematureNudge(ws, hwId, mapping, teamMeta);
          return;
        }

        const earlyMs = Math.abs(parseFloat(reactionTimeMs.toFixed(2)));
        const foulRecord = {
          hardwareId: hwId,
          displayName: mapping.displayName,
          teamName: teamMeta.teamName,
          earlyMs: earlyMs
        };
        gameState.fouls.push(foulRecord);
        broadcast({ type: 'FOUL_EVENT', foul: foulRecord });
        return;
      }

      if (reactionTimeMs < 0) reactionTimeMs = 0.0;

      const buzzRecord = {
        hardwareId: hwId,
        displayName: mapping.displayName,
        teamId: mapping.teamId,
        teamName: teamMeta.teamName,
        rawPressTime,
        clockOffset,
        trueBuzzServerTime,
        reactionTimeMs: parseFloat(reactionTimeMs.toFixed(2))
      };

      gameState.buzzes.push(buzzRecord);
      gameState.buzzes.sort((a, b) => a.trueBuzzServerTime - b.trueBuzzServerTime);

      const winningTime = gameState.buzzes[0].trueBuzzServerTime;
      const rankings = gameState.buzzes.map((entry, index) => ({
        rank: index + 1,
        hardwareId: entry.hardwareId,
        displayName: entry.displayName,
        teamName: entry.teamName,
        reactionTimeMs: entry.reactionTimeMs,
        behindWinnerMs: parseFloat((entry.trueBuzzServerTime - winningTime).toFixed(2))
      }));

      broadcast({
        type: 'RANKINGS_UPDATE',
        rankings: rankings,
        latestBuzz: buzzRecord
      });
      break;
    }
  }
}

function sendPrematureNudge(ws, hwId, mapping, teamMeta) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'PREMATURE_RESET' }));
  }

  const quips = ["Eager beaver! Save that thumb.", "Anticipation is great, but buzzers aren't live!", "Whoa there, speed racer!"];
  broadcast({
    type: 'PREMATURE_PRESS',
    hardwareId: hwId,
    displayName: mapping.displayName,
    teamName: teamMeta.teamName,
    message: quips[Math.floor(Math.random() * quips.length)]
  });
}

function broadcastDeviceList() {
  const devices = [];

  for (const [hwId, device] of gameState.connectedDevices.entries()) {
    const mapping = gameState.deviceMappings.get(hwId) || { displayName: hwId, teamId: 'unassigned' };
    
    let resolvedTeamName = 'Solo';
    if (mapping.teamId !== 'unassigned' && mapping.teamId !== 'ignore') {
      resolvedTeamName = gameState.teams[mapping.teamId] 
        ? gameState.teams[mapping.teamId].teamName 
        : `Team ${mapping.teamId}`;
    }

    devices.push({
      hardwareId: hwId,
      playerId: hwId,
      displayName: mapping.displayName,
      teamId: mapping.teamId,
      teamName: resolvedTeamName,
      clockOffset: device.clockOffset
    });
  }

  broadcast({
    type: 'DEVICE_LIST_UPDATE',
    devices: devices,
    teams: gameState.teams,
    bcpEnabled: gameState.bcpEnabled, // NEW: Broadcast BCP State
    virtualEnabled: gameState.virtualBuzzersEnabled // NEW: Append to outgoing websocket data
  });
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

server.listen(PORT, () => {
  console.log(`[HTTP] Web server running on http://localhost:${PORT}`);
});