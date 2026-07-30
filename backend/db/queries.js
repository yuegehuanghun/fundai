/**
 * 数据库查询封装 — 每个函数接收 db 实例作为第一参数
 * 所有写操作使用 db.prepare().run()，读操作使用 .all() 或 .get()
 */
const crypto = require('crypto');

// ==================== Watchlist ====================
const watchlist = {
  all: (db) => db.prepare('SELECT * FROM watchlist ORDER BY added_at ASC').all(),
  get: (db, code) => db.prepare('SELECT * FROM watchlist WHERE code = ?').get(code),
  upsert: (db, { code, name }) => {
    const addedAt = Date.now();
    db.prepare(`INSERT INTO watchlist (code, name, added_at) VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET name = excluded.name`).run(code, name, addedAt);
  },
  remove: (db, code) => db.prepare('DELETE FROM watchlist WHERE code = ?').run(code)
};

// ==================== Positions ====================
const positions = {
  all: (db) => db.prepare('SELECT * FROM positions').all(),
  get: (db, code) => db.prepare('SELECT * FROM positions WHERE code = ?').get(code),
  upsert: (db, { code, shares, costPrice, totalInvested }) => {
    db.prepare(`INSERT INTO positions (code, shares, cost_price, total_invested, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET shares=excluded.shares, cost_price=excluded.cost_price,
      total_invested=excluded.total_invested, updated_at=excluded.updated_at`)
      .run(code, shares, costPrice, totalInvested, Date.now());
  },
  remove: (db, code) => db.prepare('DELETE FROM positions WHERE code = ?').run(code)
};

// ==================== Market Cache ====================
const marketCache = {
  all: (db) => db.prepare('SELECT * FROM market_cache').all(),
  get: (db, code) => db.prepare('SELECT * FROM market_cache WHERE code = ?').get(code),
  upsertAll: (db, items) => {
    const stmt = db.prepare(`INSERT INTO market_cache
      (code, name, nav, nav_close, estimate_nav, change_pct, estimate_time, nav_date,
       nav_freshness, is_today_nav, valuation_percentile, recent_navs_json, news_json,
       news_sentiment, source, update_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name=excluded.name, nav=excluded.nav, nav_close=excluded.nav_close,
        estimate_nav=excluded.estimate_nav, change_pct=excluded.change_pct,
        estimate_time=excluded.estimate_time, nav_date=excluded.nav_date,
        nav_freshness=excluded.nav_freshness, is_today_nav=excluded.is_today_nav,
        valuation_percentile=excluded.valuation_percentile,
        recent_navs_json=excluded.recent_navs_json, news_json=excluded.news_json,
        news_sentiment=excluded.news_sentiment, source=excluded.source,
        update_time=excluded.update_time`);
    const now = Date.now();
    const insertMany = db.transaction((rows) => {
      for (const item of rows) {
        stmt.run(
          item.code, item.name || '', item.nav || 0, item.navClose || 0, item.estimateNav || 0,
          item.changePct || 0, item.estimateTime || '', item.navDate || '',
          item.navFreshness || 'close', item.isTodayNav ? 1 : 0,
          item.valuationPercentile != null ? item.valuationPercentile : null,
          JSON.stringify(item.recentNAVs || []), JSON.stringify(item.news || []),
          item.newsSentiment != null ? item.newsSentiment : 50,
          item.source || 'unknown', now
        );
      }
    });
    insertMany(items);
  }
};

// ==================== AI Calc Log (净值快照) ====================
const aiCalcLog = {
  all: (db) => db.prepare('SELECT * FROM ai_calc_log').all(),
  byCode: (db, code) => db.prepare('SELECT * FROM ai_calc_log WHERE code = ? ORDER BY date DESC').all(code),
  byDate: (db, date) => db.prepare('SELECT * FROM ai_calc_log WHERE date = ?').all(date),
  get: (db, date, code) => db.prepare('SELECT * FROM ai_calc_log WHERE id = ?').get(`${date}_${code}`),
  upsert: (db, entry) => {
    db.prepare(`INSERT INTO ai_calc_log (id, date, code, nav, nav_date, shares, nav_source, source, daily_pnl, daily_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET nav=excluded.nav, nav_date=excluded.nav_date,
      shares=excluded.shares, nav_source=excluded.nav_source, source=excluded.source,
      daily_pnl=excluded.daily_pnl, daily_pct=excluded.daily_pct`)
      .run(`${entry.date}_${entry.code}`, entry.date, entry.code, entry.nav, entry.navDate,
        entry.shares || 0, entry.navSource || 'nav', entry.source || '',
        entry.dailyPnL || 0, entry.dailyPct || 0);
  }
};

// ==================== AI Decisions ====================
const aiDecisions = {
  byDate: (db, date) => db.prepare('SELECT * FROM ai_decisions WHERE date = ?').all(date),
  byDateCode: (db, date, code) => db.prepare('SELECT * FROM ai_decisions WHERE date = ? AND code = ?').get(date, code),
  upsertAll: (db, decisions) => {
    const stmt = db.prepare(`INSERT INTO ai_decisions
      (date, code, name, timestamp, valuation_score, profit_loss_score, trend_score, news_score,
       total_score, buy_pct, hold_pct, sell_pct, recommendation, action, valuation_percentile,
       profit_pct, change_pct, news_summary, nav, missing_dims_json, degraded, highlight, notify)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, code) DO UPDATE SET
        name=excluded.name, buy_pct=excluded.buy_pct, hold_pct=excluded.hold_pct,
        sell_pct=excluded.sell_pct, recommendation=excluded.recommendation, action=excluded.action`);
    const now = Date.now();
    const insertMany = db.transaction((rows) => {
      for (const d of rows) {
        stmt.run(d.date, d.code, d.name || '', now,
          d.scores?.valuation || 0, d.scores?.profitLoss || 0, d.scores?.trend || 0, d.scores?.news || 0,
          d.scores?.total || 0, d.buyPct || 0, d.holdPct || 0, d.sellPct || 0,
          d.recommendation || '', d.action || 'hold', d.valuationPercentile,
          d.profitPct || 0, d.changePct || 0, d.newsSummary || '', d.nav || 0,
          JSON.stringify(d.missingDims || []), d.degraded ? 1 : 0, d.highlight ? 1 : 0, d.notify ? 1 : 0);
      }
    });
    insertMany(decisions);
  }
};

// ==================== Monthly Budget ====================
const monthlyBudget = {
  getCurrent: (db) => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let row = db.prepare('SELECT * FROM monthly_budget WHERE year_month = ?').get(ym);
    if (!row) {
      db.prepare(`INSERT INTO monthly_budget (year_month, total_budget, used_amount, remaining_amount, max_daily_pct)
        VALUES (?, 0, 0, 0, 30)`).run(ym);
      row = db.prepare('SELECT * FROM monthly_budget WHERE year_month = ?').get(ym);
    }
    return {
      yearMonth: row.year_month,
      totalBudget: row.total_budget,
      usedAmount: row.used_amount,
      remainingAmount: row.remaining_amount,
      maxDailyPct: row.max_daily_pct
    };
  },
  setBudget: (db, total, pct) => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    db.prepare(`INSERT INTO monthly_budget (year_month, total_budget, max_daily_pct, used_amount, remaining_amount)
      VALUES (?, ?, ?, 0, ?) ON CONFLICT(year_month) DO UPDATE SET
      total_budget=excluded.total_budget, max_daily_pct=excluded.max_daily_pct`)
      .run(ym, total, pct, total);
  },
  recordUsage: (db, amount) => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const row = db.prepare('SELECT * FROM monthly_budget WHERE year_month = ?').get(ym);
    if (!row) return;
    const newUsed = (row.used_amount || 0) + amount;
    db.prepare('UPDATE monthly_budget SET used_amount = ?, remaining_amount = total_budget - ? WHERE year_month = ?')
      .run(newUsed, newUsed, ym);
  }
};

// ==================== Operation Log ====================
const operationLog = {
  all: (db) => db.prepare('SELECT * FROM operation_log ORDER BY date DESC, id DESC').all(),
  byCode: (db, code) => db.prepare('SELECT * FROM operation_log WHERE code = ? ORDER BY date ASC, id ASC').all(code),
  add: (db, record) => {
    return db.prepare(`INSERT INTO operation_log (date, code, op_type, amount, shares, daily_profit, fund_profit, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.date, record.code, record.opType || 'none', record.amount || 0,
        record.shares || 0, record.dailyProfit || 0, record.fundProfit || 0, record.notes || '');
  },
  remove: (db, id) => db.prepare('DELETE FROM operation_log WHERE id = ?').run(id)
};

// ==================== Fund Allocations ====================
const fundAllocations = {
  all: (db) => db.prepare('SELECT * FROM fund_allocations ORDER BY target_pct DESC').all(),
  upsertAll: (db, allocs) => {
    const stmt = db.prepare(`INSERT INTO fund_allocations (code, name, target_pct) VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, target_pct=excluded.target_pct`);
    const insertMany = db.transaction((rows) => {
      for (const a of rows) { stmt.run(a.code, a.name || '', a.targetPct || 0); }
    });
    insertMany(allocs);
  }
};

// ==================== Settings ====================
const settings = {
  get: (db, key) => {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  set: (db, key, value) => {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, typeof value === 'string' ? value : JSON.stringify(value));
  },
  all: (db) => {
    const rows = db.prepare('SELECT * FROM app_settings').all();
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    return obj;
  }
};

// ==================== Preclose Advice ====================
const preclose = {
  getToday: (db) => {
    const today = new Date().toISOString().slice(0, 10);
    return db.prepare('SELECT * FROM preclose_advice WHERE date = ?').get(today);
  },
  setToday: (db, data) => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare('INSERT INTO preclose_advice (date, data_json) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET data_json=excluded.data_json')
      .run(today, JSON.stringify(data));
  }
};

// ==================== Fund News ====================
const fundNews = {
  byCode: (db, code, limit = 10) =>
    db.prepare('SELECT * FROM fund_news WHERE code = ? ORDER BY date DESC LIMIT ?').all(code, limit),
  upsertAll: (db, newsItems) => {
    const stmt = db.prepare(`INSERT OR IGNORE INTO fund_news (code, title, date, sentiment, url)
      VALUES (?, ?, ?, ?, ?)`);
    const insertMany = db.transaction((rows) => {
      for (const n of rows) { stmt.run(n.code, n.title, n.date, n.sentiment, n.url || ''); }
    });
    insertMany(newsItems);
  },
  cleanup: (db, keepDays = 30) => {
    const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
    db.prepare('DELETE FROM fund_news WHERE date < ?').run(cutoff);
  }
};

// ==================== Token Log ====================
const tokenLog = {
  add: (db, entry) => {
    db.prepare(`INSERT INTO token_log (date, code, fund_name, model, prompt_tokens, completion_tokens, total_tokens, result, success, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.date, entry.code, entry.fundName || '', entry.model || 'deepseek-chat',
        entry.promptTokens || 0, entry.completionTokens || 0, entry.totalTokens || 0,
        (entry.result || '').slice(0, 200), entry.success ? 1 : 0, (entry.error || '').slice(0, 500));
  },
  stats: (db) => {
    return db.prepare(`SELECT COUNT(*) as totalCalls, SUM(CASE WHEN success THEN 1 ELSE 0 END) as successCalls,
      SUM(CASE WHEN success THEN 0 ELSE 1 END) as failCalls,
      COALESCE(SUM(total_tokens),0) as totalTokens,
      COALESCE(SUM(prompt_tokens),0) as totalPrompt, COALESCE(SUM(completion_tokens),0) as totalCompletion
      FROM token_log`).get();
  },
  all: (db) => db.prepare('SELECT * FROM token_log ORDER BY timestamp DESC LIMIT 100').all()
};

module.exports = {
  watchlist, positions, marketCache, aiCalcLog, aiDecisions,
  monthlyBudget, operationLog, fundAllocations, settings,
  preclose, fundNews, tokenLog
};
