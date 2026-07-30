/**
 * DeepSeek API 深度咨询模块
 *
 * 设计原则:
 *   - 完全独立于本地 AI 引擎，互不耦合
 *   - 仅手动点击触发，零自动调用
 *   - 单基金 10 分钟限流，防止浪费 token
 *   - API 故障不影响页面原有任何功能
 */

// ==================== 配置管理 (localStorage) ====================

const DS_CONFIG_KEY = 'fundai_deepseek_config';
const DS_DEFAULT_CONFIG = {
  apiKey: '',                       // DeepSeek API Key（base64 混淆存储）
  model: 'deepseek-chat',           // 模型
  maxTokens: 200,                   // 单次最大输出 token（只需一句话，极小值即可）
  temperature: 0.3,                 // 低温度 = 更确定性输出
  timeout: 15000,                   // 请求超时 ms
  enabled: false,                   // 是否已配置有效 key
};

const DeepSeekConfig = {
  get() {
    try {
      const raw = localStorage.getItem(DS_CONFIG_KEY);
      if (!raw) return { ...DS_DEFAULT_CONFIG };
      const cfg = JSON.parse(raw);

      // 解码 API key
      if (cfg.apiKey && cfg.apiKey.startsWith('ds_')) {
        try { cfg.apiKey = atob(cfg.apiKey.slice(3)); } catch { cfg.apiKey = ''; }
      }

      return { ...DS_DEFAULT_CONFIG, ...cfg };
    } catch {
      return { ...DS_DEFAULT_CONFIG };
    }
  },

  save(config) {
    const toSave = { ...DeepSeekConfig.get(), ...config };

    // 编码 API key（简单混淆，非安全加密，仅防止明文存储）
    if (toSave.apiKey && !toSave.apiKey.startsWith('ds_')) {
      toSave.apiKey = 'ds_' + btoa(toSave.apiKey);
    }

    toSave.enabled = !!(toSave.apiKey && toSave.apiKey.length > 10);

    // 存储时不保留原始 key 字段中的明文
    const stored = { ...toSave };
    localStorage.setItem(DS_CONFIG_KEY, JSON.stringify(stored));

    return toSave;
  },

  /** 检查是否已配置可用 */
  isReady() {
    const cfg = DeepSeekConfig.get();
    return cfg.enabled && cfg.apiKey && cfg.apiKey.length > 10;
  },

  reset() {
    localStorage.removeItem(DS_CONFIG_KEY);
  },
};

// ==================== Token 消耗台账 (localStorage) ====================

const DS_TOKEN_LOG_KEY = 'fundai_deepseek_token_log';

const TokenLog = {
  /** 获取全部日志 */
  getAll() {
    try {
      return JSON.parse(localStorage.getItem(DS_TOKEN_LOG_KEY) || '[]');
    } catch {
      return [];
    }
  },

  /** 添加一条记录 */
  add(entry) {
    const log = TokenLog.getAll();
    log.push({
      id: Date.now(),
      timestamp: Date.now(),
      date: new Date().toISOString(),
      code: entry.code || '',
      fundName: entry.fundName || '',
      model: entry.model || 'deepseek-chat',
      promptTokens: entry.promptTokens || 0,
      completionTokens: entry.completionTokens || 0,
      totalTokens: entry.totalTokens || 0,
      result: entry.result || '',
      success: !!entry.success,
      error: entry.error || '',
    });
    localStorage.setItem(DS_TOKEN_LOG_KEY, JSON.stringify(log));
    return log;
  },

  /** 累计统计 */
  getStats() {
    const log = TokenLog.getAll();
    const successful = log.filter(e => e.success);
    return {
      totalCalls: log.length,
      successCalls: successful.length,
      failCalls: log.length - successful.length,
      totalTokens: log.reduce((s, e) => s + (e.totalTokens || 0), 0),
      totalPromptTokens: log.reduce((s, e) => s + (e.promptTokens || 0), 0),
      totalCompletionTokens: log.reduce((s, e) => s + (e.completionTokens || 0), 0),
      estimatedCostUSD: log.reduce((s, e) => {
        // DeepSeek 定价约: input $0.14/1M tokens, output $0.28/1M tokens（chat 模型）
        // 极低成本，仅供粗略估算
        const inputCost = (e.promptTokens || 0) / 1_000_000 * 0.14;
        const outputCost = (e.completionTokens || 0) / 1_000_000 * 0.28;
        return s + inputCost + outputCost;
      }, 0),
    };
  },

  /** 清空日志 */
  clear() {
    localStorage.removeItem(DS_TOKEN_LOG_KEY);
  },

  /** 导出日志为 CSV */
  exportCSV() {
    const log = TokenLog.getAll();
    const header = '时间,基金代码,基金名称,Prompt Tokens,Completion Tokens,总Tokens,结果,成功';
    const rows = log.map(e =>
      `"${e.date}","${e.code}","${e.fundName}",${e.promptTokens},${e.completionTokens},${e.totalTokens},"${e.result}",${e.success}`
    );
    return [header, ...rows].join('\n');
  },
};

// ==================== 限流控制 ====================

/** 单基金 10 分钟限流 Map: code → lastCallTimestamp */
const _rateLimitMap = new Map();
const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 检查是否允许调用
 * @returns {{ allowed: boolean, remainingSeconds: number }}
 */
function checkRateLimit(code) {
  const lastCall = _rateLimitMap.get(code) || 0;
  const elapsed = Date.now() - lastCall;
  const remaining = RATE_LIMIT_MS - elapsed;

  if (remaining > 0) {
    return {
      allowed: false,
      remainingSeconds: Math.ceil(remaining / 1000),
      nextAvailable: new Date(Date.now() + remaining),
    };
  }

  return { allowed: true, remainingSeconds: 0 };
}

/** 记录调用时间 */
function markRateLimit(code) {
  _rateLimitMap.set(code, Date.now());
}

// ==================== Prompt 构建 ====================

/**
 * 构建发送给 DeepSeek 的严格约束 Prompt
 * 关键：强制只输出一句话结论，不输出任何分析过程
 */
function buildPrompt(fundData) {
  const {
    name, code,
    nav, changePct, valuationPercentile, valuationLabel,
    profitPct, buyPct, holdPct, sellPct, recommendation,
    remainingBudget, dailyLimit,
    newsSummary, recentTrend,
  } = fundData;

  // 构建近期行情简述
  let trendDesc = '无数据';
  if (recentTrend) {
    trendDesc = recentTrend;
  } else if (changePct != null) {
    trendDesc = `今日涨跌 ${changePct >= 0 ? '+' : ''}${changePct}%`;
  }

  const systemPrompt = `你是一个基金投资决策助手。你必须严格遵守以下规则：

1. 仅输出最终操作建议，格式为以下之一：
   - "大幅加仓"
   - "适度加仓"
   - "小幅加仓"
   - "持有不动"
   - "小幅减仓"
   - "适度减仓"
   - "大幅减仓"

2. 绝对禁止输出：
   - 任何原因、理由、分析
   - 任何数据、数字、百分比
   - 任何风险提示、免责声明
   - 任何额外文字
   - 任何 markdown 格式

3. 输出字数不得超过 6 个字。`;

  const userMessage = `基金: ${name} (${code})
当前净值: ${nav || '未知'}
当日涨跌: ${changePct != null ? (changePct >= 0 ? '+' : '') + changePct + '%' : '未知'}
指数估值分位: ${valuationPercentile != null ? valuationPercentile + '%' : '未知'}（${valuationLabel || '未知'}）
持仓盈亏: ${profitPct != null ? (profitPct >= 0 ? '+' : '') + profitPct.toFixed(2) + '%' : '未知'}
近期行情: ${trendDesc}
消息面: ${newsSummary || '暂无'}
本地AI计算: 加仓${buyPct}% / 持有${holdPct}% / 减仓${sellPct}%
本地建议: ${recommendation || '无'}
当月剩余可投: ${remainingBudget != null ? '¥' + remainingBudget.toFixed(0) : '未设置'}
今日加仓上限: ${dailyLimit != null ? '¥' + dailyLimit.toFixed(0) : '未设置'}

请给出你的唯一操作建议（不超过6个字）：`;

  return { systemPrompt, userMessage };
}

// ==================== API 调用 ====================

/**
 * 发起 DeepSeek API 请求
 *
 * @param {Object} fundData - 基金完整数据
 * @returns {Promise<{success: boolean, result: string, tokens: number, error: string}>}
 */
async function callDeepSeekAPI(fundData) {
  const config = DeepSeekConfig.get();

  if (!config.apiKey || config.apiKey.length < 10) {
    return { success: false, result: '', tokens: 0, error: 'API Key 未配置' };
  }

  const { systemPrompt, userMessage } = buildPrompt(fundData);

  const body = {
    model: config.model || 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: config.maxTokens || 200,
    temperature: config.temperature ?? 0.3,
    stream: false,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout || 15000);

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error?.message || `HTTP ${response.status}`;

      // 区分错误类型
      if (response.status === 401) {
        return { success: false, result: '', tokens: 0, error: 'API Key 无效或已过期，请检查设置' };
      }
      if (response.status === 402) {
        return { success: false, result: '', tokens: 0, error: '账户余额不足，请充值后重试' };
      }
      if (response.status === 429) {
        return { success: false, result: '', tokens: 0, error: '请求频率过高，请稍后重试' };
      }
      return { success: false, result: '', tokens: 0, error: `API 错误: ${errMsg}` };
    }

    const data = await response.json();

    const result = (data.choices?.[0]?.message?.content || '').trim();
    const usage = data.usage || {};

    // 记录 token 消耗
    TokenLog.add({
      code: fundData.code,
      fundName: fundData.name,
      model: config.model,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      result: result.slice(0, 50), // 只存前 50 字
      success: true,
    });

    return {
      success: true,
      result,
      tokens: usage.total_tokens || 0,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      error: '',
    };
  } catch (err) {
    clearTimeout(timeoutId);

    let errorMsg = '网络请求失败';
    if (err.name === 'AbortError') {
      errorMsg = `请求超时（${(config.timeout || 15000) / 1000}秒），请检查网络或增加超时时间`;
    } else if (err.message) {
      errorMsg = err.message;
    }

    // 记录失败
    TokenLog.add({
      code: fundData.code,
      fundName: fundData.name,
      model: config.model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      result: '',
      success: false,
      error: errorMsg,
    });

    return { success: false, result: '', tokens: 0, error: errorMsg };
  }
}

// ==================== 主入口：深度咨询 ====================

/**
 * 执行深度咨询流程
 * 由 UI 层按钮触发，不可被自动刷新调用
 *
 * @param {string} code - 基金代码
 * @returns {Promise<{success: boolean, result: string, error: string, tokens: number}>}
 */
async function startDeepConsultation(code) {
  // 1. 检查 API 配置
  if (!DeepSeekConfig.isReady()) {
    return {
      success: false,
      result: '',
      error: '请先在「设置 → DeepSeek API」中配置 API Key',
      code: 'no_config',
    };
  }

  // 2. 限流检查
  const rateCheck = checkRateLimit(code);
  if (!rateCheck.allowed) {
    const mins = Math.floor(rateCheck.remainingSeconds / 60);
    const secs = rateCheck.remainingSeconds % 60;
    const waitText = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
    return {
      success: false,
      result: '',
      error: `该基金 ${waitText} 后才能再次咨询（10分钟限流）`,
      code: 'rate_limited',
      remainingSeconds: rateCheck.remainingSeconds,
    };
  }

  // 立即标记限流，防止并发重复调用
  markRateLimit(code);

  // 3. 收集本地数据
  const [watchlistFund, position, marketData, budget] = await Promise.all([
    Watchlist.get(code),
    Positions.get(code),
    MarketCache.get(code),
    MonthlyBudget.getCurrent(),
  ]);

  if (!watchlistFund && !marketData) {
    return {
      success: false,
      result: '',
      error: '未找到该基金的数据，请先添加自选基金并刷新行情',
      code: 'no_data',
    };
  }

  // 获取指数估值
  let valuationLabel = '未知';
  let valuationPercentile = null;
  if (marketData && marketData.valuationPercentile != null) {
    valuationPercentile = marketData.valuationPercentile;
    valuationLabel = getValuationLabel(valuationPercentile);
  }

  // 计算持仓盈亏
  const nav = marketData?.nav || marketData?.estimateNav || 0;
  let profitPct = 0;
  if (position && position.shares > 0 && position.costPrice > 0 && nav > 0) {
    profitPct = ((nav - position.costPrice) / position.costPrice) * 100;
  }

  // 获取最近的 AI 本地结论
  let aiDecision = null;
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayDecisions = await AIDecisions.getByDate(todayStr);
  aiDecision = todayDecisions.find(d => d.code === code) || null;

  // 如果没有今天的结论，运行一次本地分析
  if (!aiDecision) {
    const fund = { code, name: watchlistFund?.name || marketData?.name || code };
    aiDecision = analyzeFund(fund, marketData || {}, position || null);
  }

  // 计算预算信息
  const remainingBudget = budget.totalBudget - (budget.usedAmount || 0);
  const dailyLimit = budget.totalBudget > 0
    ? budget.totalBudget * ((budget.maxDailyPct || 30) / 100)
    : 0;

  // 构建近期行情简述
  let recentTrend = '';
  if (marketData?.recentNAVs && marketData.recentNAVs.length >= 5) {
    const recent = marketData.recentNAVs.slice(-5);
    const changes = [];
    for (let i = 1; i < recent.length; i++) {
      const chg = recent[i].nav - recent[i-1].nav;
      changes.push(chg >= 0 ? '涨' : '跌');
    }
    recentTrend = `最近5日: ${changes.join('→')}`;
  }

  // 4. 组装数据发送
  const fundData = {
    name: watchlistFund?.name || marketData?.name || code,
    code,
    nav,
    changePct: marketData?.changePct ?? null,
    valuationPercentile,
    valuationLabel,
    profitPct,
    buyPct: aiDecision?.buyPct ?? 33,
    holdPct: aiDecision?.holdPct ?? 34,
    sellPct: aiDecision?.sellPct ?? 33,
    recommendation: aiDecision?.recommendation || '无',
    remainingBudget: remainingBudget > 0 ? remainingBudget : null,
    dailyLimit: dailyLimit > 0 ? dailyLimit : null,
    newsSummary: marketData?.newsSentiment ? (marketData.newsSentiment > 60 ? '偏利好' : marketData.newsSentiment < 40 ? '偏利空' : '中性') : '暂无',
    recentTrend,
  };

  // 5. 调用 API
  const apiResult = await callDeepSeekAPI(fundData);

  return {
    ...apiResult,
    fundName: fundData.name,
    code,
    timestamp: Date.now(),
  };
}

/**
 * 清除某只基金的限流（调试用）
 */
function clearRateLimit(code) {
  _rateLimitMap.delete(code);
}

// ==================== 收盘前批量分析 ====================

/**
 * 交易日 14:30 自动触发：收集 6 只基金数据，批量发送 DeepSeek 获取操作建议。
 * 单次 API 调用处理全部基金，节省 token。
 * @returns {Promise<{success, funds, summary, hasActionableAdvice, tokens}|null>}
 */
async function startPreCloseAnalysis() {
  if (!DeepSeekConfig.isReady()) {
    console.log('[PreClose] DeepSeek 未配置，跳过收盘前分析');
    return null;
  }

  try {
    // 1. 并行获取所有数据
    const [watchlist, positions, marketList, budget] = await Promise.all([
      Watchlist.getAll(),
      Positions.getAll(),
      MarketCache.getAll(),
      MonthlyBudget.getCurrent()
    ]);

    if (!watchlist.length) return null;

    // 2. 构建盈亏上下文
    let pnlCtx = null;
    if (typeof buildPnLContext === 'function') {
      try { pnlCtx = await buildPnLContext(); } catch { /* 降级 */ }
    }

    // 3. 获取指数估值
    let indexPE = null;
    if (typeof fetchIndexValuation === 'function') {
      try { indexPE = await fetchIndexValuation('1.000300'); } catch { /* 降级 */ }
    }

    const posMap = new Map(positions.map(p => [p.code, p]));
    const marketMap = new Map(marketList.map(m => [m.code, m]));
    const pnlMap = pnlCtx ? pnlCtx.map : new Map();

    // 4. 读取目标配置
    let targetMap = new Map();
    try {
      const allocs = AppSettings.get().fundAllocations || [];
      allocs.forEach(a => { if (a.code) targetMap.set(a.code, a.targetPct || 0); });
    } catch { /* 忽略 */ }

    // 5. 为每只基金生成摘要行
    const fundLines = [];
    const fundMeta = [];

    for (const fund of watchlist) {
      const market = marketMap.get(fund.code) || {};
      const pos = posMap.get(fund.code);
      const pnl = pnlMap.get(fund.code) || {};
      const targetPct = targetMap.get(fund.code) || 0;

      const name = market.name || fund.name || fund.code;
      const nav = market.nav || 0;
      const changePct = market.changePct || 0;
      const navDate = market.navDate || '';
      const valuationPct = market.valuationPercentile;
      const profitPct = pnl.totalPnLPct != null ? pnl.totalPnLPct : 0;
      const actualPct = (pnlCtx && pnlCtx.portfolio && pnlCtx.portfolio.marketValue > 0)
        ? ((pnl.marketValue || 0) / pnlCtx.portfolio.marketValue * 100) : 0;

      const changeSign = changePct >= 0 ? '+' : '';
      const profitSign = profitPct >= 0 ? '+' : '';
      const valuationStr = valuationPct != null ? `${valuationPct}%` : '无数据';

      fundLines.push(
        `${name}(${fund.code}) | 净值${nav.toFixed(4)} | 今日${changeSign}${changePct.toFixed(2)}% | 估值分位${valuationStr} | 持仓盈亏${profitSign}${profitPct.toFixed(1)}%` +
        (targetPct > 0 ? ` | 目标${targetPct}% 实际${actualPct.toFixed(1)}%` : '')
      );

      fundMeta.push({
        code: fund.code, name, changePct, profitPct,
        valuationPct, targetPct, actualPct
      });
    }

    // 6. 市场宏观数据（新增：市场全景）
    let marketCtx = null;
    if (typeof FundAPI !== 'undefined' && FundAPI.fetchMarketContext) {
      try { marketCtx = await FundAPI.fetchMarketContext(); } catch { /* 降级 */ }
    }

    // 7. 预算信息
    const remainingBudget = budget.totalBudget - (budget.usedAmount || 0);
    const dailyLimit = budget.totalBudget * ((budget.maxDailyPct || 30) / 100);

    // 8. 构建市场全景文本
    let marketBlock = '';
    if (marketCtx) {
      const bm = marketCtx.benchmark;
      const br = marketCtx.breadth;
      const nb = marketCtx.northBound;
      const st = marketCtx.sector;

      marketBlock = '\n📊 今日市场全景：\n';
      if (bm) {
        const bmSign = bm.changePct >= 0 ? '+' : '';
        marketBlock += `  沪深300    ${bm.price}  ${bmSign}${bm.changePct}%  量比${bm.volumeRatio}  成交${bm.amount}亿\n`;
      }
      if (br) {
        const brSign = br.changePct >= 0 ? '+' : '';
        const moodMap = { greedy: '偏贪婪(追涨)', fearful: '偏恐慌(抛售)', neutral: '中性' };
        marketBlock += `  上证指数    ${br.price}  ${brSign}${br.changePct}%  量比${br.volumeRatio}  情绪${moodMap[br.sentiment] || '中性'}\n`;
      }
      if (nb) {
        const nbSign = nb.todayNet >= 0 ? '净流入' : '净流出';
        const nbTrend = { inflow: '外资持续流入', outflow: '外资持续流出', flat: '外资观望' };
        marketBlock += `  北向资金    ${nbSign} ${Math.abs(nb.todayNet)}亿  (近5日${nbTrend[nb.trend] || ''})\n`;
      }
      if (st) {
        const styleMap = { growth: '成长占优(科技强)', value: '价值占优(红利强)', mixed: '风格均衡' };
        marketBlock += `  风格偏向    ${styleMap[st.style] || '风格均衡'}  创业板${st.growth.changePct >= 0 ? '+' : ''}${st.growth.changePct}% vs 上证50${st.value.changePct >= 0 ? '+' : ''}${st.value.changePct}%\n`;
      }
    }

    // 9. 构建 prompt
    const peInfo = indexPE && indexPE.pePercentile != null
      ? `沪深300 PE 分位 ${indexPE.pePercentile}%（当前 PE ${indexPE.currentPE?.toFixed(2) || '—'}）`
      : '大盘估值数据暂缺';

    const systemPrompt = `你是基金投资助手。每天 A 股收盘前 30 分钟，根据用户持仓基金的实时数据和今日市场全景给出操作建议。
参考市场全景判断整体环境：北向大幅流出时更谨慎，成长占优时可更积极对待科技类基金，放量下跌时优先防守。
对每只基金，只输出以下 7 种建议之一：大幅加仓/适度加仓/小幅加仓/持有不动/小幅减仓/适度减仓/大幅减仓。
使用格式"基金名：建议"。最后如有需要特别说明的基金（不超过 3 只），简要说明原因（一句话）。
不要输出任何其他内容。`;

    const userPrompt = `当前时间: 14:30，距收盘 30 分钟。${peInfo}。${marketBlock}
📈 持仓基金实时数据：
${fundLines.join('\n')}

本月剩余可投: ¥${remainingBudget.toFixed(0)} | 今日加仓上限: ¥${dailyLimit.toFixed(0)}
用户定投规则: 每月固定日按比例投入，非定投日不做大额操作。QDII 基金每日限购 100 元。`;

    // 10. 调用 API
    const apiKey = DeepSeekConfig.get().apiKey;
    const cfg = DeepSeekConfig.get();

    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 300,
        temperature: 0.3,
        stream: false
      }),
      signal: AbortSignal.timeout(cfg.timeout || 20000)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`DeepSeek API ${resp.status}: ${errText.slice(0, 100)}`);
    }

    const json = await resp.json();
    const content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    const tokens = {
      total: json.usage?.total_tokens || 0,
      prompt: json.usage?.prompt_tokens || 0,
      completion: json.usage?.completion_tokens || 0
    };

    // 11. Token 日志
    try {
      TokenLog.add({
        date: new Date().toISOString().slice(0, 10),
        code: 'BATCH',
        fundName: '收盘前批量分析',
        model: cfg.model || 'deepseek-chat',
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
        totalTokens: tokens.total,
        result: content.slice(0, 50),
        success: true
      });
    } catch { /* 忽略 */ }

    // 12. 解析响应 → 每只基金的建议
    const funds = fundMeta.map(meta => {
      const lineMatch = content.split('\n').find(line =>
        line.includes(meta.name) || line.includes(meta.code)
      );
      const adviceMatch = lineMatch ? lineMatch.match(/(大幅加仓|适度加仓|小幅加仓|持有不动|小幅减仓|适度减仓|大幅减仓)/) : null;
      return {
        code: meta.code,
        name: meta.name,
        changePct: meta.changePct,
        advice: adviceMatch ? adviceMatch[1] : '持有不动',
        explicit: !!adviceMatch
      };
    });

    // 13. 提取特殊说明
    const adviceLine = content.split('\n').find(l => l.includes('说明') || l.includes('原因') || l.includes('注意'));
    const summary = adviceLine ? adviceLine.replace(/^[^：:]*[：:]\s*/, '') : '';

    // 14. 判断是否有需要操作的建议
    const hasActionableAdvice = funds.some(f =>
      f.advice.includes('加仓') || f.advice.includes('减仓')
    ) && !funds.every(f => f.advice === '持有不动');

    const result = {
      success: true,
      funds,
      summary,
      hasActionableAdvice,
      tokens: tokens.total,
      timestamp: Date.now(),
      date: new Date().toISOString().slice(0, 10)
    };

    // 15. 持久化
    try {
      localStorage.setItem('fundai_preclose_advice', JSON.stringify(result));
    } catch { /* 忽略 */ }

    console.log(`[PreClose] ✅ 收盘前分析完成 · ${tokens.total} tokens · ${funds.map(f => f.name + ':' + f.advice).join(', ')}`);
    return result;

  } catch (err) {
    console.error('[PreClose] 分析失败:', err && err.message);
    try {
      TokenLog.add({
        date: new Date().toISOString().slice(0, 10),
        code: 'BATCH',
        fundName: '收盘前批量分析',
        model: DeepSeekConfig.get().model || 'deepseek-chat',
        promptTokens: 0, completionTokens: 0, totalTokens: 0,
        result: (err && err.message || '').slice(0, 50),
        success: false, error: err && err.message
      });
    } catch { /* 忽略 */ }
    return { success: false, error: err && err.message, funds: [], summary: '', hasActionableAdvice: false, tokens: 0 };
  }
}
