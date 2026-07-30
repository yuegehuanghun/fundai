/**
 * 月度资金管理 & 智能加仓金额分配
 *
 * 规则:
 *   1. 每月独立额度，不累计叠加
 *   2. 单日加仓总额 ≤ 月度总额 × 自定义比例（默认 30%）
 *   3. 单只基金分配金额 ∝ 该基金加仓概率 / 所有加仓概率之和
 *   4. 剩余资金自动留存，后续触发高分时再分配
 */

const BudgetManager = {

  /** 默认单日最大使用比例 */
  DEFAULT_MAX_DAILY_PCT: 30,

  /**
   * 获取当前月度预算
   * @returns {Promise<Object>} { yearMonth, totalBudget, usedAmount, remainingAmount, maxDailyPct }
   */
  async getCurrentBudget() {
    return MonthlyBudget.getCurrent();
  },

  /**
   * 设置月度总预算
   * @param {number} totalBudget - 当月可投入总金额
   * @param {number} maxDailyPct - 单日最大使用比例（默认 30）
   */
  async setMonthlyBudget(totalBudget, maxDailyPct) {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const pct = maxDailyPct || BudgetManager.DEFAULT_MAX_DAILY_PCT;

    const existing = await MonthlyBudget.get(yearMonth);

    const budget = {
      yearMonth,
      totalBudget: parseFloat(totalBudget) || 0,
      usedAmount: existing ? (existing.usedAmount || 0) : 0,
      remainingAmount: (parseFloat(totalBudget) || 0) - (existing ? (existing.usedAmount || 0) : 0),
      maxDailyPct: pct,
      updatedAt: Date.now(),
      createdAt: existing ? existing.createdAt : Date.now(),
    };

    await MonthlyBudget.save(budget);
    return budget;
  },

  /**
   * 计算当日可用于加仓的最大金额
   * @returns {Promise<number>}
   */
  async getDailyMaxAllocation() {
    const budget = await MonthlyBudget.getCurrent();
    if (!budget || !budget.totalBudget) return 0;

    const maxDaily = budget.totalBudget * (budget.maxDailyPct / 100);
    const remaining = budget.totalBudget - (budget.usedAmount || 0);

    // 单日上限 与 剩余额度 取较小值
    return Math.min(maxDaily, Math.max(0, remaining));
  },

  /**
   * 智能分配加仓金额
   *
   * 输入: AI 分析结果列表（包含每只基金的加仓概率）
   * 输出: 每只基金的推荐加仓金额
   *
   * @param {Array} decisions - AI 决策结果列表
   * @returns {Promise<Object>} { allocations, dailyTotal, dailyLimit, remainingAfter }
   */
  async allocateAmounts(decisions) {
    const budget = await MonthlyBudget.getCurrent();
    const dailyLimit = await BudgetManager.getDailyMaxAllocation();

    // 筛选出建议加仓的基金（action 包含 'buy'）
    const buyCandidates = decisions.filter(d =>
      d.action === 'buy' || d.action === 'buy_strong'
    );

    if (buyCandidates.length === 0 || dailyLimit <= 0) {
      return {
        allocations: decisions.map(d => ({ ...d, recommendAmount: 0, allocationNote: '' })),
        dailyTotal: 0,
        dailyLimit,
        remainingAfter: budget.totalBudget - (budget.usedAmount || 0),
        budget,
      };
    }

    // 按加仓概率加权分配
    const totalBuyPct = buyCandidates.reduce((sum, d) => sum + d.buyPct, 0);

    const allocations = decisions.map(d => {
      if (d.action === 'buy' || d.action === 'buy_strong') {
        // 按概率占比分配
        const weight = d.buyPct / totalBuyPct;
        const rawAmount = dailyLimit * weight;

        // 取整到 10 元
        const amount = Math.round(rawAmount / 10) * 10;

        // 最小加仓 100 元，避免零碎
        const finalAmount = amount >= 100 ? amount : 0;

        return {
          ...d,
          recommendAmount: finalAmount,
          allocationWeight: Math.round(weight * 100),
          allocationNote: `本次加仓消耗当月可用资金 ${Math.round(weight * budget.maxDailyPct)}%`,
        };
      } else {
        return { ...d, recommendAmount: 0, allocationNote: '' };
      }
    });

    const dailyTotal = allocations.reduce((sum, d) => sum + (d.recommendAmount || 0), 0);
    const remainingAfter = budget.totalBudget - (budget.usedAmount || 0) - dailyTotal;

    return {
      allocations,
      dailyTotal,
      dailyLimit,
      remainingAfter: Math.max(0, remainingAfter),
      budget,
    };
  },

  /**
   * 记录加仓消耗（用户确认操作后调用）
   * @param {number} amount - 本次实际加仓总金额
   */
  async recordUsage(amount) {
    const budget = await MonthlyBudget.getCurrent();
    return MonthlyBudget.updateUsage(budget.yearMonth, parseFloat(amount) || 0);
  },

  /**
   * 检查是否还有可用资金
   * @returns {Promise<{hasFunds: boolean, remaining: number, dailyLimit: number}>}
   */
  async checkAvailability() {
    const budget = await MonthlyBudget.getCurrent();
    const dailyLimit = await BudgetManager.getDailyMaxAllocation();
    const remaining = budget.totalBudget - (budget.usedAmount || 0);

    return {
      hasFunds: remaining > 0 && dailyLimit > 0,
      remaining: Math.max(0, remaining),
      dailyLimit,
      totalBudget: budget.totalBudget,
      usedAmount: budget.usedAmount || 0,
      maxDailyPct: budget.maxDailyPct || BudgetManager.DEFAULT_MAX_DAILY_PCT,
    };
  },

  /**
   * 月初自动重置：如果上个月的额度没用完，不累计，清零后由用户重新设置
   * 这个方法在每天首次加载时调用，检测是否需要提醒用户设置新月度额度
   */
  async checkMonthRollover() {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const budget = await MonthlyBudget.get(yearMonth);

    // 如果当月预算不存在，检查上月是否有预算并提醒
    if (!budget || budget.totalBudget === 0) {
      // 检查上月
      const lastMonth = now.getMonth() === 0
        ? `${now.getFullYear() - 1}-12`
        : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`;
      const lastBudget = await MonthlyBudget.get(lastMonth);

      return {
        needsSetup: true,
        lastMonthBudget: lastBudget ? lastBudget.totalBudget : 0,
        lastMonthRemaining: lastBudget ? lastBudget.totalBudget - (lastBudget.usedAmount || 0) : 0,
      };
    }

    return { needsSetup: false };
  },
};
