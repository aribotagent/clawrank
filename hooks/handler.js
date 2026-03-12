const { createHash } = require("crypto");
const { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } = require("fs");
const { hostname } = require("os");
const { join } = require("path");

const API_URL = "https://clawrank-production.up.railway.app/api/report";
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const LOG_FILE = join(HOME, ".openclaw", "clawrank-hook.log");
const SKILL_DIR = join(__dirname, "..");
const CONFIG_FILE = join(SKILL_DIR, "config.json");
// Use separate state file for hook (incompatible with report.sh)
const STATE_FILE = join(HOME, ".openclaw", "clawrank-hook-state.json");
const AGENTS_DIR = join(HOME, ".openclaw", "agents");
const REPORT_INTERVAL_MS = 2 * 60 * 60 * 1000;  // 2小时
const SCAN_INTERVAL_MS = 60 * 1000;  // 1分钟
const RATE_LIMIT_MS = 60 * 1000;  // 1分钟

let intervalStarted = false;
let lastReportTime = 0;
let lastRateLimitTime = 0;
const modelDeltas = new Map();
let lastSeenByFile = new Map();

function log(message) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch (_) {}
}

function getGatewayId() {
  const raw = `${hostname()}-${HOME || ""}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ensureDir(path) {
  try { mkdirSync(path, { recursive: true }); } catch (_) {}
}

function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (!parsed || !parsed.name) return null;
    return {
      name: parsed.name,
      message: parsed.message || "",
      agent_id: parsed.agent_id || getGatewayId(),
      registered_at: parsed.registered_at || new Date().toISOString(),
    };
  } catch (_) { return null; }
}

async function registerToApi(config) {
  try {
    const res = await fetch(API_URL.replace("/report", "/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: config.agent_id,
        name: config.name,
        message: config.message,
      }),
    });
    if (res.ok) {
      log(`Registered to API: ${config.name}`);
      return true;
    }
    log(`Register failed: ${res.status}`);
    return false;
  } catch (err) {
    log(`Register error: ${err.message}`);
    return false;
  }
}

async function registerFallback() {
  const name = hostname() || "anonymous";
  const agent_id = getGatewayId();
  const config = {
    name: name,
    message: "",
    agent_id: agent_id,
    registered_at: new Date().toISOString(),
  };
  try {
    ensureDir(SKILL_DIR);
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    log(`Created fallback config at ${CONFIG_FILE}`);
    // Try to register to API
    await registerToApi(config);
  } catch (err) {
    log(`Failed creating fallback config: ${err.message}`);
  }
  return config;
}

function listAgentIds() {
  if (!existsSync(AGENTS_DIR)) return [];
  try {
    return readdirSync(AGENTS_DIR).filter((entry) => {
      try { return statSync(join(AGENTS_DIR, entry)).isDirectory(); } catch (_) { return false; }
    });
  } catch (_) { return []; }
}

function getRecentJsonlFiles() {
  const files = [];
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  for (const agentId of listAgentIds()) {
    const sessionsDir = join(AGENTS_DIR, agentId, "sessions");
    if (!existsSync(sessionsDir)) continue;
    try {
      for (const entry of readdirSync(sessionsDir)) {
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = join(sessionsDir, entry);
        try {
          if (statSync(filePath).mtimeMs >= cutoff) files.push(filePath);
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

function normalizeModel(message) {
  if (!message || typeof message !== "object") return "unknown";
  return message.model || message.modelId || 
    (message.metadata && message.metadata.model) || 
    (message.usage && message.usage.model) || "unknown";
}

function scanJsonlByModel(filePath) {
  const byModel = {};
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      const message = extractMessage(obj);
      if (!message || message.role !== "assistant") continue;
      const usage = parseUsage(message.usage);
      if (!usage) continue;
      const model = normalizeModel(message);
      if (!byModel[model]) byModel[model] = { tokens: 0, input: 0, output: 0 };
      byModel[model].tokens += usage.total;
      byModel[model].input += usage.input;
      byModel[model].output += usage.output;
    }
  } catch (err) {
    log(`Failed scanning ${filePath}: ${err.message}`);
  }
  return byModel;
}

function saveState() {
  try {
    const files = {};
    for (const [key, value] of lastSeenByFile.entries()) files[key] = value;
    writeFileSync(STATE_FILE, JSON.stringify({ version: 1, files }, null, 2), "utf8");
  } catch (err) { log(`Failed saving state: ${err.message}`); }
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!parsed || !parsed.files) return;
    for (const [filePath, state] of Object.entries(parsed.files)) {
      if (!state || typeof state !== "object") continue;
      lastSeenByFile.set(filePath, { mtime: safeNumber(state.mtime), models: state.models || {} });
    }
    log(`Loaded state (${lastSeenByFile.size} files)`);
  } catch (err) { log(`Failed loading state: ${err.message}`); }
}

function addDelta(model, delta) {
  const existing = modelDeltas.get(model) || { tokens: 0, input: 0, output: 0 };
  existing.tokens += Math.max(0, safeNumber(delta.tokens));
  existing.input += Math.max(0, safeNumber(delta.input));
  existing.output += Math.max(0, safeNumber(delta.output));
  modelDeltas.set(model, existing);
}

function accumulateDeltas() {
  for (const filePath of getRecentJsonlFiles()) {
    let mtime = 0;
    try { mtime = statSync(filePath).mtimeMs; } catch (_) { continue; }
    const previous = lastSeenByFile.get(filePath);
    if (previous && previous.mtime >= mtime) continue;
    const currentByModel = scanJsonlByModel(filePath);
    if (!previous) { lastSeenByFile.set(filePath, { mtime, models: currentByModel }); continue; }
    for (const [model, totals] of Object.entries(currentByModel)) {
      const prev = previous.models?.[model] || { tokens: 0, input: 0, output: 0 };
      addDelta(model, {
        tokens: safeNumber(totals.tokens) - safeNumber(prev.tokens),
        input: safeNumber(totals.input) - safeNumber(prev.input),
        output: safeNumber(totals.output) - safeNumber(prev.output),
      });
    }
    lastSeenByFile.set(filePath, { mtime, models: currentByModel });
  }
  saveState();
}

function hasPendingDeltas() {
  for (const delta of modelDeltas.values()) {
    if (delta.tokens > 0 || delta.input > 0 || delta.output > 0) return true;
  }
  return false;
}

async function postReport(config, model, delta) {
  // Check rate limit
  if (Date.now() - lastRateLimitTime < RATE_LIMIT_MS) {
    log(`Rate limited, skip ${model}`);
    return false;
  }
  
  const body = {
    agent_id: config.agent_id,
    agent_name: config.name,
    tokens_in: delta.input,
    tokens_out: delta.output,
    model,
  };
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      lastRateLimitTime = Date.now();
      log(`Rate limited (429), will retry later`);
      return false;
    }
    if (res.ok) {
      log(`Reported ${model}: ${delta.input + delta.output} tokens`);
      return true;
    }
    log(`Report failed: ${res.status}`);
    return false;
  } catch (err) {
    log(`Report error: ${err.message}`);
    return false;
  }
}

async function report(config) {
  if (!hasPendingDeltas()) return;
  for (const [model, delta] of modelDeltas.entries()) {
    if (delta.tokens <= 0 && delta.input <= 0 && delta.output <= 0) continue;
    await postReport(config, model, delta);
  }
  // Note: deltas cleared after attempt, may lose data on failure
  lastReportTime = Date.now();
}

function startPeriodicReporting(config) {
  if (intervalStarted) return;
  intervalStarted = true;
  loadState();
  for (const filePath of getRecentJsonlFiles()) {
    if (lastSeenByFile.has(filePath)) continue;
    let mtime = 0;
    try { mtime = statSync(filePath).mtimeMs; } catch (_) {}
    lastSeenByFile.set(filePath, { mtime, models: scanJsonlByModel(filePath) });
  }
  saveState();
  log(`Baseline loaded (${lastSeenByFile.size} files)`);

  setInterval(async () => {
    try {
      accumulateDeltas();
      if (hasPendingDeltas() && Date.now() - lastReportTime >= REPORT_INTERVAL_MS) {
        await report(config);
      }
    } catch (err) { log(`Tick failed: ${err.message}`); }
  }, SCAN_INTERVAL_MS);
}

module.exports = async function handler(event) {
  log(`Event: type=${event?.type} action=${event?.action}`);
  const config = loadConfig() || await registerFallback();
  
  if (event?.type === "gateway" && event?.action === "startup") {
    startPeriodicReporting(config);
    return;
  }
  
  if (event?.type === "command" && ["new", "reset", "compact"].includes(event?.action)) {
    accumulateDeltas();
    if (hasPendingDeltas()) await report(config);
  }
};
