import type { AlertKind, LiveQuote, LiveStatus, Strategy, StrategyAction } from '@/types'

/**
 * 盘中信号判定（signals-alerts 负责人实现）。
 *
 * 基础规则：现价 ≤ 保护位 → stop；现价 ≥ 目标位 → target；
 *           现价 ≥ 触发价 → trigger。
 *
 * 提醒语义按「是否持仓」分级（而不是只看 action）：
 * - 持仓（strategy.isHolding，旧数据缺字段时回退 action 推断）：任意 action
 *   （breakout / pullback / hold / reduce / stop）都只提醒保护位 stop 与目标 target；
 *   触发价对已持仓计划不再有「买入」含义。
 * - 非持仓：只提醒买入触发 trigger（且仅 breakout / pullback）；
 *   价格穿越保护位/目标位不产生「保护失守 / 止盈」噪音。
 * - watch（观望）：不发任何提醒。
 *
 * 注意：generateStrategy 对持仓股也可能给出 breakout / pullback（例：持仓股回踩 MA5
 * 触发 pullback、现价跌破 stop），因此不能仅凭 action 推断非持仓；
 * evaluateLive 优先读 Strategy.isHolding，只有字段缺失（旧快照/旧 localStorage）时才回退 action 推断。
 *
 * hits 顺序固定为 止损 > 目标 > 触发（同一策略内按此优先级排列）。
 * 本函数只做「当前快照」的纯计算，不做去重/通知；提醒层（src/lib/alerts.ts）
 * 负责墙钟时段校验、去重、节流与持久化。
 */

/** 买入类动作：这些动作的触发价才有「买入触发」含义。 */
const ENTRY_ACTIONS: ReadonlySet<StrategyAction> = new Set(['breakout', 'pullback'])

/** 持仓语义动作：这些动作的保护位/目标位才值得提醒（isHolding 缺失时的回退推断）。 */
const HOLDING_ACTIONS: ReadonlySet<StrategyAction> = new Set(['hold', 'reduce', 'stop'])

export function isEntryAction(action: StrategyAction): boolean {
  return ENTRY_ACTIONS.has(action)
}

export function isHoldingAction(action: StrategyAction): boolean {
  return HOLDING_ACTIONS.has(action)
}

/**
 * 是否持仓：优先使用 Strategy.isHolding（generateStrategy 依据 status==='holding' && shares>0 写入），
 * 旧数据没有该字段时回退到 action 推断（hold/reduce/stop 视为持仓语义）。
 */
export function isHoldingStrategy(strategy: Strategy): boolean {
  return strategy.isHolding ?? isHoldingAction(strategy.action)
}

/**
 * 某类命中是否属于该策略应提醒的语义：
 * - watch 一律不发；
 * - 持仓只发 stop/target；非持仓只发 trigger（且仅 breakout/pullback）。
 */
export function isAlertKindForStrategy(strategy: Strategy, kind: AlertKind): boolean {
  if (strategy.action === 'watch') return false
  if (isHoldingStrategy(strategy)) return kind !== 'trigger'
  return kind === 'trigger' && isEntryAction(strategy.action)
}

/** 仅凭 action 推断的旧版语义判断（无 isHolding 信息时使用）。 */
export function isAlertKindForAction(action: StrategyAction, kind: AlertKind): boolean {
  return kind === 'trigger' ? ENTRY_ACTIONS.has(action) : HOLDING_ACTIONS.has(action)
}

/** 规整策略价位：非有限数值或非正数视为未设置，避免 0/NaN 产生假信号。 */
function priceLevel(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function evaluateLive(strategy: Strategy, quote: LiveQuote): LiveStatus {
  const stop = priceLevel(strategy.stop)
  const target = priceLevel(strategy.target)
  const trigger = priceLevel(strategy.trigger)
  const price = quote.price

  // 先按契约优先级收集候选命中，再按持仓/动作语义过滤（保持 止损 > 目标 > 触发 顺序）
  const candidates: AlertKind[] = []
  if (stop !== undefined && price <= stop) candidates.push('stop')
  if (target !== undefined && price >= target) candidates.push('target')
  if (trigger !== undefined && price >= trigger) candidates.push('trigger')

  const hits = candidates.filter((kind) => isAlertKindForStrategy(strategy, kind))

  return {
    code: strategy.code,
    price,
    changePct: quote.changePct,
    updatedAt: quote.updatedAt,
    phase: quote.phase,
    distanceToTriggerPct:
      trigger !== undefined && price > 0 ? (trigger / price - 1) * 100 : undefined,
    distanceToStopPct:
      stop !== undefined && stop > 0 ? (price / stop - 1) * 100 : undefined,
    hits,
  }
}
