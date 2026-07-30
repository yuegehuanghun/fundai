/**
 * 服务端基金数据采集 — HTTP 直接请求，无需 JSONP，不存在 CORS 问题
 * 数据源: 天天基金 + 东方财富 + 新浪
 */
const fetch = require('node-fetch');

// ==================== 天天基金实时估值 ====================
// 前端用 <script> JSONP 注入，服务端直接 GET JS 文本解析 jsonpgz({...})
async function fetchTianTian(code) {
  try {
    const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    const resp = await fetch(url, { timeout: 8000 });
    if (!resp.ok) return null;
    const text = await resp.text();
    const match = text.match(/jsonpgz\((\{.*\})\)/);
    if (!match) return null;
    const data = JSON.parse(match[1]);
    if (!data || !data.fundcode) return null;

    const dwjz = parseFloat(data.dwjz) || 0;
    const gsz = parseFloat(data.gsz) || 0;
    const jzrq = data.jzrq || '';
    const todayStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const isTodayNav = jzrq === todayStr;

    // 同前端逻辑：交易时段优先用估值，非交易时段用收盘净值
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const inTradingHours = (now.getUTCDay() !== 0 && now.getUTCDay() !== 6) && totalMin >= 570 && totalMin <= 900;

    let displayNav = dwjz, navFreshness = 'close';
    if (isTodayNav && dwjz > 0) { displayNav = dwjz; navFreshness = 'close'; }
    else if (!isTodayNav && inTradingHours && gsz > 0) { displayNav = gsz; navFreshness = 'estimate'; }
    else if (dwjz > 0) { displayNav = dwjz; navFreshness = 'stale'; }
    else if (gsz > 0) { displayNav = gsz; navFreshness = 'estimate'; }

    return {
      code: data.fundcode, name: data.name || '',
      nav: displayNav, navClose: dwjz, estimateNav: gsz,
      changePct: parseFloat(data.gszzl) || 0,
      estimateTime: data.gztime || '', navDate: jzrq,
      navFreshness, isTodayNav, source: 'tiantian'
    };
  } catch (e) {
    console.error(`[Scraper] 天天基金 ${code} 失败:`, e.message);
    return null;
  }
}

// ==================== 东方财富历史净值 ====================
async function fetchEastMoneyHistory(code) {
  try {
    const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
    const resp = await fetch(url, { timeout: 6000 });
    if (!resp.ok) return null;
    const text = await resp.text();

    // 解析 var Data_netWorthTrend = [...]
    const trendMatch = text.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    const nameMatch = text.match(/fS_name\s*=\s*"(.+?)";/);
    if (!trendMatch) return null;

    const trend = JSON.parse(trendMatch[1]);
    const name = nameMatch ? nameMatch[1] : '';

    const history = trend
      .filter(d => d && d.x && parseFloat(d.y) > 0)
      .map(d => ({
        date: new Date(d.x + 8 * 3600 * 1000).toISOString().slice(0, 10),
        nav: parseFloat(d.y),
        growthPct: d.equityReturn != null ? parseFloat(d.equityReturn) : null
      }));

    const recentNAVs = history.slice(-30).map(h => ({
      date: h.date, nav: h.nav, growthPct: h.growthPct == null ? 0 : h.growthPct
    }));

    return { code, name, history, recentNAVs, source: 'eastmoney' };
  } catch (e) {
    console.error(`[Scraper] 东方财富 ${code} 失败:`, e.message);
    return null;
  }
}

// ==================== 东方财富资讯搜索（主源） ====================
async function fetchFundNewsFromEastMoney(code, limit = 10) {
  try {
    // 优先尝试公告 API
    const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${limit}&page_index=1&ann_type=A&client_source=web&stock_list=${code}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com/' },
      timeout: 5000
    });
    if (resp.ok) {
      const json = await resp.json();
      if (json && json.data && json.data.list) {
        return json.data.list.map(item => ({
          title: item.title || '', date: item.notice_date || '',
          sentiment: analyzeSentiment(item.title || ''), url: item.url || ''
        }));
      }
    }
  } catch { /* 降级 */ }

  // 降级：搜索 API
  try {
    const searchUrl = `https://searchapi.eastmoney.com/bussiness/Web/GetCMSSearchResult?type=8196&pageindex=1&pagesize=${limit}&keyword=${code}&name=zixun`;
    const resp = await fetch(searchUrl, { timeout: 5000 });
    if (resp.ok) {
      const json = await resp.json();
      if (json && json.Data) {
        return json.Data.map(item => ({
          title: item.Title || item.title || '', date: item.Date || item.date || '',
          sentiment: analyzeSentiment(item.Title || item.title || '')
        }));
      }
    }
  } catch { /* 忽略 */ }

  return [];
}

// ==================== 情感分析（同前端逻辑） ====================
const POSITIVE_WORDS = [
  '利好','大涨','上涨','增长','盈利','突破','反弹','看好','增持','加仓','牛','创新高',
  '分红','降息','宽松','业绩预增','超预期','回升','修复','改善','强劲','扩张','景气'
];
const NEGATIVE_WORDS = [
  '利空','大跌','下跌','亏损','回落','减持','看空','风险','危机','暴雷','清盘','赎回',
  '踩踏','加息','收紧','业绩预减','不及预期','下行','衰退','恶化','疲软','收缩','低迷'
];

function analyzeSentiment(text) {
  let score = 50;
  const lower = text.toLowerCase();
  for (const w of POSITIVE_WORDS) { if (lower.includes(w)) score += 8; }
  for (const w of NEGATIVE_WORDS) { if (lower.includes(w)) score -= 8; }
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ==================== 批量行情采集 ====================
async function fetchAllFundData(codes) {
  const results = [];
  for (const code of codes) {
    const [tt, em] = await Promise.allSettled([
      fetchTianTian(code),
      fetchEastMoneyHistory(code)
    ]);
    const quote = tt.status === 'fulfilled' ? tt.value : null;
    const history = em.status === 'fulfilled' ? em.value : null;

    // 资讯采集（服务端无 CORS 限制）
    let news = [];
    try { news = await fetchFundNewsFromEastMoney(code, 10); } catch { /* 忽略 */ }

    results.push({
      code,
      name: quote?.name || history?.name || code,
      nav: quote?.nav || 0,
      navClose: quote?.navClose || 0,
      estimateNav: quote?.estimateNav || 0,
      changePct: quote?.changePct || 0,
      estimateTime: quote?.estimateTime || '',
      navDate: quote?.navDate || '',
      navFreshness: quote?.navFreshness || 'close',
      isTodayNav: quote?.isTodayNav || false,
      recentNAVs: history?.recentNAVs || [],
      news,
      newsSentiment: news.length > 0
        ? Math.round(news.reduce((s, n) => s + n.sentiment, 0) / news.length) : 50,
      source: quote?.source || history?.source || 'unknown',
      updateTime: Date.now()
    });
  }
  return results;
}

// ==================== 北向资金 ====================
async function fetchNorthBoundFlow() {
  try {
    const url = 'https://push2his.eastmoney.com/api/qt/kamt.kline/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56&klt=1&lmt=5';
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) return null;
    const text = await resp.text();
    // 解析 JSONP: callback({...})
    const match = text.match(/^\w+\((.+)\)\s*$/);
    if (!match) return null;
    const json = JSON.parse(match[1]);
    if (!json || !json.data) return null;

    const hk2sh = json.data.hk2sh || [];
    const hk2sz = json.data.hk2sz || [];
    let todayNet = 0, fiveDayTotal = 0;

    if (hk2sh.length) {
      const last = hk2sh[hk2sh.length - 1];
      todayNet += parseFloat(last.split(',')[1]) || 0;
      hk2sh.forEach(r => { fiveDayTotal += parseFloat(r.split(',')[1]) || 0; });
    }
    if (hk2sz.length) {
      const last = hk2sz[hk2sz.length - 1];
      todayNet += parseFloat(last.split(',')[1]) || 0;
      hk2sz.forEach(r => { fiveDayTotal += parseFloat(r.split(',')[1]) || 0; });
    }

    todayNet = Math.round(todayNet / 1e8 * 100) / 100;
    fiveDayTotal = Math.round(fiveDayTotal / 1e8 * 100) / 100;
    const trend = todayNet > 5 ? 'inflow' : (todayNet < -5 ? 'outflow' : 'flat');
    return { todayNet, fiveDayTotal, trend };
  } catch (e) {
    console.error('[Scraper] 北向资金失败:', e.message);
    return null;
  }
}

// ==================== 市场基准（沪深300） ====================
async function fetchMarketBenchmark() {
  try {
    const url = 'https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.000300&fields=f43,f47,f48,f50,f57,f58,f60,f169,f170';
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) return null;
    const text = await resp.text();
    const match = text.match(/^\w+\((.+)\)\s*$/);
    if (!match) return null;
    const json = JSON.parse(match[1]);
    if (!json || !json.data) return null;
    const d = json.data;
    return {
      index: '沪深300',
      price: Math.round(parseFloat(d.f43) * 100) / 100 || 0,
      prevClose: Math.round(parseFloat(d.f60) * 100) / 100 || 0,
      changePct: Math.round(parseFloat(d.f170) / 100 * 100) / 100 || 0,
      volume: parseInt(d.f47) || 0,
      amount: Math.round(parseFloat(d.f48) / 1e8 * 100) / 100 || 0,
      volumeRatio: Math.round(parseFloat(d.f50) * 100) / 100 || 1
    };
  } catch (e) {
    console.error('[Scraper] 沪深300失败:', e.message);
    return null;
  }
}

// ==================== 风格偏向 ====================
async function fetchSectorStyle() {
  try {
    const [gemResp, sz50Resp] = await Promise.all([
      fetch('https://push2delay.eastmoney.com/api/qt/stock/get?secid=0.399006&fields=f43,f58,f170', { timeout: 5000 }),
      fetch('https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.000016&fields=f43,f58,f170', { timeout: 5000 })
    ]);
    const parseResp = async (resp) => {
      const text = await resp.text();
      const match = text.match(/^\w+\((.+)\)\s*$/);
      return match ? JSON.parse(match[1]) : null;
    };
    const gem = await parseResp(gemResp);
    const sz50 = await parseResp(sz50Resp);

    const growthPct = (gem && gem.data) ? parseFloat(gem.data.f170) / 100 : 0;
    const valuePct = (sz50 && sz50.data) ? parseFloat(sz50.data.f170) / 100 : 0;
    const divergence = Math.round((growthPct - valuePct) * 100) / 100;
    let style = 'mixed';
    if (divergence > 0.5) style = 'growth';
    else if (divergence < -0.5) style = 'value';

    return {
      growth: { name: '创业板指', changePct: Math.round(growthPct * 100) / 100 },
      value: { name: '上证50', changePct: Math.round(valuePct * 100) / 100 },
      style, divergence
    };
  } catch (e) {
    console.error('[Scraper] 风格数据失败:', e.message);
    return null;
  }
}

// ==================== 市场情绪 ====================
async function fetchMarketBreadth() {
  try {
    const url = 'https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.000001&fields=f43,f47,f50,f58,f60,f170';
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) return null;
    const text = await resp.text();
    const match = text.match(/^\w+\((.+)\)\s*$/);
    if (!match) return null;
    const json = JSON.parse(match[1]);
    if (!json || !json.data) return null;
    const d = json.data;
    const changePct = parseFloat(d.f170) / 100 || 0;
    const volumeRatio = parseFloat(d.f50) || 1;
    let sentiment = 'neutral';
    if (changePct > 0.5 && volumeRatio > 1.2) sentiment = 'greedy';
    else if (changePct < -0.5 && volumeRatio > 1.2) sentiment = 'fearful';
    else if (changePct < -0.5 && volumeRatio < 0.8) sentiment = 'fearful';
    else if (changePct > 0.5 && volumeRatio < 0.8) sentiment = 'neutral';

    return {
      index: '上证指数', price: Math.round(parseFloat(d.f43) * 100) / 100 || 0,
      changePct: Math.round(changePct * 100) / 100,
      volumeRatio: Math.round(volumeRatio * 100) / 100,
      sentiment
    };
  } catch (e) {
    console.error('[Scraper] 市场宽度失败:', e.message);
    return null;
  }
}

/** 汇总市场全景 */
async function fetchMarketContext() {
  const [northBound, benchmark, sector, breadth] = await Promise.allSettled([
    fetchNorthBoundFlow(), fetchMarketBenchmark(), fetchSectorStyle(), fetchMarketBreadth()
  ]);
  return {
    northBound: northBound.value || null,
    benchmark: benchmark.value || null,
    sector: sector.value || null,
    breadth: breadth.value || null,
    timestamp: Date.now()
  };
}

module.exports = {
  fetchTianTian, fetchEastMoneyHistory, fetchFundNewsFromEastMoney,
  fetchAllFundData, analyzeSentiment,
  fetchNorthBoundFlow, fetchMarketBenchmark, fetchSectorStyle,
  fetchMarketBreadth, fetchMarketContext
};
