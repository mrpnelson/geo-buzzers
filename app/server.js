const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const WebSocket = require('ws');
const parseArgs = require('minimist');
const crypto = require('crypto');

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
    monitor: { title: '{app} Monitor',             heading: '{app}' },
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

  // The TV page became the Monitor page. A config written against the old
  // key would otherwise stop applying silently and fall back to generic
  // defaults, so accept it and say so.
  if (fileConfig.pages && fileConfig.pages.tv && !fileConfig.pages.monitor) {
    fileConfig.pages.monitor = fileConfig.pages.tv;
    console.warn('[CONFIG] "pages.tv" is deprecated - rename it to "pages.monitor". Using it for now.');
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
const PAGE_FILES = { host: 'main.html', mobile: 'mobile.html', monitor: 'monitor.html', virtual: 'virtual.html' };
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
// Behind Cloud Run's load balancer, the socket address is the proxy. Without
// this, every client looks like one IP and the throttle below would lock out
// the whole venue on one person's typo.
app.set('trust proxy', true);
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const GRACE_TOLERANCE_MS = 0;
// How far the server's own receive time may sit outside the light sequence
// before we stop believing a press really happened during the countdown.
const ARRIVAL_TOLERANCE_MS = 1000;
// No human reacts in more than a couple of minutes. Anything beyond this is
// a broken client clock, not a slow player - most often a device that
// calibrated its offset before NTP set its system clock, then had the clock
// corrected underneath it, so the offset gets counted twice.
const MAX_PLAUSIBLE_REACTION_MS = 120000;


// ====================================================================
// SLACK NOTIFIER (optional)
//
// Two one-way incoming webhooks: a live feed of round results, and an ops
// feed of admin, security and device events. Both stay dormant unless the
// matching environment variable is set, so this is safe to ship disabled.
//
// Rule for everything below: never touch the buzz path. Calls queue a line
// and return immediately, a timer flushes batches, and every failure is
// swallowed. Slack being down must never affect a game.
// ====================================================================
const SLACK = {
  live: process.env.SLACK_WEBHOOK_LIVE || null,
  ops:  process.env.SLACK_WEBHOOK_OPS  || null
};
// Slack allows about one message per second per webhook, with short bursts,
// and answers a 429 with Retry-After. The two feeds are separate webhooks
// aimed at separate channels, so each has its own budget - which is why the
// live feed can be snappy while ops stays lazy and batched.
const SLACK_CFG = {
  live: { flushMs: 700,  minGapMs: 1000 },   // game action: post promptly
  ops:  { flushMs: 5000, minGapMs: 1000 }    // audit trail: batch heavily
};
const SLACK_MAX_LINES = 40;     // lines per posted message
const SLACK_MAX_QUEUE = 200;    // hard cap; oldest are dropped and counted
const SLACK_TIMEOUT_MS = 4000;
const SLACK_MAX_BACKOFF_MS = 60000;

// A device that reconnects in a loop would otherwise post one line per
// attempt. Past the threshold we say so once and go quiet.
const CHURN_WINDOW_MS = 60000;
const CHURN_THRESHOLD = 3;

const slackQueues = { live: [], ops: [] };
// Premature presses are counted per device per round. Someone leaning on a
// button could otherwise post several lines a second.
const slackPrematureCount = new Map();
const slackDropped = { live: 0, ops: 0 };
const slackChurn = new Map();
const slackState = {
  live: { lastPostAt: 0, pausedUntil: 0, timer: null, nextAt: 0, sending: false },
  ops:  { lastPostAt: 0, pausedUntil: 0, timer: null, nextAt: 0, sending: false }
};

function slackPost(channel, line, urgent) {
  if (!SLACK[channel] || !line) return;
  const q = slackQueues[channel];
  if (q.length >= SLACK_MAX_QUEUE) { slackDropped[channel]++; return; }
  q.push(line);
  slackSchedule(channel, urgent ? 0 : SLACK_CFG[channel].flushMs);
}

// Schedules the next flush, never sooner than one second after the last
// post and never while Slack has told us to back off. Pulls an existing
// timer earlier if something urgent arrives.
function slackSchedule(channel, delayMs) {
  if (!SLACK[channel]) return;
  const st = slackState[channel];
  const cfg = SLACK_CFG[channel];
  const now = Date.now();

  const earliest = Math.max(now + delayMs, st.lastPostAt + cfg.minGapMs, st.pausedUntil);
  if (st.timer && st.nextAt <= earliest) return;    // already due sooner
  if (st.timer) clearTimeout(st.timer);

  st.nextAt = earliest;
  st.timer = setTimeout(() => {
    st.timer = null;
    slackFlush(channel);
  }, Math.max(0, earliest - now));
  if (st.timer.unref) st.timer.unref();
}

async function slackFlush(channel) {
  const url = SLACK[channel];
  if (!url) return;
  const st = slackState[channel];
  if (st.sending) return;                       // one request in flight at a time
  const q = slackQueues[channel];
  if (q.length === 0) return;
  if (Date.now() < st.pausedUntil) { slackSchedule(channel, 0); return; }

  const lines = q.splice(0, SLACK_MAX_LINES);
  if (slackDropped[channel] > 0) {
    lines.push(`_${slackDropped[channel]} further message(s) dropped - queue full_`);
    slackDropped[channel] = 0;
  }

  st.sending = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
      signal: controller.signal
    });

    if (res.status === 429) {
      // Rate limited. Put the batch back and wait however long Slack says.
      const raw = parseInt(res.headers.get('retry-after') || '1', 10);
      const waitMs = Math.min(Math.max(Number.isFinite(raw) ? raw : 1, 1) * 1000, SLACK_MAX_BACKOFF_MS);
      st.pausedUntil = Date.now() + waitMs;
      q.unshift(...lines);
      console.warn(`[SLACK] ${channel} rate limited - retrying in ${waitMs / 1000}s`);
    } else if (!res.ok) {
      console.warn(`[SLACK] ${channel} webhook returned ${res.status}`);
    }
  } catch (err) {
    console.warn(`[SLACK] ${channel} post failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
    st.sending = false;
    st.lastPostAt = Date.now();
    if (slackQueues[channel].length > 0) slackSchedule(channel, 0);
  }
}

// Device events, coalesced per device so one flaky buzzer cannot flood the
// channel. The suppression notice is itself the useful signal.
function slackDevice(hwId, line) {
  if (!SLACK.ops) return;
  const now = Date.now();
  const rec = slackChurn.get(hwId) || { count: 0, firstAt: now, suppressed: 0 };

  if (now - rec.firstAt > CHURN_WINDOW_MS) {
    if (rec.suppressed > 0) {
      slackPost('ops', `:repeat: \`${hwId}\` settled - ${rec.suppressed} further event(s) were suppressed`);
    }
    rec.count = 0; rec.firstAt = now; rec.suppressed = 0;
  }

  rec.count++;
  if (rec.count <= CHURN_THRESHOLD) {
    slackPost('ops', line);
  } else {
    rec.suppressed++;
    if (rec.suppressed === 1) {
      slackPost('ops', `:repeat: \`${hwId}\` is reconnecting repeatedly - muting its events for 60s`);
    }
  }
  slackChurn.set(hwId, rec);
}

// Reports only what actually changed, so saving an unedited form stays
// silent. Roster and team changes are part of the game, so they go to the
// live feed; the ops feed keeps the same detail as a moderator audit trail.
function reportMappingChanges(beforeTeams, beforeMaps, isModeratorEdit) {
  if (!SLACK.live && !SLACK.ops) return;

  const teamName = (id) => (gameState.teams[id] && gameState.teams[id].teamName) || `Team ${id}`;
  const label = (id) => {
    if (id === 'unassigned') return 'unassigned';
    if (id === 'ignore') return 'disabled';
    return teamName(id);
  };

  const lines = [];

  for (const [tId, was] of Object.entries(beforeTeams)) {
    const now = gameState.teams[tId] && gameState.teams[tId].teamName;
    if (now && now !== was) lines.push(`:busts_in_silhouette: Team ${tId} renamed *${was}* → *${now}*`);
  }

  for (const [hwId, m] of gameState.deviceMappings.entries()) {
    const was = beforeMaps.get(hwId);
    if (!was) {
      lines.push(`:heavy_plus_sign: *${m.displayName}* added — ${label(m.teamId)}`);
      continue;
    }
    if (was.displayName !== m.displayName) {
      lines.push(`:pencil2: *${was.displayName}* renamed to *${m.displayName}*`);
    }
    if (was.teamId !== m.teamId) {
      lines.push(`:dart: *${m.displayName}* — ${label(was.teamId)} → *${label(m.teamId)}*`);
    }
  }

  if (lines.length === 0) return;

  slackPost('live', lines.join('\n'));
  slackPost('ops', (isModeratorEdit
    ? ':memo: *Moderator updated the roster*'
    : ':memo: Buzzer self-registered a name') + '\n' + lines.join('\n'));
}

function slackRoundSummary() {
  if (!SLACK.live) return;
  const buzzes = gameState.buzzes || [];
  const fouls = gameState.fouls || [];

  const early = [];
  for (const [hwId, count] of slackPrematureCount.entries()) {
    const m = gameState.deviceMappings.get(hwId);
    early.push(`${m ? m.displayName : hwId}${count > 1 ? ` ×${count}` : ''}`);
  }
  slackPrematureCount.clear();

  if (buzzes.length === 0 && fouls.length === 0) {
    slackPost('live', ':no_bell: Round closed with no buzzes.'
      + (early.length ? `\n   :raised_hand: Early presses: ${early.join(', ')}` : ''));
    return;
  }

  const lines = [`:bell: *Round results*`];
  const winner = buzzes.length ? buzzes[0].trueBuzzServerTime : 0;
  buzzes.forEach((b, i) => {
    const behind = i === 0 ? 'fastest' : `+${(b.trueBuzzServerTime - winner).toFixed(0)}ms`;
    lines.push(`   ${i + 1}. *${b.displayName}* (${b.teamName}) — ${(b.reactionTimeMs / 1000).toFixed(3)}s _${behind}_`);
  });
  fouls.forEach(f => {
    lines.push(`   :warning: *${f.displayName}* (${f.teamName}) — early by ${(f.earlyMs / 1000).toFixed(3)}s`);
  });
  if (early.length) {
    lines.push(`   :raised_hand: Early presses: ${early.join(', ')}`);
  }
  slackPost('live', lines.join('\n'));
}

if (SLACK.live || SLACK.ops) {
  console.log(`[SLACK] Enabled - live feed: ${SLACK.live ? `yes (${SLACK_CFG.live.flushMs}ms)` : 'no'}, ops feed: ${SLACK.ops ? `yes (${SLACK_CFG.ops.flushMs}ms)` : 'no'}`);
} else {
  console.log('[SLACK] Disabled (set SLACK_WEBHOOK_LIVE and/or SLACK_WEBHOOK_OPS to enable)');
}


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
  const key = req.ip || 'unknown';

  const wait = pinLockoutRemaining(key);
  if (wait > 0) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({
      success: false,
      error: `Too many attempts. Try again in ${wait}s.`,
      retryAfter: wait
    });
  }

  const { pin } = req.body || {};
  if (pinMatches(pin)) {
    clearPinFailures(key);
    console.log(`[AUTH] PIN accepted from ${key}`);
    slackPost('ops', `:unlock: Console unlocked from \`${key}\``);
    return res.json({ success: true });
  }

  recordPinFailure(key);
  console.warn(`[AUTH] PIN rejected from ${key}`);
  slackPost('ops', `:key: Incorrect PIN from \`${key}\``);
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
          <div class="card-icon">🖥️</div>
          <div class="card-title">Live Monitor</div>
          <div class="card-desc">Scoreboard for a TV or projector in the room, and a live view remote players can follow on a laptop or phone.</div>
          <a href="/monitor" class="btn-launch">LAUNCH MONITOR</a>
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
app.get('/monitor', (req, res) => sendPage(res, 'monitor'));
app.get('/host', (req, res) => sendPage(res, 'host'));
app.get('/mm', (req, res) => sendPage(res, 'mobile')); // Mobile management console
app.get('/virtual', (req, res) => sendPage(res, 'virtual'));

// Direct .html paths resolve to the same branded output; without these,
// express.static below would hand back the raw, unbranded file.
app.get('/monitor.html', (req, res) => sendPage(res, 'monitor'));

// Old paths. A TV or stick already bookmarked to /tv keeps working.
app.get('/tv', (req, res) => res.redirect(301, '/monitor'));
app.get('/tv.html', (req, res) => res.redirect(301, '/monitor'));
app.get('/main.html', (req, res) => sendPage(res, 'host'));
app.get('/mobile.html', (req, res) => sendPage(res, 'mobile'));
app.get('/virtual.html', (req, res) => sendPage(res, 'virtual'));

// Read-only view of the resolved branding, handy for debugging a deployment.
app.get('/api/config', (req, res) => res.json(CONFIG));

// Serve static assets without auto-serving index.html on root
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Helper to check PIN authorization on incoming WS admin messages
// Plain === leaks length and returns early on the first wrong character.
// The practical risk to a 4-digit PIN is brute force rather than timing,
// but a constant-time compare costs nothing.
function pinMatches(providedPin) {
  if (!ADMIN_PIN) return true;
  const a = Buffer.from(String(providedPin === undefined ? '' : providedPin));
  const b = Buffer.from(String(ADMIN_PIN));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAuthorized(providedPin) {
  return pinMatches(providedPin);
}

// ====================================================================
// PIN BRUTE-FORCE THROTTLE
// A 4-digit PIN is 10,000 possibilities. Unthrottled, the whole keyspace
// falls in seconds, which makes the PIN decorative. Failures are counted
// per client and lock that client out for a cooling-off period.
// ====================================================================
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 10 * 60 * 1000;
// Progressive backoff: a host who mistypes recovers in half a minute, while
// anyone working through the keyspace is pushed out to a quarter hour. At
// five tries per 30s the 10,000 combinations take days, which is ample for
// something guarding a quiz round.
const PIN_LOCKOUT_BASE_MS = 30 * 1000;
const PIN_LOCKOUT_MAX_MS = 15 * 60 * 1000;
const pinAttempts = new Map(); // key -> { count, firstAt, lockedUntil, strikes }

function prunePinAttempts(now) {
  for (const [key, rec] of pinAttempts.entries()) {
    const expired = (rec.lockedUntil || 0) < now && (now - rec.firstAt) > PIN_WINDOW_MS;
    if (expired) pinAttempts.delete(key);
  }
}

// Returns 0 if allowed, else the seconds remaining on the lockout.
function pinLockoutRemaining(key) {
  const now = Date.now();
  prunePinAttempts(now);
  const rec = pinAttempts.get(key);
  if (!rec || !rec.lockedUntil) return 0;
  if (rec.lockedUntil > now) return Math.ceil((rec.lockedUntil - now) / 1000);
  rec.lockedUntil = 0;
  pinAttempts.set(key, rec);
  return 0;
}

function recordPinFailure(key) {
  const now = Date.now();
  const rec = pinAttempts.get(key) || { count: 0, firstAt: now, lockedUntil: 0, strikes: 0 };
  if (now - rec.firstAt > PIN_WINDOW_MS) {
    rec.count = 0;
    rec.firstAt = now;
    rec.strikes = 0;
  }
  rec.count++;
  if (rec.count >= PIN_MAX_ATTEMPTS) {
    rec.strikes++;
    const lockMs = Math.min(
      PIN_LOCKOUT_BASE_MS * Math.pow(2, rec.strikes - 1),
      PIN_LOCKOUT_MAX_MS
    );
    rec.lockedUntil = now + lockMs;
    rec.count = 0;
    rec.firstAt = now;
    console.warn(`[AUTH] ${PIN_MAX_ATTEMPTS} failed PIN attempts from ${key} - locked out for ${lockMs / 1000}s (strike ${rec.strikes})`);
    slackPost('ops', `:lock: ${PIN_MAX_ATTEMPTS} failed PIN attempts from \`${key}\` - locked out ${lockMs / 1000}s (strike ${rec.strikes})`);
  }
  pinAttempts.set(key, rec);
}

function clearPinFailures(key) {
  pinAttempts.delete(key);
}

console.log(`\n==================================================`);
console.log(`Buzzer Server running on port ${PORT}`);
if (ADMIN_PIN) {
  // Never log the value: Cloud Logging is readable by anyone with the
  // Logs Viewer role on the project.
  console.log(`[AUTH] Host actions locked behind a PIN (${String(ADMIN_PIN).length} characters)`);
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
    slackDevice(ws.hardwareId, `:electric_plug: \`${ws.hardwareId}\` dropped off`);
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
  sendDeviceListTo(ws);

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
      ws.pinFailures = (ws.pinFailures || 0) + 1;
      console.warn(`[AUTH] Unauthorized attempt for action '${data.type}' (failure ${ws.pinFailures})`);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Unauthorized: Invalid PIN' }));
      }

      // Guessing over the socket is as cheap as guessing over HTTP unless
      // we hang up. A legitimate console sends one wrong PIN at most.
      if (ws.pinFailures >= PIN_MAX_ATTEMPTS) {
        console.warn(`[AUTH] Closing socket after ${ws.pinFailures} failed PIN attempts`);
        slackPost('ops', `:lock: Socket closed after ${ws.pinFailures} failed PIN attempts over the websocket`);
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
      return;
    }
    ws.pinFailures = 0;
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
        const previous = gameState.connectedDevices.get(cleanId);
        ws.hardwareId = cleanId;

        // A client may report the offset it has calibrated to. Until it
        // does, carry forward whatever we already knew rather than
        // resetting to 0 on every sync sample - the roster previously read
        // 0 for a calibrated buzzer until its first BUZZ arrived.
        let knownOffset = previous ? previous.clockOffset : 0;
        if (Number.isFinite(data.clockOffset)) knownOffset = Number(data.clockOffset);

        // Devices report whether their clock offset is calibrated. An
        // uncalibrated buzzer still works, but its reaction times are
        // untrustworthy, so the host should be able to see it.
        let calibrated = previous ? previous.calibrated : null;
        if (typeof data.calibrated === 'boolean') calibrated = data.calibrated;

        gameState.connectedDevices.set(cleanId, {
          socket: ws,
          hardwareId: cleanId,
          clockOffset: knownOffset,
          calibrated: calibrated,
          videoDelayMs: typeof data.videoDelayMs === 'number'
            ? data.videoDelayMs
            : (previous ? previous.videoDelayMs : 0)
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
          slackDevice(cleanId, `:white_check_mark: \`${cleanId}\` checked in`);
          broadcastDeviceList();
        } else if (previous && previous.calibrated !== calibrated) {
          slackDevice(cleanId, calibrated
            ? `:stopwatch: \`${cleanId}\` clock calibrated`
            : `:warning: \`${cleanId}\` lost clock calibration`);
          // Only on an actual change, so the 60s periodic sync from every
          // buzzer does not turn into a broadcast every 60s per device.
          console.log(`[SYNC] ${cleanId} calibration state -> ${calibrated}`);
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
      slackPost('ops', `:electric_plug: Web buzzer check-in *${gameState.bcpEnabled ? 'enabled' : 'disabled'}*`);
      
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
      // A virtual buzzer renames only itself; anything touching another
      // device, or any team name, is a moderator acting from a console.
      const mapKeys = Object.keys(data.mappings || {});
      const isModeratorEdit = !!data.teams || mapKeys.some(id => id !== ws.hardwareId);

      const beforeTeams = Object.fromEntries(
        Object.entries(gameState.teams).map(([id, t]) => [id, t.teamName]));
      const beforeMaps = new Map();
      for (const [id, m] of gameState.deviceMappings.entries()) {
        beforeMaps.set(id, { displayName: m.displayName, teamId: m.teamId });
      }

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

      reportMappingChanges(beforeTeams, beforeMaps, isModeratorEdit);

      broadcastDeviceList();
      break;
    }

    case 'TOGGLE_VIRTUAL': {
      gameState.virtualBuzzersEnabled = !gameState.virtualBuzzersEnabled;
      console.log(`[CONFIG] Virtual buzzers participation enabled: ${gameState.virtualBuzzersEnabled}`);
      slackPost('ops', `:iphone: Virtual buzzer play *${gameState.virtualBuzzersEnabled ? 'enabled' : 'disabled'}*`);
      
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
      slackPrematureCount.clear();

      console.log(`\n[ROUND START] Host initiated open buzzers!`);
      {
        const playing = [...gameState.deviceMappings.values()]
          .filter(m => m.teamId !== 'ignore' && m.teamId !== 'unassigned').length;
        slackPost('live', `:rotating_light: *Buzzers open* — ${playing} buzzer(s) in play`, true);
        slackPost('ops', `:rotating_light: Moderator opened buzzers (${playing} in play)`);
      }

      broadcast({
        type: 'SCHEDULED_TIMER_START',
        syncStartTime: syncStartTime,
        greenTargetTime: greenTargetTime
      });
      break;
    }

    case 'LED_TEST': {
      slackPost('ops', ':bulb: LED test triggered');
      console.log(`[TEST] Host requested buzzer LED self-test`);
      broadcast({ type: 'LED_TEST' });
      break;
    }

    case 'RESET_ROUND': {
      slackRoundSummary();   // reads buzzes/fouls before they are cleared
      slackPost('ops', ':arrows_counterclockwise: Moderator reset the round');

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
      if (mapping.teamId === 'ignore' || mapping.teamId === 'unassigned') {
        // Dropped on the floor, which looks to the player like a dead
        // buzzer. Surface it so a moderator can fix the assignment.
        slackDevice(hwId, `:no_entry_sign: *${mapping.displayName}* buzzed but is ${mapping.teamId === 'ignore' ? 'disabled' : 'not assigned to a team'}`);
        return;
      }

      const rawPressTime = Number(data.clientPressTime);
      const clockOffset = Number(data.clockOffset) || 0;
      if (isNaN(rawPressTime)) return;

      const teamMeta = gameState.teams[mapping.teamId] || { teamName: `Team ${mapping.teamId}` };

      const device = gameState.connectedDevices.get(hwId);
      let calibrationChanged = false;
      if (device) {
        device.clockOffset = clockOffset;
        if (typeof data.calibrated === 'boolean' && device.calibrated !== data.calibrated) {
          device.calibrated = data.calibrated;
          calibrationChanged = true;
        }
      }
      // Again only on change, so a normal buzz does not trigger a roster
      // broadcast on top of the rankings it already sends.
      if (calibrationChanged) broadcastDeviceList();

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

      // Sanity-check before this reaches a scoreboard. The arrival time is
      // the server's own clock and cannot be influenced by the device, so a
      // buzz that arrived on time but claims an implausible reaction is
      // definitionally a clock problem.
      const arrivalReactionMs = serverArrivalTime - gameState.timerStartTime;
      if (Math.abs(reactionTimeMs) > MAX_PLAUSIBLE_REACTION_MS &&
          Math.abs(arrivalReactionMs) <= MAX_PLAUSIBLE_REACTION_MS) {
        console.error(
          `[CLOCK] Rejected buzz from ${hwId}: claimed reaction ${(reactionTimeMs / 1000).toFixed(1)}s ` +
          `but it arrived ${(arrivalReactionMs / 1000).toFixed(3)}s after the green light. ` +
          `Reported clockOffset ${clockOffset}ms is stale - device must re-calibrate.`
        );
        slackDevice(hwId, `:alarm_clock: \`${hwId}\` buzz rejected - stale clock offset, device re-calibrating`);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'CLOCK_ERROR',
            message: 'Clock offset is stale. Re-calibrating.',
            serverTime: serverArrivalTime
          }));
        }
        return;
      }

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
        slackPost('live', `:warning: *${mapping.displayName}* (${teamMeta.teamName}) jumped the light by ${(earlyMs / 1000).toFixed(3)}s`, true);
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

      {
        const place = rankings.find(r => r.hardwareId === hwId);
        const secs = (buzzRecord.reactionTimeMs / 1000).toFixed(3);
        slackPost('live', place && place.rank === 1
          ? `:bell: *${buzzRecord.displayName}* (${buzzRecord.teamName}) buzzed in first — *${secs}s*`
          : `:arrow_right_hook: ${place ? place.rank : '?'}. *${buzzRecord.displayName}* (${buzzRecord.teamName}) — ${secs}s _+${place ? place.behindWinnerMs.toFixed(0) : '?'}ms_`,
          true);
      }

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
  // First press per device per round is reported; the rest are counted and
  // rolled into the round summary, so a held button stays one line.
  const n = (slackPrematureCount.get(hwId) || 0) + 1;
  slackPrematureCount.set(hwId, n);
  if (n === 1) {
    slackPost('live', `:raised_hand: *${mapping.displayName}* (${teamMeta.teamName}) pressed before the lights`, true);
  }

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

function buildDeviceListPayload() {
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
      clockOffset: device.clockOffset,
      calibrated: device.calibrated
    });
  }

  return {
    type: 'DEVICE_LIST_UPDATE',
    devices: devices,
    teams: gameState.teams,
    bcpEnabled: gameState.bcpEnabled,
    virtualEnabled: gameState.virtualBuzzersEnabled
  };
}

function broadcastDeviceList() {
  broadcast(buildDeviceListPayload());
}

// Sent to one socket that has just connected. A fresh console needs the
// roster immediately, but nobody else's state changed, so there is nothing
// to tell them. Broadcasting here meant every connect - including each
// attempt from a client stuck in a reconnect loop - fanned a full roster
// out to every buzzer on the server.
function sendDeviceListTo(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(buildDeviceListPayload()));
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
  slackPost('ops', `:large_green_circle: Buzzer server started (port ${PORT}, PIN ${ADMIN_PIN ? 'enabled' : 'disabled'})`);
});