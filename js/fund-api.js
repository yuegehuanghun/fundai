/**
 * FundAPI — 基金数据采集模块
 * 数据源: 天天基金 (JSONP) + 东方财富
 * 特性: 重试、备用源切换、交易日检测、缓存
 */

const FundAPI = {
  // 缓存配置（缩短 TTL 以更快获取最新净值）
  CACHE_TTL: {
    quote: 2 * 60 * 1000,       // 实时行情 2 分钟（更频繁刷新）
    valuation: 30 * 60 * 1000,   // 估值分位 30 分钟
    history: 15 * 60 * 1000,     // 历史净值 15 分钟
    news: 30 * 60 * 1000,        // 资讯 30 分钟
  },

  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,

  // 交易日判断缓存
  _tradingDayCache: null,
  _tradingDayCacheTime: 0,
};

// ==================== 工具函数 ====================

/** JSONP 请求（用于天天基金等不支持 CORS 的接口） */
function jsonp(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const callbackName = '_fundai_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    let timer;

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
      delete window[callbackName];
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error('JSONP timeout: ' + url));
    }, timeout);

    script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + callbackName + '&_=' + Date.now();
    script.onerror = () => {
      cleanup();
      reject(new Error('JSONP request failed: ' + url));
    };
    document.head.appendChild(script);
  });
}

/** Fetch with retry */
async function fetchWithRetry(url, options = {}, retries = FundAPI.MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, FundAPI.RETRY_DELAY * (i + 1)));
    }
  }
}

/** 解析天天基金 JSONP 返回的 js 内容（备用方案：直接 fetch js 文本） */
function parseTTFundJS(text) {
  // 天天基金格式: jsonpgz({...});
  const match = text.match(/jsonpgz\((\{.*\})\)/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch { return null; }
  }
  return null;
}

// ==================== 交易日检测 ====================

/** 判断今天是否为 A 股交易日（简化版：周一到周五，排除长假） */
async function isTradingDay() {
  const now = Date.now();
  // 缓存 1 小时
  if (FundAPI._tradingDayCache !== null && (now - FundAPI._tradingDayCacheTime) < 3600000) {
    return FundAPI._tradingDayCache;
  }

  const day = new Date().getDay();
  // 周末肯定不是交易日
  if (day === 0 || day === 6) {
    FundAPI._tradingDayCache = false;
    FundAPI._tradingDayCacheTime = now;
    return false;
  }

  // 网络探测：3 秒超时，避免卡死页面初始化
  try {
    const data = await Promise.race([
      FundAPI.fetchFundQuote('000001'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);
    if (data && data.gztime) {
      FundAPI._tradingDayCache = true;
      FundAPI._tradingDayCacheTime = now;
      return true;
    }
  } catch {
    // 网络不可用，保守假设为交易日（周末已排除）
    FundAPI._tradingDayCache = true;
    FundAPI._tradingDayCacheTime = now;
    return true;
  }

  FundAPI._tradingDayCache = true;
  FundAPI._tradingDayCacheTime = now;
  return true;
}

/** 判断当前是否在交易时段 (9:30-15:00 周一到周五) */
function isTradingHours() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const totalMinutes = hours * 60 + minutes;
  return totalMinutes >= 9 * 60 + 30 && totalMinutes <= 15 * 60;
}

// ==================== 行情数据获取 ====================

/**
 * 从天天基金获取单只基金实时估值
 * API: https://fundgz.1234567.com.cn/js/{code}.js
 *
 * ⚠️ 该接口不返回 CORS 头，浏览器 fetch() 会被跨域拦截，
 * 因此必须用 JSONP（<script> 注入）方式，天生绕过 CORS。
 * 该 js 文件固定调用全局函数 jsonpgz(data)，不支持自定义 callback 名。
 */

/** 天天基金 JSONP 并发分发器：按 fundcode 匹配等待中的请求 */
const _ttJsonpPending = new Map(); // code -> settle(data)

if (typeof window !== 'undefined' && typeof window.jsonpgz !== 'function') {
  window.jsonpgz = function (data) {
    const code = data && (data.fundcode || data.code);
    // 精准匹配：按 fundcode 找到对应的等待者
    let settle = code ? _ttJsonpPending.get(code) : null;
    // ⚠️ 不再做兜底匹配：错误地把 A 基金数据塞给 B 基金请求会导致盈亏计算全错，
    // 宁可单只超时返回 null 也不混淆数据。若确实出现对不上的情况，打印警告便于排查。
    if (!settle) {
      console.warn(`[FundAPI] jsonpgz 收到 fundcode="${code}"，但无匹配的等待请求（pending codes: ${[..._ttJsonpPending.keys()].join(',')}）`);
    }
    if (settle) settle(data);
  };
}

/**
 * 以 JSONP 方式请求天天基金 fundgz 接口，返回原始 data 对象（含名称+实时估值）。
 * 内置 2 次重试（首次超时 6s，重试 8s），network error 也会触发重试。
 * @param {string} code    6 位基金代码
 * @param {number} timeout 超时毫秒（首次）
 * @returns {Promise<Object|null>}
 */
function fetchTianTianJSONP(code, timeout = 6000) {
  const doRequest = (attemptTimeout) => new Promise((resolve) => {
    const script = document.createElement('script');
    let done = false;

    const cleanup = () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      _ttJsonpPending.delete(code);
    };
    const settle = (data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      resolve(data || null);
    };

    const timer = setTimeout(() => {
      settle(null); // timeout → resolve(null)，交由外层重试
    }, attemptTimeout);

    _ttJsonpPending.set(code, settle);
    script.onerror = () => {
      settle(null); // network error → resolve(null)，交由外层重试
    };
    script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    document.head.appendChild(script);
  });

  // 最多 2 次尝试：首次 timeout，重试用更长时间；均失败返回 null
  return doRequest(timeout).then(data => {
    if (data && data.fundcode) return data;
    // 第一次失败 → 等 500ms 后重试
    return new Promise(resolve => setTimeout(resolve, 500))
      .then(() => doRequest(Math.max(timeout, 8000)))
      .then(data2 => (data2 && data2.fundcode) ? data2 : null);
  });
}

async function fetchFromTianTian(code) {
  try {
    const data = await fetchTianTianJSONP(code, 6000);
    if (!data || !data.fundcode) return null;

    const dwjz = parseFloat(data.dwjz) || 0;       // 官方单位净值
    const gsz  = parseFloat(data.gsz)  || 0;       // 盘中实时估值
    const jzrq = data.jzrq || '';                   // 净值日期（dwjz 对应的交易日）
    const gztime = data.gztime || '';                // 估值时间

    // ---- 净值新鲜度判断 ----
    // 今天北京时间日期
    const todayStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const isTodayNav = (jzrq === todayStr);         // dwjz 已是今日收盘净值（约 22:00 后发布）
    const inTradingHours = isTradingHours();

    // 展示净值策略：
    //   - jzrq == 今天 → 官方净值已发布，优先用 dwjz
    //   - jzrq != 今天 & 交易时段 & gsz > 0 → 用实时估算值（更接近当前市价）
    //   - jzrq != 今天 & 非交易时段 → 用 dwjz（最近一个已确认的收盘净值）
    let displayNav = dwjz;
    let navFreshness = 'close';  // 'close' | 'estimate' | 'stale'

    if (isTodayNav && dwjz > 0) {
      displayNav = dwjz;
      navFreshness = 'close';
    } else if (!isTodayNav && inTradingHours && gsz > 0) {
      displayNav = gsz;
      navFreshness = 'estimate';
    } else if (dwjz > 0) {
      displayNav = dwjz;
      navFreshness = 'stale';  // 非交易时段且官方净值未更新 → 标记为旧数据
    } else if (gsz > 0) {
      displayNav = gsz;
      navFreshness = 'estimate';
    }

    return {
      code: data.fundcode,
      name: data.name || '',
      nav: displayNav,                              // 展示净值（按上述策略选择）
      navClose: dwjz,                               // 原始官方收盘净值（备查）
      estimateNav: gsz,                             // 实时估值
      changePct: parseFloat(data.gszzl) || 0,       // 估算涨跌幅 %
      estimateTime: gztime,
      navDate: jzrq,
      navFreshness,                                 // 'close' | 'estimate' | 'stale'
      isTodayNav,                                   // 官方净值是否为今日
      source: 'tiantian',
    };
  } catch (err) {
    console.warn(`[FundAPI] TianTian fetch failed for ${code}:`, err.message);
    return null;
  }
}

// 供 isTradingDay 等探测使用（此前被调用却未定义，导致探测恒抛异常）
FundAPI.fetchFundQuote = fetchFromTianTian;

/**
 * 净值抓取（双数据源兜底 + 重试）：
 *   1. 主源天天基金 JSONP（内置重试），按新鲜度策略选 nav
 *   2. 天天基金彻底失败时，二级备用源东方财富历史净值最后一条
 *   3. 东方财富也失败时，三级备用源新浪基金
 * 单只失败返回 null，由调用方标记当日无净值，不阻断其它基金。
 * @returns {Promise<{code,name,nav,navDate,source,_navSource,navFreshness}|null>}
 */
async function fetchNavWithFallback(code) {
  // 主源：天天基金（已内置 2 次重试）
  try {
    const q = await fetchFromTianTian(code);
    if (q) {
      const nav = parseFloat(q.nav) || 0;
      if (nav > 0) {
        return {
          ...q,
          nav,
          navDate: q.navFreshness === 'close' ? q.navDate : (q.navFreshness === 'estimate' ? q.estimateTime : q.navDate),
          _navSource: q.navFreshness === 'estimate' ? 'estimate' : 'nav',
        };
      }
    }
  } catch { /* 进入备用源 */ }

  // 二级备用源：东方财富历史净值
  try {
    const em = await fetchFromEastMoney(code);
    const navs = em && em.recentNAVs;
    if (navs && navs.length) {
      const last = navs[navs.length - 1];
      if (last && parseFloat(last.nav) > 0) {
        return {
          code, name: em.name || '', nav: parseFloat(last.nav),
          navDate: last.date || '', source: 'eastmoney', _navSource: 'nav',
          navFreshness: 'close', navClose: parseFloat(last.nav), estimateNav: 0,
          changePct: 0, estimateTime: '', isTodayNav: false,
        };
      }
    }
  } catch { /* 忽略 */ }

  // 三级备用源：新浪基金
  try {
    const s = await fetchSinaFundNav(code, 4000);
    if (s && s.nav > 0) {
      return {
        code, name: s.name || '', nav: s.nav,
        navDate: s.navDate || '', source: 'sina', _navSource: 'nav',
        navFreshness: 'close', navClose: s.nav, estimateNav: 0,
        changePct: 0, estimateTime: '', isTodayNav: false,
      };
    }
  } catch { /* 忽略 */ }

  return null;
}

// ==================== 东方财富历史净值源（<script> 读全局，绕过 CORS） ====================
// pingzhongdata/{code}.js 是 `var Data_netWorthTrend=[...]` 赋值型脚本，
// fetch 会被跨域拦截，改用 <script> 注入执行后读取全局变量即可获取全历史官方净值。
// 多个并发请求会互相覆盖全局变量 Data_netWorthTrend，故限制并发数（信号量=3）。
// 单次只执行一个 <script> 注入（执行时读全局），用队列控制。

let _emPending = 0;
const _emQueue = [];
const _EM_MAX_CONCURRENT = 3;

function _emNext() {
  try {
    while (_emPending < _EM_MAX_CONCURRENT && _emQueue.length) {
      const item = _emQueue.shift();
      if (!item) continue;
      const { code, timeout, resolve } = item;
      _emPending++;
      _emRunOne(code, timeout).then(resolve, resolve);
    }
  } catch (e) {
    console.error('[FundAPI] _emNext error:', e && e.message);
    // 出错时重置计数器防止死锁
    if (_emPending > 0) _emPending--;
    // 延迟重试
    setTimeout(() => { try { _emNext(); } catch {} }, 1000);
  }
}

function _emRunOne(code, timeout) {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    let done = false;

    const cleanup = () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      try { delete window.Data_netWorthTrend; } catch { window.Data_netWorthTrend = undefined; }
      try { delete window.fS_name; } catch { window.fS_name = undefined; }
    };
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const out = val;
      cleanup();
      resolve(out);
    };

    const timer = setTimeout(() => finish(null), timeout);

    script.onload = () => {
      try {
        const trend = window.Data_netWorthTrend;
        const name = window.fS_name || '';
        if (Array.isArray(trend) && trend.length) {
          const history = trend.map(d => ({
            date: (d && d.x) ? new Date(d.x + 8 * 3600 * 1000).toISOString().slice(0, 10) : '',
            nav: (d && parseFloat(d.y) > 0) ? parseFloat(d.y) : 0,
            growthPct: (d && d.equityReturn != null) ? parseFloat(d.equityReturn) : null,
          })).filter(h => h.date && h.nav > 0);
          finish(history.length ? { code, name, history } : null);
        } else {
          finish(null);
        }
      } catch { finish(null); }
    };
    script.onerror = () => finish(null);

    script.src = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
    document.head.appendChild(script);
  }).finally(() => {
    if (_emPending > 0) _emPending--;
    try { _emNext(); } catch { /* 忽略队列唤醒错误 */ }
  });
}

/**
 * 拉取某基金的历史收盘净值序列（用于备用收盘源 + 历史补录）。
 * 最多 3 个并发 <script> 注入，超出排队的请求在队列中等待。
 * @returns {Promise<{code,name,history:Array<{date,nav,growthPct}>}|null>}
 */
function fetchEastMoneyHistoryJSONP(code, timeout = 6000) {
  return new Promise((resolve) => {
    _emQueue.push({ code, timeout, resolve });
    _emNext();
  });
}

// ==================== 交易日判断（纯函数，含节假日简化表） ====================
// 供净值抓取/补录判断，不发网络请求；周末 + A 股法定节假日（简化）跳过。
const A_SHARE_HOLIDAYS = new Set([
  // 2025 尾部（补录跨年时可能用到）
  '2025-10-01','2025-10-02','2025-10-03','2025-10-06','2025-10-07','2025-10-08',
  '2025-12-25','2025-12-26',
  // 2026 元旦
  '2026-01-01','2026-01-02',
  // 2026 春节（除夕~初六，简化）
  '2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-23','2026-02-24',
  // 2026 清明
  '2026-04-06',
  // 2026 劳动节
  '2026-05-01','2026-05-04','2026-05-05',
  // 2026 端午
  '2026-06-19',
  // 2026 中秋 + 国庆（简化）
  '2026-09-25','2026-10-01','2026-10-02','2026-10-05','2026-10-06','2026-10-07','2026-10-08',
]);

/**
 * P1-5：可编辑节假日集合。设置页保存后写入 localStorage `fundai_holidays`（整表覆盖），
 * 未设置时回退内置 A_SHARE_HOLIDAYS。避免内置日期过期导致 isTradingDate 失效。
 */
function getHolidaySet() {
  try {
    const raw = localStorage.getItem('fundai_holidays');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return new Set(arr);
    }
  } catch { /* 回退默认 */ }
  return A_SHARE_HOLIDAYS;
}

/** 返回当前生效节假日数组（供设置页编辑面板预填） */
function getEditableHolidays() {
  return Array.from(getHolidaySet()).sort();
}

/**
 * 判断某个日期字符串（YYYY-MM-DD）是否为 A 股交易日（纯本地，无网络）。
 * 周六、周日、法定节假日（可编辑表）返回 false。
 */
function isTradingDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  // 以中午构造，规避时区导致的日期漂移
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  if (day === 0 || day === 6) return false;      // 周末
  if (getHolidaySet().has(dateStr)) return false; // 节假日（可编辑）
  return true;
}

/**
 * P1-4：收盘净值第三方兜底源 C（新浪基金），<script> 注入读取全局 hq_str_of_ 变量绕过 CORS。
 * 仅在天天基金(A)+东财(B)均失败时调用；best-effort，任何异常/被反爬拦截返回 null。
 */
function fetchSinaFundNav(code, timeout = 4000) {
  return new Promise((resolve) => {
    const varName = 'hq_str_of_' + code;
    const script = document.createElement('script');
    let done = false;
    const cleanup = () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      try { delete window[varName]; } catch { window[varName] = undefined; }
    };
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); cleanup(); resolve(v); };
    const t = setTimeout(() => finish(null), timeout);
    script.onload = () => {
      try {
        const raw = window[varName];
        if (typeof raw === 'string' && raw.length) {
          const parts = raw.split(',');
          const nav = parseFloat(parts[1]) || 0; // [1] 单位净值
          const name = parts[0] || '';
          const navDate = parts.find(p => /^\d{4}-\d{2}-\d{2}$/.test(p)) || '';
          if (nav > 0) { finish({ code, name, nav, navDate, source: 'sina' }); return; }
        }
        finish(null);
      } catch { finish(null); }
    };
    script.onerror = () => finish(null);
    script.src = `https://hq.sinajs.cn/list=of_${code}`;
    document.head.appendChild(script);
  });
}

/**
 * 按指定交易日拉取「官方收盘单位净值」（三源交叉校验，仅取 unitNav，剔除累计净值）。
 *
 * 核心：解决「当日净值滞后」——只有当某数据源自报的净值日期 == targetDate 时才采信，
 * 从根本上杜绝把上一交易日旧净值冒充当日净值。今日官方净值通常收盘当晚才发布，
 * 因此 15:30 抓取若各源仍报昨日日期，则返回 null（当日尚未发布），由上层提示待归档。
 *
 * @param {string} code
 * @param {string} targetDate  YYYY-MM-DD，需要的交易日；缺省则取各源最新一条
 * @returns {Promise<{nav:number, navDate:string, source:string}|null>}
 */
async function fetchCloseNavByDate(code, targetDate) {
  const results = [];

  // 源A：天天基金 dwjz（jzrq 必须等于 targetDate）
  try {
    const q = await fetchTianTianJSONP(code, 3000);
    if (q && q.fundcode) {
      const dwjz = parseFloat(q.dwjz) || 0; // 单位净值（非累计）
      if (dwjz > 0 && (!targetDate || q.jzrq === targetDate)) {
        results.push({ nav: dwjz, navDate: q.jzrq || targetDate, source: 'tiantian' });
      }
    }
  } catch { /* 忽略 */ }

  // 源B：东财历史（按日期精确匹配，y=单位净值）
  try {
    const em = await fetchEastMoneyHistoryJSONP(code, 6000);
    if (em && em.history && em.history.length) {
      const hit = targetDate ? em.history.find(h => h.date === targetDate) : em.history[em.history.length - 1];
      if (hit && hit.nav > 0) results.push({ nav: hit.nav, navDate: hit.date, source: 'eastmoney' });
    }
  } catch { /* 忽略 */ }

  // 源C：新浪基金（navDate 必须等于 targetDate）
  try {
    const s = await fetchSinaFundNav(code, 4000);
    if (s && s.nav > 0 && (!targetDate || s.navDate === targetDate)) {
      results.push({ nav: s.nav, navDate: s.navDate || targetDate, source: 'sina' });
    }
  } catch { /* 忽略 */ }

  if (!results.length) return null;

  // 无 targetDate（取最新可得）时，对齐到各源里最新的净值日期，避免不同源日期错配
  let pool = results;
  if (!targetDate) {
    const maxDate = results.reduce((m, r) => (r.navDate > m ? r.navDate : m), results[0].navDate);
    pool = results.filter(r => r.navDate === maxDate);
  }

  // 三源交叉校验：同日净值差值 > 0.02 判脏，取中位数源
  if (pool.length >= 2) {
    const navs = pool.map(r => r.nav).sort((a, b) => a - b);
    const spread = navs[navs.length - 1] - navs[0];
    if (spread > 0.02) {
      const median = navs[Math.floor(navs.length / 2)];
      const pick = pool.find(r => r.nav === median) || pool[0];
      console.warn(`[NAV] ${code} 多源净值差值 ${spread.toFixed(4)} > 0.02，取中位源 ${pick.source}=${median}`);
      return { ...pick };
    }
  }
  return pool[0];
}

/**
 * 从东方财富获取基金历史净值数据（用于计算短期趋势，JSONP 绕过 CORS）
 * API: https://fund.eastmoney.com/pingzhongdata/{code}.js
 */
async function fetchFromEastMoney(code) {
  // PO-1：改用 <script> JSONP（fetchEastMoneyHistoryJSONP）读取 Data_netWorthTrend，
  // 彻底规避 fetch 跨域 CORS 拦截；趋势数据统一来源于此。
  try {
    const em = await fetchEastMoneyHistoryJSONP(code, 6000);
    if (!em || !em.history || !em.history.length) return null;
    return {
      code,
      source: 'eastmoney',
      name: em.name || '',
      recentNAVs: em.history.slice(-30).map(h => ({
        date: h.date,
        nav: h.nav,
        growthPct: h.growthPct == null ? 0 : h.growthPct,
      })),
    };
  } catch (err) {
    console.warn(`[FundAPI] EastMoney JSONP failed for ${code}:`, err && err.message);
    return null;
  }
}

// ==================== 指数估值数据 ====================

/**
 * JSONP GET（东财 push2 系列接口支持 &cb= 回调），绕过 CORS。
 */
function jsonpCb(url, timeout = 6000, cbParam = 'cb') {
  return new Promise((resolve) => {
    const cbName = '_emcb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    const script = document.createElement('script');
    let done = false;
    const cleanup = () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      try { delete window[cbName]; } catch { window[cbName] = undefined; }
    };
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); cleanup(); resolve(v); };
    window[cbName] = (data) => finish(data);
    const t = setTimeout(() => finish(null), timeout);
    script.onerror = () => finish(null);
    script.src = url + (url.includes('?') ? '&' : '?') + cbParam + '=' + cbName;
    document.head.appendChild(script);
  });
}

/**
 * 获取指数 K 线（JSONP，绕过 CORS）。保留原分位解析逻辑，best-effort。
 * 常见指数代码: 1.000300 (沪深300), 1.000905 (中证500), 1.000016 (上证50)
 */
async function fetchIndexValuation(indexCode = '1.000300') {
  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${indexCode}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&end=20500000&lmt=2000`;
    const data = await jsonpCb(url, 6000, 'cb');

    if (data && data.data && data.data.klines) {
      const klines = data.data.klines;
      const peValues = [];
      for (const line of klines) {
        const parts = line.split(',');
        const pe = parseFloat(parts[10] || parts[9] || 0);
        if (pe > 0) peValues.push(pe);
      }
      if (peValues.length > 0) {
        const currentPE = peValues[peValues.length - 1];
        const sorted = [...peValues].sort((a, b) => a - b);
        const rank = sorted.findIndex(v => v >= currentPE);
        const percentile = rank >= 0 ? (rank / sorted.length) * 100 : 50;
        return {
          indexCode, currentPE,
          pePercentile: Math.round(percentile),
          peMin: sorted[0], peMax: sorted[sorted.length - 1],
          peMedian: sorted[Math.floor(sorted.length / 2)],
          dataPoints: sorted.length, fetchTime: Date.now(),
        };
      }
    }
    return null;
  } catch (err) {
    console.warn(`[FundAPI] Index valuation JSONP failed for ${indexCode}:`, err && err.message);
    return null;
  }
}

// ==================== 基金资讯采集 ====================

/**
 * 采集基金相关资讯标题
 * 使用东方财富基金新闻接口
 */
async function fetchFundNews(code, limit = 10) {
  try {
    // 东方财富个股/基金新闻
    const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${limit}&page_index=1&ann_type=A&client_source=web&stock_list=${code}`;
    const data = await fetchWithRetry(url);

    if (data && data.data && data.data.list) {
      return data.data.list.map(item => ({
        title: item.title || '',
        date: item.notice_date || '',
        sentiment: analyzeSentiment(item.title || ''), // 简单情感分析
        url: item.url || '',
      }));
    }
    return [];
  } catch {
    // 降级：尝试用搜索接口
    try {
      const searchUrl = `https://searchapi.eastmoney.com/bussiness/Web/GetCMSSearchResult?type=8196&pageindex=1&pagesize=${limit}&keyword=${code}&name=zixun`;
      const data = await fetchWithRetry(searchUrl);
      if (data && data.Data) {
        return data.Data.map(item => ({
          title: item.Title || item.title || '',
          date: item.Date || item.date || '',
          sentiment: analyzeSentiment(item.Title || item.title || ''),
        }));
      }
    } catch { return []; }
    return [];
  }
}

/** 简易中文情感词库分析 */
function analyzeSentiment(text) {
  const positiveWords = [
    '利好', '大涨', '上涨', '增长', '盈利', '突破', '反弹', '看好', '增持',
    '加仓', '牛', '创新高', '分红', '降息', '宽松', '业绩预增', '超预期',
    '回升', '修复', '改善', '强劲', '扩张', '景气',
  ];
  const negativeWords = [
    '利空', '大跌', '下跌', '亏损', '回落', '减持', '看空', '风险', '危机',
    '暴雷', '清盘', '赎回', '踩踏', '加息', '收紧', '业绩预减', '不及预期',
    '下行', '衰退', '恶化', '疲软', '收缩', '低迷',
  ];

  let score = 50; // 中性起始
  const lower = text.toLowerCase();

  for (const word of positiveWords) {
    if (lower.includes(word)) score += 8;
  }
  for (const word of negativeWords) {
    if (lower.includes(word)) score -= 8;
  }

  // 钳位到 0-100
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 读取基金持仓中的重仓股对应的指数，用于估算估值分位 */
const FUND_INDEX_MAP = {
  // 常见宽基指数对应的基金类型
  '沪深300': ['000300', '510300', '510310', '159919'],
  '中证500': ['000905', '510500', '159922'],
  '上证50': ['000016', '510050', '510710'],
  '创业板': ['000688', '159915', '399006'],
};

/**
 * 批量获取多只基金的完整行情数据
 * @param {string[]} codes - 基金代码列表
 * @param {Function} onProgress - 进度回调 (completed, total)
 */
async function fetchAllFundData(codes, onProgress) {
  const results = [];
  let completed = 0;

  for (const code of codes) {
    try {
      // PO-4：资讯接口是跨域 fetch，默认跳过（避免 CORS 刷屏）；开关开启时才请求
      const allowNews = (typeof shouldSkipCorsFetch === 'function') ? !shouldSkipCorsFetch() : false;
      if (!allowNews && typeof logCorsSkippedOnce === 'function') logCorsSkippedOnce();

      // 并行获取天天基金(JSONP) + 东方财富历史(JSONP) + 资讯(可选)
      const [ttData, emData, news] = await Promise.allSettled([
        fetchFromTianTian(code),
        fetchFromEastMoney(code),
        allowNews ? fetchFundNews(code) : Promise.resolve([]),
      ]);

      const quote = ttData.status === 'fulfilled' ? ttData.value : null;
      const history = emData.status === 'fulfilled' ? emData.value : null;
      const newsData = news.status === 'fulfilled' ? news.value : [];

      // 合并数据（保留新鲜度标记）
      const marketData = {
        code,
        name: quote?.name || history?.name || code,
        nav: quote?.nav || 0,
        navClose: quote?.navClose || quote?.nav || 0,      // 官方收盘净值（备查）
        estimateNav: quote?.estimateNav || 0,
        changePct: quote?.changePct || 0,
        estimateTime: quote?.estimateTime || '',
        navDate: quote?.navDate || '',
        navFreshness: quote?.navFreshness || 'close',       // 'close' | 'estimate' | 'stale'
        isTodayNav: quote?.isTodayNav || false,
        recentNAVs: history?.recentNAVs || [],
        news: newsData,
        newsSentiment: newsData.length > 0
          ? Math.round(newsData.reduce((s, n) => s + n.sentiment, 0) / newsData.length)
          : 50,
        updateTime: Date.now(),
        source: quote?.source || history?.source || 'unknown',
      };

      results.push(marketData);
    } catch (err) {
      console.warn(`[FundAPI] Failed to fetch data for ${code}:`, err.message);
      // 如果缓存中有旧数据，保留
      const cached = await MarketCache.get(code);
      if (cached) {
        results.push({ ...cached, updateTime: Date.now(), stale: true });
      }
    }

    completed++;
    if (onProgress) onProgress(completed, codes.length);
  }

  // 存储到缓存
  if (results.length > 0) {
    await MarketCache.saveAll(results);
  }

  return results;
}

/**
 * 获取指数估值分位（带缓存）
 */
async function getValuationPercentile(fundCode) {
  // 先查缓存
  const cached = await MarketCache.get(fundCode);
  if (cached && cached.valuationPercentile != null &&
      (Date.now() - cached.updateTime) < FundAPI.CACHE_TTL.valuation) {
    return cached.valuationPercentile;
  }

  // 尝试取沪深 300 作为默认基准
  const valuation = await fetchIndexValuation('1.000300');
  return valuation ? valuation.pePercentile : 50; // 默认中性 50
}

/**
 * 获取基金估值分位（PO-1：CORS-free）。
 * 用基金自身历史净值在其区间内的百分位作为「估值高低」信号（越高越贵→少加仓），
 * 数据来自 fetchEastMoneyHistoryJSONP（<script> JSONP，无跨域）。
 * 数据不足/拉取失败时 percentile 返回 null，交由 AI 引擎按维度缺失降级处理（不再硬塞 50）。
 */
async function getFundValuation(fundCode) {
  try {
    const em = await fetchEastMoneyHistoryJSONP(fundCode, 6000);
    const hist = em && em.history ? em.history.filter(h => h.nav > 0) : [];
    if (hist.length >= 20) {
      const navs = hist.map(h => h.nav);
      const current = navs[navs.length - 1];
      const sorted = [...navs].sort((a, b) => a - b);
      let rank = sorted.findIndex(v => v >= current);
      if (rank < 0) rank = sorted.length - 1;
      const percentile = Math.round((rank / (sorted.length - 1)) * 100);
      return {
        percentile,
        pe: 0,
        peMin: sorted[0],
        peMax: sorted[sorted.length - 1],
        label: getValuationLabel(percentile),
        source: 'fund-nav',
      };
    }
  } catch { /* 忽略，走缺失降级 */ }
  // 数据不可用：percentile=null → AI 引擎将该维度权重归零重分配
  return { percentile: null, pe: 0, peMin: 0, peMax: 0, label: '估值数据不可用', source: 'none' };
}

/** 估值分位文字标签 */
function getValuationLabel(percentile) {
  if (percentile <= 10) return '极度低估';
  if (percentile <= 25) return '低估';
  if (percentile <= 40) return '偏低估';
  if (percentile <= 60) return '估值适中';
  if (percentile <= 75) return '偏高估';
  if (percentile <= 90) return '高估';
  return '极度高估';
}

// ==================== 连通性快速探测 ====================

/**
 * 快速探测天天基金 API 是否可达（< 4 秒超时）。
 * 探测成功缓存 2 分钟，失败不缓存（允许快速重试）。
 * @returns {Promise<{reachable: boolean, latencyMs: number}>}
 */
FundAPI.probeConnectivity = async function () {
  const now = Date.now();
  // 成功缓存 2 分钟
  if (FundAPI._probeResult && FundAPI._probeResult.reachable && (now - FundAPI._probeTime) < 120_000) {
    return FundAPI._probeResult;
  }
  const start = Date.now();
  try {
    const data = await fetchTianTianJSONP('000001', 3500);
    const latencyMs = Date.now() - start;
    const reachable = !!(data && data.fundcode);
    FundAPI._probeResult = { reachable, latencyMs };
    FundAPI._probeTime = now;
    if (reachable) {
      console.log(`%c[FundAPI] ✅ 天天基金 API 可达，延迟 ${latencyMs}ms`, 'color:#34d399');
    } else {
      console.warn(`[FundAPI] ⚠️ 天天基金 API 返回异常（${latencyMs}ms），请检查网络或 API 状态`);
    }
    return FundAPI._probeResult;
  } catch {
    const latencyMs = Date.now() - start;
    FundAPI._probeResult = { reachable: false, latencyMs };
    FundAPI._probeTime = 0; // 不缓存失败
    console.error(`[FundAPI] ❌ 天天基金 API 不可达（${latencyMs}ms），请确认能访问 fundgz.1234567.com.cn`);
    return FundAPI._probeResult;
  }
};

/** 获取最近一次连通探测结果 */
FundAPI.lastProbeResult = function () {
  return FundAPI._probeResult || null;
};

// ==================== 市场宏观数据采集（JSONP，绕过 CORS） ====================

/**
 * 北向资金净流向（沪深港通）
 * API: push2his.eastmoney.com/api/qt/kamt.kline/get
 * 返回今日北向净流入(亿) + 近5日趋势
 */
async function fetchNorthBoundFlow() {
  try {
    const url = 'https://push2his.eastmoney.com/api/qt/kamt.kline/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56&klt=1&lmt=5';
    const data = await jsonpCb(url, 5000, 'cb');
    if (!data || !data.data) return null;

    // 北向 = 港股通→沪市 + 港股通→深市
    const hk2sh = data.data.hk2sh || [];
    const hk2sz = data.data.hk2sz || [];

    let todayNet = 0, fiveDayTotal = 0;
    if (hk2sh.length) {
      const last = hk2sh[hk2sh.length - 1];
      const net = parseFloat(last.split(',')[1]) || 0;
      todayNet += net;
      hk2sh.forEach(r => { fiveDayTotal += parseFloat(r.split(',')[1]) || 0; });
    }
    if (hk2sz.length) {
      const last = hk2sz[hk2sz.length - 1];
      const net = parseFloat(last.split(',')[1]) || 0;
      todayNet += net;
      hk2sz.forEach(r => { fiveDayTotal += parseFloat(r.split(',')[1]) || 0; });
    }

    // 单位转换：元 → 亿元
    todayNet = Math.round(todayNet / 1e8 * 100) / 100;
    fiveDayTotal = Math.round(fiveDayTotal / 1e8 * 100) / 100;

    const trend = todayNet > 5 ? 'inflow' : (todayNet < -5 ? 'outflow' : 'flat');

    return { todayNet, fiveDayTotal, trend };
  } catch (e) {
    console.warn('[MktData] 北向资金获取失败:', e && e.message);
    return null;
  }
}

/**
 * 大盘基准 — 沪深300 实时行情
 * API: push2delay.eastmoney.com/api/qt/stock/get?secid=1.000300
 */
async function fetchMarketBenchmark() {
  try {
    const url = 'https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.000300&fields=f43,f47,f48,f50,f57,f58,f60,f169,f170';
    const data = await jsonpCb(url, 5000, 'cb');
    if (!data || !data.data) return null;

    const d = data.data;
    const price = parseFloat(d.f43) || 0;
    const prevClose = parseFloat(d.f60) || 0;
    const changePct = parseFloat(d.f170) / 100 || 0; // 基点→百分比
    const volume = parseFloat(d.f47) || 0;            // 成交量(手)
    const amount = parseFloat(d.f48) || 0;             // 成交额(元)
    const volumeRatio = parseFloat(d.f50) || 1;        // 量比

    return {
      index: '沪深300',
      price: Math.round(price * 100) / 100,
      prevClose: Math.round(prevClose * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      volume: Math.round(volume),
      amount: Math.round(amount / 1e8 * 100) / 100,   // 转为亿元
      volumeRatio: Math.round(volumeRatio * 100) / 100
    };
  } catch (e) {
    console.warn('[MktData] 沪深300获取失败:', e && e.message);
    return null;
  }
}

/**
 * 成长 vs 价值风格偏向
 * 对比创业板指(secid=0.399006) 和 上证50(secid=1.000016)
 */
async function fetchSectorStyle() {
  try {
    const [gem, sz50] = await Promise.all([
      jsonpCb('https://push2delay.eastmoney.com/api/qt/stock/get?secid=0.399006&fields=f43,f58,f170', 5000, 'cb'),
      jsonpCb('https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.000016&fields=f43,f58,f170', 5000, 'cb')
    ]);

    const growthPct = (gem && gem.data) ? parseFloat(gem.data.f170) / 100 : 0;
    const valuePct = (sz50 && sz50.data) ? parseFloat(sz50.data.f170) / 100 : 0;
    const divergence = Math.round((growthPct - valuePct) * 100) / 100;

    let style = 'mixed';
    if (divergence > 0.5) style = 'growth';       // 成长领先 >0.5%
    else if (divergence < -0.5) style = 'value';  // 价值领先 >0.5%

    return {
      growth: { name: '创业板指', changePct: Math.round(growthPct * 100) / 100 },
      value: { name: '上证50', changePct: Math.round(valuePct * 100) / 100 },
      style,
      divergence
    };
  } catch (e) {
    console.warn('[MktData] 风格数据获取失败:', e && e.message);
    return null;
  }
}

/**
 * 市场情绪 — 上证指数涨跌 + 量比 → 情绪判断
 * API: push2delay.eastmoney.com/api/qt/stock/get?secid=1.000001
 */
async function fetchMarketBreadth() {
  try {
    const url = 'https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.000001&fields=f43,f47,f50,f58,f60,f170';
    const data = await jsonpCb(url, 5000, 'cb');
    if (!data || !data.data) return null;

    const d = data.data;
    const price = parseFloat(d.f43) || 0;
    const prevClose = parseFloat(d.f60) || 0;
    const changePct = parseFloat(d.f170) / 100 || 0;
    const volumeRatio = parseFloat(d.f50) || 1;

    // 情绪判断：涨跌 + 量比
    let sentiment = 'neutral';
    if (changePct > 0.5 && volumeRatio > 1.2) sentiment = 'greedy';      // 放量上涨
    else if (changePct < -0.5 && volumeRatio > 1.2) sentiment = 'fearful'; // 放量下跌
    else if (changePct < -0.5 && volumeRatio < 0.8) sentiment = 'fearful'; // 缩量下跌
    else if (changePct > 0.5 && volumeRatio < 0.8) sentiment = 'neutral';  // 缩量上涨

    return {
      index: '上证指数',
      price: Math.round(price * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      volumeRatio: Math.round(volumeRatio * 100) / 100,
      sentiment
    };
  } catch (e) {
    console.warn('[MktData] 市场宽度获取失败:', e && e.message);
    return null;
  }
}

/** 汇总市场全景（并行请求，单只失败不阻塞其余） */
FundAPI.fetchMarketContext = async function () {
  const [northBound, benchmark, sector, breadth] = await Promise.allSettled([
    fetchNorthBoundFlow(),
    fetchMarketBenchmark(),
    fetchSectorStyle(),
    fetchMarketBreadth()
  ]);
  return {
    northBound: northBound.status === 'fulfilled' ? northBound.value : null,
    benchmark: benchmark.status === 'fulfilled' ? benchmark.value : null,
    sector: sector.status === 'fulfilled' ? sector.value : null,
    breadth: breadth.status === 'fulfilled' ? breadth.value : null,
    timestamp: Date.now()
  };
};
