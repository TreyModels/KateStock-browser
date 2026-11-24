import type { Strategy } from '@/types'
import type { MarketRegime } from './regime.ts'

/**
 * Regime 过滤器（task-24）：「熊市禁买 / 震荡半仓 / 牛市不变」落到代码。
 *
 * 背景：docs/research/strategies.md 的 playbook + docs/research/regime.md 的判定。
 * 本模块是纯函数层（不碰 DOM/React、不发请求），供 UI 在展示/提醒前对 generateStrategy
 * 产出的策略列表做 regime 过滤；**不改 EOD 策略算法与回测语义**（strategy.ts 不动）。
 *
 * 契约（UI 按此接线，字段名不得改）：
 *   profileFor(regime) → 三档仓位配置
 *   applyRegimeFilter(strategies, regime) → 新数组（不可变），bear 禁买、range 半仓、bull 不变
 *   regimeVerdict(regime) → 行动卡中文文案
 *
 * 说明：交易信号来自 EOD 策略引擎，regime 只做「阀门」：
 * - bear：breakout / pullback 一律降级为 watch（现金也是仓位）；
 * - range：保留买入计划，但建议仓位 ×0.5 并向下取整到 100 股；
 * - bull：原样（仅做不可变拷贝）。
 */

/** 三档市场状态对应的仓位配置（数值来自 docs/research/strategies.md 决策表）。 */
export interface RegimeProfile {
  regime: MarketRegime
  /** 股票总仓位上限（%）。 */
  maxEquityPct: number
  /** 建议基准仓位（%）。 */
  baselineEquityPct: number
  /** 现金下限（%）。 */
  cashPct: number
  /** 单票上限（%）。 */
  maxPerNamePct: number
  /** 同时持仓数上限。 */
  maxPositions: number
  allowBreakout: boolean
  allowPullback: boolean
  /** 买入仓位系数（bear 0 / range 0.5 / bull 1）。 */
  sizeMultiplier: number
  /** 中文说明。 */
  notes: string[]
}

/** 行动卡文案（headline + 今天做/不做）。 */
export interface RegimeVerdict {
  headline: string
  doToday: string[]
  dontToday: string[]
}

export const REGIME_PROFILES: Record<MarketRegime, RegimeProfile> = {
  bear: {
    regime: 'bear',
    maxEquityPct: 30,
    baselineEquityPct: 20,
    cashPct: 70,
    maxPerNamePct: 6,
    maxPositions: 2,
    allowBreakout: false,
    allowPullback: false,
    sizeMultiplier: 0,
    notes: [
      '熊市：只做止损/减仓，不开新仓',
      '现金 ≥70%，单票 ≤6%，同时持仓 ≤2 只',
      '等 MA60 回升与市场宽度修复后再考虑买入',
    ],
  },
  range: {
    regime: 'range',
    maxEquityPct: 60,
    baselineEquityPct: 45,
    cashPct: 40,
    maxPerNamePct: 8,
    maxPositions: 4,
    allowBreakout: true,
    allowPullback: true,
    sizeMultiplier: 0.5,
    notes: [
      '震荡市：只做半仓回踩，突破降级',
      '现金 30–50%，单票 ≤8%，同时持仓 ≤4 只',
      '回踩需确认，别追高',
    ],
  },
  bull: {
    regime: 'bull',
    maxEquityPct: 100,
    baselineEquityPct: 80,
    cashPct: 20,
    maxPerNamePct: 10,
    maxPositions: 6,
    allowBreakout: true,
    allowPullback: true,
    sizeMultiplier: 1,
    notes: [
      '牛市：突破/回踩正常执行',
      '保留 10–20% 现金机动，单票 ≤10%，同时持仓 ≤6 只',
    ],
  },
}

export const REGIME_VERDICTS: Record<MarketRegime, RegimeVerdict> = {
  bear: {
    headline: '熊市：禁止新买入，只做止损/减仓',
    doToday: [
      '执行止损/减仓纪律，保护本金',
      '保持现金 ≥70%（基准仓位 20%，上限 30%）',
      '跟踪 MA60 回升与市场宽度修复，等确认再买',
    ],
    dontToday: ['不追突破（breakout 已关闭）', '不抄底回踩（pullback 已关闭）', '不满仓、不因超跌盲目补仓'],
  },
  range: {
    headline: '震荡市：半仓参与，等待确认',
    doToday: [
      '只做回踩确认后的半仓买入（仓位系数 0.5）',
      '单票 ≤8%，同时持仓 ≤4 只，股票仓位 ≤60%',
      '保留 30–50% 现金',
    ],
    dontToday: ['不追高突破（突破信号降级处理）', '不满仓、不加杠杆'],
  },
  bull: {
    headline: '牛市：按计划执行突破/回踩',
    doToday: [
      '突破/回踩按计划执行，仓位系数 1',
      '单票 ≤10%，同时持仓 ≤6 只，股票仓位 ≤100%',
      '保留 10–20% 现金机动',
    ],
    dontToday: ['不追偏离均线过远的个股', '不一次性满仓'],
  },
}

/** 熊市降级后的卡片文案（契约固定）。 */
const BEAR_ACTION_LABEL = '熊市观望'
const BEAR_SUMMARY = '熊市禁止新买入：等 MA60 回升与宽度修复'
/** range 半仓提示理由（契约固定）。 */
const RANGE_REASON = '震荡市半仓'

const BUY_ACTIONS: ReadonlySet<Strategy['action']> = new Set(['breakout', 'pullback'])

function isMarketRegime(value: unknown): value is MarketRegime {
  return value === 'bull' || value === 'range' || value === 'bear'
}

/** 取某档配置（返回副本，调用方修改不影响模块常量）。 */
export function profileFor(regime: MarketRegime): RegimeProfile {
  const profile = isMarketRegime(regime) ? REGIME_PROFILES[regime] : REGIME_PROFILES.range
  return { ...profile, notes: [...profile.notes] }
}

/** 取行动卡文案（返回副本，数组/字符串不可被调用方改坏）。 */
export function regimeVerdict(regime: MarketRegime): RegimeVerdict {
  const verdict = isMarketRegime(regime) ? REGIME_VERDICTS[regime] : REGIME_VERDICTS.range
  return { headline: verdict.headline, doToday: [...verdict.doToday], dontToday: [...verdict.dontToday] }
}

/** 浅拷贝策略（reasons 也复制，保证不改输入）。 */
function cloneStrategy(strategy: Strategy): Strategy {
  return { ...strategy, reasons: [...strategy.reasons] }
}

/** 半仓建议股数：×0.5 后向下取整到 100 股。 */
function halfLotShares(shares: number): number {
  if (!Number.isFinite(shares) || shares <= 0) return 0
  return Math.floor((shares * 0.5) / 100) * 100
}

function halfPct(pct: number): number {
  if (!Number.isFinite(pct)) return pct
  return Math.round(pct * 0.5 * 100) / 100
}

/**
 * 按 regime 过滤策略列表（纯函数、不可变）。
 *
 * - bear：breakout / pullback → action='watch'、actionLabel='熊市观望'、
 *   summary 改为禁买文案、suggestedShares/Pct 清空、reasons 追加 profile 理由；score 保留。
 *   hold / reduce / stop / watch 原样。
 * - range：breakout / pullback 保留，suggestedShares/Pct ×0.5（股数向下取整到 100 股），
 *   reasons 追加「震荡市半仓」；其他动作原样。
 * - bull：值原样（仍返回新数组/新对象，保证调用方拿到不可变结果）。
 * - regime 缺省/非法：原样返回入参数组（避免误过滤）。
 */
export function applyRegimeFilter(strategies: Strategy[], regime: MarketRegime | undefined): Strategy[] {
  if (!isMarketRegime(regime)) return strategies
  const profile = profileFor(regime)

  return strategies.map((strategy) => {
    if (!BUY_ACTIONS.has(strategy.action)) return cloneStrategy(strategy)

    if (regime === 'bear') {
      return {
        ...strategy,
        action: 'watch',
        actionLabel: BEAR_ACTION_LABEL,
        summary: BEAR_SUMMARY,
        suggestedShares: undefined,
        suggestedPositionPct: undefined,
        reasons: [...strategy.reasons, profile.notes[0]],
      }
    }

    if (regime === 'range') {
      const shares = strategy.suggestedShares
      const pct = strategy.suggestedPositionPct
      return {
        ...strategy,
        suggestedShares: typeof shares === 'number' ? halfLotShares(shares) : undefined,
        suggestedPositionPct: typeof pct === 'number' ? halfPct(pct) : undefined,
        reasons: [...strategy.reasons, RANGE_REASON],
      }
    }

    // bull：值不变，但仍返回拷贝
    return cloneStrategy(strategy)
  })
}
