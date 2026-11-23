require('dotenv').config();
const net = require('net');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const cfg = {
  apiKey: process.env.E2E_API_KEY,
  apiToken: process.env.E2E_API_TOKEN,
  projectId: process.env.E2E_PROJECT_ID,
  location: process.env.E2E_LOCATION || 'Delhi',
  nodeId: process.env.E2E_NODE_ID,
  targetIp: process.env.TARGET_IP || '101.53.135.76',
  mongoPort: Number(process.env.MONGO_PORT || 27050),
  mongoTimeoutMs: Number(process.env.MONGO_TIMEOUT_MS || 10000),
  intervalMs: Number(process.env.CHECK_INTERVAL_MS || 15000),
  downDurationMs: Number(process.env.MONGO_DOWN_DURATION_MS || 210000), // 3.5 minutes
  cooldownMs: Number(process.env.REBOOT_COOLDOWN_MS || 1800000),
  alertAfterMs: Number(process.env.ALERT_AFTER_MS || 120000), // 2 minutes
  maxRebootsPerDay: Number(process.env.MAX_REBOOTS_PER_DAY || 3),
  // Safe by default: real reboots only when DRY_RUN=false is set explicitly.
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false',
};

const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'watchdog.log');
const stateFile = path.join(logDir, 'state.json');

function log(msg) {
  const line = `${new Date().toISOString()} | ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
}

function loadState() {
  const defaults = { downSince: null, lastRebootAt: 0, alerted: false, rebootHistory: [], capAlerted: false };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; }
  catch { return defaults; }
}
function saveState() { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
let state = loadState();


// Builds a legacy OP_QUERY for { isMaster: 1 } on admin.$cmd. This handshake command
// needs no auth and is answered by every MongoDB version (2.x through 8.x).
function buildIsMaster(requestId) {
  const cstr = s => Buffer.from(s + '\0', 'utf8');
  const int32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  const body = Buffer.concat([Buffer.from([0x10]), cstr('isMaster'), int32(1), Buffer.from([0x00])]);
  const doc = Buffer.concat([int32(body.length + 4), body]);
  const payload = Buffer.concat([
    int32(0),             // flags
    cstr('admin.$cmd'),   // fullCollectionName
    int32(0),             // numberToSkip
    int32(-1),            // numberToReturn
    doc,
  ]);
  const header = Buffer.concat([int32(16 + payload.length), int32(requestId), int32(0), int32(2004)]);
  return Buffer.concat([header, payload]);
}

// Resolves ok=true only if mongod actually answers isMaster in time.
function mongoCheck() {
  return new Promise(resolve => {
    const requestId = Math.floor(Math.random() * 0x7fffffff);
    const socket = new net.Socket();
    let buf = Buffer.alloc(0);
    let finished = false;
    const done = (ok, why) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve({ ok, why });
    };
    socket.setTimeout(cfg.mongoTimeoutMs);
    socket.once('connect', () => socket.write(buildIsMaster(requestId)));
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16) return;
      const responseTo = buf.readInt32LE(8);
      const opCode = buf.readInt32LE(12);
      // OP_REPLY (1) from older servers, OP_MSG (2013) is also accepted just in case.
      if (responseTo === requestId && (opCode === 1 || opCode === 2013)) done(true);
      else done(false, `unexpected reply opCode=${opCode}`);
    });
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', e => done(false, e.code || e.message));
    socket.once('close', () => done(false, 'closed'));
    socket.connect(cfg.mongoPort, cfg.targetIp);
  });
}


async function sendEmail(subject, text) {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'ALERT_FROM', 'ALERT_TO'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    log(`EMAIL_SKIPPED missing SMTP configuration: ${missing.join(', ')}`);
    return false;
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER.trim(), pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    socketTimeout: 15000,
  });
  try {
    await transporter.sendMail({
      from: process.env.ALERT_FROM.trim(),
      to: process.env.ALERT_TO.split(',').map(s => s.trim()).filter(Boolean),
      subject,
      text,
    });
    log(`EMAIL_SENT: ${subject}`);
    return true;
  } catch (e) {
    log(`EMAIL_ERROR: ${e.message}`);
    return false;
  }
}


async function e2eReboot() {
  if (!cfg.apiKey || !cfg.apiToken || !cfg.projectId || !cfg.nodeId) {
    throw new Error('Missing E2E API credentials or node/project IDs in environment');
  }
  const url = new URL(`https://api.e2enetworks.com/myaccount/api/v1/nodes/${encodeURIComponent(cfg.nodeId)}/actions/`);
  url.searchParams.set('project_id', cfg.projectId);
  url.searchParams.set('apikey', cfg.apiKey);
  url.searchParams.set('location', cfg.location);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'reboot' }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let body;
    try { body = JSON.parse(bodyText); } catch { body = bodyText; }
    if (!response.ok) throw new Error(`E2E API HTTP ${response.status}: ${bodyText}`);
    if (body && body.data && body.data.status === 'failed') throw new Error(`E2E action failed: ${bodyText}`);
    log(`E2E_REBOOT_REQUEST_ACCEPTED: HTTP ${response.status} ${bodyText}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}


async function checkOnce() {
  const { ok, why } = await mongoCheck();
  log(`CHECK mongo=${ok ? 'UP' : `DOWN (${why})`} target=${cfg.targetIp}:${cfg.mongoPort}`);

  if (ok) {
    if (state.downSince) {
      log(`MONGO_RECOVERED after ${Math.round((Date.now() - state.downSince) / 1000)}s`);
      state.downSince = null;
    }
    if (state.alerted) {
      // Only email recovery if we told someone about the problem (alert or reboot).
      await sendEmail('RECOVERY: MongoDB is responding again',
        `MongoDB on ${cfg.targetIp}:${cfg.mongoPort} is responding again.`);
      state.alerted = false;
      state.capAlerted = false;
    }
    saveState();
    return;
  }

  if (!state.downSince) {
    state.downSince = Date.now();
    log('MONGO_DOWN_START');
    saveState();
  }

  const downMs = Date.now() - state.downSince;

  // Early warning, once per outage, before any reboot happens.
  if (!state.alerted && downMs >= cfg.alertAfterMs) {
    state.alerted = true;
    saveState();
    await sendEmail('ALERT: MongoDB not responding',
      `MongoDB on ${cfg.targetIp}:${cfg.mongoPort} has not responded for ${Math.round(downMs / 1000)} seconds (last error: ${why}).\n` +
      `An automatic reboot will be requested if it is still down after ${Math.round(cfg.downDurationMs / 1000)} seconds.`);
  }

  const sinceLastReboot = Date.now() - Number(state.lastRebootAt || 0);
  if (downMs < cfg.downDurationMs) return;
  if (sinceLastReboot < cfg.cooldownMs) {
    log(`REBOOT_SKIPPED cooldown, last reboot ${Math.round(sinceLastReboot / 1000)}s ago`);
    return;
  }

  // Daily cap: stop rebooting and ask for a human if reboots aren't fixing it.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  state.rebootHistory = (state.rebootHistory || []).filter(t => t > dayAgo);
  if (state.rebootHistory.length >= cfg.maxRebootsPerDay) {
    log(`REBOOT_SKIPPED daily cap reached (${state.rebootHistory.length}/${cfg.maxRebootsPerDay} in last 24h)`);
    if (!state.capAlerted) {
      state.capAlerted = true;
      await sendEmail('URGENT: auto-reboot limit reached, manual action needed',
        `MongoDB on ${cfg.targetIp}:${cfg.mongoPort} is still not responding after ${state.rebootHistory.length} automatic reboots in the last 24 hours.\n` +
        `The watchdog will not reboot again until the oldest of those is more than 24 hours old. Please investigate manually.`);
    }
    saveState();
    return;
  }

  log(`REBOOT_TRIGGER mongo down ${Math.round(downMs / 1000)}s`);
  state.rebootHistory.push(Date.now());
  state.alerted = true; // so a recovery email is sent once Mongo is back
  try {
    if (cfg.dryRun) {
      log('DRY_RUN reboot NOT sent (set DRY_RUN=false to enable real reboots)');
    } else {
      await e2eReboot();
    }
    await sendEmail(`${cfg.dryRun ? '[DRY RUN] ' : ''}ACTION: E2E reboot requested (MongoDB not responding)`,
      `${cfg.dryRun ? 'DRY RUN - no reboot was actually sent.\n' : ''}` +
      `Automatic reboot was requested for node ${cfg.nodeId} (${cfg.targetIp}).\n` +
      `MongoDB on port ${cfg.mongoPort} did not respond for ${Math.round(downMs / 1000)} seconds (last error: ${why}).\n` +
      `Please verify service recovery.`);
  } catch (e) {
    log(`REBOOT_ERROR: ${e.message}`);
    await sendEmail('ERROR: automatic E2E reboot failed', `Reboot request failed for ${cfg.targetIp}:\n${e.message}`);
  }
  // Cooldown applies on failure too, to prevent rapid repeated API attempts.
  state.lastRebootAt = Date.now();
  state.downSince = null;
  saveState();
}


async function main() {
  log(`WATCHDOG_STARTED target=${cfg.targetIp}:${cfg.mongoPort} interval=${cfg.intervalMs}ms alertAfter=${cfg.alertAfterMs}ms rebootAfter=${cfg.downDurationMs}ms dryRun=${cfg.dryRun}`);
  // Time while the watchdog wasn't running is not observed downtime: start the clock fresh.
  if (state.downSince) {
    log('Discarding stale downSince from previous run');
    state.downSince = null;
    saveState();
  }
  while (true) {
    try { await checkOnce(); }
    catch (e) { log(`CHECK_ERROR: ${e.stack || e.message}`); }
    await new Promise(r => setTimeout(r, cfg.intervalMs));
  }
}

main().catch(err => { log(`FATAL: ${err.stack || err.message}`); process.exit(1); });
