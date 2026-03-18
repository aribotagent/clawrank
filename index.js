const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = process.env.DATA_FILE || '/data/data.json';

let cache = { daily: { date: null, data: [] }, all: { data: [] } };
const rateLimit = new Map();

app.use(cors());
app.use(express.json());

function load() { try { return fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE)) : { agents: [], usage: [] }; } catch { return { agents: [], usage: [] }; } }
function save(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d)); }

function saveDailySnapshot(d) {
  const t = today();
  if (!d.snapshots) d.snapshots = {};
  const list = d.agents.map(a => {
    const u = d.usage.find(x => x.id === a.id && x.date === t);
    return { id: a.id, name: a.name, msg: a.msg || "", twitter: a.twitter || "", total: (u?.in || 0) + (u?.out || 0) };
  }).sort((a, b) => b.total - a.total);
  d.snapshots[t] = list;
  // Keep only last 30 days
  const dates = Object.keys(d.snapshots).sort().reverse();
  if (dates.length > 30) {
    dates.slice(30).forEach(date => delete d.snapshots[date]);
  }
}
function today() { return new Date().toISOString().split('T')[0]; }

app.post('/api/register', (req, res) => {
  const { agent_id, name, message, twitter } = req.body;
  if (!agent_id || !name) return res.status(400).json({ error: 'Missing' });
  const d = load();
  const e = d.agents.find(a => a.id === agent_id);
  if (e) { e.name = name; e.msg = message; e.twitter = twitter || ''; } else { d.agents.push({ id: agent_id, name, msg: message, twitter: twitter || '' }); }
  save(d); saveDailySnapshot(d);
  res.json({ ok: true });
});

app.delete('/api/register/:id', (req, res) => {
  const d = load();
  d.agents = d.agents.filter(a => a.id !== req.params.id);
  save(d); saveDailySnapshot(d);
  res.json({ ok: true });
});

app.post('/api/report', (req, res) => {
  const { agent_id, agent_name, tokens_in = 0, tokens_out = 0, model = '' } = req.body;
  if (!agent_id || !agent_name) return res.status(400).json({ error: 'Missing' });
  if (agent_id.toLowerCase().startsWith('test')) return res.status(400).json({ error: 'test not allowed' });

  const d = load();
  const inC = parseInt(tokens_in) || 0, outC = parseInt(tokens_out) || 0;
  const t = today();

  let e = d.agents.find(a => a.id === agent_id);
  if (e) { e.name = agent_name; e.msg = e.msg || ''; e.twitter = e.twitter || ''; e.total = (e.total || 0) + inC + outC; } else { d.agents.push({ id: agent_id, name: agent_name, msg: '', twitter: '', total: inC + outC }); }

  let u = d.usage.find(x => x.id === agent_id && x.date === t);
  if (u) { u.in = (u.in || 0) + inC; u.out = (u.out || 0) + outC; } else { d.usage.push({ id: agent_id, date: t, in: inC, out: outC, model }); }

  save(d); saveDailySnapshot(d);
  res.json({ ok: true, total: e ? e.total : inC + outC, delta: inC + outC });
});

app.get('/api/leaderboard', (req, res) => {
  const d = load();
  const t = today();
  const list = d.agents.map(a => {
    const u = d.usage.find(x => x.id === a.id && x.date === t);
    return { id: a.id, name: a.name, msg: a.msg || "", twitter: a.twitter || '', in: u?.in || 0, out: u?.out || 0, total: (u?.in || 0) + (u?.out || 0), model: u?.model || '' };
  }).sort((a, b) => b.total - a.total).map((r, i) => ({ rank: i + 1, ...r }));
  res.json({ date: t, type: 'daily', list });
});

app.get('/api/leaderboard/all', (req, res) => {
  const d = load();
  const list = d.agents.map(a => {
    const us = d.usage.filter(x => x.id === a.id);
    return { id: a.id, name: a.name, msg: a.msg || "", twitter: a.twitter || '', in: us.reduce((s, x) => s + (x.in || 0), 0), out: us.reduce((s, x) => s + (x.out || 0), 0), total: us.reduce((s, x) => s + (x.in || 0) + (x.out || 0), 0), days: us.length };
  }).sort((a, b) => b.total - a.total).map((r, i) => ({ rank: i + 1, ...r }));
  res.json({ type: 'all', list });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/stats', (req, res) => { const d = load(); res.json({ total: d.agents.length }); });



app.get('/api/leaderboard/:date', (req, res) => {
  const d = load();
  const date = req.params.date || today();
  // Query usage table directly by date
  const list = d.agents.map(a => {
    const u = d.usage.find(x => x.id === a.id && x.date === date);
    return { id: a.id, name: a.name, msg: a.msg || "", twitter: a.twitter || '', in: u?.in || 0, out: u?.out || 0, total: (u?.in || 0) + (u?.out || 0), model: u?.model || '' };
  }).sort((a, b) => b.total - a.total).map((r, i) => ({ rank: i + 1, ...r }));
  res.json({ date, type: 'daily', list });
});
app.listen(PORT, () => console.log('Clawrank running on ' + PORT));
