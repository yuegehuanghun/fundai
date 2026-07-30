/**
 * FundAI — 主控制器
 * 初始化、定时刷新、事件绑定、全局操作函数
 */

// ==================== 应用状态 ====================
const AppState = {
  initialized: false,
  refreshTimer: null,
  lastDecisions: null,
  activeTab: 'dashboard',      // 当前激活标签，用于暂停非激活标签的后台任务
  suspendMarketSync: false,    // 切换到设置页时置真，暂停行情同步、优先读取配置
  debugMode: false,            // 后端调试日志开关（Node 后端已移除，仅作占位）
};

/**
 * 后端可用性检测占位函数。
 * 项目已完全移除 Node 后端 / server.js / 接口请求，纯浏览器 IndexedDB 存储，
 * 因此后端永远不可用。保留此函数只为兼容历史模板引用，避免 ReferenceError 阻断渲染。
 */
function isBackendAvailable() {
  return false;
}

// ==================== 后端 API 通信 ====================

/**
 * 调用后端 REST API
 * @param {string} path - API 路径，如 '/api/preclose'
 * @param {Object} opts - fetch 选项（method, body 等）
 * @returns {Promise<Object|null>} 成功返回 data 字段，失败返回 null
 */
async function apiFetch(path, opts = {}) {
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  const url = base + path;
  try {
    const resp = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
      signal: AbortSignal.timeout(opts.timeout || 8000)
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.success !== false ? json : null;
  } catch {
    return null; // 后端不可达 → 静默降级
  }
}

// ==================== PO-4：CORS 跨域接口总开关 + 连通探测 ====================
// 说明：需求要求存入 IndexedDB system_config，但该 store 不存在且本次不改 storage.js，
// 故复用 AppSettings（localStorage）持久化，功能等价（可编辑、持久、跨会话）。
// 默认关闭：跳过所有必然 CORS 失败的 fetch 请求（资讯等），杜绝控制台红色刷屏。

/** 读取 CORS 抓取开关（默认关闭） */
function isCorsFetchEnabled() {
  try { return AppSettings.get().corsFetchEnabled === true; } catch { return false; }
}

/** 设置 CORS 抓取开关 */
function setCorsFetchEnabled(on) {
  try { AppSettings.save({ corsFetchEnabled: !!on }); } catch { /* 忽略 */ }
  AppState._corsProbeDone = false; // 重置探测缓存
}

/**
 * 是否跳过跨域 fetch 请求：
 *   - 开关关闭 → 跳过
 *   - 开关开启 → 经一次会话级探测，探测失败也跳过（避免重复必失败请求）
 */
function shouldSkipCorsFetch() {
  if (!isCorsFetchEnabled()) return true;
  if (AppState._corsProbeDone && AppState._corsReachable === false) return true;
  return false;
}

let _corsSkipLogged = false;
/** 跳过跨域请求时仅打印一行灰色提示（不刷屏） */
function logCorsSkippedOnce() {
  if (_corsSkipLogged) return;
  _corsSkipLogged = true;
  console.log('%c[CORS] 已跳过跨域资讯/估值 fetch 请求（可在「设置」开启）', 'color:#9ca3af');
}

/** 会话级探测：轻量试探一次跨域 fetch，失败则本会话不再发起 */
async function probeCorsReachable() {
  if (AppState._corsProbeDone) return AppState._corsReachable;
  AppState._corsProbeDone = true;
  if (!isCorsFetchEnabled()) { AppState._corsReachable = false; return false; }
  try {
    await fetch('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300&lmt=1&klt=101&fqt=0&fields1=f1&fields2=f51',
      { signal: AbortSignal.timeout(2500) });
    AppState._corsReachable = true;
  } catch {
    AppState._corsReachable = false;
    logCorsSkippedOnce();
  }
  return AppState._corsReachable;
}

// ==================== 初始化 ====================

async function initApp() {
  if (AppState.initialized) return;

  try {
    // 1. 初始化 IndexedDB（失败不阻塞）
    await initDB().catch(err => console.warn('[App] IndexedDB 延迟:', err.message));
    console.log('[App] IndexedDB ready');

    // 2. 请求通知权限
    requestNotificationPermission();

    // 3. 检查月度预算滚动
    await BudgetManager.checkMonthRollover().catch(() => {});

    // 4. 更新顶栏（5秒超时兜底，避免 isTradingDay 卡死）
    await Promise.race([updateTopBar(), new Promise(r => setTimeout(r, 5000))]);

    // 5. 渲染 Dashboard
    try { await renderDashboard(); } catch (e) { console.warn('[App] Dashboard:', e.message); }

    // 6. 定时刷新
    scheduleAutoRefresh();

    // 6b. 净值子系统：初始化触发（交易日收盘抓正式净值 / 未收盘拉估值 / 自动补录）
    if (typeof NAV !== 'undefined') NAV.init().catch(e => console.error('[NAV] ERROR init:', e && e.message));

    // 7. 收盘归档
    dailyArchiveCheck().catch(() => {});

    AppState.initialized = true;
    console.log('[App] 初始化完成 - 纯浏览器存储模式');
  } catch (err) {
    console.error('[App] Init error:', err.message);
  }
}

// ==================== 定时刷新（差异化频率，杜绝高频请求） ====================

/** 行情刷新定时器（交易时段 60s / 休市 300s） */
let _marketTimer = null;
/** 静态数据刷新定时器（5 分钟） */
let _staticTimer = null;
/** 收盘前建议定时器（交易日 14:30 触发） */
let _precloseTimer = null;

function scheduleAutoRefresh() {
  // 清除旧定时器
  if (_marketTimer) clearInterval(_marketTimer);
  if (_staticTimer) clearInterval(_staticTimer);

  isTradingDay().then(trading => {
    const tradingHours = trading && isTradingHours();

    // 行情实时类：交易时段 180s，休市 300s
    const marketInterval = tradingHours ? 180_000 : 300_000;
    _marketTimer = setInterval(() => {
      // 暂停条件：切到设置页（优先读取配置）、页面不可见、或正处于设置标签
      if (AppState.suspendMarketSync || document.hidden || AppState.activeTab === 'settings') {
        console.log('[App] ⏸ 行情刷新已暂停（非激活/设置页/后台）');
        return;
      }
      console.log('[App] 🔄 行情刷新');
      refreshAllData(false);
    }, marketInterval);

    // 静态台账/资金/AI日志：统一 5 分钟刷新一次
    _staticTimer = setInterval(() => {
      if (document.hidden || AppState.activeTab === 'settings') {
        console.log('[App] ⏸ 台账刷新已暂停（后台/设置页）');
        return;
      }
      console.log('[App] 📋 台账数据刷新');
      refreshStaticData();
    }, 300_000);

    console.log(`[App] 定时刷新已配置 — 行情:${Math.round(marketInterval/1000)}s 台账:300s（不再自动同步）`);
  });

  // 收盘前建议：独立定时器，不跟行情刷新混在一起
  schedulePrecloseCheck();
}

/** 收盘前建议定时器：每 5 分钟检查一次，14:30-14:35 窗口触发一次 */
function schedulePrecloseCheck() {
  if (_precloseTimer) clearInterval(_precloseTimer);

  const check = async () => {
    if (!isTradingHours()) return;
    const now = new Date();
    const totalMin = now.getHours() * 60 + now.getMinutes();
    // 仅 14:30-14:35 窗口内触发，且当天只触发一次
    if (totalMin >= 14 * 60 + 30 && totalMin < 14 * 60 + 35) {
      const today = now.toISOString().slice(0, 10);
      const lastRun = localStorage.getItem('fundai_preclose_date');
      if (lastRun === today) return; // 今天已经运行过了
      localStorage.setItem('fundai_preclose_date', today);

      console.log('[App] ⏰ 14:30 收盘前分析触发');
      await runPreCloseAnalysis();
    }
  };

  _precloseTimer = setInterval(check, 5 * 60 * 1000);
  check(); // 立即检查一次（页面可能在 14:30 时刷新）
}

/** 执行收盘前批量分析 */
async function runPreCloseAnalysis() {
  try {
    // 优先：调用后端 /api/preclose/run（后端负责行情采集 + DeepSeek 调用）
    const apiResult = await apiFetch('/api/preclose/run', { method: 'POST', timeout: 30000 });
    if (apiResult && apiResult.success) {
      console.log(`[PreClose] ✅ 后端分析完成 · ${apiResult.tokens || 0} tokens`);
      // 后端已将结果存入 SQLite，UI 下次 renderDashboard 时会通过 /api/preclose 读取
      return;
    }
    console.log('[PreClose] 后端不可达，降级到前端分析');
  } catch { console.log('[PreClose] 后端不可达，降级到前端分析'); }

  // 降级：前端本地执行
  try {
    await refreshAllData(false);
    if (typeof startPreCloseAnalysis !== 'function') {
      console.log('[PreClose] startPreCloseAnalysis 不可用，跳过');
      return;
    }

    const result = await startPreCloseAnalysis();
    if (!result || !result.success) {
      console.log('[PreClose] 分析未成功，跳过通知');
      return;
    }

    // 3. 桌面通知（仅在有操作建议时）
    if (result.hasActionableAdvice && result.summary) {
      const actionableFunds = result.funds.filter(f => f.advice.includes('加仓') || f.advice.includes('减仓'));
      const names = actionableFunds.map(f => `${f.name}:${f.advice}`).join('，');
      try {
        sendDesktopNotification(
          '📊 收盘前操作建议',
          names || result.summary
        );
      } catch { /* 通知失败不影响主流程 */ }
    }

    // 4. 刷新 UI（如果有渲染函数）
    try { await updateTopBar(); } catch { /* 忽略 */ }

    console.log(`[PreClose] ✅ 收盘前分析完成 · ${result.tokens || 0} tokens · actionable=${result.hasActionableAdvice}`);
  } catch (err) {
    console.error('[PreClose] 执行失败:', err && err.message);
  }
}

/** 仅刷新静态数据（台账、资金、AI日志），不拉取行情 */
async function refreshStaticData() {
  // 更新顶栏 + 后台静默刷新当前 Tab 数据
  await updateTopBar();
  const activeTab = document.querySelector('.tab-content.active');
  if (activeTab) {
    const tabId = activeTab.id;
    if (tabId === 'tab-dashboard') await renderDashboard();
    else if (tabId === 'tab-budget') await renderBudgetTab();
  }
}

// ==================== 手动刷新 ====================

async function manualRefresh() {
  showLoading(true);
  try {
    await refreshAllData(true);
    // 手动强制刷新净值子系统：拉估值 + 补全当日收盘净值归档
    if (typeof NAV !== 'undefined') {
      await NAV.manualRefresh().catch(err => console.error('[NAV] ERROR manualRefresh:', err && err.message));
    }
    const active = document.querySelector('.tab-content.active');
    if (active && active.id === 'tab-dashboard') {
      try { await renderDashboard(); } catch { /* 忽略 */ }
    }
    showToast('行情与净值已更新，盈亏已重新计算', 'success');
  } catch (err) {
    showToast('刷新失败: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

/** 核心刷新逻辑 */
async function refreshAllData(showProgress = false) {
  // PO-4：刷新前先做一次会话级跨域连通探测（开关关闭时直接判定跳过）
  await probeCorsReachable().catch(() => {});

  const watchlist = await Watchlist.getAll();
  if (watchlist.length === 0) {
    if (showProgress) showToast('请先在「设置」中添加自选基金', 'info');
    return;
  }

  const codes = watchlist.map(f => f.code);

  if (showProgress) {
    showToast(`正在获取 ${codes.length} 只基金行情数据...`, 'info');
  }

  // 1. 获取行情数据
  const marketData = await fetchAllFundData(codes, (completed, total) => {
    if (showProgress && completed === total) {
      showToast(`已完成 ${total} 只基金数据采集`, 'success');
    }
  });

  // 2. 获取指数估值
  const valuation = await getFundValuation('000300');
  for (const data of marketData) {
    if (data.valuationPercentile == null) {
      data.valuationPercentile = valuation.percentile;
    }
  }

  // 3. 更新估值分位到缓存
  for (const data of marketData) {
    if (data.valuationPercentile == null) {
      data.valuationPercentile = valuation.percentile;
    }
    if (!data.code) continue;
    await MarketCache.save({
      ...data,
      valuationPercentile: data.valuationPercentile,
    });
  }

  // 4. 运行 AI 分析
  const { decisions, summary } = await runFullAnalysis();

  // 5. 保存结论（如果是在交易时段末尾或手动刷新）
  AppState.lastDecisions = decisions;

  // 5.5. 市场快照（供投资框架卡片使用）
  try {
    if (typeof FundAPI !== 'undefined' && FundAPI.fetchMarketContext) {
      const snap = await FundAPI.fetchMarketContext();
      localStorage.setItem('fundai_market_snapshot', JSON.stringify(snap));
    }
  } catch { /* 非关键路径 */ }

  // 6. 更新 UI
  const activeTab = document.querySelector('.tab-content.active');
  if (activeTab && activeTab.id === 'tab-dashboard') {
    await renderDashboard();
  }

  // 7. 更新刷新时间
  localStorage.setItem('fundai_last_update', String(Date.now()));
  await updateTopBar();

  return { decisions, summary, marketData };
}

// ==================== 收盘自动归档 ====================

async function dailyArchiveCheck() {
  const today = new Date().toISOString().slice(0, 10);
  const existingArchive = await AIDecisions.getByDate(today);

  // 如果今天还没有存档，且不是刚初始化，则在收盘后 15:30 左右自动保存
  if (existingArchive.length === 0 && AppState.lastDecisions && AppState.lastDecisions.length > 0) {
    await archiveDecisions(AppState.lastDecisions);
    console.log('[App] Daily AI decisions archived for', today);
  }
}

// ==================== DeepSeek 深度咨询 ====================

/**
 * 触发深度咨询（由基金卡片上的按钮调用）
 * 仅在用户手动点击时执行，自动刷新/概率计算等逻辑完全不会触发
 */
async function triggerConsultation(code) {
  // 1. 检查 API 配置
  if (!DeepSeekConfig.isReady()) {
    showToast('请先在「设置 → DeepSeek API」中配置 API Key', 'error');
    // 自动跳转到设置页
    switchTab('settings');
    return;
  }

  // 2. 限流检查（前端快速拦截，避免不必要的异步操作）
  const rateCheck = checkRateLimit(code);
  if (!rateCheck.allowed) {
    const mins = Math.floor(rateCheck.remainingSeconds / 60);
    const secs = rateCheck.remainingSeconds % 60;
    const waitText = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
    showToast(`该基金 ${waitText} 后才能再次咨询`, 'warning');
    return;
  }

  // 3. 获取基金名称用于加载弹窗
  let fundName = code;
  try {
    const fund = await Watchlist.get(code);
    if (fund && fund.name) fundName = fund.name;
    else {
      const market = await MarketCache.get(code);
      if (market && market.name) fundName = market.name;
    }
  } catch { /* 使用代码 */ }

  // 4. 显示加载弹窗
  const loadingOverlay = showConsultLoading(fundName);

  // 5. 执行 API 调用
  let result;
  try {
    result = await startDeepConsultation(code);

    // 附加上本地决策数据用于弹窗对比展示
    if (result.success) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayDecisions = await AIDecisions.getByDate(todayStr);
      const localDecision = todayDecisions.find(d => d.code === code);
      if (localDecision) {
        result._localDecision = {
          buyPct: localDecision.buyPct,
          holdPct: localDecision.holdPct,
          sellPct: localDecision.sellPct,
        };
      }
    }
  } catch (err) {
    result = { success: false, error: err.message, code: 'exception' };
  }

  // 6. 移除加载弹窗
  loadingOverlay.remove();

  // 7. 显示结果弹窗
  showConsultPopup(result);

  // 8. 如果成功，显示轻量提示
  if (result.success) {
    const ts = result.totalTokens || result.tokens || 0;
    showToast(`DeepSeek: ${result.result}（消耗 ${ts} tokens）`, 'info');
  }
}

/** 保存 DeepSeek API 配置 */
function saveDeepSeekConfig() {
  const apiKey = document.getElementById('ds-api-key')?.value?.trim() || '';
  const model = document.getElementById('ds-model')?.value || 'deepseek-chat';
  const timeout = parseInt(document.getElementById('ds-timeout')?.value) || 15000;
  const maxTokens = parseInt(document.getElementById('ds-max-tokens')?.value) || 200;

  if (apiKey && !apiKey.startsWith('sk-')) {
    showToast('API Key 格式可能不正确（应以 sk- 开头），请检查', 'warning');
    // 不阻止保存，因为可能有其他格式
  }

  DeepSeekConfig.save({ apiKey, model, timeout, maxTokens });

  if (apiKey) {
    showToast('DeepSeek API 配置已保存 ✅ 可在持仓看板点击「咨询」按钮使用', 'success');
  } else {
    showToast('API Key 已清除，深度咨询功能将不可用', 'info');
  }

  // 重新渲染设置页（更新 token 统计等）
  renderSettingsTab();
}

/** 清除 DeepSeek 配置 */
function clearDeepSeekConfig() {
  if (!confirm('确认清除 DeepSeek API 配置？这将删除 API Key 和所有 token 日志。')) return;

  DeepSeekConfig.reset();
  TokenLog.clear();
  showToast('DeepSeek 配置和 token 日志已清除', 'info');
  renderSettingsTab();
}

/** 导出 Token 日志 CSV */
function exportTokenLog() {
  const csv = TokenLog.exportCSV();
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deepseek-token-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Token 日志已导出', 'success');
}

/** 清空 Token 日志 */
function clearTokenLog() {
  if (!confirm('确认清空所有 Token 消耗日志？此操作不可恢复。')) return;
  TokenLog.clear();
  showToast('Token 日志已清空', 'info');
  renderSettingsTab();
}

// ==================== 全局操作函数（供 HTML onclick 调用） ====================

/** 保存月度预算 */
async function saveBudget() {
  const totalEl = document.getElementById('budget-total');
  const pctEl = document.getElementById('budget-daily-pct');

  const total = parseFloat(totalEl?.value) || 0;
  const pct = parseFloat(pctEl?.value) || 30;

  if (total <= 0) {
    showToast('请输入有效的月度总金额', 'error');
    return;
  }

  await BudgetManager.setMonthlyBudget(total, pct);
  showToast(`月度预算已更新: ${formatMoney(total)} (单日上限 ${pct}%)`, 'success');
  await renderBudgetTab();
}

/** 提交操作记录 */
async function submitRecord() {
  const code = document.getElementById('record-code')?.value;
  if (!code) {
    showToast('请选择基金', 'error');
    return;
  }

  const record = {
    date: new Date().toISOString().slice(0, 10),
    code,
    opType: document.getElementById('record-type')?.value || 'none',
    amount: parseFloat(document.getElementById('record-amount')?.value) || 0,
    shares: parseFloat(document.getElementById('record-shares')?.value) || 0,
    dailyProfit: parseFloat(document.getElementById('record-daily-profit')?.value) || 0,
    fundProfit: parseFloat(document.getElementById('record-fund-profit')?.value) || 0,
    notes: document.getElementById('record-notes')?.value || '',
  };

  // 如果是加仓操作，记录消耗
  if ((record.opType === 'buy' || record.opType === 'auto') && record.amount > 0) {
    await BudgetManager.recordUsage(record.amount);
  }

  await Operations.addRecord(record);

  // P1-1：以台账为唯一真实源头，自动重算该基金持仓（份额/加权成本/累计投入）
  await rebuildPositionFromLog(record.code).catch(err => console.warn('[Pos] 重算失败:', err && err.message));

  showToast('操作记录已保存，持仓与盈亏已同步', 'success');
  await renderRecordTab();
  // 录入后自动重算全部盈亏、概率色块
  const _act = document.querySelector('.tab-content.active');
  if (_act && _act.id === 'tab-dashboard') { try { await renderDashboard(); } catch { /* 忽略 */ } }
}

/**
 * P1-1：由操作台账全量重算某基金持仓（唯一真实源头）
 * 加仓/定投累加份额与投入；减仓按比例扣减投入；清仓则移除持仓。加权平均成本 = 累计投入 / 持有份额。
 */
async function rebuildPositionFromLog(code) {
  if (!code) return;
  const records = await OperationLog.getByCode(code).catch(() => []);
  records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));

  let shares = 0, invested = 0;
  for (const r of records) {
    const s = parseFloat(r.shares) || 0;
    const amt = parseFloat(r.amount) || 0;
    if (r.opType === 'buy' || r.opType === 'auto') {
      shares += s;
      invested += amt;
    } else if (r.opType === 'sell') {
      if (shares > 0 && s > 0) {
        const frac = Math.min(1, s / shares);
        invested = invested * (1 - frac);
      }
      shares -= s;
      if (shares < 0) shares = 0;
    }
  }

  if (shares > 0) {
    const costPrice = invested > 0 ? invested / shares : 0;
    await Positions.save({
      code,
      shares: Math.round(shares * 10000) / 10000,
      costPrice: Math.round(costPrice * 10000) / 10000,
      totalInvested: Math.round(invested * 100) / 100,
    });
  } else {
    // 已清仓：移除持仓记录
    await Positions.remove(code).catch(() => {});
  }
}

/** 清空录入表单 */
function clearRecordForm() {
  const ids = ['record-code', 'record-type', 'record-amount', 'record-shares',
               'record-daily-profit', 'record-fund-profit', 'record-notes'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (el.tagName === 'SELECT') el.selectedIndex = 0;
      else el.value = '';
    }
  });
}

/** 查询台账 */
async function queryHistory() {
  const start = document.getElementById('filter-start')?.value || '';
  const end = document.getElementById('filter-end')?.value || '';
  const code = document.getElementById('filter-code')?.value || '';
  const opType = document.getElementById('filter-type')?.value || '';

  const records = await Operations.query({ startDate: start, endDate: end, code, opType });
  const watchlist = await Watchlist.getAll();

  const container = document.getElementById('history-table-container');
  if (container) {
    if (records.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">暂无匹配记录</div>';
    } else {
      container.innerHTML = renderRecordTable(records, watchlist);
    }
  }
}

/** 执行复盘 */
async function runReview() {
  const lookbackDays = 90;
  await renderReviewResults(lookbackDays);
}

/** 添加基金 */
async function addFunds() {
  const codeInput = document.getElementById('add-fund-code')?.value?.trim();
  const nameInput = document.getElementById('add-fund-name')?.value?.trim();
  const batchInput = document.getElementById('add-fund-batch')?.value?.trim();

  const codes = [];

  // 单个代码
  if (codeInput && /^\d{6}$/.test(codeInput)) {
    codes.push(codeInput);
  }

  // 批量
  if (batchInput) {
    const batchCodes = batchInput.split(/[,\n\s]+/).filter(c => /^\d{6}$/.test(c));
    codes.push(...batchCodes);
  }

  // 去重
  const uniqueCodes = [...new Set(codes)];

  if (uniqueCodes.length === 0) {
    showToast('请输入有效的6位基金代码', 'error');
    return;
  }

  // 检查已有
  const existing = await Watchlist.getAll();
  const existingCodes = new Set(existing.map(f => f.code));
  const newCodes = uniqueCodes.filter(c => !existingCodes.has(c));

  if (newCodes.length === 0) {
    showToast('所有基金已在自选清单中', 'info');
    return;
  }

  // 尝试获取基金名称（优先使用已缓存的查询结果）
  const toAdd = [];
  for (const code of newCodes) {
    let name = nameInput || '';

    // 优先从缓存中获取名称（由实时查询填充）
    if (!name) {
      const cached = getCachedName(code);
      if (cached && cached.name) {
        name = cached.name;
        console.log(`[App] 📦 使用缓存名称: ${code} → ${name}`);
      }
    }

    // 缓存未命中时，尝试实时查询
    if (!name) {
      try {
        console.log(`[App] 🔍 缓存未命中，实时查询: ${code}`);
        const result = await lookupFundName(code);
        if (result && result.name) {
          name = result.name;
        }
      } catch (err) {
        console.warn(`[App] ⚠️ 实时查询失败: ${code}`, err.message);
      }
    }

    toAdd.push({ code, name: name || code });
  }

  await Watchlist.addAll(toAdd);
  showToast(`成功添加 ${toAdd.length} 只基金`, 'success');

  // 关闭弹窗
  const overlay = document.querySelector('.modal-overlay');
  if (overlay) overlay.remove();

  // 刷新设置页
  await renderSettingsTab();
}

/** 编辑持仓（从设置页点击） */
async function editFundPosition(code) {
  await showPositionModal(code);
}

/** 保存持仓 */
async function savePosition(code) {
  const shares = parseFloat(document.getElementById('pos-shares')?.value) || 0;
  const costPrice = parseFloat(document.getElementById('pos-cost')?.value) || 0;
  const totalInvested = parseFloat(document.getElementById('pos-invested')?.value) || 0;

  if (shares <= 0 || costPrice <= 0) {
    showToast('请填写有效的份额和成本价', 'error');
    return;
  }

  await Positions.save({ code, shares, costPrice, totalInvested });
  showToast('持仓数据已保存', 'success');

  // 关闭弹窗
  const overlay = document.querySelector('.modal-overlay');
  if (overlay) overlay.remove();

  await renderSettingsTab();
}

/** 移除自选基金 */
async function removeFund(code) {
  if (!confirm(`确认移除基金 ${code}? 相关持仓数据不会被删除。`)) return;

  await Watchlist.remove(code);
  showToast(`已移除基金 ${code}`, 'info');
  await renderSettingsTab();
}

/** 删除操作记录 */
async function deleteOpRecord(id) {
  if (!confirm('确认删除此条操作记录?')) return;

  // P1-1：删除前取出该记录的基金代码，删后重算持仓（台账为唯一真实源头）
  let code = '';
  try { const rec = await getOne('operationLog', id); code = rec ? rec.code : ''; } catch { /* 忽略 */ }

  await Operations.deleteRecord(id);
  if (code) await rebuildPositionFromLog(code).catch(err => console.warn('[Pos] 重算失败:', err && err.message));
  showToast('记录已删除，持仓与盈亏已同步', 'info');

  // 刷新当前显示的 Tab
  const activeTab = document.querySelector('.tab-content.active');
  if (activeTab) {
    if (activeTab.id === 'tab-record') await renderRecordTab();
    else if (activeTab.id === 'tab-history') await queryHistory();
    else if (activeTab.id === 'tab-dashboard') { try { await renderDashboard(); } catch { /* 忽略 */ } }
  }
}

/** 保存设置 */
function saveSettings() {
  const settings = {
    refreshIntervalTrading: parseInt(document.getElementById('setting-refresh-trading')?.value) || 30,
    refreshIntervalOff: parseInt(document.getElementById('setting-refresh-off')?.value) || 120,
    maxDailyBudgetPct: parseInt(document.getElementById('setting-max-daily-pct')?.value) || 30,
    notificationThreshold: parseInt(document.getElementById('setting-notify-threshold')?.value) || 80,
    notificationEnabled: document.getElementById('setting-notify-enabled')?.checked ?? true,
  };

  AppSettings.save(settings);
  showToast('设置已保存', 'success');

  // 重新调整定时器
  scheduleAutoRefresh();
}

/** 重置设置 */
function resetSettings() {
  if (!confirm('确认恢复默认设置?')) return;
  AppSettings.reset();
  showToast('已恢复默认设置', 'info');
  renderSettingsTab();
}

// ==================== 数据导入导出 ====================

async function exportAllData() {
  try {
    let data;

    // 从 IndexedDB 导出
    data = {
      version: 3,
      exportedAt: new Date().toISOString(),
      watchlist: await Watchlist.getAll().catch(() => []),
      positions: await Positions.getAll().catch(() => []),
      marketCache: await MarketCache.getAll().catch(() => []),
      aiDecisions: await AIDecisions.getAll().catch(() => []),
      monthlyBudget: await MonthlyBudget.getAll().catch(() => []),
      operationLog: await OperationLog.getAll().catch(() => []),
      settings: AppSettings.get(),
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fundai-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('数据导出成功', 'success');
  } catch (err) {
    showToast('导出失败: ' + err.message, 'error');
  }
}

function importDataPrompt() {
  document.getElementById('import-file-input')?.click();
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.version) {
      throw new Error('无效的备份文件格式');
    }

    // 统计信息
    const fundCount = data.fund_list?.length || data.watchlist?.length || 0;
    const opCount = data.daily_operation_record?.length || data.operationLog?.length || 0;
    const aiCount = data.ai_calc_log?.length || data.aiDecisions?.length || 0;

    if (!confirm(
      `即将导入备份数据:\n` +
      `- 基金: ${fundCount} 只\n` +
      `- 操作记录: ${opCount} 条\n` +
      `- AI 结论: ${aiCount} 条\n\n` +
      `当前数据将被覆盖，确认导入？`
    )) return;

    // 导入到 IndexedDB 本地存储
    await importToLocalStorage(data);

    showToast('数据导入成功', 'success');
    await initApp();
    await renderDashboard();
  } catch (err) {
    showToast('导入失败: ' + err.message, 'error');
  }

  event.target.value = '';
}

/** 降级导入到浏览器本地存储 */
async function importToLocalStorage(data) {
  if (data.watchlist) await Watchlist.addAll(data.watchlist).catch(() => {});
  if (data.positions) await Positions.saveAll(data.positions).catch(() => {});
  if (data.marketCache) await MarketCache.saveAll(data.marketCache).catch(() => {});
  if (data.aiDecisions) {
    try { await AIDecisions.saveAll(data.aiDecisions); } catch {}
  }
  if (data.monthlyBudget) {
    for (const b of data.monthlyBudget) {
      try { await MonthlyBudget.save(b); } catch {}
    }
  }
  if (data.operationLog) {
    try { await OperationLog.addAll(data.operationLog); } catch {}
  }
  if (data.settings) AppSettings.save(data.settings);
  console.log('[App] 📤 数据导入到浏览器本地存储完成');
}

/** 清空全部数据 */
async function clearAllData() {
  if (!confirm('⚠️ 确认清空全部本地数据？此操作不可恢复！\n\n建议先导出数据备份。')) return;
  if (!confirm('再次确认：清空所有自选基金、持仓、行情、AI结论、月度资金、操作台账？')) return;

  try {
    const stores = ['watchlist', 'positions', 'marketCache', 'aiDecisions', 'monthlyBudget', 'operationLog'];
    for (const store of stores) {
      await clearStore(store);
    }
    localStorage.removeItem('fundai_settings');
    localStorage.removeItem('fundai_last_update');

    showToast('全部数据已清空', 'info');
    AppState.lastDecisions = null;
    await renderDashboard();
    await renderSettingsTab();
  } catch (err) {
    showToast('清空失败: ' + err.message, 'error');
  }
}

// ==================== 启动 ====================

document.addEventListener('DOMContentLoaded', () => {
  initApp().catch(err => {
    console.error('[App] Fatal initialization error:', err);
  });
});

// ==================== 目标持仓配置 ====================

/** 保存全部目标配置 */
function saveAllocations() {
  const inputs = document.querySelectorAll('.allocation-pct');
  const allocs = [];
  for (const inp of inputs) {
    const pct = Math.max(0, Math.min(100, parseInt(inp.value) || 0));
    allocs.push({ code: inp.dataset.code, targetPct: pct });
  }
  Watchlist.getAll().then(w => {
    const nameMap = new Map(w.map(f => [f.code, f.name]));
    const withNames = allocs.map(a => ({ ...a, name: nameMap.get(a.code) || a.code }));
    AppSettings.save({ fundAllocations: withNames });
    showToast('目标配置已保存 ✅', 'success');
    if (typeof renderAllocationEditor === 'function') renderAllocationEditor(w);
  }).catch(() => showToast('保存失败', 'error'));
}

/** 重置为默认 6 只基金配置骨架 */
function resetAllocations() {
  const defaults = [
    { code: '019155', name: '易方达全球配置混合(QDII)A', targetPct: 15 },
    { code: '000834', name: '大成纳斯达克100ETF联接(QDII)A', targetPct: 15 },
    { code: '016664', name: '天弘全球高端制造混合(QDII)A', targetPct: 10 },
    { code: '021561', name: '天弘中证央企红利50指数A', targetPct: 30 },
    { code: '018345', name: '华夏中证机器人ETF联接C', targetPct: 15 },
    { code: '000307', name: '易方达黄金ETF联接A', targetPct: 15 },
  ];
  AppSettings.save({ fundAllocations: defaults });
  showToast('已重置为默认 5 只基金配置，请填入实际代码', 'info');
  Watchlist.getAll().then(w => { if (typeof renderAllocationEditor === 'function') renderAllocationEditor(w); }).catch(() => {});
}

// 页面关闭前：如果当天有未归档的 AI 结论，自动保存
window.addEventListener('beforeunload', async () => {
  await dailyArchiveCheck();
});

// 页面恢复可见时：仅更新顶栏状态，不触发全量数据刷新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    updateTopBar();
  }
});

