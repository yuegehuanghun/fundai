/**
 * PnL — 三层盈亏计算引擎（纯前端，零 Token 消耗）
 *
 * 数据来源：
 *   - Positions:  { code, shares, costPrice, totalInvested }
 *   - AICalcLog:  每日 22:00 净值快照 { date, code, nav, navDate, shares, dailyPnL, dailyPct }
 *   - MarketCache: 实时行情缓存，nav = 昨日/最新单位净值（dwjz）
 *
 * 三层：
 *   1. 单基总浮动盈亏（长期持仓总盈亏）
 *   2. 单基单日盈亏（今日 vs 昨日 22:00 净值）
 *   3. 全局汇总盈亏
 *
 * 全程判分母，杜绝 NaN / Infinity；异常只降级不抛出。
 */

/** 参考日期 = 最近一个交易日（北京，<= 今日）；周末/节假日回退到上一交易日，与归档口径一致 */
function _pnlToday() {
  let t = Date.now() + 8 * 3600 * 1000;
  if (typeof isTradingDate === 'function') {
    for (let i = 0; i < 15; i++) {
      const ds = new Date(t).toISOString().slice(0, 10);
      if (isTradingDate(ds)) return ds;
      t -= 24 * 3600 * 1000;
    }
  }
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 安全数字：非有限值一律回退为 0 */
function _num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 计算单只基金盈亏
 * @param {Object} args
 *   position   持仓 { shares, costPrice, totalInvested }（可空）
 *   todayEntry 今日净值快照（可空）
 *   prevEntry  昨日净值快照（可空）
 *   marketNav  行情缓存中的最新净值（兜底）
 * @returns {Object} 盈亏结果（含各类兜底标记，绝无 NaN）
 */
function computeFundPnL({ position, todayEntry, prevEntry, marketNav }) {
  const shares = _num(position && position.shares);
  // 累计买入总成本：优先 totalInvested，缺失回退 shares×costPrice
  let totalCost = _num(position && position.totalInvested);
  if (totalCost <= 0) {
    totalCost = shares * _num(position && position.costPrice);
  }
  const hasPosition = shares > 0 && totalCost > 0;

  // 最新净值：今日快照 > 昨日快照 > 行情缓存
  const todayNav = _num(todayEntry && todayEntry.nav);
  const prevNav = _num(prevEntry && prevEntry.nav);
  const latestNav = todayNav > 0 ? todayNav
    : (prevNav > 0 ? prevNav : _num(marketNav));
  const navPending = !(todayNav > 0);           // 今日未落库 → 待 22:00 更新

  const result = {
    latestNav,
    navPending,
    hasPosition,
    shares,
    totalCost,
    // Tier1 总浮动
    marketValue: 0,
    totalPnL: 0,
    totalPnLPct: 0,
    // Tier2 单日
    hasDaily: false,
    dailyPnL: 0,
    dailyPct: 0,
    prevNav,
    prevMarketValue: 0,
  };

  // Tier1：总浮动盈亏（需有持仓成本 + 有效净值）
  if (hasPosition && latestNav > 0) {
    result.marketValue = latestNav * shares;
    result.totalPnL = result.marketValue - totalCost;
    result.totalPnLPct = totalCost > 0 ? (result.totalPnL / totalCost) * 100 : 0;
  }

  // Tier2：单日盈亏（需今日 + 昨日两个快照）
  if (todayNav > 0 && prevNav > 0) {
    result.hasDaily = true;
    const diff = todayNav - prevNav;
    result.dailyPnL = hasPosition ? diff * shares : 0;
    result.dailyPct = prevNav > 0 ? (diff / prevNav) * 100 : 0;
    result.prevMarketValue = hasPosition ? prevNav * shares : 0;
  }

  return result;
}

/**
 * 计算全仓汇总盈亏
 * @param {Array} fundPnLs computeFundPnL 结果数组（仅统计有持仓的）
 */
function computePortfolioPnL(fundPnLs) {
  let marketValue = 0;   // Σ 持仓市值
  let totalCostSum = 0;  // Σ 累计成本（用于总收益率）
  let totalPnL = 0;      // Σ 总浮动盈亏
  let dailyPnL = 0;      // Σ 单日盈亏
  let prevValueSum = 0;  // Σ 昨日市值（用于全仓单日涨跌幅）
  let hasAnyPosition = false;
  let hasAnyDaily = false;

  for (const p of fundPnLs) {
    if (!p || !p.hasPosition) continue;
    hasAnyPosition = true;
    marketValue += p.marketValue;
    totalCostSum += p.totalCost;
    totalPnL += p.totalPnL;
    if (p.hasDaily) {
      hasAnyDaily = true;
      dailyPnL += p.dailyPnL;
      prevValueSum += p.prevMarketValue;
    }
  }

  return {
    hasAnyPosition,
    hasAnyDaily,
    marketValue,
    totalPnL,
    totalPnLPct: totalCostSum > 0 ? (totalPnL / totalCostSum) * 100 : 0,
    dailyPnL,
    dailyPct: prevValueSum > 0 ? (dailyPnL / prevValueSum) * 100 : 0,
  };
}

/**
 * 一次性构建全部盈亏上下文，供 UI 单次读取。
 * @returns {Promise<{ map: Map<string,Object>, portfolio: Object }>}
 */
async function buildPnLContext() {
  const empty = {
    map: new Map(),
    portfolio: { hasAnyPosition: false, hasAnyDaily: false, marketValue: 0, totalPnL: 0, totalPnLPct: 0, dailyPnL: 0, dailyPct: 0 },
  };

  try {
    const [watchlist, positions, calcLog, marketList] = await Promise.all([
      Watchlist.getAll().catch(() => []),
      Positions.getAll().catch(() => []),
      AICalcLog.getAll().catch(() => []),
      MarketCache.getAll().catch(() => []),
    ]);

    const today = _pnlToday();
    const posMap = new Map(positions.map(p => [p.code, p]));
    const marketMap = new Map(marketList.map(m => [m.code, m]));

    // 按基金分组净值快照，取今日 + 最近一条昨日
    const byCode = new Map();
    for (const e of calcLog) {
      if (!byCode.has(e.code)) byCode.set(e.code, []);
      byCode.get(e.code).push(e);
    }

    const map = new Map();
    const fundPnLs = [];

    for (const fund of watchlist) {
      const snaps = (byCode.get(fund.code) || [])
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const todayEntry = snaps.find(s => s.date === today) || null;
      // 昨日快照 = 除今日外最近的一条
      const prevEntry = snaps.find(s => s.date !== today) || null;

      const pnl = computeFundPnL({
        position: posMap.get(fund.code) || null,
        todayEntry,
        prevEntry,
        marketNav: (marketMap.get(fund.code) || {}).nav,
      });
      map.set(fund.code, pnl);
      fundPnLs.push(pnl);
    }

    return { map, portfolio: computePortfolioPnL(fundPnLs) };
  } catch (err) {
    console.warn('[PnL] 盈亏上下文构建失败，返回空态:', err && err.message);
    return empty;
  }
}
