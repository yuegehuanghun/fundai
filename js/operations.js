/**
 * 操作台账 & 收益记录 & AI 复盘统计
 *
 * 功能:
 *   1. 每日手动录入操作（单只/批量）
 *   2. 按日期/基金/操作类型筛选历史
 *   3. AI 复盘: 对比历史建议 vs 实际操作 vs 最终盈亏
 *   4. 简单文字总结成功率
 */

const Operations = {

  /**
   * 录入单条操作记录
   * @param {Object} record - { date, code, opType, amount, shares, dailyProfit, fundProfit, notes }
   */
  async addRecord(record) {
    const data = {
      date: record.date || new Date().toISOString().slice(0, 10),
      code: record.code || '',
      opType: record.opType || 'none',  // buy | sell | auto | none
      amount: parseFloat(record.amount) || 0,
      shares: parseFloat(record.shares) || 0,
      dailyProfit: parseFloat(record.dailyProfit) || 0,     // 当日账户总收益
      fundProfit: parseFloat(record.fundProfit) || 0,        // 单只盈亏
      notes: record.notes || '',
      createdAt: Date.now(),
    };
    return OperationLog.add(data);
  },

  /**
   * 批量录入
   * @param {Array} records
   */
  async addRecords(records) {
    const data = records.map(r => ({
      date: r.date || new Date().toISOString().slice(0, 10),
      code: r.code || '',
      opType: r.opType || 'none',
      amount: parseFloat(r.amount) || 0,
      shares: parseFloat(r.shares) || 0,
      dailyProfit: parseFloat(r.dailyProfit) || 0,
      fundProfit: parseFloat(r.fundProfit) || 0,
      notes: r.notes || '',
      createdAt: Date.now(),
    }));
    return OperationLog.addAll(data);
  },

  /**
   * 获取指定日期的所有操作记录
   * @param {string} date - YYYY-MM-DD
   */
  async getByDate(date) {
    return OperationLog.getByDate(date);
  },

  /**
   * 按条件筛选记录
   * @param {Object} filters - { startDate, endDate, code, opType }
   */
  async query(filters = {}) {
    let records;

    if (filters.startDate && filters.endDate) {
      records = await OperationLog.getByDateRange(filters.startDate, filters.endDate);
    } else if (filters.date) {
      records = await OperationLog.getByDate(filters.date);
    } else {
      records = await OperationLog.getAll();
    }

    // 客户端进一步筛选
    if (filters.code) {
      records = records.filter(r => r.code === filters.code);
    }
    if (filters.opType) {
      records = records.filter(r => r.opType === filters.opType);
    }

    // 按日期降序排列
    records.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    return records;
  },

  /**
   * 获取今日操作摘要
   */
  async getTodaySummary() {
    const today = new Date().toISOString().slice(0, 10);
    const records = await OperationLog.getByDate(today);

    let totalBuy = 0, totalSell = 0, totalAuto = 0;
    let totalProfit = 0;
    const operatedCodes = new Set();

    for (const r of records) {
      operatedCodes.add(r.code);
      totalProfit += r.dailyProfit || 0;
      if (r.opType === 'buy') totalBuy += r.amount || 0;
      else if (r.opType === 'sell') totalSell += r.amount || 0;
      else if (r.opType === 'auto') totalAuto += r.amount || 0;
    }

    return {
      date: today,
      totalRecords: records.length,
      operatedFunds: operatedCodes.size,
      totalBuyAmount: totalBuy,
      totalSellAmount: totalSell,
      totalAutoAmount: totalAuto,
      totalProfit: Math.round(totalProfit * 100) / 100,
    };
  },

  /**
   * AI 复盘统计
   *
   * 对比逻辑:
   *   1. 找到每天每只基金的 AI 建议和实际操作
   *   2. 如果操作方向与 AI 建议一致 → "听从建议"
   *   3. 统计听从建议后的平均收益 vs 未听从的平均收益
   *   4. 计算 AI 建议成功率
   *
   * @param {number} lookbackDays - 回看天数（默认 90）
   * @returns {Object} 复盘统计结果
   */
  async runReview(lookbackDays = 90) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - lookbackDays);
    const startDateStr = startDate.toISOString().slice(0, 10);
    const endDateStr = new Date().toISOString().slice(0, 10);

    // 获取 AI 决策历史
    const aiDecisions = await AIDecisions.getDateRange(startDateStr, endDateStr);

    // 获取操作记录
    const operations = await OperationLog.getByDateRange(startDateStr, endDateStr);

    // 按 (date, code) 匹配 AI 建议和实际操作
    const matches = [];
    let followedCount = 0;
    let notFollowedCount = 0;
    let followedProfit = 0;
    let notFollowedProfit = 0;

    const aiMap = {};
    for (const d of aiDecisions) {
      const key = `${d.date}|${d.code}`;
      aiMap[key] = d;
    }

    for (const op of operations) {
      const key = `${op.date}|${op.code}`;
      const ai = aiMap[key];

      if (!ai) continue; // 没有 AI 建议的操作，跳过

      const opDirection = op.opType === 'buy' || op.opType === 'auto' ? 'buy'
        : op.opType === 'sell' ? 'sell' : 'hold';

      const aiDirection = ai.action.includes('buy') ? 'buy'
        : ai.action.includes('sell') ? 'sell' : 'hold';

      const followed = opDirection === aiDirection;
      const profit = op.fundProfit || 0;

      matches.push({
        date: op.date,
        code: op.code,
        aiDirection,
        opDirection,
        followed,
        aiBuyPct: ai.buyPct,
        aiSellPct: ai.sellPct,
        profit,
      });

      if (followed) {
        followedCount++;
        followedProfit += profit;
      } else {
        notFollowedCount++;
        notFollowedProfit += profit;
      }
    }

    const totalMatched = followedCount + notFollowedCount;
    const followRate = totalMatched > 0 ? Math.round((followedCount / totalMatched) * 100) : 0;
    const avgFollowedProfit = followedCount > 0 ? Math.round((followedProfit / followedCount) * 100) / 100 : 0;
    const avgNotFollowedProfit = notFollowedCount > 0 ? Math.round((notFollowedProfit / notFollowedCount) * 100) / 100 : 0;

    // 成功次数: 听从建议且收益为正
    const successCount = matches.filter(m => m.followed && m.profit > 0).length;
    const successRate = followedCount > 0 ? Math.round((successCount / followedCount) * 100) : 0;

    // 生成文字总结
    let summary = '';
    if (totalMatched === 0) {
      summary = '暂无足够数据生成复盘统计。请持续录入每日操作与收益，系统将自动对比 AI 建议与实际效果。';
    } else {
      const comparison = avgFollowedProfit > avgNotFollowedProfit
        ? `听从 AI 建议的平均单次收益（${avgFollowedProfit} 元）高于未听从（${avgNotFollowedProfit} 元）`
        : `听从 AI 建议的平均单次收益（${avgFollowedProfit} 元）低于未听从（${avgNotFollowedProfit} 元）`;

      summary = `过去 ${lookbackDays} 天中，共发生 ${totalMatched} 次可比操作。`
        + `其中 ${followedCount} 次（${followRate}%）遵循了 AI 建议，`
        + `${successCount} 次获得正收益，成功率 ${successRate}%。`
        + comparison + '。';
    }

    return {
      lookbackDays,
      period: `${startDateStr} ~ ${endDateStr}`,
      totalMatched,
      followedCount,
      notFollowedCount,
      followRate,
      successCount,
      successRate,
      avgFollowedProfit,
      avgNotFollowedProfit,
      summary,
      matches: matches.slice(0, 100), // 最多返回 100 条详细记录
    };
  },

  /**
   * 删除操作记录
   */
  async deleteRecord(id) {
    return OperationLog.remove(id);
  },

  /**
   * 更新操作记录
   */
  async updateRecord(id, data) {
    return OperationLog.update(id, data);
  },
};
