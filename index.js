import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = 3001;
const DATA_FILE = path.join(process.cwd(), 'data.json');

// 配置
const RATE_LIMIT_MS = 30 * 60 * 1000; // 每30分钟只能上报一次
const MAX_DAILY_TOKENS = 10_000_000; // 单日上限 1000万标红
const KEEP_DAYS = 7; // 保留最近7天的数据

// 排行榜缓存
let leaderboardCache = {
  daily: { date: null, leaderboard: [], updatedAt: null },
  all_time: { leaderboard: [], updatedAt: null }
};

function cleanupOldData() {
  const data = loadData();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const before = data.daily_usage.length;
  data.daily_usage = data.daily_usage.filter(u => u.date >= cutoffStr);
  const after = data.daily_usage.length;
  
  if (before !== after) {
    console.log(`🧹 清理了 ${before - after} 条旧数据`);
    saveData(data);
  }
}

cleanupOldData();

function saveDailySnapshot() {
  const data = loadData();
  const today = getToday();
    const alreadySaved = data.daily_snapshots?.find(s => s.date === today);
  if (alreadySaved) return;
  
  const todayUsage = data.daily_usage.filter(u => u.date === today);
  const snapshot = { date: today, entries: [] };
  
  for (const agent of data.agents) {
    const usage = todayUsage.filter(u => u.agent_id === agent.agent_id);
    const totalIn = usage.reduce((sum, u) => sum + (u.tokens_in || 0), 0);
    const totalOut = usage.reduce((sum, u) => sum + (u.tokens_out || 0), 0);
    
    if (totalIn > 0 || totalOut > 0) {
      snapshot.entries.push({
        agent_id: agent.agent_id,
        name: agent.agent_name || agent.name,
                message: agent.message,
        tokens_in: totalIn,
        tokens_out: totalOut,
        total_tokens: totalIn + totalOut
      });
    }
  }
  
  snapshot.entries.sort((a, b) => b.total_tokens - a.total_tokens);
  snapshot.entries.forEach((e, i) => e.rank = i + 1);
  
  if (!data.daily_snapshots) data.daily_snapshots = [];
  data.daily_snapshots.push(snapshot);
  if (data.daily_snapshots.length > 30) data.daily_snapshots = data.daily_snapshots.slice(-30);
  console.log(`📸 已保存 ${today} 快照`);
  saveData(data);
}

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
  if (message?.length > 15) return res.status(400).json({ error: 'Message too long' });

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
  const { agent_id, agent_name, tokens_in = 0, tokens_out = 0, model = '', request_id = '', country = 'unknown' } = req.body;
  const today = getToday(), now = Date.now();

  if (!agent_id || !agent_name) return res.status(400).json({ error: 'Missing fields' });
    if (agent_id.toLowerCase().startsWith('test-')) return res.status(400).json({ error: 'test not allowed' });

  const lastReported = rateLimitStore.get(agent_id);
  if (lastReported && now - lastReported < RATE_LIMIT_MS) return res.status(429).json({ error: 'Rate limited' });

  const data = loadData();
  const tokensInDelta = parseInt(tokens_in) || 0, tokensOutDelta = parseInt(tokens_out) || 0;
  
  const existingAgent = data.agents.find(a => a.agent_id === agent_id);
  if (existingAgent) {
    existingAgent.agent_name = agent_name;
    existingAgent.tokens_total = (existingAgent.tokens_total || 0) + tokensInDelta + tokensOutDelta;
  } else {
    data.agents.push({ agent_id, agent_name, country, tokens_total: tokensInDelta + tokensOutDelta, created_at: new Date().toISOString() });
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
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Clawrank', port: PORT }));

app.get('/api/history', (req, res) => {
  const data = loadData();
  res.json({ type: 'history', snapshots: (data.daily_snapshots || []).slice(-30).reverse() });
});

function recalculateLeaderboard() {
  const data = loadData(), today = getToday();
  
  const daily = data.agents.map(a => {
    const u = data.daily_usage.find(x => x.agent_id === a.agent_id && x.date === today);
    return { agent_id: a.agent_id, name: a.agent_name || a.name, message: a.message, tokens_in: u?.tokens_in || 0, tokens_out: u?.tokens_out || 0, total_tokens: (u?.tokens_in || 0) + (u?.tokens_out || 0), model: u?.model || '', country: a.country };
  }).sort((a, b) => b.total_tokens - a.total_tokens).map((r, i) => ({ rank: i + 1, ...r, is_warning: r.total_tokens > MAX_DAILY_TOKENS }));
    
  const allTime = data.agents.map(a => {
    const usage = data.daily_usage.filter(x => x.agent_id === a.agent_id);
    return { agent_id: a.agent_id, name: a.agent_name || a.name, message: a.message, tokens_in: usage.reduce((s, x) => s + (x.tokens_in || 0), 0), tokens_out: usage.reduce((s, x) => s + (x.tokens_out || 0), 0), total_tokens: usage.reduce((s, x) => s + (x.tokens_in || 0) + (x.tokens_out || 0), 0), country: a.country, days_active: usage.length };
  }).sort((a, b) => b.total_tokens - a.total_tokens).map((r, i) => ({ rank: i + 1, ...r }));
  
  leaderboardCache = { daily: { date: today, leaderboard: daily, updatedAt: new Date().toISOString() }, all_time: { leaderboard: allTime, updatedAt: new Date().toISOString() } };
  console.log(`🔄 排行榜已更新`);
}

setTimeout(recalculateLeaderboard, 2000);
setInterval(recalculateLeaderboard, 120 * 60 * 1000);

app.listen(PORT, () => console.log(`🔥 Clawrank running on port ${PORT}`));
