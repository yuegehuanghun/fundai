/**
 * 数据库查询封装 — 基于 sql.js（纯 JS，无原生依赖）
 * sql.js stmt.bind/getAsObject 提供与 better-sqlite3 类似的接口
 */

// ── 工具函数 ──────────────────────────────────────
function _queryAll(db, sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) { console.error('[DB] queryAll error:', e.message, sql.slice(0, 80)); return []; }
}

function _queryOne(db, sql, params = []) {
  const rows = _queryAll(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function _execute(db, sql, params = []) {
  try {
    db.run(sql, params);
    return true;
  } catch (e) { console.error('[DB] execute error:', e.message, sql.slice(0, 80)); return false; }
}

// ── Watchlist ──────────────────────────────────────
const watchlist = {
  all: (db) => _queryAll(db, 'SELECT * FROM watchlist ORDER BY added_at ASC'),
  get: (db, code) => _queryOne(db, 'SELECT * FROM watchlist WHERE code = ?', [code]),
  upsert: (db, { code, name }) => {
    _execute(db, 'INSERT OR REPLACE INTO watchlist (code, name, added_at) VALUES (?, ?, ?)',
      [code, name || '', Date.now()]);
  },
  remove: (db, code) => _execute(db, 'DELETE FROM watchlist WHERE code = ?', [code])
};

// ── Positions ─────────────────────────────────────
const positions = {
  all: (db) => _queryAll(db, 'SELECT * FROM positions'),
  get: (db, code) => _queryOne(db, 'SELECT * FROM positions WHERE code = ?', [code]),
  upsert: (db, { code, shares, costPrice, totalInvested }) => {
    _execute(db, `INSERT OR REPLACE INTO positions (code, shares, cost_price, total_invested, updated_at)
      VALUES (?, ?, ?, ?, ?)`,
      [code, shares || 0, costPrice || 0, totalInvested || 0, Date.now()]);
  },
  remove: (db, code) => _execute(db, 'DELETE FROM positions WHERE code = ?', [code])
};

// ── Market Cache ──────────────────────────────────
const marketCache = {
  all: (db) => _queryAll(db, 'SELECT * FROM market_cache'),
  get: (db, code) => _queryOne(db, 'SELECT * FROM market_cache WHERE code = ?', [code]),
  upsertAll: (db, items) => {
    for (const item of items) {
      _execute(db, `INSERT OR REPLACE INTO market_cache
        (code, name, nav, nav_close, estimate_nav, change_pct, estimate_time, nav_date,
         nav_freshness, is_today_nav, valuation_percentile, recent_navs_json, news_json,
         news_sentiment, source, update_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.code, item.name || '', item.nav || 0, item.navClose || 0, item.estimateNav || 0,
         item.changePct || 0, item.estimateTime || '', item.navDate || '',
         item.navFreshness || 'close', item.isTodayNav ? 1 : 0,
         item.valuationPercentile != null ? item.valuationPercentile : null,
         JSON.stringify(item.recentNAVs || []), JSON.stringify(item.news || []),
         item.newsSentiment != null ? item.newsSentiment : 50,
         item.source || 'unknown', Date.now()]);
    }
  }
};

// ── AI Calc Log ───────────────────────────────────
const aiCalcLog = {
  all: (db) => _queryAll(db, 'SELECT * FROM ai_calc_log'),
  byCode: (db, code) => _queryAll(db, 'SELECT * FROM ai_calc_log WHERE code = ? ORDER BY date DESC', [code]),
  byDate: (db, date) => _queryAll(db, 'SELECT * FROM ai_calc_log WHERE date = ?', [date]),
  get: (db, date, code) => _queryOne(db, 'SELECT * FROM ai_calc_log WHERE id = ?', [`${date}_${code}`]),
  upsert: (db, entry) => {
    _execute(db, `INSERT OR REPLACE INTO ai_calc_log (id, date, code, nav, nav_date, shares, nav_source, source, daily_pnl, daily_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`${entry.date}_${entry.code}`, entry.date, entry.code, entry.nav, entry.navDate,
       entry.shares || 0, entry.navSource || 'nav', entry.source || '', entry.dailyPnL || 0, entry.dailyPct || 0]);
  }
};

// ── AI Decisions ──────────────────────────────────
const aiDecisions = {
  byDate: (db, date) => _queryAll(db, 'SELECT * FROM ai_decisions WHERE date = ?', [date]),
  byDateCode: (db, date, code) => _queryOne(db, 'SELECT * FROM ai_decisions WHERE date = ? AND code = ?', [date, code]),
  upsertAll: (db, decisions) => {
    const now = Date.now();
    for (const d of decisions) {
      _execute(db, `INSERT OR REPLACE INTO ai_decisions
        (date, code, name, timestamp, valuation_score, profit_loss_score, trend_score, news_score,
         total_score, buy_pct, hold_pct, sell_pct, recommendation, action, valuation_percentile,
         profit_pct, change_pct, news_summary, nav, missing_dims_json, degraded, highlight, notify)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.date, d.code, d.name || '', now,
         (d.scores && d.scores.valuation) || 0, (d.scores && d.scores.profitLoss) || 0,
         (d.scores && d.scores.trend) || 0, (d.scores && d.scores.news) || 0,
         (d.scores && d.scores.total) || 0, d.buyPct || 0, d.holdPct || 0, d.sellPct || 0,
         d.recommendation || '', d.action || 'hold', d.valuationPercentile,
         d.profitPct || 0, d.changePct || 0, d.newsSummary || '', d.nav || 0,
         JSON.stringify(d.missingDims || []), d.degraded ? 1 : 0,
         d.highlight ? 1 : 0, d.notify ? 1 : 0]);
    }
  }
};

// ── Monthly Budget ────────────────────────────────
const monthlyBudget = {
  getCurrent: (db) => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let row = _queryOne(db, 'SELECT * FROM monthly_budget WHERE year_month = ?', [ym]);
    if (!row) {
      _execute(db, 'INSERT INTO monthly_budget (year_month, total_budget, used_amount, remaining_amount, max_daily_pct) VALUES (?, 0, 0, 0, 30)', [ym]);
      row = _queryOne(db, 'SELECT * FROM monthly_budget WHERE year_month = ?', [ym]) || {};
    }
    return { yearMonth: row.year_month, totalBudget: row.total_budget, usedAmount: row.used_amount,
      remainingAmount: row.remaining_amount, maxDailyPct: row.max_daily_pct };
  },
  setBudget: (db, total, pct) => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    _execute(db, `INSERT OR REPLACE INTO monthly_budget (year_month, total_budget, max_daily_pct, used_amount, remaining_amount)
      VALUES (?, ?, ?, COALESCE((SELECT used_amount FROM monthly_budget WHERE year_month = ?), 0), ?)`,
      [ym, total, pct, ym, total]);
  },
  recordUsage: (db, amount) => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const row = _queryOne(db, 'SELECT * FROM monthly_budget WHERE year_month = ?', [ym]);
    if (!row) return;
    const nu = (row.used_amount || 0) + amount;
    _execute(db, 'UPDATE monthly_budget SET used_amount = ?, remaining_amount = total_budget - ? WHERE year_month = ?', [nu, nu, ym]);
  }
};

// ── Operation Log ─────────────────────────────────
const operationLog = {
  all: (db) => _queryAll(db, 'SELECT * FROM operation_log ORDER BY date DESC, id DESC'),
  byCode: (db, code) => _queryAll(db, 'SELECT * FROM operation_log WHERE code = ? ORDER BY date ASC, id ASC', [code]),
  add: (db, record) => {
    _execute(db, `INSERT INTO operation_log (date, code, op_type, amount, shares, daily_profit, fund_profit, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.date, record.code, record.opType || 'none', record.amount || 0,
       record.shares || 0, record.dailyProfit || 0, record.fundProfit || 0, record.notes || '']);
  },
  remove: (db, id) => _execute(db, 'DELETE FROM operation_log WHERE id = ?', [id])
};

// ── Fund Allocations ──────────────────────────────
const fundAllocations = {
  all: (db) => _queryAll(db, 'SELECT * FROM fund_allocations ORDER BY target_pct DESC'),
  upsertAll: (db, allocs) => {
    for (const a of allocs) {
      _execute(db, 'INSERT OR REPLACE INTO fund_allocations (code, name, target_pct) VALUES (?, ?, ?)',
        [a.code, a.name || '', a.targetPct || 0]);
    }
  }
};

// ── Settings ──────────────────────────────────────
const settings = {
  get: (db, key) => { const r = _queryOne(db, 'SELECT value FROM app_settings WHERE key = ?', [key]); return r ? r.value : null; },
  set: (db, key, value) => {
    _execute(db, 'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
      [key, typeof value === 'string' ? value : JSON.stringify(value)]);
  },
  all: (db) => {
    const rows = _queryAll(db, 'SELECT * FROM app_settings');
    const obj = {}; rows.forEach(r => { obj[r.key] = r.value; }); return obj;
  }
};

// ── Preclose Advice ───────────────────────────────
const preclose = {
  getToday: (db) => {
    const today = new Date().toISOString().slice(0, 10);
    return _queryOne(db, 'SELECT * FROM preclose_advice WHERE date = ?', [today]);
  },
  setToday: (db, data) => {
    const today = new Date().toISOString().slice(0, 10);
    _execute(db, 'INSERT OR REPLACE INTO preclose_advice (date, data_json, created_at) VALUES (?, ?, ?)',
      [today, JSON.stringify(data), Date.now()]);
  }
};

// ── Fund News ─────────────────────────────────────
const fundNews = {
  byCode: (db, code, limit = 10) =>
    _queryAll(db, 'SELECT * FROM fund_news WHERE code = ? ORDER BY date DESC LIMIT ?', [code, limit]),
  upsertAll: (db, items) => {
    for (const n of items) {
      _execute(db, 'INSERT OR IGNORE INTO fund_news (code, title, date, sentiment, url) VALUES (?, ?, ?, ?, ?)',
        [n.code, n.title, n.date, n.sentiment, n.url || '']);
    }
  },
  cleanup: (db, keepDays = 30) => {
    const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
    _execute(db, 'DELETE FROM fund_news WHERE date < ?', [cutoff]);
  }
};

// ── Token Log ─────────────────────────────────────
const tokenLog = {
  add: (db, entry) => {
    _execute(db, `INSERT INTO token_log (date, code, fund_name, model, prompt_tokens, completion_tokens, total_tokens, result, success, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.date, entry.code, entry.fundName || '', entry.model || 'deepseek-chat',
       entry.promptTokens || 0, entry.completionTokens || 0, entry.totalTokens || 0,
       (entry.result || '').slice(0, 200), entry.success ? 1 : 0, (entry.error || '').slice(0, 500)]);
  },
  stats: (db) => {
    return _queryOne(db, `SELECT COUNT(*) as totalCalls, COALESCE(SUM(CASE WHEN success THEN 1 ELSE 0 END),0) as successCalls,
      COALESCE(SUM(CASE WHEN success THEN 0 ELSE 1 END),0) as failCalls,
      COALESCE(SUM(total_tokens),0) as totalTokens, COALESCE(SUM(prompt_tokens),0) as totalPrompt,
      COALESCE(SUM(completion_tokens),0) as totalCompletion FROM token_log`) || {};
  },
  all: (db) => _queryAll(db, 'SELECT * FROM token_log ORDER BY timestamp DESC LIMIT 100')
};

module.exports = { watchlist, positions, marketCache, aiCalcLog, aiDecisions,
  monthlyBudget, operationLog, fundAllocations, settings,
  preclose, fundNews, tokenLog };
