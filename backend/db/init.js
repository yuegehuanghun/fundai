/**
 * SQLite 数据库初始化 — 与前端 IndexedDB schema 一一对应
 * 运行: node db/init.js
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'fundai.db');

function initDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- 自选基金清单 (对应 IndexedDB watchlist, keyPath=code)
    CREATE TABLE IF NOT EXISTS watchlist (
      code        TEXT PRIMARY KEY NOT NULL CHECK(length(code) = 6),
      name        TEXT NOT NULL DEFAULT '',
      added_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- 持仓数据 (对应 IndexedDB positions, keyPath=code)
    CREATE TABLE IF NOT EXISTS positions (
      code            TEXT PRIMARY KEY NOT NULL REFERENCES watchlist(code),
      shares          REAL NOT NULL DEFAULT 0 CHECK(shares >= 0),
      cost_price      REAL NOT NULL DEFAULT 0 CHECK(cost_price >= 0),
      total_invested  REAL NOT NULL DEFAULT 0 CHECK(total_invested >= 0),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- 行情缓存 (对应 IndexedDB marketCache, keyPath=code)
    CREATE TABLE IF NOT EXISTS market_cache (
      code                TEXT PRIMARY KEY NOT NULL REFERENCES watchlist(code),
      name                TEXT NOT NULL DEFAULT '',
      nav                 REAL NOT NULL DEFAULT 0,
      nav_close           REAL NOT NULL DEFAULT 0,
      estimate_nav        REAL NOT NULL DEFAULT 0,
      change_pct          REAL NOT NULL DEFAULT 0,
      estimate_time       TEXT NOT NULL DEFAULT '',
      nav_date            TEXT NOT NULL DEFAULT '',
      nav_freshness       TEXT NOT NULL DEFAULT 'close',
      is_today_nav        INTEGER NOT NULL DEFAULT 0,
      valuation_percentile REAL,
      recent_navs_json    TEXT NOT NULL DEFAULT '[]',
      news_json           TEXT NOT NULL DEFAULT '[]',
      news_sentiment      REAL NOT NULL DEFAULT 50,
      source              TEXT NOT NULL DEFAULT 'unknown',
      update_time         INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- AI 每日结论归档 (对应 IndexedDB aiDecisions, keyPath=id autoIncrement)
    CREATE TABLE IF NOT EXISTS ai_decisions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      date                  TEXT NOT NULL,
      code                  TEXT NOT NULL,
      name                  TEXT NOT NULL DEFAULT '',
      timestamp             INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      valuation_score       REAL NOT NULL DEFAULT 0,
      profit_loss_score     REAL NOT NULL DEFAULT 0,
      trend_score           REAL NOT NULL DEFAULT 0,
      news_score            REAL NOT NULL DEFAULT 0,
      total_score           REAL NOT NULL DEFAULT 0,
      buy_pct               REAL NOT NULL DEFAULT 0,
      hold_pct              REAL NOT NULL DEFAULT 0,
      sell_pct              REAL NOT NULL DEFAULT 0,
      recommendation        TEXT NOT NULL DEFAULT '',
      action                TEXT NOT NULL DEFAULT 'hold',
      valuation_percentile  REAL,
      profit_pct            REAL NOT NULL DEFAULT 0,
      change_pct            REAL NOT NULL DEFAULT 0,
      news_summary          TEXT NOT NULL DEFAULT '',
      nav                   REAL NOT NULL DEFAULT 0,
      missing_dims_json     TEXT NOT NULL DEFAULT '[]',
      degraded              INTEGER NOT NULL DEFAULT 0,
      highlight             INTEGER NOT NULL DEFAULT 0,
      notify                INTEGER NOT NULL DEFAULT 0,
      UNIQUE(date, code)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_decisions_date ON ai_decisions(date);
    CREATE INDEX IF NOT EXISTS idx_ai_decisions_code ON ai_decisions(code);

    -- 月度资金 (对应 IndexedDB monthlyBudget, keyPath=yearMonth)
    CREATE TABLE IF NOT EXISTS monthly_budget (
      year_month        TEXT PRIMARY KEY NOT NULL,
      total_budget      REAL NOT NULL DEFAULT 0,
      used_amount       REAL NOT NULL DEFAULT 0,
      remaining_amount  REAL NOT NULL DEFAULT 0,
      max_daily_pct     INTEGER NOT NULL DEFAULT 30,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- 操作台账 (对应 IndexedDB operationLog, keyPath=id autoIncrement)
    CREATE TABLE IF NOT EXISTS operation_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT NOT NULL,
      code          TEXT NOT NULL,
      op_type       TEXT NOT NULL DEFAULT 'none',
      amount        REAL NOT NULL DEFAULT 0,
      shares        REAL NOT NULL DEFAULT 0,
      daily_profit  REAL NOT NULL DEFAULT 0,
      fund_profit   REAL NOT NULL DEFAULT 0,
      notes         TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_operation_log_date ON operation_log(date);
    CREATE INDEX IF NOT EXISTS idx_operation_log_code ON operation_log(code);

    -- 每日净值快照 (对应 IndexedDB aiCalcLog, keyPath=id)
    CREATE TABLE IF NOT EXISTS ai_calc_log (
      id          TEXT PRIMARY KEY NOT NULL,
      date        TEXT NOT NULL,
      code        TEXT NOT NULL,
      nav         REAL NOT NULL DEFAULT 0,
      nav_date    TEXT NOT NULL DEFAULT '',
      shares      REAL NOT NULL DEFAULT 0,
      nav_source  TEXT NOT NULL DEFAULT 'nav',
      source      TEXT NOT NULL DEFAULT '',
      daily_pnl   REAL NOT NULL DEFAULT 0,
      daily_pct   REAL NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_calc_log_date ON ai_calc_log(date);
    CREATE INDEX IF NOT EXISTS idx_ai_calc_log_code ON ai_calc_log(code);

    -- 目标持仓配置 (对应 AppSettings.fundAllocations)
    CREATE TABLE IF NOT EXISTS fund_allocations (
      code        TEXT PRIMARY KEY NOT NULL REFERENCES watchlist(code),
      name        TEXT NOT NULL DEFAULT '',
      target_pct  REAL NOT NULL DEFAULT 0 CHECK(target_pct >= 0 AND target_pct <= 100)
    );

    -- 系统设置键值对 (对应 AppSettings)
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL DEFAULT ''
    );

    -- 收盘前建议缓存 (对应 localStorage fundai_preclose_advice)
    CREATE TABLE IF NOT EXISTS preclose_advice (
      date        TEXT PRIMARY KEY NOT NULL,
      data_json   TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- 资讯缓存 (新增：服务端抓取的基金资讯)
    CREATE TABLE IF NOT EXISTS fund_news (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT '',
      date        TEXT NOT NULL DEFAULT '',
      sentiment   REAL NOT NULL DEFAULT 50,
      url         TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_fund_news_code ON fund_news(code);
    CREATE INDEX IF NOT EXISTS idx_fund_news_date ON fund_news(date);

    -- Token 消耗台账 (对应 localStorage fundai_deepseek_token_log)
    CREATE TABLE IF NOT EXISTS token_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      date              TEXT NOT NULL,
      code              TEXT NOT NULL,
      fund_name         TEXT NOT NULL DEFAULT '',
      model             TEXT NOT NULL DEFAULT 'deepseek-chat',
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      result            TEXT NOT NULL DEFAULT '',
      success           INTEGER NOT NULL DEFAULT 1,
      error             TEXT NOT NULL DEFAULT ''
    );
  `);

  console.log('[DB] SQLite 初始化完成:', DB_PATH);
  return db;
}

// 直接运行时初始化
if (require.main === module) {
  const db = initDB();
  console.log('[DB] 表结构:');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  tables.forEach(t => console.log('  -', t.name));
  db.close();
}

module.exports = { initDB, DB_PATH };
