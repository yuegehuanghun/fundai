/**
 * FundAI 薄后端 — Express 服务入口（sql.js 纯 JS 版）
 * 即使数据库失败也会启动，方便排查问题
 */
try { require('dotenv').config({ path: require('path').join(__dirname, '.env') }); } catch {}

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

(async () => {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // 确保 data 目录
  const dataDir = path.join(__dirname, '..', 'data');
  try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch {}

  // ─── 数据库初始化 ────────────────────────────
  let db = null;
  try {
    const { initDB, saveToDisk } = require('./db/init');
    db = await initDB();
    console.log('[Server] ✅ SQLite 就绪');

    // 定期保存 + 优雅退出
    setInterval(() => { try { saveToDisk(db); } catch {} }, 30_000);
    const graceful = () => { try { saveToDisk(db); } catch {} process.exit(0); };
    process.on('SIGTERM', graceful);
    process.on('SIGINT', graceful);

    // 定时任务
    try {
      const { startScheduler } = require('./scheduler');
      startScheduler(db);
      console.log('[Server] ✅ 定时任务已启动');
    } catch (e) { console.error('[Server] 定时任务失败:', e.message); }

  } catch (e) {
    console.error('[Server] ⚠ 数据库初始化失败:', e.message);
    console.error('[Server] 将以无数据库模式运行');
  }

  // ─── 诊断端点 ────────────────────────────────
  app.get('/api/ping', (req, res) => {
    res.json({ pong: true, time: Date.now(), dbOk: !!db });
  });

  // ─── API 路由 ────────────────────────────────
  if (db) {
    try {
      const { router, withDB } = require('./routes/api');
      app.use('/api', withDB(db), router);
    } catch (e) {
      console.error('[Server] API 路由加载失败:', e.message);
      app.use('/api', (req, res) => res.status(500).json({ error: 'API 加载失败: ' + e.message }));
    }
  } else {
    app.use('/api', (req, res) => {
      res.status(503).json({ error: '数据库未就绪', dbOk: false });
    });
  }

  // 静态文件由 Railway 内置 fileserver 处理，Express 只负责 /api/*

  // ─── 启动 ────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[Server] 🚀 FundAI 启动 → http://localhost:${PORT}`);
    console.log(`[Server] DB: ${db ? '✅' : '❌'}  DeepSeek: ${process.env.DEEPSEEK_API_KEY ? '✅' : '⚠'}`);
  });

})().catch(e => {
  console.error('[Server] 💥 致命错误:', e.message);
  console.error(e.stack);
});
