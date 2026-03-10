const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Railway 磁盘挂载路径
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// API Key 保护
const API_KEY = process.env.API_KEY || '';

// 配置
const RATE_LIMIT_MS = 30 * 60 * 1000;  // 30分钟限制
const KEEP_DAYS = 30;  // 数据保留30天

let leaderboardCache = {
  daily: { date: null, leaderboard: [], updatedAt: null },
  all_time: { leaderboard: [], updatedAt: null }
};

app.use(cors());
app.use(express.json());

// 自动创建数据目录
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('Created data directory:', DATA_DIR);
  }
}
ensureDataDir();

// API Key 验证中间件
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (e) { console.error('Error loading data:', e); }
  return { agents: [], usage: [] };
}

function saveData(d) { 
  fs.writeFileSync(DATA_FILE, JSON.stringify(d)); 
}

function today() { return new Date().toISOString().split('T')[0]; }

// 清理旧数据（保留30天）
function cleanupOldData() {
  const data = loadData();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  
  const before = data.usage.length;
  data.usage = data.usage.filter(u => u.date >= cutoffStr);
  const removed = before - data.usage.length;
  
  if (removed > 0) {
    console.log(`Cleaned up ${removed} old records`);
    saveData(data);
  }
}
cleanupOldData();

const rateLimit = new Map();

// 公开接口 - 不需要 API Key
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/leaderboard', (req, res) => {
  const d = loadData();
  const t = today();
  const list = d.agents.map(a => {
    const u = d.usage.find(x => x.id === a.id && x.date === t);
    return { id: a.id, name: a.name, msg: a.msg, in: u?.in || 0, out: u?.out || 0, total: (u?.in || 0) + (u?.out || 0), model: u?.model || '' };
  }).sort((a, b) => b.total - a.total).map((r, i) => ({ rank: i + 1, ...r }));
  res.json({ date: t, type: 'daily', list });
});

app.get('/api/leaderboard/all', (req, res) => {
  const d = loadData();
  const list = d.agents.map(a => {
    const us = d.usage.filter(x => x.id === a.id);
    return { id: a.id, name: a.name, msg: a.msg, in: us.reduce((s, x) => s + (x.in || 0), 0), out: us.reduce((s, x) => s + (x.out || 0), 0), total: us.reduce((s, x) => s + (x.in || 0) + (x.out || 0), 0), days: us.length };
  }).sort((a, b) => b.total - a.total).map((r, i) => ({ rank: i + 1, ...r }));
  res.json({ type: 'all', list });
});

// 需要 API Key 的接口
app.post('/api/register', requireApiKey, (req, res) => {
  const { agent_id, name, message } = req.body;
  if (!agent_id || !name) return res.status(400).json({ error: 'Missing agent_id or name' });
  if (message && message.length > 15) return res.status(400).json({ error: 'Message too long' });
  
  const d = loadData();
  const e = d.agents.find(a => a.id === agent_id);
  if (e) { e.name = name; e.msg = message; } 
  else { d.agents.push({ id: agent_id, name, msg: message }); }
  saveData(d);
  res.json({ ok: true });
});

app.delete('/api/register/:id', requireApiKey, (req, res) => {
  const d = loadData();
  d.agents = d.agents.filter(a => a.id !== req.params.id);
  saveData(d);
  res.json({ ok: true });
});

app.post('/api/report', requireApiKey, (req, res) => {
  const { agent_id, agent_name, tokens_in = 0, tokens_out = 0, model = '' } = req.body;
  
  // 验证必填字段
  if (!agent_id || !agent_name) return res.status(400).json({ error: 'Missing agent_id or agent_name' });
  
  // 防止负数
  const inVal = parseInt(tokens_in) || 0;
  const outVal = parseInt(tokens_out) || 0;
  if (inVal < 0 || outVal < 0) {
    return res.status(400).json({ error: 'tokens_in and tokens_out must be non-negative' });
  }
  
  // 防止测试账号
  if (agent_id.toLowerCase().startsWith('test')) {
    return res.status(400).json({ error: 'test not allowed' });
  }

  const d = loadData();
  const t = today();

  let e = d.agents.find(a => a.id === agent_id);
  if (e) { e.name = agent_name; e.total = (e.total || 0) + inVal + outVal; } 
  else { d.agents.push({ id: agent_id, name: agent_name, total: inVal + outVal }); }

  let u = d.usage.find(x => x.id === agent_id && x.date === t);
  if (u) { u.in = (u.in || 0) + inVal; u.out = (u.out || 0) + outVal; } 
  else { d.usage.push({ id: agent_id, date: t, in: inVal, out: outVal, model }); }

  saveData(d);
  res.json({ ok: true });
});

app.get('/api/stats', requireApiKey, (req, res) => { 
  const d = loadData(); 
  res.json({ total_agents: d.agents.length, total_usage_records: d.usage.length }); 
});

app.listen(PORT, () => console.log('Clawrank on ' + PORT));
