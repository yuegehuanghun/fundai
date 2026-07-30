/**
 * SQLite 数据库初始化 — 使用 sql.js（纯 JS WASM，无需原生编译）
 * sql.js 在内存中运行 SQLite，定期持久化到磁盘文件
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'fundai.db');

async function initDB() {
  // 确保 data 目录存在
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });

  // 尝试从磁盘加载已有数据库
  let db;
  if (fs.existsSync(DB_PATH)) {
    try {
      const fileBuffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(fileBuffer);
      console.log('[DB] 从磁盘加载已有数据库');
    } catch (e) {
      console.warn('[DB] 数据库文件损坏，创建新库:', e.message);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
    console.log('[DB] 创建新数据库');
  }

  // 建表（IF NOT EXISTS 保证幂等）
  db.run('PRAGMA journal_mode = OFF'); // sql.js 不需要 WAL
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      code TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL DEFAULT '',
      added_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS positions (
      code TEXT PRIMARY KEY NOT NULL, shares REAL NOT NULL DEFAULT 0,
      cost_price REAL NOT NULL DEFAULT 0, total_invested REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS market_cache (
      code TEXT PRIMARY KEY NOT NULL, name TEXT DEFAULT '', nav REAL DEFAULT 0,
      nav_close REAL DEFAULT 0, estimate_nav REAL DEFAULT 0, change_pct REAL DEFAULT 0,
      estimate_time TEXT DEFAULT '', nav_date TEXT DEFAULT '',
      nav_freshness TEXT DEFAULT 'close', is_today_nav INTEGER DEFAULT 0,
      valuation_percentile REAL, recent_navs_json TEXT DEFAULT '[]',
      news_json TEXT DEFAULT '[]', news_sentiment REAL DEFAULT 50,
      source TEXT DEFAULT 'unknown', update_time INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, code TEXT NOT NULL,
      name TEXT DEFAULT '', timestamp INTEGER DEFAULT 0,
      valuation_score REAL DEFAULT 0, profit_loss_score REAL DEFAULT 0,
      trend_score REAL DEFAULT 0, news_score REAL DEFAULT 0, total_score REAL DEFAULT 0,
      buy_pct REAL DEFAULT 0, hold_pct REAL DEFAULT 0, sell_pct REAL DEFAULT 0,
      recommendation TEXT DEFAULT '', action TEXT DEFAULT 'hold',
      valuation_percentile REAL, profit_pct REAL DEFAULT 0, change_pct REAL DEFAULT 0,
      news_summary TEXT DEFAULT '', nav REAL DEFAULT 0,
      missing_dims_json TEXT DEFAULT '[]', degraded INTEGER DEFAULT 0,
      highlight INTEGER DEFAULT 0, notify INTEGER DEFAULT 0,
      UNIQUE(date, code)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS monthly_budget (
      year_month TEXT PRIMARY KEY NOT NULL, total_budget REAL DEFAULT 0,
      used_amount REAL DEFAULT 0, remaining_amount REAL DEFAULT 0,
      max_daily_pct INTEGER DEFAULT 30, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS operation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, code TEXT NOT NULL,
      op_type TEXT DEFAULT 'none', amount REAL DEFAULT 0, shares REAL DEFAULT 0,
      daily_profit REAL DEFAULT 0, fund_profit REAL DEFAULT 0, notes TEXT DEFAULT '',
      created_at INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_calc_log (
      id TEXT PRIMARY KEY NOT NULL, date TEXT NOT NULL, code TEXT NOT NULL,
      nav REAL DEFAULT 0, nav_date TEXT DEFAULT '', shares REAL DEFAULT 0,
      nav_source TEXT DEFAULT 'nav', source TEXT DEFAULT '',
      daily_pnl REAL DEFAULT 0, daily_pct REAL DEFAULT 0, created_at INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS fund_allocations (
      code TEXT PRIMARY KEY NOT NULL, name TEXT DEFAULT '',
      target_pct REAL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL, value TEXT DEFAULT ''
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS preclose_advice (
      date TEXT PRIMARY KEY NOT NULL, data_json TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS fund_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL,
      title TEXT DEFAULT '', date TEXT DEFAULT '', sentiment REAL DEFAULT 50,
      url TEXT DEFAULT '', created_at INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS token_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER DEFAULT 0,
      date TEXT NOT NULL, code TEXT NOT NULL, fund_name TEXT DEFAULT '',
      model TEXT DEFAULT 'deepseek-chat', prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0,
      result TEXT DEFAULT '', success INTEGER DEFAULT 1, error TEXT DEFAULT ''
    )
  `);

  // 创建索引
  ['ai_decisions','operation_log','ai_calc_log','fund_news'].forEach(t => {
    try { db.run(`CREATE INDEX IF NOT EXISTS idx_${t}_date ON ${t}(date)`); } catch {}
    try { db.run(`CREATE INDEX IF NOT EXISTS idx_${t}_code ON ${t}(code)`); } catch {}
  });

  console.log('[DB] sql.js 数据库就绪');
  return db;
}

/** 持久化到磁盘（每次写操作后调用） */
function saveToDisk(db) {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('[DB] 持久化失败:', e.message);
  }
}

module.exports = { initDB, saveToDisk, DB_PATH };
