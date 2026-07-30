/**
 * FundAI 后端 — Express 最小版（JSON 文件存储）
 * 先确保 Railway 能启动，再逐步加回 SQLite
 */
try { require('dotenv').config({ path: require('path').join(__dirname, '.env') }); } catch {}

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'fundai.json');

// ─── JSON 文件数据库 ────────────────────────────
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch { return {}; }
}
function writeDB(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 初始化默认结构
function getDB() {
  let db = readDB();
  if (!db.watchlist) db.watchlist = [];
  if (!db.positions) db.positions = [];
  if (!db.settings) db.settings = {};
  if (!db.preclose) db.preclose = {};
  if (!db.allocations) db.allocations = [];
  return db;
}

const db = getDB();
console.log('[Server] JSON 数据库就绪');

// ─── Express ───────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ─── API 路由（只处理 /api，无外部依赖） ──────
const api = express.Router();

api.get('/ping', (req, res) => {
  const d = getDB();
  res.json({ pong: true, time: Date.now(), fundCount: d.watchlist.length });
});

api.get('/funds', (req, res) => {
  res.json({ success: true, data: getDB().watchlist });
});

api.get('/allocations', (req, res) => {
  res.json({ success: true, data: getDB().allocations });
});

api.post('/allocations', (req, res) => {
  const d = getDB();
  d.allocations = req.body.allocations || [];
  writeDB(d);
  res.json({ success: true });
});

api.get('/preclose', (req, res) => {
  const d = getDB();
  const today = new Date().toISOString().slice(0, 10);
  res.json({ success: true, data: d.preclose[today] || null });
});

api.get('/health', (req, res) => {
  const d = getDB();
  res.json({ success: true, status: 'ok', fundCount: d.watchlist.length });
});

app.use('/api', api);

// ─── 启动 ──────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] 🚀 FundAI 启动 → port ${PORT}`);
  console.log(`[Server] DeepSeek: ${process.env.DEEPSEEK_API_KEY ? '✅' : '⚠'}`);
});
