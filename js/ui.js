/**
 * UI 渲染层 — 所有页面渲染、更新、通知
 */

const UI = {
  _toastTimer: null,
  _notificationGranted: false,
  _renderGen: 0,          // 渲染代际计数：每次切换标签自增，旧读取结果失效即被丢弃
  _tabTimeoutTimer: null, // 全局 10 秒加载超时计时器
};

// ==================== IndexedDB 读取容错工具 ====================

/**
 * 竞速读取：DB 读取 Promise 与超时赛跑，任何异常/超时都降级为兜底值，绝不抛出。
 * @param {Promise} promise    IndexedDB 读取 Promise
 * @param {number}  ms         超时毫秒
 * @param {Function} fallbackFn 兜底函数，返回降级数据（通常读 LocalStorage）
 */
function readWithTimeout(promise, ms, fallbackFn) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } };
    const timer = setTimeout(() => {
      if (settled) return;
      console.warn('[Settings] ⏱ IndexedDB 读取超时，启用缓存兜底');
      let fb; try { fb = fallbackFn ? fallbackFn() : null; } catch { fb = null; }
      finish(fb);
    }, ms);
    Promise.resolve(promise)
      .then(v => finish(v))
      .catch(err => {
        console.warn('[Settings] ⚠ IndexedDB 读取失败，启用缓存兜底:', err && err.message);
        if (err && err.stack) console.warn(err.stack);
        let fb; try { fb = fallbackFn ? fallbackFn() : null; } catch { fb = null; }
        finish(fb);
      });
  });
}

/** 从 LocalStorage 双备份读取列表数据（IndexedDB 异常时的兜底） */
function readBackupList(key) {
  try {
    const raw = localStorage.getItem('fundai_' + key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 强制清除当前激活标签内残留的「正在加载…」占位，保证页面可操作 */
function forceClearActiveTabLoading() {
  const active = document.querySelector('.tab-content.active');
  if (!active) return;
  if (/正在加载/.test(active.innerHTML)) {
    active.innerHTML = `
      <div class="card" style="text-align:center;padding:40px;color:var(--text-muted);">
        <div style="font-size:1.6rem;margin-bottom:10px;">⚠️</div>
        <div>数据加载超时，部分内容可能未加载完整</div>
        <div style="margin-top:14px;">
          <button class="btn btn--sm" onclick="switchTab('${active.id.replace('tab-','')}')">重试加载</button>
        </div>
      </div>`;
  }
}


// ==================== 初始化 ====================

/** 请求桌面通知权限 */
function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    UI._notificationGranted = true;
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => {
      UI._notificationGranted = p === 'granted';
    });
  }
}

/** 发送桌面通知 */
function sendDesktopNotification(title, body) {
  const settings = AppSettings.get();
  if (!settings.notificationEnabled || !UI._notificationGranted) return;

  try {
    new Notification(title, {
      body,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="24" font-size="28">📈</text></svg>',
      tag: 'fundai-decision',
      requireInteraction: false,
    });
  } catch { /* 静默失败 */ }
}

// ==================== Toast 消息 ====================

function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ==================== Tab 切换 ====================

function switchTab(tabName) {
  document.querySelectorAll('.tab-nav__item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));

  const tabBtn = document.querySelector(`[data-tab="${tabName}"]`);
  const tabPanel = document.getElementById(`tab-${tabName}`);
  if (tabBtn) tabBtn.classList.add('active');
  if (tabPanel) tabPanel.classList.add('active');

  // 代际自增：上一标签未完成的 IndexedDB 读取结果将因代际失效而被丢弃，
  // 避免并发读取回填到已切走的页面、造成阻塞与错乱。
  UI._renderGen++;
  const gen = UI._renderGen;

  // 记录激活标签 → 非激活标签暂停后台轮询（减少 IndexedDB 并发读写冲突）
  if (typeof AppState !== 'undefined') {
    AppState.activeTab = tabName;
    // 切到设置页：暂停行情同步，优先执行配置读取；离开设置页则恢复
    AppState.suspendMarketSync = (tabName === 'settings');
  }

  // 全局 10 秒加载超时兜底：无论渲染成功/失败/卡住，超时后强制解除加载态并提示
  if (UI._tabTimeoutTimer) clearTimeout(UI._tabTimeoutTimer);
  UI._tabTimeoutTimer = setTimeout(() => {
    if (gen !== UI._renderGen) return; // 已切到其它标签，忽略
    console.warn('[Tab] ⏱ 加载超时:', tabName);
    forceClearActiveTabLoading();
    showToast('数据加载超时，部分配置可能未加载完整', 'warning');
  }, 10000);

  const clearTimer = () => {
    if (gen === UI._renderGen && UI._tabTimeoutTimer) {
      clearTimeout(UI._tabTimeoutTimer);
      UI._tabTimeoutTimer = null;
    }
  };

  // 切换时渲染对应 Tab；任何渲染异常都被捕获，绝不阻断页面
  let task;
  try {
    switch (tabName) {
      case 'dashboard': task = renderDashboard(); break;
      case 'budget': task = renderBudgetTab(); break;
      case 'record': task = renderRecordTab(); break;
      case 'history': task = renderHistoryTab(); break;
      case 'settings': task = renderSettingsTab(); break;
    }
  } catch (err) {
    console.warn('[Tab] 渲染同步异常:', tabName, err && err.message);
    forceClearActiveTabLoading();
  }

  Promise.resolve(task)
    .catch(err => {
      console.warn('[Tab] 渲染异步异常:', tabName, err && err.message);
      forceClearActiveTabLoading();
      showToast('页面加载出现问题，已启用兜底显示', 'warning');
    })
    .finally(clearTimer);
}

// ==================== 收盘前建议卡片 ====================

/**
 * @param {Object|null} apiAdvice - 从后端 /api/preclose 获取的建议（可选）
 */
function buildPreCloseCard(apiAdvice) {
  // 非交易日不显示
  if (typeof isTradingDate === 'function' && !isTradingDate(new Date().toISOString().slice(0, 10))) return '';

  // 读取建议：优先用后端 API 数据，其次 localStorage
  let advice = apiAdvice || null;
  if (!advice) {
    try {
      const raw = localStorage.getItem('fundai_preclose_advice');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.date === new Date().toISOString().slice(0, 10)) {
          advice = parsed;
        }
      }
    } catch { /* 忽略 */ }
  }

  // 14:30 之前 — 占位提示
  const now = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const beforePreclose = totalMin < 14 * 60 + 30;

  if (!advice && beforePreclose) {
    return `
      <div class="card preclose-card" style="margin-bottom:16px;opacity:0.7;">
        <div class="card__header">
          <span class="card__title">⏰ 收盘前建议</span>
          <span style="font-size:0.78rem;color:var(--text-muted);">14:30 更新</span>
        </div>
        <div style="padding:12px;text-align:center;color:var(--text-muted);font-size:0.85rem;">
          ⏳ 等待收盘前分析… 系统将在 14:30 自动调用 AI 生成今日操作建议
        </div>
      </div>`;
  }

  if (!advice || !advice.funds || !advice.funds.length) {
    // 过了 14:30 但无数据 — 可能是今天没触发或 API 失败
    return '';
  }

  // 建议卡片
  const adviceClass = (a) => {
    if (a.includes('大幅加仓') || a.includes('适度加仓')) return 'prob-badge buy';
    if (a.includes('小幅加仓')) return 'prob-badge buy';
    if (a.includes('大幅减仓') || a.includes('适度减仓')) return 'prob-badge sell';
    if (a.includes('小幅减仓')) return 'prob-badge sell';
    return 'prob-badge hold';
  };

  const rowsHTML = advice.funds.map(f => {
    const changeClass = f.changePct >= 0 ? 'pnl-up' : 'pnl-down';
    const changeSign = f.changePct >= 0 ? '+' : '';
    return `
      <div class="preclose-fund-row" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-color);">
        <span style="flex:1;font-size:0.85rem;">${f.name}</span>
        <span class="${changeClass}" style="font-family:var(--font-mono);font-size:0.82rem;min-width:60px;text-align:right;">${changeSign}${f.changePct.toFixed(2)}%</span>
        <span class="${adviceClass(f.advice)}" style="min-width:72px;text-align:center;">${f.advice}</span>
      </div>`;
  }).join('');

  const summaryHTML = advice.summary
    ? `<div style="margin-top:8px;padding:8px 12px;background:var(--bg-input);border-radius:6px;font-size:0.82rem;color:var(--text-secondary);">📌 ${advice.summary}</div>`
    : '';

  const statusIcon = advice.hasActionableAdvice ? '🔔' : '✅';
  const statusText = advice.hasActionableAdvice ? '有操作建议' : '无需操作';
  const statusColor = advice.hasActionableAdvice ? 'var(--accent-yellow)' : 'var(--accent-green)';

  return `
    <div class="card preclose-card" style="margin-bottom:16px;border-left:3px solid ${statusColor};">
      <div class="card__header">
        <span class="card__title">⏰ 收盘前建议</span>
        <span style="font-size:0.78rem;color:${statusColor};font-weight:600;">${statusIcon} ${statusText}</span>
      </div>
      <div style="padding:0 4px;">
        ${rowsHTML}
      </div>
      ${summaryHTML}
      <div style="margin-top:6px;font-size:0.72rem;color:var(--text-muted);text-align:right;">
        DeepSeek · ${advice.tokens || 0} tokens · ${new Date(advice.timestamp).toLocaleTimeString('zh-CN')}
      </div>
    </div>`;
}

// ==================== 投资框架看板 ====================

/**
 * 四层投资框架 — 基于实时市场数据 + 持仓偏离
 * ① 宏观仓位开关 → ② 风格轮动 → ③ 基金体检 → ④ 风险控制
 */
function buildFrameworkCard(pnlCtx) {
  const settings = AppSettings.get();
  const allocs = settings.fundAllocations || [];
  if (!allocs.length) return ''; // 无目标配置时不显示

  // ── 数据采集 ──
  const port = pnlCtx.portfolio;
  const map = pnlCtx.map;
  const totalValue = port.marketValue || 0;

  // ── 市场温度（0-100）──
  // 从 localStorage 读取上一轮市场快照（由 preclose 或手动刷新时存入）
  let mktCtx = null;
  try { const raw = localStorage.getItem('fundai_market_snapshot'); if (raw) mktCtx = JSON.parse(raw); } catch {}

  let tempScore = 50; // 默认中性
  const dims = { flow: 50, trend: 50, breadth: 50, valuation: 50 };

  if (mktCtx) {
    // 北向资金 → 0-25 分
    const nb = mktCtx.northBound;
    if (nb) {
      if (nb.trend === 'inflow') dims.flow = nb.todayNet > 30 ? 25 : 20;
      else if (nb.trend === 'outflow') dims.flow = nb.todayNet < -30 ? 5 : 10;
      else dims.flow = 13;
    }

    // 沪深300趋势 → 0-25 分
    const bm = mktCtx.benchmark;
    if (bm) {
      if (bm.changePct > 1 && bm.volumeRatio > 1.2) dims.trend = 25;      // 放量上涨
      else if (bm.changePct > 0) dims.trend = 18;                          // 缩量上涨
      else if (bm.changePct < -1 && bm.volumeRatio > 1.2) dims.trend = 5;  // 放量下跌
      else if (bm.changePct < 0) dims.trend = 10;                          // 缩量下跌
      else dims.trend = 13;
    }

    // 市场情绪 → 0-25 分
    const br = mktCtx.breadth;
    if (br) {
      if (br.sentiment === 'greedy') dims.breadth = 22;
      else if (br.sentiment === 'fearful') dims.breadth = 5;
      else dims.breadth = 13;
    }

    // 估值分位 → 0-25 分（分位越低越便宜，分越高）
    // 需要从行情缓存中取沪深300 估值分位
    try {
      const cached = mktCtx._indexPE;
      if (cached && cached.pePercentile != null) {
        const p = cached.pePercentile;
        if (p <= 10) dims.valuation = 25;
        else if (p <= 25) dims.valuation = 20;
        else if (p <= 50) dims.valuation = 15;
        else if (p <= 75) dims.valuation = 10;
        else dims.valuation = 5;
      }
    } catch {}
  }

  tempScore = dims.flow + dims.trend + dims.breadth + dims.valuation;

  // ── 第①层：温度 → 仓位 ──
  let tempLabel, tempColor, positionAdvice, positionRange;
  if (tempScore >= 70) {
    tempLabel = '进攻'; tempColor = 'var(--accent-green)';
    positionAdvice = '积极配置 · QDII 可加码'; positionRange = '60-70%';
  } else if (tempScore >= 45) {
    tempLabel = '中性'; tempColor = 'var(--accent-yellow)';
    positionAdvice = '按计划定投 · 维持比例'; positionRange = '40-55%';
  } else if (tempScore >= 25) {
    tempLabel = '防守'; tempColor = 'var(--accent-red)';
    positionAdvice = '增配红利+黄金 · 减配 QDII'; positionRange = '25-40%';
  } else {
    tempLabel = '观望'; tempColor = '#f87171';
    positionAdvice = '暂停定投 · 持有现金'; positionRange = '10-25%';
  }

  // ── 第②层：风格轮动 ──
  let styleLabel, styleAdvice;
  const st = mktCtx && mktCtx.sector;
  if (st && st.style === 'growth') {
    styleLabel = '成长占优';
    styleAdvice = '机器人+纳指定投金额 ×1.2，红利 ×0.8';
  } else if (st && st.style === 'value') {
    styleLabel = '价值占优';
    styleAdvice = '红利益定投金额 ×1.2，机器人+纳指 ×0.8';
  } else {
    styleLabel = '风格均衡';
    styleAdvice = '按原计划比例定投，不调整';
  }

  // ── 第③层：基金体检状态 ──
  // 检查项：是否有基金规模暴增、基金经理变更等（简化版：检查偏离度 + 估值异常）
  let healthIssues = [];
  for (const alloc of allocs) {
    const pnl = map.get(alloc.code);
    if (!pnl || !pnl.hasPosition) continue;
    const actualPct = totalValue > 0 ? (pnl.marketValue / totalValue) * 100 : 0;
    const dev = actualPct - (alloc.targetPct || 0);
    if (Math.abs(dev) >= 10) healthIssues.push(`${alloc.name || alloc.code} 偏离 ${dev >= 0 ? '+' : ''}${dev.toFixed(0)}%`);
  }
  const healthStatus = healthIssues.length === 0
    ? { label: '全部正常', color: 'var(--accent-green)', text: '✅ 所有基金仓位在目标范围内' }
    : { label: `${healthIssues.length} 只异常`, color: 'var(--accent-yellow)', text: `⚠ ${healthIssues.join('、')}` };

  // ── 第④层：风险控制 ──
  const allocArr = allocs.filter(a => a.targetPct > 0);
  let riskIssues = [];
  // 检查总仓位是否超过建议范围
  const totalPosPct = totalValue > 0 ? Math.round(totalValue / (totalValue + (port._cashEstimate || 0) + 1) * 100) : 0;
  // 检查是否有目标占比合计 != 100%
  const targetSum = allocArr.reduce((s, a) => s + (a.targetPct || 0), 0);
  if (Math.abs(targetSum - 100) > 1) riskIssues.push(`目标占比合计 ${targetSum}% ≠ 100%`);
  // 偏离检查
  const badDeviations = [];
  for (const alloc of allocArr) {
    const pnl = map.get(alloc.code);
    if (!pnl || !pnl.hasPosition) { badDeviations.push(`${alloc.name || alloc.code} 未建仓`); continue; }
    const actualPct = totalValue > 0 ? (pnl.marketValue / totalValue) * 100 : 0;
    if (Math.abs(actualPct - alloc.targetPct) >= 5) {
      badDeviations.push(`${alloc.name || alloc.code} 偏离${(actualPct - alloc.targetPct) >= 0 ? '+' : ''}${(actualPct - alloc.targetPct).toFixed(0)}%`);
    }
  }
  if (badDeviations.length) riskIssues.push(...badDeviations);

  const riskStatus = riskIssues.length === 0
    ? { label: '风险可控', color: 'var(--accent-green)', text: '✅ 所有监控指标正常' }
    : { label: `${riskIssues.length} 项风险`, color: 'var(--accent-red)', text: '⚠ ' + riskIssues.slice(0, 3).join(' · ') + (riskIssues.length > 3 ? ' …' : '') };

  // ── 渲染 ──
  return `
    <div class="card" style="margin-bottom:16px;border-left:3px solid ${tempColor};">
      <div class="card__header">
        <span class="card__title">🧠 投资框架</span>
        <span style="font-size:0.78rem;color:var(--text-muted);">四层决策体系</span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px;">
        <!-- ① 宏观仓位 -->
        <div style="background:var(--bg-input);border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;">① 宏观仓位</div>
          <div style="font-size:1.2rem;font-weight:700;color:${tempColor};margin-bottom:2px;">${tempLabel}</div>
          <div style="font-size:0.75rem;color:var(--text-secondary);">温度 ${tempScore}/100</div>
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">仓位 ${positionRange}</div>
        </div>
        <!-- ② 风格轮动 -->
        <div style="background:var(--bg-input);border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;">② 风格轮动</div>
          <div style="font-size:1.2rem;font-weight:700;color:var(--accent-blue);margin-bottom:2px;">${styleLabel}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">${st ? '创业板' + (st.growth.changePct >= 0 ? '+' : '') + st.growth.changePct.toFixed(1) + '% vs 上证50' + (st.value.changePct >= 0 ? '+' : '') + st.value.changePct.toFixed(1) + '%' : '数据暂缺'}</div>
        </div>
        <!-- ③ 基金体检 -->
        <div style="background:var(--bg-input);border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;">③ 基金体检</div>
          <div style="font-size:1.2rem;font-weight:700;color:${healthStatus.color};margin-bottom:2px;">${healthStatus.label}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">${healthStatus.text}</div>
        </div>
        <!-- ④ 风险控制 -->
        <div style="background:var(--bg-input);border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;">④ 风险控制</div>
          <div style="font-size:1.2rem;font-weight:700;color:${riskStatus.color};margin-bottom:2px;">${riskStatus.label}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">${riskStatus.text}</div>
        </div>
      </div>

      <!-- 触发动作 -->
      <div style="background:var(--bg-input);border-radius:8px;padding:10px 14px;font-size:0.82rem;">
        <div style="display:flex;align-items:flex-start;gap:8px;">
          <span style="color:var(--accent-yellow);flex-shrink:0;">⚡</span>
          <div>
            <strong>当前触发动作：</strong>
            <span style="color:var(--text-secondary);">
              仓位${positionRange} · ${positionAdvice} · ${styleAdvice}
            </span>
          </div>
        </div>
      </div>
    </div>`;
}

// ==================== 持仓偏离表 ====================

function buildDeviationTable(pnlCtx) {
  const settings = AppSettings.get();
  const allocations = (settings.fundAllocations || []).filter(a => a.targetPct > 0);
  if (!allocations.length) return '';

  const port = pnlCtx.portfolio;
  const totalValue = port.marketValue || 0;
  if (totalValue <= 0) return '';

  const map = pnlCtx.map;
  let rows = '';
  let warnCount = 0;

  for (const alloc of allocations) {
    const pnl = map.get(alloc.code);
    const marketValue = (pnl && pnl.marketValue) ? pnl.marketValue : 0;
    const actualPct = totalValue > 0 ? (marketValue / totalValue) * 100 : 0;
    const deviation = actualPct - (alloc.targetPct || 0);
    const absDev = Math.abs(deviation);

    const warnClass = absDev >= 10 ? 'rebalance-critical' : (absDev >= 5 ? 'rebalance-warn' : '');
    if (absDev >= 5) warnCount++;

    const tagHTML = absDev >= 10
      ? '<span class="deviation-tag critical">⚠ 大幅偏离</span>'
      : (absDev >= 5 ? '<span class="deviation-tag warn">⚡ 需再平衡</span>'
      : '<span style="color:var(--text-muted);font-size:0.78rem;">正常</span>');

    const devClass = deviation > 0.05 ? 'deviation-up' : (deviation < -0.05 ? 'deviation-down' : '');
    rows += `
      <tr class="${warnClass}">
        <td><strong>${alloc.name || alloc.code}</strong><br><span style="color:var(--text-muted);font-size:0.72rem;">${alloc.code || '—'}</span></td>
        <td style="font-family:var(--font-mono);">${formatMoney(marketValue)}</td>
        <td style="font-family:var(--font-mono);">${actualPct.toFixed(1)}%</td>
        <td class="align-target" style="font-family:var(--font-mono);">${alloc.targetPct}%</td>
        <td class="${devClass}" style="font-family:var(--font-mono);">${deviation >= 0 ? '+' : ''}${deviation.toFixed(1)}%</td>
        <td>${tagHTML}</td>
      </tr>`;
  }

  const summaryHint = warnCount > 0
    ? `<div style="margin-top:6px;font-size:0.78rem;color:var(--accent-yellow);">⚡ ${warnCount} 只基金偏离 ≥ 5%，建议在季度末执行再平衡</div>`
    : `<div style="margin-top:6px;font-size:0.78rem;color:var(--text-muted);">✅ 所有基金偏离均在 5% 以内，无需操作</div>`;

  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="card__header">
        <span class="card__title">🎯 持仓偏离表</span>
        <span style="font-size:0.78rem;color:var(--text-muted);">总市值 ${formatMoney(totalValue)}</span>
      </div>
      <div class="table-container">
        <table class="deviation-table">
          <thead>
            <tr>
              <th>基金</th>
              <th>当前市值</th>
              <th>实际占比</th>
              <th>目标占比</th>
              <th>偏离</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${summaryHint}
    </div>`;
}

// ==================== Tab 1: 持仓看板 ====================

async function renderDashboard() {
  const container = document.getElementById('tab-dashboard');
  if (!container) return;

  const { decisions, summary } = await runFullAnalysis();
  const budgetInfo = await BudgetManager.checkAvailability();
  const pnlCtx = await buildPnLContext().catch(() => ({
    map: new Map(),
    portfolio: { hasAnyPosition: false, hasAnyDaily: false, marketValue: 0, totalPnL: 0, totalPnLPct: 0, dailyPnL: 0, dailyPct: 0 },
  }));

  // 如果无数据
  if (!decisions || decisions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📋</div>
        <div class="empty-state__text">还没有添加自选基金</div>
        <p style="color:var(--text-muted);font-size:0.82rem;margin-bottom:16px;">前往「设置」页面添加自选基金清单</p>
        <button class="btn btn--primary" onclick="switchTab('settings')">前往设置</button>
      </div>`;
    return;
  }

  // 汇总卡片（4 张统计 + 右侧 2 张全局盈亏，共处一行）
  const port = pnlCtx.portfolio;

  const totalPnLCard = port.hasAnyPosition
    ? `<div class="summary-card">
         <div class="summary-card__value summary-card__value--pnl ${pnlColorClass(port.totalPnL)}">${fmtSignedMoney(port.totalPnL)}</div>
         <div class="summary-card__label">全仓总浮动盈亏 · <span class="${pnlColorClass(port.totalPnLPct)}">${fmtSignedPct(port.totalPnLPct)}</span></div>
       </div>`
    : `<div class="summary-card">
         <div class="summary-card__value summary-card__value--pnl pnl-flat">—</div>
         <div class="summary-card__label">全仓总浮动盈亏</div>
       </div>`;

  const dailyPnLCard = (port.hasAnyPosition && port.hasAnyDaily)
    ? `<div class="summary-card">
         <div class="summary-card__value summary-card__value--pnl ${pnlColorClass(port.dailyPnL)}">${fmtSignedMoney(port.dailyPnL)}</div>
         <div class="summary-card__label">全仓单日合计盈亏 · <span class="${pnlColorClass(port.dailyPct)}">${fmtSignedPct(port.dailyPct)}</span></div>
       </div>`
    : `<div class="summary-card">
         <div class="summary-card__value summary-card__value--pnl pnl-flat">—</div>
         <div class="summary-card__label">全仓单日合计盈亏${port.hasAnyPosition ? ' · 待收盘净值补齐' : ''}</div>
       </div>`;

  // 收盘前建议卡片：尝试从后端 API 获取（后端定时任务自动生成）
  let precloseAdvice = null;
  try {
    const apiResp = await apiFetch('/api/preclose');
    if (apiResp && apiResp.data) precloseAdvice = apiResp.data;
  } catch { /* 后端不可达时降级到 localStorage */ }
  const precloseHTML = buildPreCloseCard(precloseAdvice);

  // 投资框架看板
  const frameworkHTML = buildFrameworkCard(pnlCtx);

  let summaryHTML = `
    <div class="dashboard-summary">
      <div class="summary-card">
        <div class="summary-card__value blue">${summary.total}</div>
        <div class="summary-card__label">自选基金</div>
      </div>
      <div class="summary-card">
        <div class="summary-card__value green">${summary.buyCount}</div>
        <div class="summary-card__label">建议加仓</div>
      </div>
      <div class="summary-card">
        <div class="summary-card__value yellow">${summary.holdCount}</div>
        <div class="summary-card__label">保持不动</div>
      </div>
      <div class="summary-card">
        <div class="summary-card__value red">${summary.sellCount}</div>
        <div class="summary-card__label">建议减仓</div>
      </div>
      ${totalPnLCard}
      ${dailyPnLCard}
    </div>`;

  // 资金状态条
  if (budgetInfo.totalBudget > 0) {
    const usedPct = budgetInfo.totalBudget > 0
      ? Math.round((budgetInfo.usedAmount / budgetInfo.totalBudget) * 100) : 0;
    summaryHTML += `
      <div class="card" style="margin-bottom:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <span style="font-size:0.86rem;">💰 当月资金: 已用 <strong>${formatMoney(budgetInfo.usedAmount)}</strong> / <strong>${formatMoney(budgetInfo.totalBudget)}</strong></span>
          <span style="font-size:0.82rem;color:var(--text-secondary);">剩余 <strong style="color:var(--accent-green);">${formatMoney(budgetInfo.remaining)}</strong> · 今日可用上限 <strong style="color:var(--accent-blue);">${formatMoney(budgetInfo.dailyLimit)}</strong></span>
        </div>
        <div class="progress-bar">
          <div class="progress-bar__fill blue" style="width:${Math.min(100, usedPct)}%;"></div>
        </div>
      </div>`;
  }

  // 分配金额（如果有加仓建议）
  const { allocations, dailyTotal, remainingAfter } = await BudgetManager.allocateAmounts(decisions);

  // 基金行列表
  // 是否处于 A 股实时交易时段（交易日北京时间 9:30~15:00）——否则不显示"盘中估值"
  const _bjNow = new Date(Date.now() + 8 * 3600 * 1000);
  const _bjDate = _bjNow.toISOString().slice(0, 10);
  const _bjMin = _bjNow.getUTCHours() * 60 + _bjNow.getUTCMinutes();
  const inSession = (typeof isTradingDate !== 'function' || isTradingDate(_bjDate)) && _bjMin >= 9 * 60 + 30 && _bjMin <= 15 * 60;

  // 偏离表：在基金行之前插入
  const deviationHTML = buildDeviationTable(pnlCtx);

  let rowsHTML = '';
  for (const d of allocations) {
    const buyHL = d.buyPct > 75 ? ' highlight' : '';
    const holdHL = d.holdPct > 75 ? ' highlight' : '';
    const sellHL = d.sellPct > 75 ? ' highlight' : '';

    const amountHTML = d.recommendAmount > 0
      ? `<span style="color:var(--accent-blue);font-family:var(--font-mono);">+${formatMoney(d.recommendAmount)}</span>`
      : '<span style="color:var(--text-muted);">-</span>';

    // 深度咨询按钮状态
    const rateCheck = checkRateLimit(d.code);
    const dsReady = DeepSeekConfig.isReady();
    const consultBtnHTML = dsReady
      ? (rateCheck.allowed
        ? `<button class="btn btn--consult btn--consult-sm" onclick="triggerConsultation('${d.code}')" title="调用 DeepSeek 深度分析">🤖 咨询</button>`
        : `<span class="consult-cooldown" title="10分钟内限流，请稍后再试">⏳ ${Math.floor(rateCheck.remainingSeconds / 60)}:${String(rateCheck.remainingSeconds % 60).padStart(2, '0')}</span>`)
      : `<button class="btn btn--consult btn--consult-sm" onclick="triggerConsultation('${d.code}')" title="DeepSeek API 未配置">🔒 咨询</button>`;

    // 三层盈亏子行数据
    const p = pnlCtx.map.get(d.code);
    const _today = _navToday();
    // 当日收盘净值展示：已归档→显示官方净值；未归档→明确标注日期，不冒充昨日
    let closeNavHTML;
    if (p && !p.navPending && p.latestNav > 0) {
      closeNavHTML = `<span class="pnl-cell__nav">${p.latestNav.toFixed(4)}</span> <span style="color:var(--text-muted);font-size:0.72rem;">(${_today} 官方收盘)</span>`;
    } else if (p && p.latestNav > 0) {
      closeNavHTML = `<span style="color:var(--text-muted);">今日(${_today})收盘净值暂未归档，展示上一交易日 </span><span class="pnl-cell__nav">${p.latestNav.toFixed(4)}</span>`;
    } else {
      closeNavHTML = `<span style="color:var(--text-muted);">今日(${_today})收盘净值暂未归档</span>`;
    }
    let pnlLineHTML = '';
    if (p && p.hasPosition) {
      const dailyText = p.hasDaily
        ? `<span class="${pnlColorClass(p.dailyPnL)}">${fmtSignedMoney(p.dailyPnL)}</span> <span class="pnl-pct ${pnlColorClass(p.dailyPct)}">(${fmtSignedPct(p.dailyPct)})</span>`
        : (p.navPending
            ? '<span style="color:var(--text-muted);">今日收盘净值发布后自动计算单日盈亏</span>'
            : '<span style="color:var(--text-muted);">缺少上一交易日正式收盘净值，补录历史数据后可查看单日盈亏</span>');
      const totalText = `<span class="${pnlColorClass(p.totalPnL)}">${fmtSignedMoney(p.totalPnL)}</span> <span class="pnl-pct ${pnlColorClass(p.totalPnLPct)}">(${fmtSignedPct(p.totalPnLPct)})</span>`;
      pnlLineHTML = `
        <div class="fund-row__pnl">
          <span class="pnl-cell"><span class="pnl-cell__label">当日收盘净值</span> ${closeNavHTML}</span>
          <span class="pnl-cell"><span class="pnl-cell__label">单日盈亏</span> ${dailyText}</span>
          <span class="pnl-cell"><span class="pnl-cell__label">总浮动盈亏</span> ${totalText}</span>
        </div>`;
    } else {
      pnlLineHTML = `
        <div class="fund-row__pnl">
          <span class="pnl-cell"><span class="pnl-cell__label">当日收盘净值</span> ${closeNavHTML}</span>
          <span class="pnl-cell" style="color:var(--text-muted);">未录入持仓成本，暂不计算盈亏</span>
        </div>`;
    }

    rowsHTML += `
      <div class="fund-row">
        <div class="fund-row__main">
          <div>
            <div class="fund-row__name">${escapeHTML(d.name)}</div>
            <div class="fund-row__code">${d.code}</div>
            ${d.degraded
              ? `<div style="font-size:0.68rem;color:var(--text-muted);margin-top:3px;" title="行情数据接口不可用，缺失维度权重已归零，概率按剩余维度动态重分配">⚠ ${(d.missingDims || []).map(k => ({ valuation: '估值', trend: '趋势', news: '消息' }[k] || k)).join(' / ')}数据不可用，概率仅基于盈亏等剩余维度</div>`
              : ''}
          </div>
          <div style="font-size:0.78rem;color:var(--text-secondary);" title="盘中实时估值涨跌，仅交易时段展示，不参与盈亏计算">
            <span style="color:var(--text-muted);">盘中估值 </span>
            ${inSession
              ? (d.changePct != null
                  ? `<span class="${pnlColorClass(d.changePct)}">${fmtSignedPct(d.changePct)}</span>`
                  : '<span style="color:var(--text-muted);">—</span>')
              : '<span style="color:var(--text-muted);">休市</span>'}
          </div>
          <div class="fund-row__probabilities">
            <span class="prob-badge buy${buyHL}">加仓 ${d.buyPct}%</span>
            <span class="prob-badge hold${holdHL}">持有 ${d.holdPct}%</span>
            <span class="prob-badge sell${sellHL}">减仓 ${d.sellPct}%</span>
          </div>
          <div class="fund-row__action">${d.recommendation}</div>
          <div class="fund-row__amount">${amountHTML}</div>
          <div style="text-align:center;display:flex;gap:4px;justify-content:center;align-items:center;">
            <button class="btn btn--sm" style="padding:2px 6px;" title="单独刷新该基金当日收盘净值" onclick="refreshSingleFund('${d.code}')">🔄</button>
            ${consultBtnHTML}
          </div>
        </div>
        ${pnlLineHTML}
      </div>`;
  }

  // 加仓金额摘要
  if (dailyTotal > 0) {
    const pctOfMonthly = budgetInfo.totalBudget > 0
      ? Math.round((dailyTotal / budgetInfo.totalBudget) * 100) : 0;
    rowsHTML += `
      <div class="alert alert--info" style="margin-top:12px;">
        📊 本次建议加仓合计 <strong>${formatMoney(dailyTotal)}</strong> 元，
        消耗当月可用资金 <strong>${pctOfMonthly}%</strong>，
        剩余可投余额 <strong>${formatMoney(remainingAfter)}</strong> 元
      </div>`;
  }

  container.innerHTML = precloseHTML + frameworkHTML + summaryHTML + deviationHTML + rowsHTML;

  // 检查桌面通知
  checkAndNotify(allocations);
}

/** 检查触发桌面通知 */
function checkAndNotify(decisions) {
  const settings = AppSettings.get();
  if (!settings.notificationEnabled) return;

  for (const d of decisions) {
    if (d.buyPct > settings.notificationThreshold) {
      sendDesktopNotification(
        `📈 ${d.name} — 强烈加仓信号 ${d.buyPct}%`,
        `${d.recommendation}${d.recommendAmount > 0 ? ` · 建议金额: ${formatMoney(d.recommendAmount)}` : ''}`
      );
    } else if (d.sellPct > settings.notificationThreshold) {
      sendDesktopNotification(
        `📉 ${d.name} — 强烈减仓信号 ${d.sellPct}%`,
        d.recommendation
      );
    }
  }
}

// ==================== Tab 2: 月度资金 ====================

async function renderBudgetTab() {
  const container = document.getElementById('tab-budget');
  if (!container) return;

  const budget = await MonthlyBudget.getCurrent();
  const rollover = await BudgetManager.checkMonthRollover();

  const usedPct = budget.totalBudget > 0
    ? Math.round(((budget.usedAmount || 0) / budget.totalBudget) * 100) : 0;
  const remaining = budget.totalBudget - (budget.usedAmount || 0);
  const dailyLimit = budget.totalBudget * ((budget.maxDailyPct || 30) / 100);

  container.innerHTML = `
    ${rollover.needsSetup ? `
      <div class="alert alert--warning">
        ⚠️ 本月尚未设置可投入资金${rollover.lastMonthBudget > 0 ? `（上月余额 ${formatMoney(rollover.lastMonthRemaining)} 元不累计）` : ''}，请在下方填写当月预算。
      </div>` : ''}

    <div class="card">
      <div class="card__header">
        <span class="card__title">📅 ${budget.yearMonth} 月度资金管理</span>
      </div>

      <div class="budget-display">
        <div class="budget-card">
          <div class="budget-card__amount total">${formatMoney(budget.totalBudget)}</div>
          <div class="budget-card__label">月度总额</div>
        </div>
        <div class="budget-card">
          <div class="budget-card__amount used">${formatMoney(budget.usedAmount || 0)}</div>
          <div class="budget-card__label">已使用</div>
        </div>
        <div class="budget-card">
          <div class="budget-card__amount available">${formatMoney(Math.max(0, remaining))}</div>
          <div class="budget-card__label">剩余可用</div>
        </div>
      </div>

      <div style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:0.8rem;color:var(--text-secondary);">
          <span>使用进度</span><span>${usedPct}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-bar__fill ${usedPct > 80 ? 'red' : 'blue'}" style="width:${Math.min(100, usedPct)}%;"></div>
        </div>
      </div>

      <div class="alert alert--info">
        💡 今日单次加仓上限: <strong>${formatMoney(dailyLimit)}</strong>（月度总额 ${budget.maxDailyPct || 30}%）
      </div>
    </div>

    <div class="card">
      <div class="card__title" style="margin-bottom:14px;">✏️ 更新月度预算</div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">当月可投入总金额（元）</label>
          <input type="number" class="form-input" id="budget-total" value="${budget.totalBudget || ''}" placeholder="如: 5000" min="0" step="100">
        </div>
        <div class="form-group">
          <label class="form-label">单日使用上限比例（%）</label>
          <input type="number" class="form-input" id="budget-daily-pct" value="${budget.maxDailyPct || 30}" placeholder="30" min="5" max="100">
          <div class="form-hint">建议 20%-40%，避免一次性用完当月资金</div>
        </div>
      </div>
      <button class="btn btn--primary" onclick="saveBudget()">💾 保存设置</button>
      <span style="font-size:0.78rem;color:var(--text-muted);margin-left:10px;">每月独立额度，不累计到下月</span>
    </div>
  `;
}

// ==================== Tab 3: 操作录入 ====================

async function renderRecordTab() {
  const container = document.getElementById('tab-record');
  if (!container) return;

  const today = new Date().toISOString().slice(0, 10);
  const watchlist = await Watchlist.getAll();
  const todayRecords = await Operations.getByDate(today);
  const todaySummary = await Operations.getTodaySummary();

  const fundOptions = watchlist.map(f =>
    `<option value="${f.code}">${f.name || f.code} (${f.code})</option>`
  ).join('');

  container.innerHTML = `
    <div class="card">
      <div class="card__title" style="margin-bottom:14px;">📝 今日操作录入 — ${today}</div>

      <!-- 单条录入 -->
      <div class="form-row" id="single-record-form">
        <div class="form-group">
          <label class="form-label">基金</label>
          <select class="form-select" id="record-code">
            <option value="">选择基金</option>
            ${fundOptions}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">操作类型</label>
          <select class="form-select" id="record-type">
            <option value="buy">加仓</option>
            <option value="sell">减仓</option>
            <option value="auto">定投</option>
            <option value="none">无操作</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">交易金额（元）</label>
          <input type="number" class="form-input" id="record-amount" placeholder="0" min="0" step="0.01">
        </div>
        <div class="form-group">
          <label class="form-label">交易份额</label>
          <input type="number" class="form-input" id="record-shares" placeholder="0" min="0" step="0.01">
        </div>
        <div class="form-group">
          <label class="form-label">当日账户总收益（元）</label>
          <input type="number" class="form-input" id="record-daily-profit" placeholder="0" step="0.01">
        </div>
        <div class="form-group">
          <label class="form-label">单只盈亏（元）</label>
          <input type="number" class="form-input" id="record-fund-profit" placeholder="0" step="0.01">
        </div>
        <div class="form-group" style="grid-column:1/-1;">
          <label class="form-label">备注</label>
          <input type="text" class="form-input" id="record-notes" placeholder="选填">
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn--primary" onclick="submitRecord()">✅ 提交记录</button>
        <button class="btn" onclick="clearRecordForm()">清空表单</button>
      </div>
    </div>

    <!-- 今日摘要 -->
    <div class="card">
      <div class="card__title" style="margin-bottom:12px;">📊 今日摘要</div>
      <div class="dashboard-summary" style="grid-template-columns: repeat(4, 1fr);">
        <div class="summary-card">
          <div class="summary-card__value blue">${todaySummary.totalRecords}</div>
          <div class="summary-card__label">操作笔数</div>
        </div>
        <div class="summary-card">
          <div class="summary-card__value green">${formatMoney(todaySummary.totalBuyAmount)}</div>
          <div class="summary-card__label">加仓金额</div>
        </div>
        <div class="summary-card">
          <div class="summary-card__value red">${formatMoney(todaySummary.totalSellAmount)}</div>
          <div class="summary-card__label">减仓金额</div>
        </div>
        <div class="summary-card">
          <div class="summary-card__value ${todaySummary.totalProfit >= 0 ? 'green' : 'red'}">${todaySummary.totalProfit >= 0 ? '+' : ''}${todaySummary.totalProfit}</div>
          <div class="summary-card__label">总收益</div>
        </div>
      </div>
    </div>

    <!-- 今日记录列表 -->
    <div class="card">
      <div class="card__title" style="margin-bottom:12px;">📋 今日操作记录</div>
      ${todayRecords.length === 0
        ? '<div style="text-align:center;padding:30px;color:var(--text-muted);">暂无记录</div>'
        : renderRecordTable(todayRecords, watchlist)}
    </div>
  `;
}

function renderRecordTable(records, watchlist) {
  const nameMap = {};
  if (watchlist) watchlist.forEach(f => { nameMap[f.code] = f.name; });

  const opTypeLabels = { buy: '加仓', sell: '减仓', auto: '定投', none: '无操作' };
  const opTypeTags = { buy: 'tag--buy', sell: 'tag--sell', auto: 'tag--auto', none: '' };

  let html = `
    <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>日期</th><th>基金</th><th>操作</th><th>金额</th><th>份额</th>
          <th>账户收益</th><th>单只盈亏</th><th>备注</th><th></th>
        </tr>
      </thead>
      <tbody>`;

  for (const r of records) {
    const name = nameMap[r.code] || r.code;
    html += `
      <tr>
        <td>${r.date}</td>
        <td>${escapeHTML(name)}<br><span style="font-size:0.72rem;color:var(--text-muted);">${r.code}</span></td>
        <td><span class="tag ${opTypeTags[r.opType] || ''}">${opTypeLabels[r.opType] || r.opType}</span></td>
        <td>${r.amount > 0 ? formatMoney(r.amount) : '-'}</td>
        <td>${r.shares > 0 ? r.shares.toFixed(2) : '-'}</td>
        <td style="color:${(r.dailyProfit||0) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'};">
          ${r.dailyProfit != null ? ((r.dailyProfit >= 0 ? '+' : '') + r.dailyProfit.toFixed(2)) : '-'}
        </td>
        <td style="color:${(r.fundProfit||0) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'};">
          ${r.fundProfit != null ? ((r.fundProfit >= 0 ? '+' : '') + r.fundProfit.toFixed(2)) : '-'}
        </td>
        <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHTML(r.notes||'')}">${escapeHTML(r.notes || '-')}</td>
        <td><button class="btn btn--sm btn--danger" onclick="deleteOpRecord(${r.id})">删除</button></td>
      </tr>`;
  }

  html += '</tbody></table></div>';
  return html;
}

// ==================== Tab 4: 台账查询 & 复盘 ====================

async function renderHistoryTab() {
  const container = document.getElementById('tab-history');
  if (!container) return;

  const watchlist = await Watchlist.getAll();
  const fundOptions = watchlist.map(f =>
    `<option value="${f.code}">${f.name || f.code} (${f.code})</option>`
  ).join('');

  // 默认显示最近 30 天
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const records = await Operations.query({ startDate, endDate });

  container.innerHTML = `
    <div class="card">
      <div class="card__title" style="margin-bottom:14px;">🔍 操作台账查询</div>
      <div class="filter-bar">
        <input type="date" class="form-input" id="filter-start" value="${startDate}" style="min-width:140px;">
        <span style="color:var(--text-muted);">至</span>
        <input type="date" class="form-input" id="filter-end" value="${endDate}" style="min-width:140px;">
        <select class="form-select" id="filter-code" style="min-width:180px;">
          <option value="">全部基金</option>
          ${fundOptions}
        </select>
        <select class="form-select" id="filter-type" style="min-width:120px;">
          <option value="">全部操作</option>
          <option value="buy">加仓</option>
          <option value="sell">减仓</option>
          <option value="auto">定投</option>
          <option value="none">无操作</option>
        </select>
        <button class="btn btn--primary" onclick="queryHistory()">查询</button>
      </div>
      <div id="history-table-container">
        ${records.length === 0
          ? '<div style="text-align:center;padding:40px;color:var(--text-muted);">暂无匹配记录</div>'
          : renderRecordTable(records, watchlist)}
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__title">🤖 AI 复盘统计</span>
        <button class="btn btn--primary btn--sm" onclick="runReview()">执行复盘分析</button>
      </div>
      <div id="review-results">
        <div style="text-align:center;padding:30px;color:var(--text-muted);">
          点击「执行复盘分析」对比 AI 历史建议与实际操作盈亏
        </div>
      </div>
    </div>
  `;
}

/** 执行复盘并渲染结果 */
async function renderReviewResults(lookbackDays = 90) {
  const container = document.getElementById('review-results');
  if (!container) return;

  container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);">⏳ 分析中...</div>';

  const review = await Operations.runReview(lookbackDays);

  if (review.totalMatched === 0) {
    container.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted);">${review.summary}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="review-stats">
      <div class="stat-item">
        <div class="stat-item__value" style="color:var(--accent-blue);">${review.totalMatched}</div>
        <div class="stat-item__label">可比操作次数</div>
      </div>
      <div class="stat-item">
        <div class="stat-item__value" style="color:var(--accent-green);">${review.followRate}%</div>
        <div class="stat-item__label">听从 AI 建议比例</div>
      </div>
      <div class="stat-item">
        <div class="stat-item__value" style="color:${review.successRate >= 50 ? 'var(--accent-green)' : 'var(--accent-yellow)'};">${review.successRate}%</div>
        <div class="stat-item__label">AI 建议成功率</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
      <div class="stat-item">
        <div class="stat-item__value" style="color:${review.avgFollowedProfit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'};">
          ${review.avgFollowedProfit >= 0 ? '+' : ''}${review.avgFollowedProfit}
        </div>
        <div class="stat-item__label">听从建议 · 平均单次收益（元）</div>
      </div>
      <div class="stat-item">
        <div class="stat-item__value" style="color:${review.avgNotFollowedProfit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'};">
          ${review.avgNotFollowedProfit >= 0 ? '+' : ''}${review.avgNotFollowedProfit}
        </div>
        <div class="stat-item__label">未听从 · 平均单次收益（元）</div>
      </div>
    </div>

    <div class="alert alert--${review.avgFollowedProfit > review.avgNotFollowedProfit ? 'success' : 'warning'}">
      ${review.summary}
    </div>
  `;
}

// ==================== Tab 5: 设置 ====================

/**
 * 渲染设置页 —— 拆分为「立即渲染骨架」+「后台异步填充」两阶段，彻底杜绝卡死：
 *   1. DOM 先立刻渲染空白设置框架（含所有可编辑表单），瞬间移除「正在加载…」；
 *   2. 后台异步读取 IndexedDB 列表数据（自选基金/持仓），带 2 秒超时 + LocalStorage 兜底；
 *   3. 无论成功/失败/超时，2 秒内必定完成填充或降级，绝不永久阻塞。
 */
async function renderSettingsTab() {
  const container = document.getElementById('tab-settings');
  if (!container) return;
  const gen = UI._renderGen;

  // ---- 同步配置（LocalStorage，安全，缺失自动填默认） ----
  let settings, dsCfg;
  try {
    settings = AppSettings.get();
  } catch (e) {
    console.warn('[Settings] 读取系统设置失败，使用默认值:', e && e.message);
    settings = { refreshIntervalTrading: 30, refreshIntervalOff: 120, maxDailyBudgetPct: 30, notificationThreshold: 80, notificationEnabled: true };
  }
  try {
    dsCfg = DeepSeekConfig.get(); // 内部已对解密失败做置空兜底，不会抛出
  } catch (e) {
    console.warn('[Settings] 读取 DeepSeek 配置失败，密钥置空:', e && e.message);
    dsCfg = { apiKey: '', model: 'deepseek-chat', timeout: 15000, maxTokens: 200 };
  }

  // ---- 1. 立即渲染骨架（清除「正在加载…」） ----
  container.innerHTML = `
    <!-- 自选基金 -->
    <div class="card">
      <div class="card__header">
        <span class="card__title">⭐ 自选基金清单</span>
        <button class="btn btn--primary btn--sm" onclick="showAddFundModal()">+ 添加基金</button>
      </div>
      <div id="settings-fund-list"><div style="color:var(--text-muted);padding:8px;">加载中…</div></div>
      <div class="form-hint" style="margin-top:8px;">添加基金代码后，系统将自动获取行情数据。支持批量导入。</div>
    </div>

    <!-- 持仓管理 -->
    <div class="card">
      <div class="card__header">
        <span class="card__title">💼 持仓数据管理</span>
        <button class="btn btn--sm" onclick="showBatchPositionModal()">批量录入</button>
      </div>
      <div id="settings-position-list"><div style="color:var(--text-muted);padding:8px;">加载中…</div></div>
    </div>

    <!-- 目标持仓配置 -->
    <div class="card">
      <div class="card__header">
        <span class="card__title">🎯 目标持仓配置</span>
      </div>
      <div id="settings-allocation-list"><div style="color:var(--text-muted);padding:8px;">加载中…</div></div>
      <div class="form-hint" style="margin-top:8px;">设置每只基金的目标占比（总和应为 100%）。持仓偏离 ≥ 5% 时看板会高亮提醒。</div>
      <div style="margin-top:10px;display:flex;gap:8px;">
        <button class="btn btn--sm" onclick="saveAllocations()">💾 保存配置</button>
        <button class="btn btn--sm" onclick="resetAllocations()">🔄 重置为默认</button>
      </div>
    </div>

    <!-- 系统设置 -->
    <div class="card">
      <div class="card__title" style="margin-bottom:14px;">⚙️ 系统设置</div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">交易日刷新间隔（分钟）</label>
          <input type="number" class="form-input" id="setting-refresh-trading" value="${settings.refreshIntervalTrading}" min="5" max="120">
        </div>
        <div class="form-group">
          <label class="form-label">休市刷新间隔（分钟）</label>
          <input type="number" class="form-input" id="setting-refresh-off" value="${settings.refreshIntervalOff}" min="30" max="480">
        </div>
        <div class="form-group">
          <label class="form-label">单日最大使用月度预算（%）</label>
          <input type="number" class="form-input" id="setting-max-daily-pct" value="${settings.maxDailyBudgetPct}" min="5" max="100">
        </div>
        <div class="form-group">
          <label class="form-label">桌面通知触发阈值（%）</label>
          <input type="number" class="form-input" id="setting-notify-threshold" value="${settings.notificationThreshold}" min="60" max="95">
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
        <input type="checkbox" id="setting-notify-enabled" ${settings.notificationEnabled ? 'checked' : ''}>
        <label for="setting-notify-enabled" style="font-size:0.88rem;">启用桌面通知提醒</label>
      </div>
      <div style="margin-top:14px;display:flex;gap:8px;">
        <button class="btn btn--primary" onclick="saveSettings()">💾 保存设置</button>
        <button class="btn" onclick="resetSettings()">恢复默认</button>
      </div>
    </div>

    <!-- DeepSeek API 深度咨询 -->
    <div class="card" style="border-color:rgba(124,58,237,0.3);">
      <div class="card__header">
        <span class="card__title">🤖 DeepSeek API 深度咨询</span>
        <span style="font-size:0.72rem;color:var(--text-muted);">付费增强功能 · 仅手动触发</span>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">API Key</label>
          <input type="password" class="form-input" id="ds-api-key" placeholder="sk-..." value="${escapeHTML(dsCfg.apiKey || '')}" style="font-family:var(--font-mono);">
          <div class="form-hint">密钥仅加密存储在浏览器本地，不会上传</div>
        </div>
        <div class="form-group">
          <label class="form-label">模型</label>
          <select class="form-select" id="ds-model">
            <option value="deepseek-chat" ${(dsCfg.model||'deepseek-chat')==='deepseek-chat'?'selected':''}>deepseek-chat（推荐）</option>
            <option value="deepseek-reasoner" ${dsCfg.model==='deepseek-reasoner'?'selected':''}>deepseek-reasoner（推理）</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">请求超时（毫秒）</label>
          <input type="number" class="form-input" id="ds-timeout" value="${dsCfg.timeout || 15000}" min="5000" max="60000" step="1000">
        </div>
        <div class="form-group">
          <label class="form-label">单次最大输出 Token</label>
          <input type="number" class="form-input" id="ds-max-tokens" value="${dsCfg.maxTokens || 200}" min="50" max="500" step="50">
          <div class="form-hint">输出仅一句话，50-200 足够</div>
        </div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button class="btn btn--primary" onclick="saveDeepSeekConfig()" style="background:linear-gradient(135deg, #4f46e5, #7c3aed);border-color:transparent;">💾 保存 API 配置</button>
        <button class="btn btn--sm" onclick="clearDeepSeekConfig()">清除配置</button>
      </div>
    </div>

    <!-- Token 消耗台账 -->
    <div class="card">
      <div class="card__header">
        <span class="card__title">📊 Token 消耗统计</span>
        <div style="display:flex;gap:6px;">
          <button class="btn btn--sm" onclick="exportTokenLog()">📥 导出 CSV</button>
          <button class="btn btn--sm btn--danger" onclick="clearTokenLog()">清空日志</button>
        </div>
      </div>
      ${safeRenderTokenStats()}
    </div>

    <!-- 净值历史补录 & 抓取调试 -->
    <div class="card">
      <div class="card__title" style="margin-bottom:14px;">📈 净值历史补录 & 抓取设置</div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">补录起始日期</label>
          <input type="date" class="form-input" id="nav-backfill-start" value="${_navDefaultStart()}">
        </div>
        <div class="form-group">
          <label class="form-label">补录截止日期</label>
          <input type="date" class="form-input" id="nav-backfill-end" value="${_navToday()}">
        </div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button class="btn btn--primary btn--sm" onclick="backfillNavRange()">🔄 一键补录区间历史净值</button>
        <span class="form-hint">从东方财富拉取区间内各交易日官方收盘净值，补完自动重算盈亏</span>
      </div>
      <div id="backfill-progress" class="form-hint" style="margin-top:8px;min-height:18px;"></div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--border-color);">
        <label class="form-label">手动补录当日净值（接口当日抓取失败时使用）</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <input type="text" class="form-input" id="manual-nav-code" placeholder="基金代码" maxlength="6" style="max-width:110px;">
          <input type="date" class="form-input" id="manual-nav-date" value="${_navToday()}" style="max-width:150px;">
          <input type="number" class="form-input" id="manual-nav-value" placeholder="官方单位净值" step="0.0001" min="0.1" max="10" style="max-width:140px;">
          <button class="btn btn--sm btn--primary" id="manual-nav-btn" onclick="manualArchiveNav()">写入归档</button>
        </div>
        <div class="form-hint" style="margin-top:6px;">用于当日官方净值已在天天基金官网发布、但自动抓取失败时手动补齐</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border-color);">
        <input type="checkbox" id="nav-debug-toggle" ${localStorage.getItem('fundai_nav_debug') === '1' ? 'checked' : ''} onchange="toggleNavDebug(this.checked)">
        <label for="nav-debug-toggle" style="font-size:0.88rem;">净值抓取调试日志</label>
        <span class="form-hint">开启后控制台逐条输出每只基金请求明细，默认关闭保持干净</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;">
        <input type="checkbox" id="cors-fetch-toggle" ${(typeof isCorsFetchEnabled === 'function' && isCorsFetchEnabled()) ? 'checked' : ''} onchange="toggleCorsFetch(this.checked)">
        <label for="cors-fetch-toggle" style="font-size:0.88rem;">允许跨域 fetch 资讯请求</label>
        <span class="form-hint">默认关闭：跳过必然 CORS 失败的资讯接口，避免控制台刷屏；网络可直连时可开启</span>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-color);">
        <label class="form-label">A 股节假日表（每行一个 YYYY-MM-DD，交易日判断用）</label>
        <textarea class="form-input" id="holiday-editor" rows="4" style="resize:vertical;font-family:var(--font-mono);font-size:0.78rem;">${_holidaysText()}</textarea>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
          <button class="btn btn--sm btn--primary" onclick="saveHolidays()">💾 保存节假日表</button>
          <button class="btn btn--sm" onclick="resetHolidays()">恢复内置默认</button>
          <span class="form-hint">年度更新一次即可，避免内置日期过期导致交易日判断失效</span>
        </div>
      </div>
    </div>

    <!-- 数据管理 -->
    <div class="card">
      <div class="card__title" style="margin-bottom:14px;">🗄️ 数据管理 & 备份</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <button class="btn btn--sm" onclick="exportAllData()">📥 导出备份</button>
        <button class="btn btn--sm" onclick="importDataPrompt()">📤 导入备份</button>
        <button class="btn btn--sm btn--danger" onclick="clearAllData()">🗑️ 清空数据</button>
      </div>
      <div class="form-hint" style="margin-top:8px;">纯浏览器 IndexedDB 存储 · 双备份至 LocalStorage · 无需启动本地服务</div>
    </div>
  `;

  // ---- 2. 后台异步读取 IndexedDB 列表数据（带超时 + 兜底），与 UI 渲染解耦 ----
  console.log('[Settings] 开始读取配置表（自选基金 / 持仓）');
  let watchlist = [];
  let positions = [];
  try {
    [watchlist, positions] = await Promise.all([
      readWithTimeout(Watchlist.getAll(), 2000, () => readBackupList('watchlist')),
      readWithTimeout(Positions.getAll(), 2000, () => readBackupList('positions')),
    ]);
    watchlist = Array.isArray(watchlist) ? watchlist : [];
    positions = Array.isArray(positions) ? positions : [];
    console.log(`[Settings] 读取成功 — 自选基金 ${watchlist.length} 只 / 持仓 ${positions.length} 条`);
  } catch (err) {
    console.warn('[Settings] 读取失败，启用缓存兜底:', err && err.message);
    if (err && err.stack) console.warn(err.stack);
    watchlist = readBackupList('watchlist');
    positions = readBackupList('positions');
  }

  // 用户已切到其它标签 → 放弃回填，避免污染其它页面
  if (gen !== UI._renderGen) {
    console.log('[Settings] 已切换标签，跳过列表回填');
    return;
  }

  // ---- 3. 填充列表（DOM 已存在，异常也不影响其余表单） ----
  try {
    const fl = document.getElementById('settings-fund-list');
    const pl = document.getElementById('settings-position-list');
    if (fl) fl.innerHTML = buildFundListHTML(watchlist, positions);
    if (pl) pl.innerHTML = buildPositionListHTML(positions, watchlist);
    // 目标配置编辑器（依赖 watchlist）
    renderAllocationEditor(watchlist);
  } catch (err) {
    console.warn('[Settings] 列表渲染异常（不影响其它功能）:', err && err.message);
  }
}

/** 构建自选基金列表 HTML */
function buildFundListHTML(watchlist, positions) {
  if (!watchlist || watchlist.length === 0) {
    return '<div style="color:var(--text-muted);padding:8px;">暂无自选基金</div>';
  }
  return watchlist.map(f => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-input);border-radius:6px;margin-bottom:6px;">
      <div>
        <strong>${escapeHTML(f.name || f.code)}</strong>
        <span style="color:var(--text-muted);margin-left:8px;font-family:var(--font-mono);">${f.code}</span>
        ${positions.find(p=>p.code===f.code) ? '<span class="tag tag--buy" style="margin-left:6px;">已持仓</span>' : ''}
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn--sm" onclick="editFundPosition('${f.code}')">持仓</button>
        <button class="btn btn--sm btn--danger" onclick="removeFund('${f.code}')">移除</button>
      </div>
    </div>`).join('');
}

/** 构建持仓列表 HTML */
function buildPositionListHTML(positions, watchlist) {
  if (!positions || positions.length === 0) {
    return '<div style="color:var(--text-muted);padding:8px;">暂无持仓数据</div>';
  }
  return positions.map(p => {
    const fund = (watchlist || []).find(f => f.code === p.code);
    return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-input);border-radius:6px;margin-bottom:6px;">
      <div>
        <strong>${escapeHTML(fund?.name || p.code)}</strong>
        <span style="color:var(--text-muted);margin-left:8px;font-family:var(--font-mono);">${p.code}</span>
      </div>
      <div style="font-size:0.82rem;color:var(--text-secondary);">
        份额: ${p.shares} · 成本: ${p.costPrice} · 投入: ${formatMoney(p.totalInvested || 0)}
      </div>
    </div>`;
  }).join('');
}

/** Token 统计渲染的容错包装：异常时降级为提示，不阻断设置页骨架 */
function safeRenderTokenStats() {
  try {
    return renderTokenStats();
  } catch (err) {
    console.warn('[Settings] Token 统计渲染异常:', err && err.message);
    return '<div style="text-align:center;padding:20px;color:var(--text-muted);">Token 统计暂不可用</div>';
  }
}

/** 渲染目标配置编辑器（设置页调用） */
function renderAllocationEditor(watchlist) {
  const container = document.getElementById('settings-allocation-list');
  if (!container) return;

  const settings = AppSettings.get();
  const saved = settings.fundAllocations || [];
  const savedMap = new Map(saved.map(a => [a.code, a]));

  // 合并：已保存的 + 自选中新增的
  const merged = watchlist.map(f => ({
    code: f.code,
    name: savedMap.get(f.code)?.name || f.name || f.code,
    targetPct: savedMap.get(f.code)?.targetPct || 0,
  }));
  for (const s of saved) {
    if (!merged.find(m => m.code === s.code)) {
      merged.push({ ...s, targetPct: 0 });
    }
  }

  if (!merged.length) {
    container.innerHTML = '<div style="color:var(--text-muted);padding:8px;">暂无自选基金，请先添加基金</div>';
    return;
  }

  const totalPct = merged.reduce((s, a) => s + (a.targetPct || 0), 0);
  const totalHint = totalPct === 100
    ? `<span style="color:var(--accent-green);">✅ 合计 ${totalPct}%</span>`
    : `<span style="color:var(--accent-red);">⚠ 合计 ${totalPct}%（应为 100%）</span>`;

  container.innerHTML = `
    <div style="margin-bottom:8px;font-size:0.82rem;">${totalHint}</div>
    ${merged.map(a => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;background:var(--bg-input);border-radius:6px;margin-bottom:4px;">
        <span style="flex:1;font-size:0.85rem;">${a.name} <span style="color:var(--text-muted);font-size:0.75rem;">${a.code}</span></span>
        <input type="number" class="form-input allocation-pct" data-code="${a.code}"
               value="${a.targetPct}" min="0" max="100" step="1"
               style="width:70px;text-align:center;padding:4px 6px;">
        <span style="font-size:0.85rem;">%</span>
      </div>
    `).join('')}
  `;
}

// ==================== 模态框 ====================

/** 添加基金弹窗 */
function showAddFundModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <span class="modal__title">➕ 添加自选基金</span>
        <button class="modal__close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div class="form-group">
        <label class="form-label">基金代码（如 000001）</label>
        <input type="text" class="form-input" id="add-fund-code" placeholder="输入6位基金代码" maxlength="6" autofocus autocomplete="off">
        <div id="add-fund-code-feedback" style="margin-top:4px;min-height:18px;"></div>
      </div>
      <div class="form-group">
        <label class="form-label">基金名称<span id="add-fund-type-tag" style="font-size:0.72rem;color:var(--accent-blue);margin-left:6px;"></span></label>
        <input type="text" class="form-input" id="add-fund-name" placeholder="输入代码后自动查询，也可手动填写" autocomplete="off">
      </div>
      <div class="form-hint" style="margin-bottom:12px;">或批量导入（每行一个代码，逗号或换行分隔）：</div>
      <textarea class="form-input" id="add-fund-batch" rows="3" placeholder="000001,000002,000003" style="resize:vertical;"></textarea>
      <div style="margin-top:14px;display:flex;gap:8px;">
        <button class="btn btn--primary" onclick="addFunds()">确认添加</button>
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // 绑定基金代码输入事件
  const codeInput = overlay.querySelector('#add-fund-code');
  const nameInput = overlay.querySelector('#add-fund-name');
  const feedbackEl = overlay.querySelector('#add-fund-code-feedback');
  const typeTagEl = overlay.querySelector('#add-fund-type-tag');

  if (codeInput) {
    // 自动过滤非法字符
    codeInput.addEventListener('input', () => {
      const raw = codeInput.value;
      const filtered = raw.replace(/\D/g, '').slice(0, 6);
      if (raw !== filtered) {
        codeInput.value = filtered;
      }

      // 使用防抖查询
      FundLookupInput.handleInput(filtered, {
        onStart: () => {
          // 查询中 — 不清除已有名称，仅显示加载状态
          feedbackEl.innerHTML = '<span style="color:var(--text-secondary);font-size:0.78rem;">⏳ 正在查询基金信息…</span>';
        },
        onSuccess: (result) => {
          // 自动填充名称和类型
          nameInput.value = result.name;
          nameInput.style.color = 'var(--accent-green)';
          typeTagEl.textContent = result.type ? `· ${result.type}` : '';

          // 区分来源显示不同提示
          if (result._fromLocalDB || result.source === 'local_db') {
            feedbackEl.innerHTML = '<span style="color:var(--accent-yellow);font-size:0.76rem;">⚠️ 线上接口异常，已使用本地基金库匹配名称</span>';
          } else {
            feedbackEl.innerHTML = '<span style="color:var(--accent-green);font-size:0.76rem;">✅ 已自动匹配基金名称</span>';
          }

          // 3秒后自动清除成功提示
          setTimeout(() => {
            const txt = feedbackEl.textContent || '';
            if (txt.includes('已自动匹配') || txt.includes('本地基金库匹配')) {
              feedbackEl.innerHTML = '';
            }
          }, 3000);
        },
        onError: () => {
          feedbackEl.innerHTML = '<span style="color:var(--accent-yellow);font-size:0.76rem;">⚠️ 线上接口异常，已使用本地基金库匹配名称</span>';
        },
        onNotFound: () => {
          // 4层全部无结果 — 保留名称输入框可编辑，提示手动输入
          typeTagEl.textContent = '';
          feedbackEl.innerHTML = '<span style="color:var(--accent-red);font-size:0.76rem;">❌ 未查询到该基金，请核对代码或手动填写基金名称</span>';
          nameInput.focus();
        },
        onFallback: () => {
          feedbackEl.innerHTML = '<span style="color:var(--accent-yellow);font-size:0.76rem;">⚠️ 线上接口异常，已使用本地基金库匹配名称</span>';
        },
        onClear: () => {
          feedbackEl.innerHTML = '';
        },
      });
    });

    // Enter 键触发查询（调用 blur 触发完整查询）
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const code = codeInput.value.replace(/\D/g, '').slice(0, 6);
        if (code.length === 6) {
          // 如果已有缓存结果直接填充，否则触发失焦查询
          const cached = getCachedName(code) || getMemCache(code);
          if (cached && nameInput.value) {
            // 已有结果，直接跳到确认按钮
            document.querySelector('#add-fund-code')?.closest('.modal')?.querySelector('.btn--primary')?.focus();
          }
        }
      }
    });

    // 失焦时确认查询
    codeInput.addEventListener('blur', () => {
      const code = codeInput.value.replace(/\D/g, '').slice(0, 6);
      if (code.length === 6 && !nameInput.value) {
        // 如果没有查询结果，强制触发查询
        FundLookupInput.handleInput(code, {
          onStart: () => {
            feedbackEl.innerHTML = '<span style="color:var(--text-secondary);font-size:0.78rem;">⏳ 正在查询基金信息...</span>';
          },
          onSuccess: (result) => {
            nameInput.value = result.name;
            nameInput.style.color = 'var(--accent-green)';
            typeTagEl.textContent = result.type ? `· ${result.type}` : '';
            feedbackEl.innerHTML = result.source === 'local_db'
              ? '<span style="color:var(--accent-yellow);font-size:0.76rem;">⚠️ 网络查询失败，已启用本地库匹配</span>'
              : '<span style="color:var(--accent-green);font-size:0.76rem;">✅ 已自动匹配基金名称</span>';
          },
          onNotFound: () => {
            feedbackEl.innerHTML = '<span style="color:var(--accent-red);font-size:0.76rem;">❌ 未查询到该基金，请核对 6 位基金代码</span>';
          },
          onError: () => {
            feedbackEl.innerHTML = '<span style="color:var(--accent-yellow);font-size:0.76rem;">⚠️ 网络查询失败，已启用本地库匹配</span>';
          },
          onClear: () => {},
        });
      }
    });
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

/** 编辑持仓弹窗 */
async function showPositionModal(code) {
  const fund = await Watchlist.get(code);
  const position = await Positions.get(code);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <span class="modal__title">💼 ${escapeHTML(fund?.name || code)} 持仓设置</span>
        <button class="modal__close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div class="form-group">
        <label class="form-label">持有份额</label>
        <input type="number" class="form-input" id="pos-shares" value="${position?.shares || ''}" placeholder="0" min="0" step="0.01">
      </div>
      <div class="form-group">
        <label class="form-label">成本价（元）</label>
        <input type="number" class="form-input" id="pos-cost" value="${position?.costPrice || ''}" placeholder="0.0000" min="0" step="0.0001">
      </div>
      <div class="form-group">
        <label class="form-label">总投入金额（元）</label>
        <input type="number" class="form-input" id="pos-invested" value="${position?.totalInvested || ''}" placeholder="0" min="0" step="0.01">
      </div>
      <div style="margin-top:14px;display:flex;gap:8px;">
        <button class="btn btn--primary" onclick="savePosition('${code}')">保存持仓</button>
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

/** 批量持仓弹窗 */
function showBatchPositionModal() {
  // 简单的批量录入提示 — 实际使用建议逐只录入
  showToast('请在「自选基金清单」中点击每只基金的「持仓」按钮逐只设置', 'info');
}

// ==================== DeepSeek 咨询弹窗 ====================

/**
 * 显示深度咨询结果弹窗
 * @param {Object} result - startDeepConsultation 返回结果
 */
function showConsultPopup(result) {
  // 移除已有弹窗
  const existing = document.querySelector('.consult-popup-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'consult-popup-overlay';

  let bodyHTML;
  if (!result.success) {
    // 错误状态
    let errorIcon = '⚠️';
    if (result.code === 'no_config') errorIcon = '🔒';
    else if (result.code === 'rate_limited') errorIcon = '⏳';
    else if (result.code === 'no_data') errorIcon = '📭';

    bodyHTML = `
      <div class="consult-popup__body">
        <div style="text-align:center;padding:20px;">
          <div style="font-size:2.5rem;margin-bottom:12px;">${errorIcon}</div>
          <div style="font-size:1rem;color:var(--text-primary);font-weight:600;margin-bottom:6px;">
            ${result.code === 'rate_limited' ? '请求过于频繁' : '无法完成咨询'}
          </div>
          <div style="font-size:0.86rem;color:var(--text-secondary);">${escapeHTML(result.error)}</div>
        </div>
      </div>`;
  } else {
    // 成功状态 — 仅展示一句话结果
    const resultText = (result.result || '持有不动').trim();
    let resultClass = 'hold';
    if (/加仓/.test(resultText)) resultClass = 'buy';
    else if (/减仓/.test(resultText)) resultClass = 'sell';

    bodyHTML = `
      <div class="consult-popup__body">
        <div class="consult-popup__fund">📌 ${escapeHTML(result.fundName || result.code)} — DeepSeek 分析结论</div>
        <div class="consult-popup__result ${resultClass}">${escapeHTML(resultText)}</div>
        <div class="consult-popup__divider">与本地 AI 对比</div>
        <div class="consult-popup__local">
          <span class="prob-badge buy">加仓 ${result._localDecision?.buyPct || '?'}%</span>
          <span class="prob-badge hold">持有 ${result._localDecision?.holdPct || '?'}%</span>
          <span class="prob-badge sell">减仓 ${result._localDecision?.sellPct || '?'}%</span>
        </div>
      </div>
      <div class="consult-popup__footer">
        <span class="consult-popup__tokens">🪙 本次消耗 ${result.totalTokens || result.tokens || 0} tokens</span>
        <span style="font-size:0.68rem;">独立查询 · 无记忆</span>
      </div>`;
  }

  overlay.innerHTML = `
    <div class="consult-popup">
      <div class="consult-popup__header">
        <div class="consult-popup__title">
          🤖 深度咨询
          <span class="ai-badge">DeepSeek</span>
        </div>
        <button class="consult-popup__close" onclick="this.closest('.consult-popup-overlay').remove()">✕</button>
      </div>
      ${bodyHTML}
    </div>`;

  document.body.appendChild(overlay);

  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  });

  // ESC 关闭
  const onEsc = (e) => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', onEsc);
    }
  };
  document.addEventListener('keydown', onEsc);

  // 关闭时清理事件监听
  const observer = new MutationObserver(() => {
    if (!document.contains(overlay)) {
      document.removeEventListener('keydown', onEsc);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });
}

/**
 * 显示咨询加载中弹窗
 * @returns {HTMLElement} overlay 元素，用于后续更新
 */
function showConsultLoading(fundName) {
  // 移除已有弹窗
  const existing = document.querySelector('.consult-popup-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'consult-popup-overlay';

  overlay.innerHTML = `
    <div class="consult-popup">
      <div class="consult-popup__header">
        <div class="consult-popup__title">
          🤖 深度咨询
          <span class="ai-badge">DeepSeek</span>
        </div>
        <button class="consult-popup__close" onclick="this.closest('.consult-popup-overlay').remove()">✕</button>
      </div>
      <div class="consult-popup__body">
        <div class="consult-popup__fund">📌 ${escapeHTML(fundName)} — 正在分析中...</div>
        <div class="consult-popup__loading">
          <div class="spinner"></div>
          <div style="font-size:0.82rem;color:var(--text-secondary);">正在调用 DeepSeek 深度分析</div>
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">仅输出操作建议，不传输持仓敏感数据</div>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // 点击遮罩不关闭（加载中）
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      // 允许关闭但会中止请求
      overlay.remove();
    }
  });

  return overlay;
}

// ==================== Token 统计渲染 ====================

/** 渲染 Token 消耗统计 */
function renderTokenStats() {
  const stats = TokenLog.getStats();
  const log = TokenLog.getAll();
  const recentLog = log.slice(-10).reverse(); // 最近 10 条

  let html = '';

  if (stats.totalCalls === 0) {
    html += '<div style="text-align:center;padding:20px;color:var(--text-muted);">暂无 API 调用记录</div>';
    return html;
  }

  html += `
    <div class="token-stats-grid">
      <div class="token-stat">
        <div class="token-stat__value" style="color:var(--accent-blue);">${stats.totalCalls}</div>
        <div class="token-stat__label">总调用次数</div>
      </div>
      <div class="token-stat">
        <div class="token-stat__value" style="color:var(--accent-green);">${stats.successCalls}</div>
        <div class="token-stat__label">成功 / 失败</div>
      </div>
      <div class="token-stat">
        <div class="token-stat__value" style="color:var(--accent-yellow);">${stats.totalTokens.toLocaleString()}</div>
        <div class="token-stat__label">累计 Token 消耗</div>
      </div>
      <div class="token-stat">
        <div class="token-stat__value" style="color:var(--text-primary);">$${stats.estimatedCostUSD.toFixed(4)}</div>
        <div class="token-stat__label">估算费用 (USD)</div>
      </div>
    </div>`;

  if (recentLog.length > 0) {
    html += `
      <div style="font-size:0.78rem;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">最近调用记录</div>
      <div class="table-container">
      <table style="font-size:0.76rem;">
        <thead>
          <tr><th>时间</th><th>基金</th><th>结果</th><th>Tokens</th><th>状态</th></tr>
        </thead>
        <tbody>`;

    for (const entry of recentLog) {
      const timeStr = new Date(entry.timestamp).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      html += `
        <tr>
          <td>${timeStr}</td>
          <td>${escapeHTML(entry.fundName || entry.code)}</td>
          <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHTML(entry.result)}">${escapeHTML(entry.result || '-')}</td>
          <td style="font-family:var(--font-mono);">${entry.totalTokens}</td>
          <td>${entry.success
            ? '<span class="tag tag--buy">成功</span>'
            : '<span class="tag tag--sell" title="' + escapeHTML(entry.error || '') + '">失败</span>'
          }</td>
        </tr>`;
    }

    html += '</tbody></table></div>';
  }

  return html;
}

// ==================== 工具函数 ====================

function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatMoney(amount) {
  if (amount == null || isNaN(amount)) return '¥0';
  const abs = Math.abs(amount);
  if (abs >= 10000) {
    return '¥' + (amount / 10000).toFixed(2) + '万';
  }
  return '¥' + amount.toFixed(2);
}

// ==================== 盈亏展示工具 ====================

/** 盈亏颜色类：盈利绿 / 亏损红 / 持平灰 */
function pnlColorClass(v) {
  const n = Number(v) || 0;
  if (n > 0.005) return 'pnl-up';
  if (n < -0.005) return 'pnl-down';
  return 'pnl-flat';
}

/** 带符号金额（正 +¥ / 负 -¥ / 零 ¥0），无 NaN */
function fmtSignedMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '¥0';
  const sign = n > 0.005 ? '+' : (n < -0.005 ? '-' : '');
  return sign + formatMoney(Math.abs(n));
}

/** 带符号百分比，无 NaN */
function fmtSignedPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00%';
  const sign = n > 0.005 ? '+' : (n < -0.005 ? '-' : '');
  return sign + Math.abs(n).toFixed(2) + '%';
}

// ==================== 净值补录 / 调试（设置页调用） ====================
/** 参考日期 = 最近交易日（周末/节假日回退上一交易日），用于净值标注与补录默认值 */
function _navToday() {
  const base = Date.now() + 8 * 3600 * 1000;
  if (typeof isTradingDate === 'function') {
    let t = base;
    for (let i = 0; i < 15; i++) {
      const ds = new Date(t).toISOString().slice(0, 10);
      if (isTradingDate(ds)) return ds;
      t -= 24 * 3600 * 1000;
    }
  }
  return new Date(base).toISOString().slice(0, 10);
}
function _navDefaultStart() { return new Date(Date.now() + 8 * 3600 * 1000 - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10); }

/** 手动区间补录历史净值（设置页按钮） */
function backfillNavRange() {
  if (typeof NAV === 'undefined') { showToast('净值模块未就绪', 'error'); return; }
  const start = document.getElementById('nav-backfill-start')?.value;
  const end = document.getElementById('nav-backfill-end')?.value;
  NAV.backfillRange(start, end);
}

/** 单基金强制刷新当日收盘净值（看板行内 🔄 按钮） */
function refreshSingleFund(code) {
  if (typeof NAV === 'undefined' || typeof NAV.refreshOne !== 'function') { showToast('净值模块未就绪', 'error'); return; }
  NAV.refreshOne(code);
}

/** 手动补录当日净值（设置页写入按钮） */
function manualArchiveNav() {
  if (typeof NAV === 'undefined' || typeof NAV.manualArchive !== 'function') { showToast('净值模块未就绪', 'error'); return; }
  const code = document.getElementById('manual-nav-code')?.value?.trim();
  const date = document.getElementById('manual-nav-date')?.value;
  const nav = document.getElementById('manual-nav-value')?.value;
  const btn = document.getElementById('manual-nav-btn');
  if (btn) { btn.disabled = true; btn.textContent = '写入中…'; }
  Promise.resolve(NAV.manualArchive(code, date, nav)).finally(() => {
    if (btn) { btn.disabled = false; btn.textContent = '写入归档'; }
  });
}

/** 切换净值抓取调试日志开关 */
function toggleNavDebug(on) {
  if (on) localStorage.setItem('fundai_nav_debug', '1');
  else localStorage.removeItem('fundai_nav_debug');
  showToast(on ? '净值抓取调试日志已开启' : '净值抓取调试日志已关闭', 'info');
}

/** 切换跨域 fetch 资讯请求开关（PO-4） */
function toggleCorsFetch(on) {
  if (typeof setCorsFetchEnabled === 'function') setCorsFetchEnabled(on);
  showToast(on ? '已开启跨域资讯请求（网络需可直连）' : '已关闭跨域资讯请求，避免 CORS 刷屏', 'info');
}

// ==================== P1-5：可编辑节假日表（设置页调用） ====================
/** 当前生效节假日文本（每行一个） */
function _holidaysText() {
  try {
    if (typeof getEditableHolidays === 'function') return getEditableHolidays().join('\n');
  } catch { /* 忽略 */ }
  return '';
}

/** 保存节假日表到 localStorage（整表覆盖） */
function saveHolidays() {
  const txt = document.getElementById('holiday-editor')?.value || '';
  const list = [...new Set(
    txt.split(/[\s,]+/).map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))
  )].sort();
  localStorage.setItem('fundai_holidays', JSON.stringify(list));
  showToast(`已保存 ${list.length} 个节假日，交易日判断已更新`, 'success');
}

/** 恢复内置默认节假日表 */
function resetHolidays() {
  localStorage.removeItem('fundai_holidays');
  const el = document.getElementById('holiday-editor');
  if (el) el.value = _holidaysText();
  showToast('已恢复内置默认节假日表', 'info');
}

/** 更新顶栏状态 */
async function updateTopBar() {
  const trading = await isTradingDay();
  const tradingHours = isTradingHours();
  const lastUpdate = localStorage.getItem('fundai_last_update') || '';

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const updateTime = document.getElementById('update-time');
  const projectBadge = document.getElementById('project-badge');

  // API 连通性探测（非阻塞，更新顶栏时顺带检查）
  let apiStatus = '';
  if (typeof FundAPI !== 'undefined' && FundAPI.probeConnectivity) {
    FundAPI.probeConnectivity().then(r => {
      if (statusDot && !r.reachable) {
        statusDot.className = 'status-dot offline';
      }
    }).catch(() => {});
  }

  if (statusDot) {
    statusDot.className = 'status-dot ' + (trading && tradingHours ? '' : trading ? 'idle' : 'offline');
    // 鼠标悬停提示
    statusDot.title = trading
      ? (tradingHours ? '交易时段 · 行情实时刷新中' : '已收盘 · 等待官方净值发布')
      : '非交易日 · 休市中';
  }
  if (statusText) {
    // 盘中估值标记：当前显示的是实时估值还是收盘净值
    const todayStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    let prefix = '';
    if (trading && tradingHours) {
      prefix = '📡 '; // 盘中实时
    }
    statusText.textContent = prefix + (trading
      ? (tradingHours ? '交易中（实时估值）' : '已收盘（待归档）')
      : '休市中');
  }
  if (updateTime && lastUpdate) {
    updateTime.textContent = '上次更新: ' + new Date(parseInt(lastUpdate)).toLocaleTimeString('zh-CN');
  }

  // 项目标识
  if (projectBadge) {
    projectBadge.style.display = 'inline-block';
    projectBadge.textContent = 'IndexedDB';
    projectBadge.style.background = '#34d399';
  }
}

/** 显示加载中 */
function showLoading(show) {
  const btn = document.getElementById('btn-refresh');
  if (btn) {
    if (show) {
      btn.classList.add('spinning');
      btn.disabled = true;
    } else {
      btn.classList.remove('spinning');
      btn.disabled = false;
    }
  }
}
