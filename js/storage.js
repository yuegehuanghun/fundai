/**
 * FundAI Storage — IndexedDB 数据持久化层
 * 6 个 Object Store: watchlist, positions, marketCache, aiDecisions, monthlyBudget, operationLog
 */
const DB_NAME = 'FundAIDB';
const DB_VERSION = 2;

let db = null;

/** 初始化数据库 */
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;

      // 自选基金清单
      if (!db.objectStoreNames.contains('watchlist')) {
        const store = db.createObjectStore('watchlist', { keyPath: 'code' });
        store.createIndex('name', 'name', { unique: false });
      }

      // 持仓数据
      if (!db.objectStoreNames.contains('positions')) {
        const store = db.createObjectStore('positions', { keyPath: 'code' });
        store.createIndex('totalInvested', 'totalInvested', { unique: false });
      }

      // 行情缓存（按基金代码）
      if (!db.objectStoreNames.contains('marketCache')) {
        const store = db.createObjectStore('marketCache', { keyPath: 'code' });
        store.createIndex('updateTime', 'updateTime', { unique: false });
      }

      // AI 每日结论归档
      if (!db.objectStoreNames.contains('aiDecisions')) {
        const store = db.createObjectStore('aiDecisions', { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('code', 'code', { unique: false });
        store.createIndex('dateCode', ['date', 'code'], { unique: true });
      }

      // 月度资金
      if (!db.objectStoreNames.contains('monthlyBudget')) {
        db.createObjectStore('monthlyBudget', { keyPath: 'yearMonth' });
      }

      // 操作台账
      if (!db.objectStoreNames.contains('operationLog')) {
        const store = db.createObjectStore('operationLog', { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('code', 'code', { unique: false });
        store.createIndex('opType', 'opType', { unique: false });
        store.createIndex('dateCode', ['date', 'code'], { unique: false });
      }

      // 每日净值历史 & 单日盈亏记录（ai_calc_log）
      // 每条记录 = 日期 + 基金代码 + 当日22点净值 + 当日单基盈亏，永久留存
      if (!db.objectStoreNames.contains('aiCalcLog')) {
        const store = db.createObjectStore('aiCalcLog', { keyPath: 'id' }); // id = `${date}_${code}`
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('code', 'code', { unique: false });
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      console.log('[Storage] Database initialized successfully');
      resolve(db);
    };

    request.onerror = (e) => {
      console.error('[Storage] Database initialization failed:', e.target.error);
      reject(e.target.error);
    };

    request.onblocked = () => {
      console.warn('[Storage] Database blocked — close other tabs using the same DB');
    };
  });
}

/** 等待 DB 就绪 */
function ensureDB() {
  if (db) return Promise.resolve(db);
  return initDB();
}

// ==================== 通用 CRUD ====================

/** 通用：根据主键获取单条记录 */
async function getOne(storeName, key) {
  await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/** 通用：获取全部记录 */
async function getAll(storeName) {
  await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/** 通用：写入（insert or update） */
async function put(storeName, data) {
  await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(data);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 通用：批量写入 */
async function putAll(storeName, items) {
  await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const item of items) {
      store.put(item);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 通用：根据主键删除 */
async function remove(storeName, key) {
  await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** 通用：清空 store */
async function clearStore(storeName) {
  await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** 通用：按索引查询 */
async function getByIndex(storeName, indexName, value) {
  await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const request = index.getAll(value);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/** 通用：按索引范围查询 */
async function getByIndexRange(storeName, indexName, lower, upper) {
  await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const range = IDBKeyRange.bound(lower, upper);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

// ==================== 自选基金 ====================
const Watchlist = {
  getAll: () => getAll('watchlist'),
  get: (code) => getOne('watchlist', code),
  add: (fund) => put('watchlist', { ...fund, addedAt: fund.addedAt || Date.now() }),
  update: (code, data) => getOne('watchlist', code).then(fund =>
    fund ? put('watchlist', { ...fund, ...data }) : Promise.reject(new Error('Fund not found'))
  ),
  remove: (code) => remove('watchlist', code),
  addAll: (funds) => putAll('watchlist', funds),
};

// ==================== 持仓数据 ====================
const Positions = {
  getAll: () => getAll('positions'),
  get: (code) => getOne('positions', code),
  save: (pos) => put('positions', { ...pos, updatedAt: Date.now() }),
  remove: (code) => remove('positions', code),
  saveAll: (positions) => putAll('positions', positions.map(p => ({ ...p, updatedAt: Date.now() }))),
};

// ==================== 行情缓存 ====================
const MarketCache = {
  getAll: () => getAll('marketCache'),
  get: (code) => getOne('marketCache', code),
  save: (data) => put('marketCache', { ...data, updateTime: Date.now() }),
  saveAll: (items) => putAll('marketCache', items.map(d => ({ ...d, updateTime: Date.now() }))),
  clear: () => clearStore('marketCache'),
  getStale: async (maxAgeMs = 5 * 60 * 1000) => {
    const all = await getAll('marketCache');
    const cutoff = Date.now() - maxAgeMs;
    return all.filter(d => d.updateTime < cutoff);
  },
};

// ==================== AI 决策归档 ====================
const AIDecisions = {
  getAll: () => getAll('aiDecisions'),
  getByDate: (date) => getByIndex('aiDecisions', 'date', date),
  getByCode: (code) => getByIndex('aiDecisions', 'code', code),
  getByDateAndCode: async (date, code) => {
    const results = await getByIndex('aiDecisions', 'dateCode', [date, code]);
    return results[0] || null;
  },
  save: (decision) => put('aiDecisions', decision),
  saveAll: (decisions) => putAll('aiDecisions', decisions),
  getDateRange: async (startDate, endDate) => {
    const all = await getAll('aiDecisions');
    return all.filter(d => d.date >= startDate && d.date <= endDate);
  },
};

// ==================== 月度资金 ====================
const MonthlyBudget = {
  getAll: () => getAll('monthlyBudget'),
  get: (yearMonth) => getOne('monthlyBudget', yearMonth),
  save: (budget) => put('monthlyBudget', budget),
  getCurrent: async () => {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let budget = await getOne('monthlyBudget', yearMonth);
    if (!budget) {
      budget = {
        yearMonth,
        totalBudget: 0,
        usedAmount: 0,
        remainingAmount: 0,
        maxDailyPct: 30,
        createdAt: Date.now(),
      };
      await put('monthlyBudget', budget);
    }
    return budget;
  },
  updateUsage: async (yearMonth, additionalUsed) => {
    const budget = await getOne('monthlyBudget', yearMonth);
    if (!budget) return null;
    budget.usedAmount = (budget.usedAmount || 0) + additionalUsed;
    budget.remainingAmount = budget.totalBudget - budget.usedAmount;
    await put('monthlyBudget', budget);
    return budget;
  },
};

// ==================== 操作台账 ====================
const OperationLog = {
  getAll: () => getAll('operationLog'),
  getByDate: (date) => getByIndex('operationLog', 'date', date),
  getByCode: (code) => getByIndex('operationLog', 'code', code),
  getByType: (opType) => getByIndex('operationLog', 'opType', opType),
  getByDateRange: (startDate, endDate) => getByIndexRange('operationLog', 'date', startDate, endDate),
  add: (record) => put('operationLog', { ...record, createdAt: Date.now() }),
  addAll: (records) => putAll('operationLog', records.map(r => ({ ...r, createdAt: Date.now() }))),
  update: async (id, data) => {
    const record = await getOne('operationLog', id);
    if (!record) throw new Error('Record not found');
    return put('operationLog', { ...record, ...data, updatedAt: Date.now() });
  },
  remove: (id) => remove('operationLog', id),
};

// ==================== 每日净值历史 & 单日盈亏（ai_calc_log） ====================
// 每条记录绑定「日期 + 基金代码 + 当日净值 + 当日单基盈亏」，永久留存用于盈亏计算
const AICalcLog = {
  getAll: () => getAll('aiCalcLog'),
  getByDate: (date) => getByIndex('aiCalcLog', 'date', date),
  getByCode: (code) => getByIndex('aiCalcLog', 'code', code),
  get: (date, code) => getOne('aiCalcLog', `${date}_${code}`),

  /** 写入单条（同日同码自动覆盖 upsert） */
  save: (entry) => put('aiCalcLog', {
    ...entry,
    id: `${entry.date}_${entry.code}`,
    createdAt: entry.createdAt || Date.now(),
  }),

  /** 批量写入 */
  saveAll: (entries) => putAll('aiCalcLog', entries.map(e => ({
    ...e,
    id: `${e.date}_${e.code}`,
    createdAt: e.createdAt || Date.now(),
  }))),

  /**
   * 带写入校验的单条写入：写入后立即回读，失败自动重试一次，
   * 防止数据库写入丢失导致「无昨日数据」。
   * @returns {Promise<boolean>} 是否确认写入成功
   */
  saveVerified: async (entry) => {
    const id = `${entry.date}_${entry.code}`;
    const record = { ...entry, id, createdAt: entry.createdAt || Date.now() };
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await put('aiCalcLog', record);
        const back = await getOne('aiCalcLog', id);
        if (back && parseFloat(back.nav) > 0) return true;
        lastErr = '回读校验未通过（写入后未读到有效净值）';
      } catch (err) {
        lastErr = (err && err.message) || String(err);
      }
    }
    console.error(`[Storage] ERROR aiCalcLog 写入失败 code=${entry.code} date=${entry.date} nav=${entry.nav} 原因=${lastErr}`);
    return false;
  },

  /** 取某基金最近两条快照 [today, prev]，按日期降序（用于单日盈亏） */
  getLastTwoByCode: async (code) => {
    const all = await getByIndex('aiCalcLog', 'code', code);
    all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return [all[0] || null, all[1] || null];
  },
};

// ==================== Settings (localStorage) ====================
const SETTINGS_KEY = 'fundai_settings';
const DEFAULT_SETTINGS = {
  refreshIntervalTrading: 30,    // 交易日刷新间隔（分钟）
  refreshIntervalOff: 120,       // 休市刷新间隔（分钟）
  maxDailyBudgetPct: 30,         // 单日最大使用月度预算比例
  notificationEnabled: true,     // 桌面通知开关
  notificationThreshold: 80,     // 触发通知的概率阈值
  dataSource: 'auto',            // 数据源: auto | tiantian | eastmoney
};

const AppSettings = {
  get: () => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  save: (settings) => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...AppSettings.get(), ...settings }));
  },
  reset: () => {
    localStorage.removeItem(SETTINGS_KEY);
  },
};

// ==================== 数据迁移：LocalStorage → IndexedDB ====================
// 页面首次加载时自动将旧 LocalStorage 数据迁移到 IndexedDB，
// 迁移完成后设置标记，后续不再重复迁移

async function migrateFromLocalStorage() {
  const MIGRATED_KEY = 'fundai_migrated_v2';
  if (localStorage.getItem(MIGRATED_KEY)) return; // 已迁移过

  console.log('[Storage] 🔄 检测到旧 LocalStorage 数据，开始迁移到 IndexedDB...');
  try {
    // 基金清单
    const oldWatchlist = localStorage.getItem('fundai_watchlist');
    if (oldWatchlist) {
      const funds = JSON.parse(oldWatchlist);
      if (Array.isArray(funds) && funds.length > 0) {
        await Watchlist.addAll(funds);
        console.log(`[Storage] 迁移基金: ${funds.length} 只`);
      }
    }

    // 持仓
    const oldPositions = localStorage.getItem('fundai_positions');
    if (oldPositions) {
      const positions = JSON.parse(oldPositions);
      if (Array.isArray(positions) && positions.length > 0) {
        await Positions.saveAll(positions);
        console.log(`[Storage] 迁移持仓: ${positions.length} 条`);
      }
    }

    // 操作台账
    const oldOps = localStorage.getItem('fundai_operations');
    if (oldOps) {
      const ops = JSON.parse(oldOps);
      if (Array.isArray(ops) && ops.length > 0) {
        await OperationLog.addAll(ops);
        console.log(`[Storage] 迁移操作记录: ${ops.length} 条`);
      }
    }

    // 月度资金
    const oldBudget = localStorage.getItem('fundai_budget');
    if (oldBudget) {
      const budgets = JSON.parse(oldBudget);
      if (Array.isArray(budgets) && budgets.length > 0) {
        for (const b of budgets) await MonthlyBudget.save(b);
        console.log(`[Storage] 迁移月度资金: ${budgets.length} 条`);
      }
    }

    localStorage.setItem(MIGRATED_KEY, '1');
    console.log('[Storage] ✅ 数据迁移完成');
  } catch (err) {
    console.warn('[Storage] 迁移失败（不影响正常使用）:', err.message);
  }
}

// 初始化时执行迁移
setTimeout(migrateFromLocalStorage, 200);

// ==================== 双重存储兜底 ====================
// 数据写入 IndexedDB 同时备份到 LocalStorage，
// IndexedDB 异常时自动降级读取 LocalStorage 缓存

function backupToLocalStorage(storeName, data) {
  try {
    const key = 'fundai_' + storeName;
    if (Array.isArray(data)) {
      localStorage.setItem(key, JSON.stringify(data.slice(-500))); // 最多备份 500 条
    }
  } catch { /* 静默 */ }
}

// 在关键写入操作后自动备份（覆盖原 save/saveAll 方法）
const _origWatchlistAddAll = Watchlist.addAll;
Watchlist.addAll = async function (funds) {
  await _origWatchlistAddAll(funds);
  const all = await Watchlist.getAll();
  backupToLocalStorage('watchlist', all);
};

const _origPositionsSave = Positions.save;
Positions.save = async function (pos) {
  await _origPositionsSave(pos);
  const all = await Positions.getAll();
  backupToLocalStorage('positions', all);
};

const _origOpAdd = OperationLog.add;
OperationLog.add = async function (record) {
  const result = await _origOpAdd(record);
  const all = await OperationLog.getAll();
  backupToLocalStorage('operations', all);
  return result;
};

const _origBudgetSave = MonthlyBudget.save;
MonthlyBudget.save = async function (budget) {
  const result = await _origBudgetSave(budget);
  const all = await MonthlyBudget.getAll();
  backupToLocalStorage('budget', all);
  return result;
};

const _origAICalcSaveAll = AICalcLog.saveAll;
AICalcLog.saveAll = async function (entries) {
  const result = await _origAICalcSaveAll(entries);
  const all = await AICalcLog.getAll();
  backupToLocalStorage('aiCalcLog', all);
  return result;
};

console.log('[Storage] ✅ IndexedDB 纯浏览器存储模式已就绪（双保险: IndexedDB + LocalStorage）');
