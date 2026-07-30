/**
 * REST API 路由 — 前端通过 fetch('/api/...') 访问
 */
const express = require('express');
const router = express.Router();
const q = require('../db/queries');
const scraper = require('../services/fund-scraper');
const deepseek = require('../services/deepseek');

// 中间件：注入 db 实例
function withDB(db) {
  return (req, res, next) => { req.db = db; next(); };
}

// ==================== 行情 ====================

/** GET /api/funds — 自选基金列表 + 最新行情 */
router.get('/funds', async (req, res) => {
  try {
    const watchlist = q.watchlist.all(req.db);
    const cache = q.marketCache.all(req.db);
    const cacheMap = new Map(cache.map(c => [c.code, c]));
    const funds = watchlist.map(f => {
      const c = cacheMap.get(f.code) || {};
      return {
        code: f.code, name: c.name || f.name,
        nav: c.nav || 0, navClose: c.nav_close || 0,
        estimateNav: c.estimate_nav || 0, changePct: c.change_pct || 0,
        navDate: c.nav_date || '', navFreshness: c.nav_freshness || 'close',
        valuationPercentile: c.valuation_percentile,
        newsSentiment: c.news_sentiment || 50,
        source: c.source || 'unknown',
        updateTime: c.update_time || 0
      };
    });
    res.json({ success: true, data: funds });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /api/funds/refresh — 强制刷新全部基金行情（服务端抓取） */
router.post('/funds/refresh', async (req, res) => {
  try {
    const watchlist = q.watchlist.all(req.db);
    if (!watchlist.length) return res.json({ success: false, error: '无自选基金' });
    const codes = watchlist.map(f => f.code);
    const results = await scraper.fetchAllFundData(codes);
    q.marketCache.upsertAll(req.db, results);
    res.json({ success: true, data: results, count: results.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== 持仓 ====================

/** GET /api/positions — 持仓列表 */
router.get('/positions', (req, res) => {
  try {
    const data = q.positions.all(req.db);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /api/positions — 更新持仓 */
router.post('/positions', (req, res) => {
  try {
    const { code, shares, costPrice, totalInvested } = req.body;
    if (!code) return res.status(400).json({ success: false, error: '缺少 code' });
    q.positions.upsert(req.db, { code, shares: shares || 0, costPrice: costPrice || 0, totalInvested: totalInvested || 0 });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== 偏离表（目标配置） ====================

/** GET /api/allocations — 目标配置 + 偏离计算 */
router.get('/allocations', (req, res) => {
  try {
    const allocs = q.fundAllocations.all(req.db);
    const positions = q.positions.all(req.db);
    const cacheMap = new Map(q.marketCache.all(req.db).map(c => [c.code, c]));

    let totalValue = 0;
    const values = new Map();
    for (const pos of positions) {
      const mkt = cacheMap.get(pos.code) || {};
      const nav = mkt.nav || 0;
      const mv = pos.shares * nav;
      totalValue += mv;
      values.set(pos.code, mv);
    }

    const result = allocs.map(a => {
      const mv = values.get(a.code) || 0;
      const actualPct = totalValue > 0 ? (mv / totalValue) * 100 : 0;
      return {
        code: a.code, name: a.name, targetPct: a.target_pct,
        marketValue: Math.round(mv * 100) / 100,
        actualPct: Math.round(actualPct * 10) / 10,
        deviation: Math.round((actualPct - a.target_pct) * 10) / 10
      };
    });

    res.json({ success: true, data: result, totalValue: Math.round(totalValue * 100) / 100 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /api/allocations — 保存目标配置 */
router.post('/allocations', (req, res) => {
  try {
    const { allocations } = req.body;
    if (!Array.isArray(allocations)) return res.status(400).json({ success: false, error: '格式错误' });
    q.fundAllocations.upsertAll(req.db, allocations);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== 收盘前建议 ====================

/** GET /api/preclose — 获取今日收盘前建议 */
router.get('/preclose', (req, res) => {
  try {
    const data = q.preclose.getToday(req.db);
    if (!data) return res.json({ success: true, data: null });
    res.json({ success: true, data: JSON.parse(data.data_json), updatedAt: data.created_at });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /api/preclose/run — 手动触发收盘前分析 */
router.post('/preclose/run', async (req, res) => {
  try {
    // 跟 scheduler.js 里同样的逻辑，但对外暴露为 API
    const watchlist = q.watchlist.all(req.db);
    if (!watchlist.length) return res.json({ success: false, error: '无自选基金' });

    const results = await scraper.fetchAllFundData(watchlist.map(f => f.code));
    q.marketCache.upsertAll(req.db, results);

    const market = await scraper.fetchMarketContext();
    // 简化：复用已有的 preclose advice 结果
    const budget = q.monthlyBudget.getCurrent(req.db);
    const allocs = q.fundAllocations.all(req.db);
    const allocMap = new Map(allocs.map(a => [a.code, a.target_pct]));
    const positions = q.positions.all(req.db);
    const posMap = new Map(positions.map(p => [p.code, p]));
    const marketMap = new Map(results.map(r => [r.code, r]));

    let totalMV = 0;
    const pnlMap = new Map();
    for (const pos of positions) {
      const mkt = marketMap.get(pos.code);
      const nav = mkt ? mkt.nav : 0;
      const mv = pos.shares * nav;
      totalMV += mv;
      pnlMap.set(pos.code, { marketValue: mv, profitPct: pos.total_invested > 0 ? ((nav - pos.cost_price) / pos.cost_price) * 100 : 0 });
    }

    const funds = results.map(r => {
      const pnl = pnlMap.get(r.code) || { marketValue: 0, profitPct: 0 };
      const tp = allocMap.get(r.code) || 0;
      return {
        code: r.code, name: r.name, nav: r.nav, changePct: r.changePct,
        valuationPct: r.valuationPercentile, profitPct: pnl.profitPct,
        targetPct: tp, actualPct: totalMV > 0 ? (pnl.marketValue / totalMV) * 100 : 0
      };
    });

    const result = await deepseek.runPreCloseAnalysis({
      funds, market,
      budget: {
        remainingBudget: budget.totalBudget - budget.usedAmount,
        dailyLimit: budget.totalBudget * (budget.maxDailyPct / 100)
      },
      indexPE: null
    });

    q.preclose.setToday(req.db, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== 资讯 ====================

/** GET /api/news/:code — 基金相关资讯 */
router.get('/news/:code', (req, res) => {
  try {
    const news = q.fundNews.byCode(req.db, req.params.code, 10);
    res.json({ success: true, data: news });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== 设置 ====================

/** GET /api/settings — 获取全部设置 */
router.get('/settings', (req, res) => {
  try {
    const all = q.settings.all(req.db);
    const allocs = q.fundAllocations.all(req.db);
    res.json({ success: true, data: { settings: all, allocations: allocs } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /api/settings — 保存设置 */
router.post('/settings', (req, res) => {
  try {
    const { settings: newSettings, allocations } = req.body;
    if (newSettings) {
      for (const [key, value] of Object.entries(newSettings)) {
        q.settings.set(req.db, key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
    if (allocations) {
      q.fundAllocations.upsertAll(req.db, allocations);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== 预算 ====================

/** GET /api/budget — 当月预算 */
router.get('/budget', (req, res) => {
  try {
    const data = q.monthlyBudget.getCurrent(req.db);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /api/budget — 设置月度预算 */
router.post('/budget', (req, res) => {
  try {
    const { totalBudget, maxDailyPct } = req.body;
    q.monthlyBudget.setBudget(req.db, totalBudget || 0, maxDailyPct || 30);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== Token 统计 ====================

/** GET /api/tokens — Token 消耗统计 */
router.get('/tokens', (req, res) => {
  try {
    const stats = q.tokenLog.stats(req.db);
    const recent = q.tokenLog.all(req.db).slice(0, 20);
    res.json({ success: true, data: { stats, recent } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== 健康检查 ====================

/** GET /api/health — 服务健康检查 */
router.get('/health', (req, res) => {
  const watchlist = q.watchlist.all(req.db);
  const lastUpdate = q.marketCache.all(req.db).reduce((max, c) => Math.max(max, c.update_time || 0), 0);
  res.json({
    success: true,
    status: 'ok',
    fundCount: watchlist.length,
    lastMarketUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : null,
    deepseekReady: deepseek.isReady()
  });
});

module.exports = { router, withDB };
