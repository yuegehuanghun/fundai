/**
 * 定时任务调度器 — 替代浏览器定时器，服务端自主执行
 *   - 每个交易日 14:30 → 收盘前分析
 *   - 每小时 → 行情快照采集 + 资讯抓取
 *   - 凌晨 2:00 → 资讯清理（保留 30 天）
 */
const cron = require('node-cron');
const { initDB } = require('./db/init');
const q = require('./db/queries');
const scraper = require('./services/fund-scraper');
const deepseek = require('./services/deepseek');

// 北京时间工具函数 (服务器可能在任意时区)
function beijingNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function beijingDateStr() { return beijingNow().toISOString().slice(0, 10); }
function beijingDay() { return beijingNow().getUTCDay(); }
function beijingMinutes() { const d = beijingNow(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

/** 判断今天是否为 A 股交易日（周末排除 + 节假日表） */
function isTradingDate(db, dateStr) {
  const day = new Date(dateStr + 'T12:00:00').getUTCDay();
  if (day === 0 || day === 6) return false;
  const holidaysJson = q.settings.get(db, 'fundai_holidays');
  if (holidaysJson) {
    try {
      const holidays = JSON.parse(holidaysJson);
      if (holidays.includes(dateStr)) return false;
    } catch { /* 忽略 */ }
  }
  return true;
}

function startScheduler(db) {
  console.log('[Scheduler] 定时任务启动');

  // ============ ① 每小时行情采集（整点后 5 分钟） ============
  cron.schedule('5 * * * *', async () => {
    const now = beijingNow();
    // 仅交易日 9:00-16:00 采集
    const mins = beijingMinutes();
    if (!isTradingDate(db, beijingDateStr())) return;
    if (mins < 9 * 60 || mins > 16 * 60) return; // 仅北京时间 9:00~16:00

    console.log(`[Scheduler] 🔄 行情采集 ${now.toISOString()}`);
    try {
      const watchlist = q.watchlist.all(db);
      if (!watchlist.length) return;

      const codes = watchlist.map(f => f.code);
      const results = await scraper.fetchAllFundData(codes);
      q.marketCache.upsertAll(db, results);

      // 同步采集资讯
      for (const fund of results) {
        if (fund.news && fund.news.length) {
          const newsItems = fund.news.map(n => ({
            code: fund.code, title: n.title, date: n.date,
            sentiment: n.sentiment, url: n.url || ''
          }));
          q.fundNews.upsertAll(db, newsItems);
        }
      }
      console.log(`[Scheduler] ✅ 行情更新完成 ${results.length} 只基金`);
    } catch (e) {
      console.error('[Scheduler] 行情采集失败:', e.message);
    }
  });

  // ============ ② 收盘前分析 — 每个交易日 14:30 ============
  cron.schedule('30 14 * * 1-5', async () => {
    const today = beijingDateStr();
    if (!isTradingDate(db, today)) {
      console.log(`[Scheduler] ${today} 非交易日，跳过收盘前分析`);
      return;
    }

    // 今天是否已执行过
    const existing = q.preclose.getToday(db);
    if (existing) {
      console.log(`[Scheduler] ${today} 收盘前分析已完成，跳过`);
      return;
    }

    console.log(`[Scheduler] ⏰ ${today} 14:30 收盘前分析触发`);

    try {
      // 1. 拉取最新行情
      const watchlist = q.watchlist.all(db);
      if (!watchlist.length) { console.log('[Scheduler] 无自选基金，跳过'); return; }

      const codes = watchlist.map(f => f.code);
      const results = await scraper.fetchAllFundData(codes);
      q.marketCache.upsertAll(db, results);

      // 2. 获取市场全景
      const market = await scraper.fetchMarketContext();

      // 3. 获取指数 PE
      let indexPE = null;
      try {
        const resp = await require('node-fetch')(
          'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&end=20500000&lmt=2000',
          { timeout: 8000 }
        );
        const text = await resp.text();
        const match = text.match(/^\w+\((.+)\)\s*$/);
        if (match) {
          const json = JSON.parse(match[1]);
          if (json?.data?.klines) {
            const peValues = json.data.klines.map(l => { const p = l.split(','); return parseFloat(p[10] || p[9] || 0); }).filter(v => v > 0);
            if (peValues.length) {
              const sorted = [...peValues].sort((a, b) => a - b);
              const rank = sorted.findIndex(v => v >= peValues[peValues.length - 1]);
              indexPE = { pePercentile: Math.round((rank / sorted.length) * 100), currentPE: peValues[peValues.length - 1] };
            }
          }
        }
      } catch { /* 降级 */ }

      // 4. 获取持仓和预算
      const positions = q.positions.all(db);
      const budget = q.monthlyBudget.getCurrent(db);
      const allocs = q.fundAllocations.all(db);
      const allocMap = new Map(allocs.map(a => [a.code, a.target_pct]));

      // 5. 构建基金数据
      const posMap = new Map(positions.map(p => [p.code, p]));
      const marketMap = new Map(results.map(r => [r.code, r]));

      // 计算总市值（简化的 PnL）
      let totalMarketValue = 0;
      const pnlMap = new Map();
      for (const pos of positions) {
        const mkt = marketMap.get(pos.code);
        const nav = mkt ? mkt.nav : 0;
        const mv = pos.shares * nav;
        totalMarketValue += mv;
        const profitPct = pos.total_invested > 0 ? ((nav - pos.cost_price) / pos.cost_price) * 100 : 0;
        pnlMap.set(pos.code, { marketValue: mv, profitPct });
      }

      const funds = results.map(r => {
        const pnl = pnlMap.get(r.code) || { marketValue: 0, profitPct: 0 };
        const targetPct = allocMap.get(r.code) || 0;
        const actualPct = totalMarketValue > 0 ? (pnl.marketValue / totalMarketValue) * 100 : 0;
        return {
          code: r.code, name: r.name, nav: r.nav,
          changePct: r.changePct,
          valuationPct: r.valuationPercentile,
          profitPct: pnl.profitPct,
          targetPct, actualPct
        };
      });

      // 6. 调用 DeepSeek
      const result = await deepseek.runPreCloseAnalysis({
        funds, market,
        budget: {
          remainingBudget: budget.totalBudget - budget.usedAmount,
          dailyLimit: budget.totalBudget * (budget.maxDailyPct / 100)
        },
        indexPE
      });

      // 7. 持久化
      q.preclose.setToday(db, result);
      q.tokenLog.add(db, {
        date: today, code: 'BATCH', fundName: '收盘前批量分析',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        promptTokens: result.tokens || 0,
        completionTokens: 0, totalTokens: result.tokens || 0,
        result: result.summary || (result.funds || []).map(f => `${f.name}:${f.advice}`).join(', '),
        success: result.success, error: result.error || ''
      });

      console.log(`[Scheduler] ✅ 收盘前分析完成 · ${result.tokens || 0} tokens · ${(result.funds || []).map(f => f.name + ':' + f.advice).join(', ')}`);

    } catch (e) {
      console.error('[Scheduler] 收盘前分析异常:', e);
    }
  }, { timezone: 'Asia/Shanghai' });

  // ============ ③ 凌晨清理旧资讯 ============
  cron.schedule('0 2 * * *', () => {
    try {
      q.fundNews.cleanup(db, 30);
      console.log('[Scheduler] 🧹 资讯清理完成（保留 30 天）');
    } catch (e) {
      console.error('[Scheduler] 资讯清理失败:', e.message);
    }
  });

  console.log('[Scheduler] 定时任务已注册: 行情@整点+5分 | 收盘前分析@14:30 CST | 资讯清理@2:00');
}

module.exports = { startScheduler };
