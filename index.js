const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(process.cwd(), 'data.json');

const RATE_LIMIT_MS = 30 * 60 * 1000;
const MAX_DAILY_TOKENS = 10000000;
const KEEP_DAYS = 7;

let leaderboardCache = {
  daily: { date: null, leaderboard: [], updatedAt: null },
  all_time: { leaderboard: [], updatedAt: null }
};

app.use(cors());
app.use(express.json());
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) { console.error('Error:', e); }
  return { agents: [], daily_usage: [], daily_snapshots: [], request_ids: [] };
}

function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
function getToday() { return new Date().toISOString().split('T')[0]; }

const rateLimitStore = new Map();

app.post('/api/register', (req, res) => {
  const { agent_id, name, message } = req.body;
  if (!agent_id || !name) return res.status(400).json({ error: 'Missing fields' });
    if (message && message.length > 15) return res.status(400).json({ error: 'Message too long' });

  const data = loadData();
  const existing = data.agents.find(a => a.agent_id === agent_id);
  if (existing) { existing.name = name; existing.message = message || ''; }
  else data.agents.push({ agent_id, name, message: message || '', created_at: new Date().toISOString() });
  saveData(data);
  res.json({ ok: true });
});

app.delete('/api/register/:agent_id', (req, res) => {
  const data = loadData();
  data.agents = data.agents.filter(a => a.agent_id !== req.params.agent_id);
  saveData(data);
  res.json({ ok: true });
  });

app.post('/api/report', (req, res) => {
  const { agent_id, agent_name, tokens_in = 0, tokens_out = 0, model = '' } = req.body;
  const today = getToday(), now = Date.now();

  if (!agent_id || !agent_name) return res.status(400).json({ error: 'Missing fields' });
  if (agent_id.toLowerCase().startsWith('test')) return res.status(400).json({ error: 'test not allowed' });

  const lastReported = rateLimitStore.get(agent_id);
  if (lastReported && now - lastReported < RATE_LIMIT_MS) return res.status(429).json({ error: 'Rate limited' });

  const data = loadData();
  const tokensInDelta = parseInt(tokens_in) || 0, tokensOutDelta = parseInt(tokens_out) || 0;
    const existingAgent = data.agents.find(a => a.agent_id === agent_id);
  if (existingAgent) {
    existingAgent.agent_name = agent_name;
    existingAgent.tokens_total = (existingAgent.tokens_total || 0) + tokensInDelta + tokensOutDelta;
  } else {
    data.agents.push({ agent_id, agent_name, tokens_total: tokensInDelta + tokensOutDelta, created_at: new Date().toISOString() });
  }

  const todayUsage = data.daily_usage.find(u => u.agent_id === agent_id && u.date === today);
  if (todayUsage) {
    todayUsage.tokens_in = (todayUsage.tokens_in || 0) + tokensInDelta;
    todayUsage.tokens_out = (todayUsage.tokens_out || 0) + tokensOutDelta;
  } else {
    data.daily_usage.push({ agent_id, date: today, tokens_in: tokensInDelta, tokens_out: tokensOutDelta, model });
  }
    saveData(data);
  rateLimitStore.set(agent_id, now);
  res.json({ success: true });
});

app.get('/api/leaderboard', (req, res) => {
  const cached = leaderboardCache.daily;
  res.json({ date: cached?.date || getToday(), type: 'daily', leaderboard: cached?.leaderboard || [] });
});

app.get('/api/leaderboard/all', (req, res) => {
  const cached = leaderboardCache.all_time;
  res.json({ type: 'all_time', leaderboard: cached?.leaderboard || [] });
});
app.post('/api/recalc', (req, res) => { recalculateLeaderboard(); res.json({ success: true }); });

app.get('/api/stats', (req, res) => {
  const data = loadData();
  res.json({ total_agents: data.agents.length, total_tokens: data.agents.reduce((s, a) => s + (a.tokens_total || 0), 0) });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

function recalculateLeaderboard() {
  const data = loadData(), today = getToday();
  const daily = data.agents.map(a => {
    const u = data.daily_usage.find(x => x.agent_id === a.agent_id && x.date === today);
    return { id: a.agent_id, name: a.agent_name || a.name, msg: a.message, in: u?.tokens_in || 0, out: u?.tokens_out || 0, total: (u?.tokens_in || 0) + (u?.tokens_out || 0), model: u?.model || '' };
      }).sort((a, b) => b.total - a.total).map((r, i) => ({ rank: i + 1, ...r }));

  const allTime = data.agents.map(a => {
    const us = data.daily_usage.filter(x => x.agent_id === a.agent_id);
    return { id: a.agent_id, name: a.agent_name || a.name, msg: a.message, in: us.reduce((s, x) => s + (x.tokens_in || 0), 0), out: us.reduce((s, x) => s + (x.tokens_out || 0), 0), total: us.reduce((s, x) => s + (x.tokens_in || 0) + (x.tokens_out || 0), 0), days: us.length };
  }).sort((a, b) => b.total - a.total).map((r, i) => ({ rank: i + 1, ...r }));

  leaderboardCache = { daily: { date: today, leaderboard: daily, updatedAt: new Date().toISOString() }, all_time: { leaderboard: allTime, updatedAt: new Date().toISOString() } };
}

setTimeout(recalculateLeaderboard, 2000);
setInterval(recalculateLeaderboard, 120 * 60 * 1000);

app.listen(PORT, () => console.log('Clawrank on port ' + PORT));
