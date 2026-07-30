/**
 * DeepSeek API 代理 — API Key 存服务端，前端不可见
 * 使用 Node.js 18+ 内置 fetch
 */

const API_URL = 'https://api.deepseek.com/v1/chat/completions';

function getConfig() {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    timeout: parseInt(process.env.DEEPSEEK_TIMEOUT) || 20000
  };
}

function isReady() {
  const cfg = getConfig();
  return !!(cfg.apiKey && cfg.apiKey.length > 10);
}

/** 调用 DeepSeek API，返回 { success, content, tokens } */
async function callDeepSeek(messages, maxTokens = 300) {
  const cfg = getConfig();
  if (!cfg.apiKey) return { success: false, error: 'DeepSeek API Key 未配置' };

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: false
      }),
      signal: AbortSignal.timeout(cfg.timeout)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { success: false, error: `DeepSeek ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const json = await resp.json();
    const content = json.choices?.[0]?.message?.content || '';
    return {
      success: true,
      content,
      tokens: {
        total: json.usage?.total_tokens || 0,
        prompt: json.usage?.prompt_tokens || 0,
        completion: json.usage?.completion_tokens || 0
      }
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 收盘前批量分析 — 构建 prompt 并调用 DeepSeek
 * @param {Object} ctx — 数据上下文
 * @param {Array} ctx.funds — [{code, name, nav, changePct, valuationPct, profitPct, targetPct, actualPct}]
 * @param {Object} ctx.market — 市场全景 {northBound, benchmark, sector, breadth}
 * @param {Object} ctx.budget — {remainingBudget, dailyLimit}
 * @param {Object} ctx.indexPE — 指数 PE {pePercentile, currentPE}
 */
async function runPreCloseAnalysis(ctx) {
  if (!isReady()) return { success: false, error: 'DeepSeek 未配置' };

  const { funds, market, budget, indexPE } = ctx;

  // 构建市场全景文本
  let marketBlock = '';
  if (market) {
    marketBlock = '\n📊 今日市场全景：\n';
    const bm = market.benchmark;
    if (bm) {
      marketBlock += `  沪深300    ${bm.price}  ${bm.changePct >= 0 ? '+' : ''}${bm.changePct}%  量比${bm.volumeRatio}  成交${bm.amount}亿\n`;
    }
    const br = market.breadth;
    if (br) {
      const moodMap = { greedy: '偏贪婪(追涨)', fearful: '偏恐慌(抛售)', neutral: '中性' };
      marketBlock += `  上证指数    ${br.price}  ${br.changePct >= 0 ? '+' : ''}${br.changePct}%  量比${br.volumeRatio}  情绪${moodMap[br.sentiment] || '中性'}\n`;
    }
    const nb = market.northBound;
    if (nb) {
      const trendMap = { inflow: '外资持续流入', outflow: '外资持续流出', flat: '外资观望' };
      marketBlock += `  北向资金    ${nb.todayNet >= 0 ? '净流入' : '净流出'} ${Math.abs(nb.todayNet)}亿  (近5日${trendMap[nb.trend] || ''})\n`;
    }
    const st = market.sector;
    if (st) {
      const styleMap = { growth: '成长占优(科技强)', value: '价值占优(红利强)', mixed: '风格均衡' };
      const gs = st.growth.changePct >= 0 ? '+' : '';
      const vs = st.value.changePct >= 0 ? '+' : '';
      marketBlock += `  风格偏向    ${styleMap[st.style]}  创业板${gs}${st.growth.changePct}% vs 上证50${vs}${st.value.changePct}%\n`;
    }
  }

  const peInfo = indexPE && indexPE.pePercentile != null
    ? `沪深300 PE 分位 ${indexPE.pePercentile}%（当前 PE ${indexPE.currentPE?.toFixed(2) || '—'}）`
    : '大盘估值数据暂缺';

  const fundLines = funds.map(f => {
    const cs = f.changePct >= 0 ? '+' : '';
    const ps = f.profitPct >= 0 ? '+' : '';
    const vs = f.valuationPct != null ? `${f.valuationPct}%` : '无数据';
    return `${f.name}(${f.code}) | 净值${f.nav.toFixed(4)} | 今日${cs}${f.changePct.toFixed(2)}% | 估值分位${vs} | 持仓盈亏${ps}${f.profitPct.toFixed(1)}%` +
      (f.targetPct > 0 ? ` | 目标${f.targetPct}% 实际${f.actualPct.toFixed(1)}%` : '');
  }).join('\n');

  const systemPrompt = `你是基金投资助手。每天 A 股收盘前 30 分钟，根据用户持仓基金的实时数据和今日市场全景给出操作建议。
参考市场全景判断整体环境：北向大幅流出时更谨慎，成长占优时可更积极对待科技类基金，放量下跌时优先防守。
对每只基金，只输出以下 7 种建议之一：大幅加仓/适度加仓/小幅加仓/持有不动/小幅减仓/适度减仓/大幅减仓。
使用格式"基金名：建议"。最后如有需要特别说明的基金（不超过 3 只），简要说明原因（一句话）。
不要输出任何其他内容。`;

  const userPrompt = `当前时间: 14:30，距收盘 30 分钟。${peInfo}。${marketBlock}
📈 持仓基金实时数据：
${fundLines}

本月剩余可投: ¥${budget.remainingBudget.toFixed(0)} | 今日加仓上限: ¥${budget.dailyLimit.toFixed(0)}
用户定投规则: 每月固定日按比例投入，非定投日不做大额操作。QDII 基金每日限购 100 元。`;

  const result = await callDeepSeek([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], 300);

  if (!result.success) return result;

  // 解析响应 → 每只基金的建议
  const adviceList = funds.map(f => {
    const lines = result.content.split('\n');
    const line = lines.find(l => l.includes(f.name) || l.includes(f.code));
    const match = line ? line.match(/(大幅加仓|适度加仓|小幅加仓|持有不动|小幅减仓|适度减仓|大幅减仓)/) : null;
    return {
      code: f.code,
      name: f.name,
      changePct: f.changePct,
      advice: match ? match[1] : '持有不动',
      explicit: !!match
    };
  });

  const adviceLine = result.content.split('\n').find(l => l.includes('说明') || l.includes('原因') || l.includes('注意'));
  const summary = adviceLine ? adviceLine.replace(/^[^：:]*[：:]\s*/, '') : '';
  const hasActionable = adviceList.some(f => f.advice.includes('加仓') || f.advice.includes('减仓'))
    && !adviceList.every(f => f.advice === '持有不动');

  return {
    success: true,
    funds: adviceList,
    summary,
    hasActionableAdvice: hasActionable,
    tokens: result.tokens.total,
    timestamp: Date.now(),
    date: new Date().toISOString().slice(0, 10)
  };
}

module.exports = { callDeepSeek, runPreCloseAnalysis, isReady, getConfig };
