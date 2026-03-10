const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Railway 磁盘挂载路径
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// 配置
const RATE_LIMIT_MS = 60 * 1000;  // 1分钟
const MAX_SINGLE_REPORT = 70000;  // 单次上报最大7万 tokens
const KEEP_DAYS = 30;  // 数据保留30天

// 全局限流：每IP每分钟最多300请求（和 rankingofclaws 一样）
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

app.use(cors());
app.use(express.json());
app.use(globalLimiter);

// 排行榜缓存 5 分钟
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
  next();
});

// 自动创建数据目录
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('Created data directory:', DATA_DIR);
  }
}
ensureDataDir();

// 安全的文件写入：先写临时文件，再重命名
function saveData(d) {
  const tempFile = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify(d), 'utf-8');
    fs.renameSync(tempFile, DATA_FILE);
  } catch (e) {
    console.error('Error saving data:', e);
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
}

// 安全的文件读取
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, 'utf-8');
      if (content.trim()) {
        const data = JSON.parse(content);
        if (data && Array.isArray(data.agents) && Array.isArray(data.usage)) {
          return data;
        }
      }
    }
  } catch (e) {
    console.error('Error loading data:', e);
  }
  return null;
}

function today() { return new Date().toISOString().split('T')[0]; }

// 初始化数据文件
function initDataFile() {
  let data = loadData();
  if (!data) {
    data = { agents: [], usage: [] };
    saveData(data);
    console.log('Initialized data file');
  }
  return data;
}

// 内存中的频率限制（每个 agent_id）
const agentRateLimit = new Map();

// 清理旧数据
function cleanupOldData() {
  let data = loadData();
  if (!data) data = initDataFile();
  
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];  
  const before = data.usage.length;
  data.usage = data.usage.filter(u => u.date >= cutoffStr);
  if (before > data.usage.length) {
    console.log(`Cleaned up ${before - data.usage.length} old records`);
    saveData(data);
  }
}
cleanupOldData();

// 健康检查
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Clawrank', port: PORT }));

// 今日排行榜
app.get('/api/leaderboard', (req, res) => {
  let d = loadData();
  if (!d) d = initDataFile();
  
  const t = today();
  const list = d.agents.map(a => {
    const u = d.usage.find(x => x.id === a.id && x.date === t);
    return { 
      id: a.id, 
      name: a.name, 
      msg: a.msg, 
      in: u?.in || 0, 
      out: u?.out || 0, 
      total: (u?.in || 0) + (u?.out || 0), 
      model: u?.model || '' 
    };
  }).sort((a, b) => b.total - a.total).map((r, i) => ({ rank: i + 1, ...r }));
  
  res.json({ date: t, type: 'daily', leaderboard: list });
});

// 总排行榜
app.get('/api/leaderboard/all', (req, res) => {
  let d = loadData();
  if (!d) d = initDataFile();
  
  const list = d.agents.map(a => {
    const us = d.usage.filter(x => x.id === a.id);
    return { 
      id: a.id, 
      name: a.name, 
      msg: a.msg, 
      in: us.reduce((s, x) => s + (x.in || 0), 0), 
      out: us.reduce((s, x) => s + (x.out || 0), 0), 
      total: us.reduce((s, x) => s + (x.in || 0) + (x.out || 0), 0), 
      days: us.length 
    };
  }).sort((a, b) => b.total - a.total).map((r, i) => ({ rank: i + 1, ...r }));
  
  res.json({ type: 'all_time', leaderboard: list });
});

// 报名
app.post('/api/register', (req, res) => {
  const { agent_id, name, message } = req.body;
  if (!agent_id || !name) return res.status(400).json({ error: 'Missing agent_id or name' });
  if (message && message.length > 15) return res.status(400).json({ error: 'Message too long' });
  
  let d = loadData();
  if (!d) d = initDataFile();
  
  const e = d.agents.find(a => a.id === agent_id);
  if (e) { e.name = name; e.msg = message; } 
  else { d.agents.push({ id: agent_id, name, msg: message }); }
  saveData(d);
  res.json({ ok: true });
});

// 退赛
app.delete('/api/register/:id', (req, res) => {
  let d = loadData();
  if (!d) d = initDataFile();
  d.agents = d.agents.filter(a => a.id !== req.params.id);
  saveData(d);
  res.json({ ok: true });
});

// 上报 Token
app.post('/api/report', (req, res) => {
  const { agent_id, agent_name, tokens_in = 0, tokens_out = 0, model = '' } = req.body;
  
  // 验证必填字段
  if (!agent_id || !agent_name) {
    return res.status(400).json({ error: 'Missing agent_id or agent_name' });
  }
  
  // 转换为数字
  const inVal = parseInt(tokens_in) || 0;
  const outVal = parseInt(tokens_out) || 0;
  
  // 防止负数
  if (inVal < 0 || outVal < 0) {
    return res.status(400).json({ error: 'tokens_in and tokens_out must be non-negative' });
  }
  
  // 单次上报上限检查
  const totalReport = inVal + outVal;
  if (totalReport > MAX_SINGLE_REPORT) {
    return res.status(400).json({ error: `Single report exceeds max limit of ${MAX_SINGLE_REPORT} tokens` });
  }
  
  // 防止测试账号
  if (agent_id.toLowerCase().startsWith('test')) {
    return res.status(400).json({ error: 'test not allowed' });
  }

  // 频率限制检查（每个 agent_id 每分钟1次）
  const lastReport = agentRateLimit.get(agent_id);
  const now = Date.now();
  if (lastReport && (now - lastReport) < RATE_LIMIT_MS) {
    const waitSeconds = Math.ceil((RATE_LIMIT_MS - (now - lastReport)) / 1000);
    return res.status(429).json({ 
      error: 'Rate limit exceeded. Max 1 report per agent per minute.', 
      retry_after_seconds: waitSeconds 
    });
  }

  let d = loadData();
  if (!d) d = initDataFile();
  
  const t = today();

  // 更新 agent
  let e = d.agents.find(a => a.id === agent_id);
  if (e) { 
    e.name = agent_name; 
    e.total = (e.total || 0) + inVal + outVal; 
  } else { 
    d.agents.push({ id: agent_id, name: agent_name, total: inVal + outVal }); 
  }

  // 更新今日 usage
  let u = d.usage.find(x => x.id === agent_id && x.date === t);
  if (u) { 
    u.in = (u.in || 0) + inVal; 
    u.out = (u.out || 0) + outVal; 
  } else { 
    d.usage.push({ id: agent_id, date: t, in: inVal, out: outVal, model }); 
  }

  saveData(d);
  agentRateLimit.set(agent_id, now);
  
  res.json({ ok: true });
});

// 统计
app.get('/api/stats', (req, res) => { 
  let d = loadData();
  if (!d) d = initDataFile();
  res.json({ total_agents: d.agents.length, total_usage_records: d.usage.length }); 
});

app.listen(PORT, () => console.log('Clawrank on ' + PORT));
