/**
 * NAV — 净值抓取子系统（纯前端，零 Token，无 Node 后端）
 *
 * 分层（严格隔离，互不混用）：
 *   [A] 盘中估值模块   —— gsz 实时估值，仅展示涨跌，写临时缓存 marketCache，禁入归档、禁算盈亏
 *   [B] 收盘净值模块   —— dwjz 官方单位净值，双源(天天/东财)，唯一入永久归档 aiCalcLog
 *   [C] 数据校验模块   —— 区间/涨跌幅/去重/超时重试
 *   [D] 历史补录模块   —— 近7交易日自动补 + 设置页手动区间补
 *   [E] 存储写入模块   —— 带回读校验写入（storage.AICalcLog.saveVerified）
 * 触发：① 页面初始化 ② 收盘低速校验轮询(15:30~23:00) ③ 手动刷新；可见性隐藏暂停。
 */

const NAV = {
  _closePollTimer: null,
};

// ==================== 安全 Toast（nav.js 在 ui.js 之前加载，延迟绑定） ====================
function _safeToast(msg, level) {
  if (typeof _safeToast === 'function') { _safeToast(msg, level); return; }
  // 降级：如果 ui.js 尚未就绪，用 console + 排队在 DOMContentLoaded 后补发
  console.log(`%c[NAV Toast] ${msg}`, level === 'error' ? 'color:red' : level === 'warning' ? 'color:orange' : 'color:inherit');
  if (!_safeToast._queue) _safeToast._queue = [];
  _safeToast._queue.push({ msg, level });
}
// DOMContentLoaded 后将排队消息补发
document.addEventListener('DOMContentLoaded', () => {
  if (!_safeToast._queue) return;
  const q = _safeToast._queue;
  _safeToast._queue = null;
  // 延迟一小段时间确保 ui.js 的 _safeToast 已挂载
  setTimeout(() => {
    if (typeof _safeToast !== 'function') return;
    q.forEach(({ msg, level }) => _safeToast(msg, level));
  }, 100);
});

// ==================== 时间工具（北京时间） ====================
function _navBeijingNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function beijingDateStr() { return _navBeijingNow().toISOString().slice(0, 10); }
function beijingMinutes() { const d = _navBeijingNow(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
const _navSleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==================== 日志分级 ====================
function navDebugOn() { return localStorage.getItem('fundai_nav_debug') === '1'; }
function navLog(...args) { if (navDebugOn()) console.log('[NAV]', ...args); }
function navOk(msg) { console.log(`%c[NAV] ✅ ${msg}`, 'color:#34d399'); }
function navErr(...args) { console.error('[NAV] ERROR', ...args); }

// ==================== [C] 数据校验模块 ====================
const NAV_MIN = 0.1, NAV_MAX = 10, NAV_MAX_DAILY_PCT = 15;

/** 收盘净值脏数据校验：区间 0.1~10、日涨跌 ±15% */
function validateCloseNav(nav, prevNav) {
  if (!(nav >= NAV_MIN && nav <= NAV_MAX)) return { ok: false, reason: 'range' };
  if (prevNav > 0) {
    const pct = Math.abs((nav - prevNav) / prevNav) * 100;
    if (pct > NAV_MAX_DAILY_PCT) return { ok: false, reason: 'jump', pct };
  }
  return { ok: true };
}

// ==================== [B] 收盘正式净值模块（双源） ====================
/**
 * 获取单只基金当日收盘正式净值（只取官方 dwjz，剔除估算/累计）。
 * 获取单只基金收盘正式净值（date-matched，只取官方 unitNav）。
 * 委托 fund-api.fetchCloseNavByDate 做三源交叉校验；targetDate 精确匹配当日。
 *
 * 当 fetchCloseNavByDate 返回 null（当日官方净值尚未发布）时，
 * 回退 fetchNavWithFallback 以获取最新可得净值（含盘中估值），
 * 但仅在 navFreshness==='close' 时视为有效收盘净值用于归档。
 */
async function getCloseNav(code, targetDate) {
  if (typeof fetchCloseNavByDate === 'function') {
    const result = await fetchCloseNavByDate(code, targetDate);
    if (result && result.nav > 0) return { ...result, _freshness: 'close' };
  }
  // 当日净值未发布 → 回退 fetchNavWithFallback，但标记 freshness 供调用方区分
  if (typeof fetchNavWithFallback === 'function') {
    const fb = await fetchNavWithFallback(code);
    if (fb && fb.nav > 0) {
      return { ...fb, _freshness: fb.navFreshness || 'stale' };
    }
  }
  return null;
}

// ==================== [A] 盘中估值模块（仅展示） ====================
/** 刷新全部自选基金盘中估值 → 仅写临时缓存 marketCache（不入归档、不算盈亏） */
async function refreshEstimates() {
  const watchlist = await Watchlist.getAll().catch(() => []);
  if (!watchlist.length) return;
  const todayStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  for (let i = 0; i < watchlist.length; i++) {
    try {
      const q = await fetchFromTianTian(watchlist[i].code);
      if (q) {
        // 写入缓存时保留新鲜度标记，前端可据此显示"实时估值"标签
        await MarketCache.save({
          code: q.code,
          name: q.name,
          nav: q.nav,
          estimateNav: q.estimateNav,
          changePct: q.changePct,
          estimateTime: q.estimateTime,
          navDate: q.navDate,
          navFreshness: q.navFreshness,
          isTodayNav: q.isTodayNav,
          source: q.source,
          updateTime: Date.now(),
        });
      }
    } catch { /* 单只失败忽略 */ }
    if (i < watchlist.length - 1) await _navSleep(200); // 减少节流延迟
  }
  navLog('盘中估值已刷新（仅展示，不入归档）');
}

// ==================== [E] 归档单只收盘净值（按真实净值日期，自动适配周末/节假日） ====================
/** 最近一个交易日（北京日期，<= 今日）。周末/节假日自动回退到上一交易日。 */
function _navLatestTradingDate() {
  let t = Date.now() + 8 * 3600 * 1000;
  for (let i = 0; i < 15; i++) {
    const ds = new Date(t).toISOString().slice(0, 10);
    if (typeof isTradingDate !== 'function' || isTradingDate(ds)) return ds;
    t -= 24 * 3600 * 1000;
  }
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function archiveCloseNav(fund, shares = 0) {
  const code = fund.code;

  // 抓取「当前可得的最新官方收盘净值」，按其自报真实净值日期归档。
  const q = await getCloseNav(code); // 无 targetDate → 最新可得
  if (!q || !(q.nav > 0) || !q.navDate) return { status: 'fail' };

  // 🔑 仅当数据源确认为收盘净值（_freshness === 'close'）时才归档；
  // 盘中估值（estimate）一律不入 aiCalcLog，避免盈亏计算基于估算值。
  const freshness = q._freshness || q.navFreshness || 'close';
  if (freshness === 'estimate') {
    navLog(`${code} 仅获取到盘中估值（非收盘净值），不入归档，等待收盘后轮询`);
    return { status: 'pending' };
  }

  const date = q.navDate;
  if (typeof isTradingDate === 'function' && !isTradingDate(date)) return { status: 'fail' }; // 防脏

  // 去重：该真实日期已有有效收盘净值 → 跳过，不覆盖历史
  try {
    const existing = await AICalcLog.get(date, code);
    if (existing && parseFloat(existing.nav) > 0 && existing.navSource === 'nav') {
      navLog(`${code} ${date} 已存档，跳过`);
      return { status: 'skip' };
    }
  } catch { /* 忽略 */ }

  // 前一交易日净值（该日期之前最近一条归档）
  let prevNav = 0;
  try {
    const rows = (await AICalcLog.getByCode(code)).filter(e => e.date < date).sort((a, b) => (a.date < b.date ? 1 : -1));
    prevNav = rows[0] ? parseFloat(rows[0].nav) || 0 : 0;
  } catch { /* 无历史 */ }

  const v = validateCloseNav(q.nav, prevNav);
  if (!v.ok) return { status: v.reason === 'jump' ? 'abnormal' : 'dirty', pct: v.pct };

  let dailyPnL = 0, dailyPct = 0;
  if (prevNav > 0) {
    dailyPct = ((q.nav - prevNav) / prevNav) * 100;
    dailyPnL = shares > 0 ? (q.nav - prevNav) * shares : 0;
  }

  const ok = await AICalcLog.saveVerified({
    date, code, nav: q.nav, navDate: date,
    shares, navSource: 'nav', source: q.source,
    dailyPnL: Math.round(dailyPnL * 100) / 100,
    dailyPct: Math.round(dailyPct * 100) / 100,
  });
  // 归档成功后同步更新行情缓存中的最新净值
  if (ok) {
    try { await MarketCache.save({ code, nav: q.nav, navDate: date, updateTime: Date.now() }); } catch { /* 忽略 */ }
  }
  return { status: ok ? 'ok' : 'fail' };
}

/** 批量归档当日收盘净值（串行 300ms 节流；失败合并一条日志） */
async function archiveAllToday() {
  const [watchlist, positions] = await Promise.all([
    Watchlist.getAll().catch(() => []),
    Positions.getAll().catch(() => []),
  ]);
  if (!watchlist.length) return { ok: 0, fail: 0, abnormal: 0, skip: 0 };

  const posMap = new Map(positions.map(p => [p.code, p]));
  let ok = 0, fail = 0, abnormal = 0, skip = 0, pending = 0;
  const failCodes = [];

  for (let i = 0; i < watchlist.length; i++) {
    const fund = watchlist[i];
    const pos = posMap.get(fund.code);
    const shares = pos && parseFloat(pos.shares) > 0 ? parseFloat(pos.shares) : 0;
    try {
      const r = await archiveCloseNav(fund, shares);
      if (r.status === 'ok') ok++;
      else if (r.status === 'skip') skip++;
      else if (r.status === 'abnormal') abnormal++;
      else if (r.status === 'pending') pending++;       // 今日官方净值尚未发布，非错误
      else { fail++; failCodes.push(fund.code); }
    } catch (e) { fail++; failCodes.push(fund.code); }
    if (i < watchlist.length - 1) await _navSleep(300);
  }

  if (ok > 0) {
    navOk(`当日 ${ok} 只基金净值存档完成`);
    // P1-2：净值归档成功后，同步归档当日整套 AI 结论，供台账复盘按日回看
    try {
      if (typeof runFullAnalysis === 'function' && typeof archiveDecisions === 'function') {
        const { decisions } = await runFullAnalysis();
        if (decisions && decisions.length) {
          const existed = await AIDecisions.getByDate(decisions[0].date).catch(() => []);
          if (!existed.length) {
            await archiveDecisions(decisions);
            navLog(`已归档当日 AI 结论 ${decisions.length} 条`);
          }
        }
      }
    } catch (e) { navErr('AI 结论归档失败:', e && e.message); }
  }
  if (abnormal > 0) _safeToast('当日净值数据疑似异常，已暂缓存档', 'warning');
  if (fail > 0) navErr(`当日 ${fail} 只基金净值抓取失败: ${failCodes.join(',')}`);
  if (ok === 0 && pending > 0) {
    navLog(`今日 ${pending} 只基金官方收盘净值尚未发布，将在收盘时段轮询重试`);
    console.log(`%c[NAV] ⏳ ${pending} 只基金等待今日官方净值发布（当前仅有盘中估值，不入归档）。预计 22:00 后陆续更新。`, 'color:#f59e0b');
  }
  // 汇总日志
  if (ok > 0 || fail > 0 || pending > 0) {
    console.log(`[NAV] 归档汇总: ✅${ok} ⏭️${skip} ⏳${pending} ⚠️${abnormal} ❌${fail}`);
  }
  return { ok, fail, abnormal, skip, pending };
}

/** 最近交易日是否已全部存档（每只自选基金都有该日有效收盘净值） */
async function isTodayArchived() {
  const date = _navLatestTradingDate();
  const [watchlist, rows] = await Promise.all([
    Watchlist.getAll().catch(() => []),
    AICalcLog.getByDate(date).catch(() => []),
  ]);
  if (!watchlist.length) return true;
  const set = new Set(rows.filter(e => parseFloat(e.nav) > 0).map(e => e.code));
  return watchlist.every(f => set.has(f.code));
}

// ==================== [D] 历史补录模块 ====================
/** 生成从今日往前的 n 个交易日（北京日期，降序含今日起） */
function recentTradingDates(n) {
  const out = [];
  let t = Date.now() + 8 * 3600 * 1000;
  let guard = 0;
  while (out.length < n && guard < 60) {
    const ds = new Date(t).toISOString().slice(0, 10);
    if (isTradingDate(ds)) out.push(ds);
    t -= 24 * 3600 * 1000;
    guard++;
  }
  return out;
}

/** 日期归一化：YYYY/MM/DD、YYYY-M-D → YYYY-MM-DD（模块3） */
function _normDate(s) {
  if (!s) return '';
  const t = String(s).trim().replace(/\//g, '-');
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : t;
}

/**
 * 补齐某基金指定日期的缺失净值（东财历史 JSONP）。
 * 每条独立写入（saveVerified）、独立异常捕获、脏数据过滤、去重；返回 {filled, failed}。
 */
async function backfillFundDates(code, dates, onProgress) {
  // 历史接口重试 2 次
  let hist = null;
  for (let a = 0; a < 2 && !hist; a++) {
    try { const em = await fetchEastMoneyHistoryJSONP(code, 6000); hist = em && em.history; } catch { /* 重试 */ }
    if (!hist && a === 0) await _navSleep(300);
  }
  if (!hist || !hist.length) {
    console.error(`[NAV] ERROR 补录 ${code}：东财历史接口无响应/无数据（可能被网络拦截或无法访问 fund.eastmoney.com）`);
    return { filled: 0, failed: dates.slice(), noHistory: true };
  }
  const idxMap = new Map(hist.map((h, i) => [h.date, i]));

  let filled = 0;
  const failed = [];
  for (const ds of dates) {
    try {
      const idx = idxMap.get(ds);
      const nav = idx != null ? hist[idx].nav : 0;
      const prevNav = idx != null && idx > 0 ? hist[idx - 1].nav : 0;
      if (!(nav > 0)) { failed.push(ds); continue; }
      // 脏数据过滤：区间 0.1~10、单日 ±15%
      if (!validateCloseNav(nav, prevNav).ok) { navLog(`补录跳过脏数据 ${code} ${ds} nav=${nav}`); failed.push(ds); continue; }
      // 去重：同基金同日期已存在则视为成功，不覆盖
      const existing = await AICalcLog.get(ds, code).catch(() => null);
      if (existing && parseFloat(existing.nav) > 0 && existing.navSource === 'nav') { filled++; continue; }

      if (onProgress) onProgress(code, ds);
      const ok = await AICalcLog.saveVerified({
        date: ds, code, nav, navDate: ds, shares: 0, navSource: 'nav', source: 'eastmoney',
        dailyPnL: 0, dailyPct: prevNav > 0 ? Math.round(((nav - prevNav) / prevNav) * 10000) / 100 : 0,
      });
      if (ok) { filled++; navLog(`补录写入 ${code} ${ds} nav=${nav}`); }
      else failed.push(ds);
      await _navSleep(300); // 串行节流
    } catch (e) {
      failed.push(ds);
      navErr(`补录 ${code} ${ds}:`, e && e.message);
    }
  }
  return { filled, failed };
}

/** 自动补录：近 7 交易日缺失的净值，后台静默批量补齐 */
NAV.autoBackfill = async function () {
  const watchlist = await Watchlist.getAll().catch(() => []);
  if (!watchlist.length) return;

  const dates = recentTradingDates(7);
  const archive = await AICalcLog.getAll().catch(() => []);
  const have = new Set(archive.filter(e => parseFloat(e.nav) > 0).map(e => `${e.date}_${e.code}`));

  let filled = 0;
  for (const fund of watchlist) {
    const missing = dates.filter(d => !have.has(`${d}_${fund.code}`));
    if (!missing.length) continue;
    try { const r = await backfillFundDates(fund.code, missing); filled += r.filled; }
    catch (e) { navErr(`补录 ${fund.code} 失败:`, e && e.message); }
  }
  if (filled > 0) { navOk(`自动补录历史净值 ${filled} 条`); await rerenderDashboard(); }
};

/** 手动区间补录（设置页调用）：进度反馈 + 汇总成功/失败 + 失败清单 */
NAV.backfillRange = async function (start, end) {
  start = _normDate(start);
  end = _normDate(end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    _safeToast('请输入有效的起止日期（YYYY-MM-DD，起始需早于截止）', 'error');
    return;
  }
  const watchlist = await Watchlist.getAll().catch(() => []);
  if (!watchlist.length) { _safeToast('暂无自选基金', 'info'); return; }

  // 区间内交易日（自动跳过周末/节假日）
  const dates = [];
  let d = new Date(start + 'T12:00:00');
  const endD = new Date(end + 'T12:00:00');
  let guard = 0;
  while (d <= endD && guard < 400) {
    const ds = d.toISOString().slice(0, 10);
    if (isTradingDate(ds)) dates.push(ds);
    d = new Date(d.getTime() + 24 * 3600 * 1000);
    guard++;
  }
  if (!dates.length) { _safeToast('所选区间内无交易日', 'info'); return; }

  const prog = document.getElementById('backfill-progress');
  const setProg = (t) => { if (prog) prog.textContent = t; };
  setProg(`开始补录 ${watchlist.length} 只基金 × ${dates.length} 个交易日…`);
  _safeToast(`开始补录 ${watchlist.length} 只 × ${dates.length} 交易日…`, 'info');

  let totalOk = 0;
  const allFailed = [];
  let noHistoryCount = 0;
  for (const fund of watchlist) {
    const r = await backfillFundDates(
      fund.code, dates,
      (c, ds) => setProg(`正在补录 ${ds} · ${fund.name || c}`)
    );
    totalOk += r.filled;
    if (r.noHistory) noHistoryCount++;
    r.failed.forEach(ds => allFailed.push(`${fund.code} ${ds}`));
  }

  navOk(`补录完成：成功 ${totalOk} 条，失败 ${allFailed.length} 条`);
  _safeToast(`补录完成：成功 ${totalOk} 条，失败 ${allFailed.length} 条`, allFailed.length ? 'warning' : 'success');
  if (prog) {
    if (totalOk === 0 && noHistoryCount > 0) {
      // 关键诊断：东财历史接口整体不可达
      prog.innerHTML = `❌ 补录 0 条：东财历史接口无法访问（${noHistoryCount} 只基金均无响应）。<br>`
        + `<span style="color:var(--text-muted);">这是获取任意历史日期净值的唯一免费数据源。请：① 确认浏览器能打开 <b>https://fund.eastmoney.com</b>；② 或改用下方「手动补录当日净值」逐条输入官网净值（该方式不依赖任何接口，一定能写入）。</span>`;
    } else if (allFailed.length) {
      prog.innerHTML = `补录完成：成功 <strong>${totalOk}</strong> 条，失败 <strong>${allFailed.length}</strong> 条。失败条目（可手动补录）：<br><span style="color:var(--text-muted);">${allFailed.slice(0, 40).join('、')}${allFailed.length > 40 ? ' …' : ''}</span>`;
    } else {
      prog.innerHTML = `✅ 补录完成：成功 <strong>${totalOk}</strong> 条，全部成功`;
    }
  }
  await rerenderDashboard();
};

// ==================== 触发机制 ====================
async function rerenderDashboard() {
  const active = document.querySelector('.tab-content.active');
  if (active && active.id === 'tab-dashboard' && typeof renderDashboard === 'function') {
    try { await renderDashboard(); } catch { /* 忽略 */ }
  }
}

/** ① 初始化触发（核心兜底） */
NAV.init = async function () {
  const today = beijingDateStr();
  const trading = isTradingDate(today);
  const closed = beijingMinutes() >= 15 * 60; // 北京 15:00 收盘
  navLog(`init：交易日=${trading} 已收盘=${closed} 目标交易日=${_navLatestTradingDate()}`);

  try {
    // 始终归档「最新可得交易日」收盘净值：周末/节假日自动取上一交易日（如周五），幂等去重
    await archiveAllToday();
    // 交易日盘中：额外刷新一次估值用于展示
    if (trading && !closed) await refreshEstimates();
    // 交易日收盘时段：轮询等待当日官方净值发布后归档
    if (trading) NAV.startClosePoll();
  } catch (e) { navErr('init 异常:', e && e.message); }

  NAV.autoBackfill().catch(e => navErr('autoBackfill:', e && e.message)); // 后台静默补录
  await rerenderDashboard();
};

/** ② 收盘低速校验轮询（仅交易日 15:30~23:00） */
NAV.startClosePoll = function () {
  NAV.stopClosePoll();
  // 自适应轮询间隔：15:30~18:00 每 3 分钟（净值陆续发布），18:00~23:00 每 8 分钟
  const getInterval = () => {
    const mins = beijingMinutes();
    return (mins >= 15 * 60 + 30 && mins < 18 * 60) ? 3 * 60 * 1000 : 8 * 60 * 1000;
  };

  const run = async () => {
    if (document.visibilityState !== 'visible') return;
    const today = beijingDateStr();
    if (!isTradingDate(today)) { NAV.stopClosePoll(); return; }
    const mins = beijingMinutes();
    if (mins < 15 * 60 + 30 || mins > 23 * 60) return;

    if (await isTodayArchived()) { navLog('当日已全部存档，终止轮询'); NAV.stopClosePoll(); return; }

    navLog(`校验轮询：发起收盘净值抓取（间隔 ${Math.round(getInterval()/1000)}s）`);
    await archiveAllToday();
    if (await isTodayArchived()) { NAV.stopClosePoll(); await rerenderDashboard(); }

    // 动态调整下次轮询间隔
    if (NAV._closePollTimer) {
      clearInterval(NAV._closePollTimer);
      NAV._closePollTimer = setInterval(run, getInterval());
    }
  };

  NAV._closePollTimer = setInterval(run, getInterval());
};

NAV.stopClosePoll = function () {
  if (NAV._closePollTimer) { clearInterval(NAV._closePollTimer); NAV._closePollTimer = null; }
};

/** ③ 手动强制刷新（右上角刷新按钮） */
NAV.manualRefresh = async function () {
  navLog('手动刷新：拉估值 + 补全当日收盘净值归档');
  await refreshEstimates().catch(() => {});
  const r = await archiveAllToday();
  await rerenderDashboard();
  return r;
};

/** 单基金强制刷新（携带当日日期精确抓取该基金收盘净值） */
NAV.refreshOne = async function (code) {
  if (!code) return { status: 'fail' };
  navLog(`单基金刷新：${code}`);
  try { const q = await fetchFromTianTian(code); if (q) await MarketCache.save({ ...q }); } catch { /* 估值失败忽略 */ }
  let pos = null;
  try { pos = await Positions.get(code); } catch { /* 忽略 */ }
  const shares = pos && parseFloat(pos.shares) > 0 ? parseFloat(pos.shares) : 0;
  const r = await archiveCloseNav({ code }, shares);
  if (r.status === 'ok') _safeToast(`${code} 收盘净值已更新（${_navLatestTradingDate()}）`, 'success');
  else if (r.status === 'skip') _safeToast(`${code} 最新交易日净值已是最新`, 'info');
  else if (r.status === 'abnormal') _safeToast(`${code} 净值疑似异常，已暂缓存档`, 'warning');
  else _safeToast(`${code} 暂未取到收盘净值，可稍后重试或手动补录`, 'info');
  await rerenderDashboard();
  return r;
};

/** 手动补录：接口当日抓取失败时，手动输入某日官方净值写入归档（模块1 加固） */
NAV.manualArchive = async function (code, date, navVal) {
  code = (code || '').trim();
  date = _normDate(date);
  const nav = parseFloat(navVal);

  // 前置严格校验（非法输入直接拦截，不触发写入报错）
  if (!/^\d{6}$/.test(code)) { _safeToast('基金代码需为 6 位数字', 'error'); return false; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { _safeToast('日期格式不正确（需 YYYY-MM-DD）', 'error'); return false; }
  if (typeof isTradingDate === 'function' && !isTradingDate(date)) { _safeToast(`${date} 为非交易日（周末/节假日），无官方收盘净值`, 'error'); return false; }
  if (!Number.isFinite(nav) || nav < 0.1 || nav > 10) { _safeToast('净值数值非法（应在 0.1 ~ 10 之间）', 'error'); return false; }

  // 去重：同基金同日期已存在 → 友好提示，不视为错误、不触发 DB 报错
  try {
    const existing = await AICalcLog.get(date, code);
    if (existing && parseFloat(existing.nav) > 0) {
      _safeToast(`该基金 ${date} 已存在净值记录（${existing.nav}），未重复写入`, 'warning');
      return false;
    }
  } catch (e) { navErr('manualArchive 查重失败:', e && e.message); }

  // 前一交易日净值 + 份额（用于记录单日盈亏，展示时会以当前份额重算）
  let prevNav = 0;
  try {
    const rows = (await AICalcLog.getByCode(code)).filter(e => e.date < date).sort((a, b) => (a.date < b.date ? 1 : -1));
    prevNav = rows[0] ? parseFloat(rows[0].nav) || 0 : 0;
  } catch { /* 忽略 */ }
  let pos = null; try { pos = await Positions.get(code); } catch { /* 忽略 */ }
  const shares = pos && parseFloat(pos.shares) > 0 ? parseFloat(pos.shares) : 0;
  const dailyPct = prevNav > 0 ? ((nav - prevNav) / prevNav) * 100 : 0;
  const dailyPnL = (prevNav > 0 && shares > 0) ? (nav - prevNav) * shares : 0;

  navLog(`手动写入 ${code} ${date} nav=${nav} prev=${prevNav} shares=${shares}`);
  let ok = false, err = '';
  try {
    ok = await AICalcLog.saveVerified({
      date, code, nav, navDate: date, shares, navSource: 'nav', source: 'manual',
      dailyPnL: Math.round(dailyPnL * 100) / 100, dailyPct: Math.round(dailyPct * 100) / 100,
    });
  } catch (e) { err = (e && e.message) || String(e); }

  if (ok) {
    _safeToast(`✅ 已写入 ${code} ${date} 收盘净值 ${nav}`, 'success');
    await rerenderDashboard();
    return true;
  }
  console.error(`[NAV] ERROR 手动写入失败 code=${code} date=${date} nav=${nav} 原因=${err || '数据库回读校验未通过'}`);
  _safeToast(`写入失败${err ? '：' + err : '（数据库异常，请刷新页面后重试）'}`, 'error');
  return false;
};

// 可见性：切回前台时恢复校验轮询（隐藏时轮询回调内部已自暂停）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') NAV.startClosePoll();
});
