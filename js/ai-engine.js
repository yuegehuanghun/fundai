/**
 * AI 评分引擎 — 四维加权评分 + 三态概率映射
 *
 * 四个维度:
 *   1. 指数估值 (30%) — PE/PB 分位越低分越高 → 倾向加仓
 *   2. 持仓盈亏 (25%) — 亏损越大分越高 → 倾向加仓
 *   3. 短期行情 (25%) — 连续下跌分越高 → 倾向加仓
 *   4. 基金消息 (20%) — 利好分越高 → 倾向加仓
 *
 * 总分映射为三个操作概率: buyPct + holdPct + sellPct = 100%
 */

const AIEngine = {
  WEIGHTS: {
    valuation: 0.30,    // 指数估值
    profitLoss: 0.25,   // 持仓盈亏
    trend: 0.25,        // 短期行情
    news: 0.20,         // 基金消息
  },
};

// ==================== 维度 1: 指数估值评分 ====================

/**
 * PE/PB 分位越低 → 越低估 → 分数越高 → 倾向加仓
 * @param {number} percentile - 0-100, PE/PB 历史分位
 * @returns {number} 0-100 评分
 */
function scoreValuation(percentile) {
  if (percentile == null || isNaN(percentile)) return 50; // 无数据默认中性

  // 分段线性映射
  if (percentile <= 10) return mapRange(percentile, 0, 10, 100, 88);    // 极度低估 → 88-100
  if (percentile <= 25) return mapRange(percentile, 10, 25, 88, 72);    // 低估 → 72-88
  if (percentile <= 40) return mapRange(percentile, 25, 40, 72, 56);    // 偏低估 → 56-72
  if (percentile <= 60) return mapRange(percentile, 40, 60, 56, 44);    // 适中 → 44-56
  if (percentile <= 75) return mapRange(percentile, 60, 75, 44, 28);    // 偏高估 → 28-44
  if (percentile <= 90) return mapRange(percentile, 75, 90, 28, 12);    // 高估 → 12-28
  return mapRange(Math.min(percentile, 100), 90, 100, 12, 0);           // 极度高估 → 0-12
}

// ==================== 维度 2: 持仓盈亏评分 ====================

/**
 * 持仓亏损越大 → 分数越高 → 倾向加仓摊低成本
 * 持仓盈利越大 → 分数越低 → 倾向减仓锁定收益
 * @param {number} profitPct - 持仓盈亏百分比 (-20 = 亏20%, +30 = 盈利30%)
 * @returns {number} 0-100 评分
 */
function scoreProfitLoss(profitPct) {
  if (profitPct == null || isNaN(profitPct)) return 50;

  if (profitPct <= -20) return mapRange(Math.max(profitPct, -50), -50, -20, 100, 88);  // 巨亏 >20%
  if (profitPct <= -10) return mapRange(profitPct, -20, -10, 88, 74);                   // 大亏 10-20%
  if (profitPct <= -5)  return mapRange(profitPct, -10, -5, 74, 62);                    // 亏损 5-10%
  if (profitPct <= 0)   return mapRange(profitPct, -5, 0, 62, 50);                      // 小亏 0-5%
  if (profitPct <= 10)  return mapRange(profitPct, 0, 10, 50, 35);                      // 小赚 0-10%
  if (profitPct <= 20)  return mapRange(profitPct, 10, 20, 35, 20);                     // 盈利 10-20%
  if (profitPct <= 35)  return mapRange(profitPct, 20, 35, 20, 8);                      // 大赚 20-35%
  return mapRange(Math.min(profitPct, 80), 35, 80, 8, 0);                               // 巨赚 >35%
}

// ==================== 维度 3: 短期行情评分 ====================

/**
 * 连续下跌 → 分数高 → 倾向逢低加仓
 * 连续上涨 → 分数低 → 倾向逢高减仓
 *
 * @param {Array} recentNAVs - 最近 N 个交易日的净值数据 [{nav, date, growthPct}]
 * @param {number} changePct - 当日涨跌幅
 * @returns {number} 0-100 评分
 */
function scoreTrend(recentNAVs, changePct) {
  if (!recentNAVs || recentNAVs.length < 3) {
    // 数据不足，仅用当日涨跌估算
    if (changePct == null) return 50;
    if (changePct <= -3) return 90;
    if (changePct <= -2) return 80;
    if (changePct <= -1) return 68;
    if (changePct <= 0) return 56;
    if (changePct <= 1) return 44;
    if (changePct <= 2) return 32;
    if (changePct <= 3) return 20;
    return 10;
  }

  // 分析最近 5-20 个交易日
  const lookback = Math.min(recentNAVs.length, 20);
  const recent = recentNAVs.slice(-lookback);

  // 计算累计涨跌幅
  const firstNAV = recent[0].nav;
  const lastNAV = recent[recent.length - 1].nav;
  const totalChange = firstNAV > 0 ? ((lastNAV - firstNAV) / firstNAV) * 100 : 0;

  // 计算连续涨/跌天数
  let consecutiveUp = 0;
  let consecutiveDown = 0;
  for (let i = recent.length - 1; i >= 1; i--) {
    const change = recent[i].nav - recent[i - 1].nav;
    if (change > 0) {
      if (consecutiveDown === 0) consecutiveUp++;
      else break;
    } else if (change < 0) {
      if (consecutiveUp === 0) consecutiveDown++;
      else break;
    } else {
      break;
    }
  }

  // 累计跌幅大 + 连续下跌 → 高分（加仓信号）
  let score = 50;

  // 累计涨跌因子 (-25 ~ +25)
  const trendFactor = -totalChange * 1.5; // 跌得越多加分越多
  score += Math.max(-25, Math.min(25, trendFactor));

  // 连续涨跌因子 (-20 ~ +20)
  if (consecutiveDown >= 5) score += 20;
  else if (consecutiveDown >= 3) score += 14;
  else if (consecutiveDown >= 2) score += 7;
  else if (consecutiveDown === 1) score += 3;

  if (consecutiveUp >= 5) score -= 20;
  else if (consecutiveUp >= 3) score -= 14;
  else if (consecutiveUp >= 2) score -= 7;
  else if (consecutiveUp === 1) score -= 3;

  // 当日涨跌微调 (-10 ~ +10)
  if (changePct != null) {
    score -= changePct * 2;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ==================== 维度 4: 基金消息评分 ====================

/**
 * 基于新闻情感分析评分
 * @param {Array} news - 新闻列表 [{title, sentiment: 0-100}]
 * @returns {{ score: number, summary: string }}
 */
function scoreNews(news) {
  if (!news || news.length === 0) return { score: 50, summary: '暂无相关资讯' };

  // 加权平均，越新的新闻权重越高
  let totalWeight = 0;
  let weightedScore = 0;

  news.forEach((item, i) => {
    const weight = 1 + (news.length - i) * 0.2; // 越新权重越高
    weightedScore += (item.sentiment || 50) * weight;
    totalWeight += weight;
  });

  const score = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 50;

  const positiveCount = news.filter(n => n.sentiment > 65).length;
  const negativeCount = news.filter(n => n.sentiment < 35).length;

  let summary = '';
  if (positiveCount > negativeCount) summary = `近期偏利好（${positiveCount}条正面消息）`;
  else if (negativeCount > positiveCount) summary = `近期偏利空（${negativeCount}条负面消息）`;
  else summary = '消息面中性';

  return { score, summary };
}

// ==================== 综合运算 ====================

/**
 * 对单只基金运行 AI 评分
 *
 * @param {Object} fund - 基金信息 { code, name }
 * @param {Object} marketData - 行情数据 { changePct, recentNAVs, news, valuationPercentile }
 * @param {Object} position - 持仓数据 { shares, costPrice }（可选）
 * @returns {Object} AI 决策结果
 */
function analyzeFund(fund, marketData, position, pnl) {
  const changePct = marketData.changePct ?? 0;
  const recentNAVs = marketData.recentNAVs || [];
  const news = marketData.news || [];

  // ---- PO-3：收益率仅取 ai_calc_log 归档收盘净值（经 pnl 上下文），彻底隔离盘中估值 ----
  const hasPnL = !!(pnl && pnl.hasPosition);
  const profitPct = hasPnL ? pnl.totalPnLPct : 0;          // 与页面底部总浮动收益率完全同源
  const nav = pnl ? pnl.latestNav : (marketData.nav || 0);  // 展示用，取归档收盘净值

  // ---- PO-2：维度可用性检测（缺失即降级，不再硬塞 50 兜底） ----
  const valuationPct = marketData.valuationPercentile;      // 可能为 null
  const valuationAvail = valuationPct != null;
  const trendAvail = recentNAVs.length > 0;
  const newsAvail = news.length > 0;

  // 各维度评分（缺失维度分数无意义，其权重会被归零）
  const vScore = scoreValuation(valuationAvail ? valuationPct : 50);
  const pScore = scoreProfitLoss(profitPct);
  const tScore = scoreTrend(recentNAVs, changePct);
  const nResult = scoreNews(news);
  const nScore = nResult.score;

  // ---- PO-2 + P1-3：动态权重重分配（缺失维度权重归零，剩余按比例重分并归一） ----
  const dims = {
    valuation:  { score: vScore, avail: valuationAvail, w: AIEngine.WEIGHTS.valuation },
    profitLoss: { score: pScore, avail: true,           w: AIEngine.WEIGHTS.profitLoss },
    trend:      { score: tScore, avail: trendAvail,     w: AIEngine.WEIGHTS.trend },
    news:       { score: nScore, avail: newsAvail,      w: AIEngine.WEIGHTS.news },
  };
  // P1-3：消息面缺失时，其 20% 权重优先并入趋势维度（趋势也缺失才走比例重分）
  if (!dims.news.avail) {
    if (dims.trend.avail) dims.trend.w += dims.news.w;
    dims.news.w = 0;
  }
  let sumW = 0;
  for (const k in dims) { if (!dims[k].avail) dims[k].w = 0; sumW += dims[k].w; }

  // 归一化加权总分（有效权重恒归一至 100%）
  let totalScore = 50;
  const effectiveWeights = {};
  if (sumW > 0) {
    let acc = 0;
    for (const k in dims) {
      const ew = dims[k].w / sumW;
      effectiveWeights[k] = Math.round(ew * 100);
      acc += dims[k].score * ew;
    }
    totalScore = Math.round(acc);
  }

  const missingDims = Object.keys(dims).filter(k => !dims[k].avail);
  const degraded = missingDims.length > 0;
  if (degraded) {
    console.log(`[AI] ${fund.code} 维度降级 — 缺失: ${missingDims.join('/')} · 生效权重:`, effectiveWeights);
  }

  // 总分 → 三态概率
  const probabilities = scoreToProbabilities(totalScore);

  // 生成建议文字
  const recommendation = getRecommendation(probabilities, totalScore);

  return {
    code: fund.code,
    name: fund.name || marketData.name || fund.code,
    timestamp: Date.now(),
    date: new Date().toISOString().slice(0, 10),

    // 评分明细
    scores: {
      valuation: vScore,
      profitLoss: pScore,
      trend: tScore,
      news: nScore,
      total: totalScore,
    },

    // 三态概率
    buyPct: probabilities.buy,
    holdPct: probabilities.hold,
    sellPct: probabilities.sell,

    // 建议
    recommendation,
    action: probabilities.action,

    // 元数据
    valuationPercentile: valuationAvail ? valuationPct : null,
    profitPct: Math.round(profitPct * 100) / 100,
    changePct,
    newsSummary: nResult.summary,
    nav,

    // PO-2：降级透明化
    missingDims,
    degraded,
    effectiveWeights,

    // 阈值标记
    highlight: Math.max(probabilities.buy, probabilities.hold, probabilities.sell) > 75,
    notify: Math.max(probabilities.buy, probabilities.hold, probabilities.sell) > 80,
  };
}

// ==================== 评分 → 概率映射 ====================

/**
 * 将总分映射为加仓/持有/减仓三态概率
 *
 * 规则:
 *   - 总分 ≥ 65: 偏加仓，加仓概率随分数升高而升高
 *   - 总分 ≤ 35: 偏减仓，减仓概率随分数降低而升高
 *   - 总分 45-55: 中间模糊区，判定为"保持不动"
 *   - 单一概率 > 75%: 标色加粗突出
 *   - 单一概率 > 80%: 弹出桌面提醒
 */
function scoreToProbabilities(totalScore) {
  let buy, hold, sell;

  if (totalScore >= 65) {
    // 偏加仓
    buy = Math.min(95, 50 + (totalScore - 50) * 1.8);
    buy = Math.round(buy);
    const remaining = 100 - buy;
    // 按总分高低分配 hold 和 sell
    const sellShare = Math.max(1, Math.round((65 - Math.min(totalScore, 85)) / 20 * remaining));
    sell = sellShare;
    hold = remaining - sell;
  } else if (totalScore <= 35) {
    // 偏减仓
    sell = Math.min(95, 50 + (50 - totalScore) * 1.8);
    sell = Math.round(sell);
    const remaining = 100 - sell;
    const buyShare = Math.max(1, Math.round((Math.max(totalScore, 15) - 35) / 20 * remaining));
    buy = buyShare;
    hold = remaining - buy;
  } else {
    // 中间区域 (36-64)
    // hold 主导，buy/sell 按偏离 50 的方向分配
    const deviation = totalScore - 50;  // -14 ~ +14
    hold = 50 + Math.abs(deviation) * 0.8;
    hold = Math.round(hold);
    const remaining = 100 - hold;

    if (deviation > 0) {
      buy = Math.round(remaining * 0.7);
      sell = remaining - buy;
    } else if (deviation < 0) {
      sell = Math.round(remaining * 0.7);
      buy = remaining - sell;
    } else {
      buy = Math.floor(remaining / 2);
      sell = remaining - buy;
    }
  }

  // 确保非负且三数之和 = 100
  buy = Math.max(0, buy);
  hold = Math.max(0, hold);
  sell = Math.max(0, sell);

  const sum = buy + hold + sell;
  if (sum !== 100) {
    hold += (100 - sum); // 微调 hold 吸收舍入误差
  }

  // 45%-55% 区间统一判定为"保持不动"
  let action;
  if (totalScore >= 45 && totalScore <= 55) {
    action = 'hold';
  } else if (buy > sell && buy > hold) {
    action = buy > 75 ? 'buy_strong' : 'buy';
  } else if (sell > buy && sell > hold) {
    action = sell > 75 ? 'sell_strong' : 'sell';
  } else {
    action = 'hold';
  }

  return { buy, hold, sell, action };
}

// ==================== 建议文字生成 ====================

function getRecommendation(probabilities, totalScore) {
  const { action, buy, hold, sell } = probabilities;

  switch (action) {
    case 'buy_strong':
      return `强烈建议加仓（概率 ${buy}%）`;
    case 'buy':
      return `适合加仓（概率 ${buy}%）`;
    case 'sell_strong':
      return `强烈建议减仓（概率 ${sell}%）`;
    case 'sell':
      return `适合减仓（概率 ${sell}%）`;
    default:
      if (hold >= 50) return `建议保持不动（概率 ${hold}%）`;
      return `暂时观望，保持不动`;
  }
}

function mapRange(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin;
  const clamped = Math.max(inMin, Math.min(inMax, value));
  const pct = (clamped - inMin) / (inMax - inMin);
  return Math.round((outMin + pct * (outMax - outMin)) * 100) / 100;
}

// ==================== 批量分析 ====================

/**
 * 对全部持仓运行 AI 分析
 * @returns {Promise<Array>} 所有基金的 AI 决策结果
 */
async function runFullAnalysis() {
  const [watchlist, positions, marketDataList] = await Promise.all([
    Watchlist.getAll(),
    Positions.getAll(),
    MarketCache.getAll(),
  ]);

  if (watchlist.length === 0) {
    return { decisions: [], summary: { total: 0, buyCount: 0, sellCount: 0, holdCount: 0 } };
  }

  const posMap = {};
  positions.forEach(p => { posMap[p.code] = p; });

  const marketMap = {};
  marketDataList.forEach(m => { marketMap[m.code] = m; });

  // PO-3：一次性构建盈亏上下文（只读 ai_calc_log 收盘净值），供收益率/概率同源计算
  let pnlCtx = { map: new Map() };
  if (typeof buildPnLContext === 'function') {
    pnlCtx = await buildPnLContext().catch(() => ({ map: new Map() }));
  }

  const decisions = [];
  let buyCount = 0, sellCount = 0, holdCount = 0;

  for (const fund of watchlist) {
    const marketData = marketMap[fund.code] || {};
    const position = posMap[fund.code] || null;

    // 估值分位：缺失时置 null（交由 analyzeFund 按维度缺失降级，不再硬塞 50）
    if (marketData.valuationPercentile == null) {
      try {
        const val = await getFundValuation(fund.code);
        marketData.valuationPercentile = val.percentile; // 可能为 null
      } catch {
        marketData.valuationPercentile = null;
      }
    }

    const pnl = pnlCtx.map.get(fund.code) || null;
    const decision = analyzeFund(fund, marketData, position, pnl);
    decisions.push(decision);

    if (decision.action.includes('buy')) buyCount++;
    else if (decision.action.includes('sell')) sellCount++;
    else holdCount++;
  }

  const summary = {
    total: decisions.length,
    buyCount,
    sellCount,
    holdCount,
    strongBuyCount: decisions.filter(d => d.action === 'buy_strong').length,
    strongSellCount: decisions.filter(d => d.action === 'sell_strong').length,
    timestamp: Date.now(),
    date: new Date().toISOString().slice(0, 10),
  };

  return { decisions, summary };
}

/**
 * 保存当次 AI 分析结论到归档
 */
async function archiveDecisions(decisions) {
  const saved = decisions.map(d => ({
    date: d.date,
    code: d.code,
    name: d.name,
    buyPct: d.buyPct,
    holdPct: d.holdPct,
    sellPct: d.sellPct,
    action: d.action,
    recommendation: d.recommendation,
    totalScore: d.scores.total,
    valuationPercentile: d.valuationPercentile,
    profitPct: d.profitPct,
    recommendAmount: d.recommendAmount || 0,
    timestamp: d.timestamp,
    archivedAt: Date.now(),
  }));

  await AIDecisions.saveAll(saved);
  return saved;
}
