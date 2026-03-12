const { createHash } = require("crypto");
const { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } = require("fs");
const { hostname } = require("os");
const { join } = require("path");

const API_URL = "https://clawrank-production.up.railway.app/api/report";
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const LOG_FILE = join(HOME, ".openclaw", "clawrank-hook.log");
const SKILL_DIR = join(__dirname, "..");
const CONFIG_FILE = join(SKILL_DIR, "config.json");
const STATE_FILE = join(HOME, ".openclaw", "clawrank-hook-state.json");
const AGENTS_DIR = join(HOME, ".openclaw", "agents");
const REPORT_INTERVAL_MS = 2 * 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 60 * 1000;
const RATE_LIMIT_MS = 60 * 1000;

let intervalStarted = false;
let lastReportTime = 0;
let lastRateLimitTime = 0;
let totalDelta = 0;
let lastSeenTotal = 0;
let lastSeenTime = 0;

function log(message) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`); } catch (_) {}
}

function getGatewayId() {
  const raw = `${hostname()}-${HOME || ""}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function safeNumber(value) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function ensureDir(path) { try { mkdirSync(path, { recursive: true }); } catch (_) {} }

function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (!parsed || !parsed.name) return null;
    return {
      name: parsed.name,
      message: parsed.message || "",
      agent_id: parsed.agent_id || getGatewayId(),
      registered_at: parsed.registered_at || null,
    };
  } catch (_) { return null; }
}

function getRegisteredAtTimestamp(config) {
  if (!config.registered_at) return 0;
  try { return new Date(config.registered_at).getTime(); } catch (_) { return 0; }
}

async function registerToApi(config) {
  try {
    const res = await fetch(API_URL.replace("/report", "/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: config.agent_id, name: config.name, message: config.message }),
    });
    if (res.ok) { log(`Registered: ${config.name}`); return true; }
    log(`Register failed: ${res.status}`); return false;
  } catch (err) { log(`Register error: ${err.message}`); return false; }
}

async function registerFallback() {
  const name = hostname() || "anonymous";
  const agent_id = getGatewayId();
  const config = { name, message: "", agent_id, registered_at: new Date().toISOString() };
  try {
    ensureDir(SKILL_DIR);
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    log(`Created fallback config at ${CONFIG_FILE}`);
    await registerToApi(config);
  } catch (err) { log(`Failed: ${err.message}`); }
  return config;
}

function listAgentIds() {
  if (!existsSync(AGENTS_DIR)) return [];
  try {
    return readdirSync(AGENTS_DIR).filter((e) => {
      try { return statSync(join(AGENTS_DIR, e)).isDirectory(); } catch (_) { return false; }
    });
  } catch (_) { return []; }
}

function getRecentJsonlFiles(registeredAt) {
  const files = [];
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  const minTime = registeredAt > 0 ? Math.max(registeredAt, cutoff) : cutoff;
  for (const agentId of listAgentIds()) {
    const sessionsDir = join(AGENTS_DIR, agentId, "sessions");
    if (!existsSync(sessionsDir)) continue;
    try {
      for (const entry of readdirSync(sessionsDir)) {
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = join(sessionsDir, entry);
        try {
          const mtime = statSync(filePath).mtimeMs;
          if (mtime >= minTime) files.push(filePath);
        } catch (_) {}
      }
    } catch (_) {}
  }
  return files;
}

function parseUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = safeNumber(usage.input || usage.inputTokens || usage.promptTokens);
  const output = safeNumber(usage.output || usage.outputTokens || usage.completionTokens);
  let total = safeNumber(usage.totalTokens || usage.total || usage.tokens);
  if (total <= 0 && (input > 0 || output > 0)) total = input + output;
  if (total <= 0 && input <= 0 && output <= 0) return null;
  return { total, input, output };
}

function extractMessage(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.type === "message" && obj.message) return obj.message;
  return obj.message || (obj.data && obj.data.message) || (obj.event && obj.event.message);
}

function scanTotalTokens(filePath) {
  let total = 0;
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      const msg = extractMessage(obj);
      if (!msg || msg.role !== "assistant") continue;
      const usage = parseUsage(msg.usage);
      if (!usage) continue;
      total += usage.total;
    }
  } catch (err) { log(`Scan error: ${err.message}`); }
  return total;
}

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ total: lastSeenTotal, time: lastSeenTime }, null, 2), "utf8");
  } catch (err) { log(`Save state error: ${err.message}`); }
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    lastSeenTotal = safeNumber(parsed.total);
    lastSeenTime = safeNumber(parsed.time);
    log(`Loaded state: total=${lastSeenTotal}`);
  } catch (err) { log(`Load state error: ${err.message}`); }
}

async function postReport(config, delta) {
  if (Date.now() - lastRateLimitTime < RATE_LIMIT_MS) {
    log(`Rate limited, skip`);
    return false;
  }
  const body = {
    agent_id: config.agent_id,
    agent_name: config.name,
    tokens_in: delta,
    tokens_out: 0,
    model: "",
  };
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      lastRateLimitTime = Date.now();
      log(`Rate limited (429)`);
      return false;
    }
    if (res.ok) { log(`Reported: ${delta} tokens`); return true; }
    log(`Failed: ${res.status}`); return false;
  } catch (err) { log(`Error: ${err.message}`); return false; }
}

async function report(config) {
  if (totalDelta <= 0) return;
  const ok = await postReport(config, totalDelta);
  if (ok) {
    lastSeenTotal += totalDelta;
    lastSeenTime = Date.now();
    totalDelta = 0;
    saveState();
  }
  lastReportTime = Date.now();
}

function startPeriodicReporting(config) {
  if (intervalStarted) return;
  intervalStarted = true;
  
  const registeredAt = getRegisteredAtTimestamp(config);
  loadState();
  
  // Initialize baseline
  let currentTotal = 0;
  for (const filePath of getRecentJsonlFiles(registeredAt)) {
    currentTotal += scanTotalTokens(filePath);
  }
  
  // First run: set baseline without reporting
  if (lastSeenTotal === 0) {
    lastSeenTotal = currentTotal;
    lastSeenTime = Date.now();
    saveState();
    log(`Baseline set: ${lastSeenTotal}`);
  }
  
  log(`Started: registeredAt=${registeredAt}, baseline=${lastSeenTotal}`);

  setInterval(async () => {
    try {
      // Scan current total
      let newTotal = 0;
      for (const filePath of getRecentJsonlFiles(registeredAt)) {
        newTotal += scanTotalTokens(filePath);
      }
      
      // Calculate delta
      totalDelta = Math.max(0, newTotal - lastSeenTotal);
      
      if (totalDelta > 0 && Date.now() - lastReportTime >= REPORT_INTERVAL_MS) {
        await report(config);
      }
    } catch (err) { log(`Tick error: ${err.message}`); }
  }, SCAN_INTERVAL_MS);
}

module.exports = async function handler(event) {
  log(`Event: ${event?.type} ${event?.action}`);
  const config = loadConfig() || await registerFallback();
  
  if (event?.type === "gateway" && event?.action === "startup") {
    startPeriodicReporting(config);
  }
};
