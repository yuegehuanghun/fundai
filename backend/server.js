/**
 * FundAI 薄后端 — Express 服务入口
 *
 * 职责:
 *   - SQLite 数据持久化（替代 IndexedDB）
 *   - 服务端行情采集（HTTP 直连，无 CORS 限制）
 *   - 资讯抓取（服务端爬虫）
 *   - DeepSeek API 代理（Key 存在服务端）
 *   - 定时任务（14:30 收盘前分析、每小时行情快照）
 *   - REST API（供前端调用）
 *
 * 启动: npm start
 * 开发: npm run dev (auto-restart)
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db/init');
const { router, withDB } = require('./routes/api');
const { startScheduler } = require('./scheduler');

const PORT = process.env.PORT || 3000;

// ─── 数据库初始化 ──────────────────────────────────
const db = initDB();
console.log('[Server] SQLite 数据库就绪');

// ─── Express 配置 ─────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ─── 静态文件（前端） ──────────────────────────────
// 生产环境: 前端文件放在 ../ 即 shop 根目录
app.use(express.static(path.join(__dirname, '..')));

// ─── API 路由（注入 db） ──────────────────────────
app.use('/api', withDB(db), router);

// ─── SPA 回退: 所有非 API 请求返回 index.html ─────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ─── 启动 ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] FundAI 后端已启动 → http://localhost:${PORT}`);
  console.log(`[Server] DeepSeek: ${process.env.DEEPSEEK_API_KEY ? '✅ 已配置' : '⚠ 未配置'}`);

  // 启动定时任务
  startScheduler(db);

  // 启动时立即采集一次行情
  console.log('[Server] 启动时行情采集...');
  try {
    const watchlist = require('./db/queries').watchlist.all(db);
    if (watchlist.length) {
      const scraper = require('./services/fund-scraper');
      scraper.fetchAllFundData(watchlist.map(f => f.code)).then(results => {
        require('./db/queries').marketCache.upsertAll(db, results);
        console.log(`[Server] ✅ 初始行情采集完成: ${results.length} 只基金`);
      }).catch(e => console.error('[Server] 初始行情采集失败:', e.message));
    }
  } catch { /* 静默 */ }
});
