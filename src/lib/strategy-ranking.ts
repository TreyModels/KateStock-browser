import type { Strategy, StrategyAction } from '@/types'
import type { MarketRegime } from './regime.ts'
import { profileFor, type RegimeProfile } from './regime-filter.ts'

/**
 * 策略排名计算层（task-27）：「今日哪种策略在发力」+ 适配度评分。
 *
 * 用户需求：今日页第一屏展示策略排名（买/卖/持），带置信度。
 * 本模块是纯计算层（不碰 DOM/React/网络），UI 直接消费 rankStrategies 的返回值。
 *
 * ⚠️ 语义：confidence 是「当前市场状态下的**适配度**」，不是胜率、不是收益率预测。
 *   公式（权重重心已固定；证据表采用 task-26 robustness-gate 结论）：
 *     confidence = round(100 × (0.55×fit + 0.25×evidence + 0.20×activity))，再按证据封顶
 *   - fit：该策略在当前 regime 的适配分（0-1，FIT_TABLE）
 *   - evidence：稳健性门槛状态（PASS 1.0 / PARTIAL 0.7 / UNKNOWN 0.45 / FAIL 0.1）
 *   - activity：当前清单命中率 = min(1, matched / 3)（3 只封顶，避免「命中多=高分」）
 *   - 证据封顶（EVIDENCE_CAPS）：UNKNOWN ≤55、PARTIAL ≤80、PASS 不封顶 ——
 *     避免把未验证的策略显示得像已验证；reasons 第一条固定为「证据：…」标签。
 *
 * matched 统计使用**未过滤**的原始策略（按 action 计数）。这样熊市里
 * 「2 只回踩形态」仍会被如实统计并展示为「不采信」，而不是被过滤后看不到。
 */

/* ─────────────────────────────────────────────────────────────
 * 契约类型（UI 消费，字段名不得改）
 * ───────────────────────────────────────────────────────────── */

export type StrategyScoreId = 'stop' | 'reduce' | 'hold' | 'pullback' | 'breakout' | 'reversion' | 'watch'
export type StrategyScoreStatus = 'active' | 'degraded' | 'blocked'
export type EvidenceState = 'PASS' | 'PARTIAL' | 'UNKNOWN' | 'FAIL'

export interface StrategyScore {
  id: StrategyScoreId
  /** 中文标签：止损管理 / 逢高减仓 / 持有待涨 / 回踩低吸 / 突破跟随 / 超跌反弹 / 观望等待 */
  label: string
  action: StrategyAction
  status: StrategyScoreStatus
  /** 0-100「适配度」，不是胜率。 */
  confidence: number
  /** 当前清单中命中该策略的股票数（基于未过滤策略、按 action 计数）。 */
  matched: number
  /** 2-3 条中文依据。 */
  reasons: string[]
  /** 来自稳健性门槛（暂用内置 provisional 表）。 */
  evidence: EvidenceState
}

export interface RankStrategiesInput {
  /** 未过滤的原始策略（用于统计 matched）。 */
  strategies: Strategy[]
  regime: MarketRegime
  /** 可选；缺省用 profileFor(regime)。 */
  profile?: RegimeProfile
  /** 可选；市场宽度（0-100），用于原因文案。 */
  breadthPct?: number
}

/* ─────────────────────────────────────────────────────────────
 * 权重 / 证据 / 适配表（集中常量；robustness-gate.md 结论已落入证据表）
 * ───────────────────────────────────────────────────────────── */

/** 加权系数：适配度权重最高，稳健性其次，活跃度只占 20%。 */
export const RANKING_WEIGHTS = {
  fit: 0.55,
  evidence: 0.25,
  activity: 0.2,
} as const

/** 稳健性门槛状态 → 分数。 */
export const EVIDENCE_WEIGHTS: Record<EvidenceState, number> = {
  PASS: 1.0,
  PARTIAL: 0.7,
  UNKNOWN: 0.45,
  FAIL: 0.1,
}

/**
 * 证据封顶：避免「未验证/部分验证」的策略在适配度公式下被算得像已验证。
 * - UNKNOWN → 上限 55（缺 ≥5 年扣费样本，不能显示成已验证）
 * - PARTIAL → 上限 80
 * - PASS → 不封顶（null）
 * - FAIL → 沿用未验证封顶 55（当前证据表未使用 FAIL）
 */
export const EVIDENCE_CAPS: Record<EvidenceState, number | null> = {
  PASS: null,
  PARTIAL: 80,
  UNKNOWN: 55,
  FAIL: 55,
}

/** 证据状态中文标签（UI 徽标用，如「证据：未验证」）。 */
export const EVIDENCE_LABELS: Record<EvidenceState, string> = {
  PASS: '通过',
  PARTIAL: '部分通过',
  UNKNOWN: '未验证',
  FAIL: '未通过',
}

/**
 * 真实证据表（来自 task-26 robustness-gate 结论）：
 * - stop PASS：仅作风控纪律，不是 alpha；
 * - watch PASS：平凡通过（不交易是默认）；
 * - reduce UNKNOWN：当前没有 reduce 独立提醒；
 * - hold UNKNOWN：无法单独检验；
 * - pullback UNKNOWN：A 股短期反转有先验，但本应用 5-20 日均线回调不是文献检验口径；
 * - breakout UNKNOWN：A 股动量先验偏弱；
 * - reversion UNKNOWN：且当前代码不可实现。
 */
export const EVIDENCE_TABLE: Record<StrategyScoreId, EvidenceState> = {
  stop: 'PASS',
  reduce: 'UNKNOWN',
  hold: 'UNKNOWN',
  pullback: 'UNKNOWN',
  breakout: 'UNKNOWN',
  reversion: 'UNKNOWN',
  watch: 'PASS',
}

/**
 * regime 适配分（0-1）。任务给定值：
 *   bear: stop .95 / reduce .80 / hold .55 / watch .50 / reversion .35 / pullback .10 / breakout .05
 *   range: pullback .75 / breakout .60 / hold .60 / reduce .65 / stop .90 / reversion .55（watch .55 为补全值）
 *   bull: breakout .90 / pullback .80 / hold .75 / stop .85 / reduce .70 / reversion .30（watch .40 为补全值）
 */
export const FIT_TABLE: Record<MarketRegime, Record<StrategyScoreId, number>> = {
  bear: {
    stop: 0.95,
    reduce: 0.8,
    hold: 0.55,
    watch: 0.5,
    reversion: 0.35,
    pullback: 0.1,
    breakout: 0.05,
  },
  range: {
    stop: 0.9,
    reduce: 0.65,
    hold: 0.6,
    watch: 0.55,
    reversion: 0.55,
    pullback: 0.75,
    breakout: 0.6,
  },
  bull: {
    stop: 0.85,
    reduce: 0.7,
    hold: 0.75,
    watch: 0.4,
    reversion: 0.3,
    pullback: 0.8,
    breakout: 0.9,
  },
}

/** activity 满分所需的命中数（3 只封顶）。 */
export const ACTIVITY_FULL_MATCHED = 3

/** 策略表：固定 7 行（含回测专用的 reversion）。 */
interface StrategyRow {
  id: StrategyScoreId
  label: string
  action: StrategyAction
  /** 是否买入类（bear 禁买 / range 半仓作用于买入类）。 */
  isBuy: boolean
}

export const STRATEGY_ROWS: readonly StrategyRow[] = [
  { id: 'stop', label: '止损管理', action: 'stop', isBuy: false },
  { id: 'reduce', label: '逢高减仓', action: 'reduce', isBuy: false },
  { id: 'hold', label: '持有待涨', action: 'hold', isBuy: false },
  { id: 'pullback', label: '回踩低吸', action: 'pullback', isBuy: true },
  { id: 'breakout', label: '突破跟随', action: 'breakout', isBuy: true },
  // reversion（超跌反弹）只在回测里存在，StrategyAction 没有对应值：
  // 这里用 'watch' 占位，matched 恒为 0（见 matchedFor）。
  { id: 'reversion', label: '超跌反弹', action: 'watch', isBuy: true },
  { id: 'watch', label: '观望等待', action: 'watch', isBuy: false },
]

const REGIME_LABELS: Record<MarketRegime, string> = {
  bull: '牛市',
  range: '震荡市',
  bear: '熊市',
}

/** 每种策略在各 regime 下的一句中文解释。 */
const ROW_HINTS: Record<MarketRegime, Record<StrategyScoreId, string>> = {
  bear: {
    stop: '止损管理优先级最高，先控回撤',
    reduce: '逢高减仓优先，提前、分批锁定风险',
    hold: '只限已有持仓且结构未破，不加仓',
    pullback: '回踩低吸在熊市容易接飞刀',
    breakout: '突破跟随是牛市工具，熊市关闭',
    reversion: '超跌反弹需三重确认，代码尚未实现',
    watch: '现金也是仓位，等待宽度修复',
  },
  range: {
    stop: '止损管理不受震荡影响',
    reduce: '逢高减仓可正常执行',
    hold: '持有待涨可正常执行',
    pullback: '回踩确认后可用半仓参与',
    breakout: '突破信号降级处理，确认后再动',
    reversion: '均值回归策略仅回测验证',
    watch: '无确认信号时观望',
  },
  bull: {
    stop: '止损管理保持不变',
    reduce: '逢高减仓保持不变',
    hold: '持有待涨正常执行',
    pullback: '回踩低吸正常执行',
    breakout: '突破跟随正常执行',
    reversion: '超跌反弹仅回测验证',
    watch: '无信号时等待，保留现金机动',
  },
}

/* ─────────────────────────────────────────────────────────────
 * 内部计算
 * ───────────────────────────────────────────────────────────── */

function isMarketRegime(value: unknown): value is MarketRegime {
  return value === 'bull' || value === 'range' || value === 'bear'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** activity = min(1, matched / max(1, 3))。 */
function activityOf(matched: number): number {
  return Math.min(1, matched / Math.max(1, ACTIVITY_FULL_MATCHED))
}

/** 该策略在当前 regime 下是否允许买入。 */
function isBuyAllowed(row: StrategyRow, profile: RegimeProfile): boolean {
  if (row.id === 'breakout') return profile.allowBreakout && profile.sizeMultiplier > 0
  if (row.id === 'pullback') return profile.allowPullback && profile.sizeMultiplier > 0
  return profile.sizeMultiplier > 0
}

function statusOf(row: StrategyRow, profile: RegimeProfile): StrategyScoreStatus {
  if (!row.isBuy) return 'active'
  if (!isBuyAllowed(row, profile)) return 'blocked'
  return profile.sizeMultiplier < 1 ? 'degraded' : 'active'
}

/** matched：按未过滤策略的 action 计数；reversion 无实盘 action，恒 0。 */
function matchedFor(row: StrategyRow, strategies: Strategy[]): number {
  if (row.id === 'reversion') return 0
  let count = 0
  for (const strategy of strategies) {
    if (strategy.action === row.action) count += 1
  }
  return count
}

function confidenceOf(fit: number, evidence: EvidenceState, matched: number): number {
  const value =
    100 *
    (RANKING_WEIGHTS.fit * fit +
      RANKING_WEIGHTS.evidence * EVIDENCE_WEIGHTS[evidence] +
      RANKING_WEIGHTS.activity * activityOf(matched))
  const raw = clamp(Math.round(value), 0, 100)
  // 证据封顶：未验证 ≤55、部分验证 ≤80、PASS 不封顶
  const cap = EVIDENCE_CAPS[evidence]
  return cap === null ? raw : Math.min(cap, raw)
}

/** 证据标签文案（reasons 必须包含「证据：…」；UI 徽标另有 evidence 字段）。 */
function evidenceReason(row: StrategyRow, evidence: EvidenceState): string {
  const label = `证据：${EVIDENCE_LABELS[evidence]}`
  if (evidence === 'PASS') {
    return row.id === 'stop' ? `${label}（仅作风控纪律，不是 alpha）` : `${label}（不交易是默认，平凡通过）`
  }
  if (evidence === 'PARTIAL') return `${label}（样本不足，需补检验）`
  if (evidence === 'FAIL') return `${label}（稳健性门槛未过）`
  return `${label}（缺 ≥5 年扣费样本）`
}

function reasonsFor(
  row: StrategyRow,
  regime: MarketRegime,
  status: StrategyScoreStatus,
  matched: number,
  profile: RegimeProfile,
  breadthPct: number | undefined,
  evidence: EvidenceState,
): string[] {
  const regimeLabel = REGIME_LABELS[regime]
  // 第 1 条：证据标签（必须出现，UI 也有 evidence 徽标）
  const reasons: string[] = [evidenceReason(row, evidence)]

  // 第 2 条：regime 下的状态解释
  if (status === 'blocked') {
    reasons.push(`${regimeLabel}：买入类策略禁用（现金下限 ${profile.cashPct}%）`)
  } else if (status === 'degraded') {
    reasons.push(`${regimeLabel}：半仓降级（仓位系数 ${profile.sizeMultiplier}）`)
  } else if (row.isBuy) {
    reasons.push(`${regimeLabel}：买入类策略可执行`)
  } else {
    reasons.push(`${regimeLabel}：${row.label}适用当前环境`)
  }

  // 第 3 条：命中情况 + 宽度（合并为一行为，保持 2-3 条）
  const detail: string[] = []
  if (matched > 0) {
    detail.push(
      status === 'blocked'
        ? `当前 ${matched} 只${row.label}形态，${regimeLabel}不采信`
        : `当前清单 ${matched} 只${row.label}形态`,
    )
  } else {
    detail.push(ROW_HINTS[regime][row.id])
  }
  if (typeof breadthPct === 'number' && Number.isFinite(breadthPct)) {
    detail.push(
      breadthPct >= 60
        ? `宽度 ${breadthPct.toFixed(1)}% 高于 60%，广度修复`
        : `宽度 ${breadthPct.toFixed(1)}% 低于 60%`,
    )
  }
  reasons.push(detail.join('；'))

  return reasons
}

/* ─────────────────────────────────────────────────────────────
 * 入口
 * ───────────────────────────────────────────────────────────── */

/**
 * 策略排名（纯函数、不可变）。
 *
 * - 基于未过滤 strategies 统计 matched（bear 下买入类也会如实计数，但 status=blocked 且文案「不采信」）。
 * - confidence 为 0-100 适配度；排序：confidence 降序，同分按 fit 降序（再同则按策略表顺序稳定排序）。
 * - 始终返回 7 行常量策略表。
 * - regime 缺省/非法时按 'range' 处理（与 regime.ts 的兜底一致）。
 */
export function rankStrategies(input: RankStrategiesInput): StrategyScore[] {
  const strategies = Array.isArray(input.strategies) ? input.strategies : []
  const regime = isMarketRegime(input.regime) ? input.regime : 'range'
  const profile = input.profile ?? profileFor(regime)
  const breadthPct = input.breadthPct

  const ranked = STRATEGY_ROWS.map((row) => {
    const fit = FIT_TABLE[regime][row.id]
    const evidence = EVIDENCE_TABLE[row.id]
    const matched = matchedFor(row, strategies)
    const status = statusOf(row, profile)
    const score: StrategyScore = {
      id: row.id,
      label: row.label,
      action: row.action,
      status,
      confidence: confidenceOf(fit, evidence, matched),
      matched,
      reasons: reasonsFor(row, regime, status, matched, profile, breadthPct, evidence),
      evidence,
    }
    return { score, fit }
  })

  ranked.sort((left, right) => {
    const byConfidence = right.score.confidence - left.score.confidence
    if (byConfidence !== 0) return byConfidence
    return right.fit - left.fit
  })

  return ranked.map((entry) => entry.score)
}
