/**
 * FundAI 薄后端 — Express 服务入口（sql.js 纯 JS 版，零原生依赖）
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDB, saveToDisk } = require('./db/init');
const { router, withDB } = require('./routes/api');
const { startScheduler } = require('./scheduler');

const PORT = process.env.PORT || 3000;

(async () => {
  // ─── 数据库初始化（async — sql.js 加载 WASM） ──
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  let db;
  try {
    db = await initDB();
    console.log('[Server] SQLite 数据库就绪 (sql.js)');
  } catch (e) {
    console.error('[Server] 数据库初始化失败:', e.message);
    process.exit(1);
  }

  // ─── 定期持久化（每 30 秒 + 进程退出时） ──────
  setInterval(() => saveToDisk(db), 30_000);
  const graceful = () => { saveToDisk(db); process.exit(0); };
  process.on('SIGTERM', graceful);
  process.on('SIGINT', graceful);

  // ─── Express 配置 ──────────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json());

  // 诊断端点
  app.get('/api/ping', (req, res) => {
    const count = db ? db.exec('SELECT COUNT(*) as c FROM watchlist')[0].values[0][0] : 0;
    res.json({ pong: true, time: Date.now(), dbOk: true, fundCount: count });
  });

  // API 路由
  app.use('/api', withDB(db), router);

  // 静态文件（前端）
  app.use(express.static(path.join(__dirname, '..')));

  // SPA 回退
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return;
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  });

  // ─── 启动 ─────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[Server] FundAI 后端已启动 → http://localhost:${PORT}`);
    console.log(`[Server] DeepSeek: ${process.env.DEEPSEEK_API_KEY ? '✅ 已配置' : '⚠ 未配置'}`);

    // 启动定时任务
    startScheduler(db);

    // 启动时采集一次行情
    try {
      const watchlist = require('./db/queries').watchlist.all(db);
      if (watchlist.length) {
        const scraper = require('./services/fund-scraper');
        scraper.fetchAllFundData(watchlist.map(f => f.code)).then(results => {
          require('./db/queries').marketCache.upsertAll(db, results);
          console.log(`[Server] ✅ 初始行情采集: ${results.length} 只基金`);
        }).catch(e => console.error('[Server] 行情采集失败:', e.message));
      }
    } catch { /* 静默 */ }
  });
})();
