import type { Bar } from '@/types'

export type BacktestStrategyId = 'breakout' | 'pullback' | 'trend' | 'reversion'

/** 成本参数（可配置；默认佣金万 2.5、最低 5 元/笔、卖出印花税 0.05%）。 */
export interface BacktestCostOptions {
  /** 佣金率（bps，1bp = 0.01%）；默认 2.5（万 2.5）。 */
  commissionBps?: number
  /** 单笔最低佣金（元）；默认 5。 */
  minCommission?: number
}

export interface BacktestOptions {
  /** 股票代码，用于判断板块涨跌停（主板 10% / 创业板科创板 20% / 北交所 30%）。缺省按主板 10%。 */
  code?: string
  /** 是否 ST（ST 主板 2026-07-06 起 10%，此前 5%；创业板/科创板 20%；北交所 30%）。 */
  isSt?: boolean
  /** 成本参数。 */
  costs?: BacktestCostOptions
  /** 初始资金（元）；默认 10 万。用于整手与最低佣金计算。 */
  initialCapital?: number
}

export interface BacktestTrade {
  signalIndex: number
  entryIndex: number
  exitIndex: number
  entryDate: string
  exitDate: string
  entryPrice: number
  exitPrice: number
  /** 扣费后单笔收益率（%）。 */
  returnPct: number
  exitReason: string
  /** 买入股数（100 股整数倍，便于核对整手约束）。 */
  units?: number
  /** 买入费用（佣金，元）。 */
  entryFee?: number
  /** 卖出费用（佣金 + 印花税，元）。 */
  exitFee?: number
  /** 本笔保护位（便于核对成交价）。 */
  stop?: number
  /** 本笔目标位（趋势策略为 Infinity）。 */
  target?: number
}

export interface EquityPoint {
  index: number
  date: string
  value: number
}

export interface BacktestResult {
  id: BacktestStrategyId
  name: string
  subtitle: string
  color: string
  equity: EquityPoint[]
  trades: BacktestTrade[]
  totalReturnPct: number
  winRate: number
  maxDrawdownPct: number
  profitFactor: number | null
  fitScore: number
  performanceScore: number
  score: number
  currentReasons: string[]
  sampleNote: string
  /** 因涨停买不到（两次尝试均失败）或资金不足 1 手而放弃入场的信号数。 */
  unfilledEntries: number
  /** 未成交原因（中文，便于回测结果页解释）。 */
  unfilledReasons: string[]
  /** 卖出遇跌停被顺延的次数（每次延迟卖出事件记 1）。 */
  slippageWaits: number
}

export interface StoryFrame {
  index: number
  date: string
  title: string
  narrative: string
  tone: 'opportunity' | 'risk' | 'holding' | 'wait'
  reasons: string[]
  close: number
  changePct: number
}

interface Indicators {
  ma5: number
  ma10: number
  ma20: number
  high20: number
  atr14: number
  rsi14: number
  volumeRatio: number
}

interface PendingEntry {
  signalIndex: number
  stop: number
  target: number
  /** 已尝试次数（涨停买不到时顺延重试一次）。 */
  attempts: number
}

interface Position {
  signalIndex: number
  stop: number
  target: number
  entryIndex: number
  entryPrice: number
  units: number
  buyFee: number
}

interface PendingExit {
  kind: 'stop' | 'target' | 'close'
  reason: string
  /** 因跌停卖不掉而顺延到下一交易日。 */
  delayed: boolean
}

/* ─────────────────────────────────────────────────────────────
 * 交易成本 / 整手 / 涨跌停常量与纯函数
 * ───────────────────────────────────────────────────────────── */

/** 默认佣金率（bps）：万 2.5。 */
export const DEFAULT_COMMISSION_BPS = 2.5
/** 单笔最低佣金（元）：5。 */
export const DEFAULT_MIN_COMMISSION = 5
/** 印花税：卖出单边 0.05%（2023-08-28 起）。 */
export const STAMP_DUTY_RATE = 0.0005
/** 买入最小单位：100 股（科创板 200 股起，此处按全市场最常见的整手近似）。 */
export const LOT_SIZE = 100
/** 默认初始资金：10 万元。 */
export const DEFAULT_INITIAL_CAPITAL = 100_000
/** 主板 ST 涨跌幅放宽到 10% 的生效日。 */
export const ST_MAIN_10_START = '2026-07-06'

export const DEFAULT_COST_OPTIONS: Required<BacktestCostOptions> = {
  commissionBps: DEFAULT_COMMISSION_BPS,
  minCommission: DEFAULT_MIN_COMMISSION,
}

const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)
const round = (value: number) => Math.round(value * 100) / 100
const roundCent = (value: number) => Math.round(value * 100) / 100
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export interface LimitPctOptions {
  isSt?: boolean
  /** 交易日 YYYY-MM-DD；仅主板 ST 的历史规则（2026-07-06 前 5%）需要。 */
  tradeDate?: string
}

/**
 * 板块 / ST 涨跌幅限制（纯函数）：
 * - 主板 10%（ST 2026-07-06 起 10%，此前 5%）
 * - 创业板（300/301）10% → 20%
 * - 科创板（688/689）20%
 * - 北交所（4/8/92 开头）30%
 */
export function limitPctFor(code: string, options: LimitPctOptions = {}): number {
  const normalized = String(code ?? '')
    .replace(/^(sh|sz|bj)/i, '')
    .trim()
  const isStar = /^(688|689)/.test(normalized)
  const isChiNext = /^(300|301)/.test(normalized)
  const isBse = /^(8|4|92)/.test(normalized)

  if (isStar || isChiNext) return 0.2
  if (isBse) return 0.3
  if (!options.isSt) return 0.1
  const date = options.tradeDate ?? ''
  // 主板 ST：2026-07-06 起 ±10%，此前 ±5%
  return date && date < ST_MAIN_10_START ? 0.05 : 0.1
}

/** 买入费用：佣金 max(成交额 × bps, 最低佣金)。 */
export function buyFeeFor(amount: number, costs: BacktestCostOptions = DEFAULT_COST_OPTIONS): number {
  if (!finitePositive(amount)) return 0
  const bps = costs.commissionBps ?? DEFAULT_COMMISSION_BPS
  const minCommission = costs.minCommission ?? DEFAULT_MIN_COMMISSION
  return Math.max((amount * bps) / 10_000, minCommission)
}

/** 卖出费用：佣金 max(成交额 × bps, 最低佣金) + 印花税 0.05%。 */
export function sellFeeFor(amount: number, costs: BacktestCostOptions = DEFAULT_COST_OPTIONS): number {
  if (!finitePositive(amount)) return 0
  return buyFeeFor(amount, costs) + amount * STAMP_DUTY_RATE
}

/** 默认参数下某成交额的往返成本（bps），用于验证「1 万元往返约 15bp」。 */
export function roundTripCostBps(amount: number, costs: BacktestCostOptions = DEFAULT_COST_OPTIONS): number {
  if (!finitePositive(amount)) return 0
  return ((buyFeeFor(amount, costs) + sellFeeFor(amount, costs)) / amount) * 10_000
}

/** bar 是否有可用于成交的开/收盘价（停牌/缺数据返回 false）。 */
function isValidBar(bar: Bar | undefined): bar is Bar {
  return bar !== undefined && finitePositive(bar.open) && finitePositive(bar.close)
}

function barHigh(bar: Bar): number {
  return finitePositive(bar.high) ? bar.high : Math.max(bar.open, bar.close)
}

function barLow(bar: Bar): number {
  return finitePositive(bar.low) ? bar.low : Math.min(bar.open, bar.close)
}

/** 向前找最近一根有效 bar 的收盘价（作为涨跌停判定的前收）。 */
function previousCloseOf(bars: Bar[], index: number): number | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const bar = bars[cursor]
    if (bar && finitePositive(bar.close)) return bar.close
  }
  return undefined
}

interface LimitPrices {
  up: number
  down: number
}

function limitPricesAt(bars: Bar[], index: number, limitPct: number): LimitPrices | undefined {
  const previousClose = previousCloseOf(bars, index)
  if (previousClose === undefined) return undefined
  return {
    up: roundCent(previousClose * (1 + limitPct)),
    down: roundCent(previousClose * (1 - limitPct)),
  }
}

const LIMIT_TOLERANCE = 0.01

/** 开盘即涨停（含一字板）→ 买不到。 */
function isLimitUp(bar: Bar, prices: LimitPrices | undefined): boolean {
  if (!prices) return false
  const high = barHigh(bar)
  const low = barLow(bar)
  const oneWord = high === low
  return bar.open >= prices.up - LIMIT_TOLERANCE || (oneWord && high >= prices.up - LIMIT_TOLERANCE)
}

/** 开盘即跌停（含一字板）→ 卖不掉。 */
function isLimitDown(bar: Bar, prices: LimitPrices | undefined): boolean {
  if (!prices) return false
  const high = barHigh(bar)
  const low = barLow(bar)
  const oneWord = high === low
  return bar.open <= prices.down + LIMIT_TOLERANCE || (oneWord && low <= prices.down + LIMIT_TOLERANCE)
}

/** 现金可买的最大整手股数（不足 1 手返回 0）。 */
function affordableUnits(cash: number, price: number, costs: BacktestCostOptions): number {
  if (!finitePositive(cash) || !finitePositive(price)) return 0
  const bps = costs.commissionBps ?? DEFAULT_COMMISSION_BPS
  const minCommission = costs.minCommission ?? DEFAULT_MIN_COMMISSION
  const perShare = price * (1 + bps / 10_000)
  let units = Math.floor((cash - minCommission) / perShare / LOT_SIZE) * LOT_SIZE
  while (units >= LOT_SIZE) {
    const amount = units * price
    if (amount + buyFeeFor(amount, costs) <= cash + 1e-6) return units
    units -= LOT_SIZE
  }
  return 0
}

export const backtestMeta: Record<BacktestStrategyId, { name: string; subtitle: string; color: string }> = {
  breakout: { name: '突破跟随', subtitle: '前高突破 · 放量确认', color: '#d84a40' },
  pullback: { name: '回踩低吸', subtitle: '多头趋势 · 均线回踩', color: '#d99a32' },
  trend: { name: '趋势持有', subtitle: '多头排列 · 移动退出', color: '#4778a8' },
  reversion: { name: '超跌反弹', subtitle: 'RSI 超卖 · 均值回归', color: '#14805f' },
}

function indicatorsAt(bars: Bar[], index: number): Indicators {
  const closes = bars.slice(0, index + 1).map((bar) => bar.close)
  const current = bars[index]
  const previous20 = bars.slice(Math.max(0, index - 20), index)
  const rsiSlice = closes.slice(-15)
  let gains = 0
  let losses = 0
  for (let cursor = 1; cursor < rsiSlice.length; cursor += 1) {
    const difference = rsiSlice[cursor] - rsiSlice[cursor - 1]
    if (difference >= 0) gains += difference
    else losses -= difference
  }
  const rsi14 = losses === 0 ? (gains === 0 ? 50 : 100) : 100 - 100 / (1 + gains / losses)
  const ranges = bars.slice(Math.max(1, index - 13), index + 1).map((bar) => {
    const previousClose = bars[bars.indexOf(bar) - 1]?.close ?? bar.open
    return Math.max(barHigh(bar) - barLow(bar), Math.abs(barHigh(bar) - previousClose), Math.abs(barLow(bar) - previousClose))
  })
  const previousVolumes = bars.slice(Math.max(0, index - 5), index).map((bar) => bar.volume)
  return {
    ma5: average(closes.slice(-5)),
    ma10: average(closes.slice(-10)),
    ma20: average(closes.slice(-20)),
    high20: Math.max(0, ...previous20.map((bar) => barHigh(bar))),
    atr14: average(ranges) || current.close * 0.025,
    rsi14,
    volumeRatio: previousVolumes.length ? current.volume / average(previousVolumes) : 1,
  }
}

function hasSignal(id: BacktestStrategyId, bar: Bar, indicator: Indicators) {
  const trendUp = indicator.ma5 > indicator.ma10 && indicator.ma10 > indicator.ma20
  if (id === 'breakout') return bar.close >= indicator.high20 * 0.998 && bar.changePct >= 1 && indicator.volumeRatio >= 1.15
  if (id === 'pullback') return trendUp && bar.close <= indicator.ma5 + indicator.atr14 * 0.25 && bar.close >= indicator.ma10 - indicator.atr14 * 0.4 && bar.changePct < 1.5
  if (id === 'trend') return trendUp && bar.close > indicator.ma5
  return indicator.rsi14 <= 32 && bar.close < indicator.ma20 && bar.changePct < 0
}

function entryLevels(id: BacktestStrategyId, entryPrice: number, indicator: Indicators) {
  const atr = indicator.atr14
  if (id === 'breakout') {
    const stop = Math.min(indicator.ma10, entryPrice - atr * 1.4)
    return { stop, target: entryPrice + Math.max(atr * 2.2, (entryPrice - stop) * 1.8) }
  }
  if (id === 'pullback') return { stop: Math.min(indicator.ma10 - atr * 0.6, indicator.ma20 - atr * 0.2), target: Math.max(indicator.high20, entryPrice + atr * 1.8) }
  if (id === 'trend') return { stop: entryPrice - atr * 2, target: Number.POSITIVE_INFINITY }
  return { stop: entryPrice - atr * 1.5, target: entryPrice + atr * 1.8 }
}

function shouldExitAtClose(id: BacktestStrategyId, bar: Bar, indicator: Indicators, holdingDays: number) {
  if (id === 'breakout') return bar.close < indicator.ma10 || holdingDays >= 12
  if (id === 'pullback') return bar.close < indicator.ma20 || holdingDays >= 12
  if (id === 'trend') return indicator.ma5 < indicator.ma10 || bar.close < indicator.ma20 - indicator.atr14 * 0.5
  return indicator.rsi14 >= 55 || holdingDays >= 8
}

function currentFit(id: BacktestStrategyId, bar: Bar, indicator: Indicators) {
  const signal = hasSignal(id, bar, indicator)
  const trendUp = indicator.ma5 > indicator.ma10 && indicator.ma10 > indicator.ma20
  let fitScore = 30
  if (id === 'breakout') fitScore = signal ? 90 : bar.close >= indicator.high20 * 0.97 ? 62 : 32
  if (id === 'pullback') fitScore = signal ? 87 : trendUp ? 61 : 25
  if (id === 'trend') fitScore = signal ? 84 : trendUp ? 68 : 24
  if (id === 'reversion') fitScore = signal ? 86 : indicator.rsi14 < 45 ? 53 : 22
  const highDistance = (bar.close / indicator.high20 - 1) * 100
  const maDistance = (bar.close / indicator.ma5 - 1) * 100
  const common = [
    `现价距前 20 日高点 ${highDistance >= 0 ? '+' : ''}${highDistance.toFixed(1)}%`,
    `量比 ${indicator.volumeRatio.toFixed(2)}，RSI14 ${indicator.rsi14.toFixed(1)}`,
  ]
  if (id === 'breakout') return { fitScore, reasons: [`突破条件${signal ? '已满足' : '未满足'}：价格、涨幅与量能需同时确认`, ...common] }
  if (id === 'pullback') return { fitScore, reasons: [`均线${trendUp ? '保持' : '尚未形成'} MA5＞MA10＞MA20`, `现价相对 MA5 乖离 ${maDistance >= 0 ? '+' : ''}${maDistance.toFixed(1)}%`, ...common] }
  if (id === 'trend') return { fitScore, reasons: [`趋势条件${trendUp ? '成立' : '不成立'}，价格${bar.close > indicator.ma5 ? '位于' : '未站稳'} MA5 ${bar.close > indicator.ma5 ? '上方' : ''}`, `MA20 为 ${indicator.ma20.toFixed(2)}，ATR14 为 ${indicator.atr14.toFixed(2)}`, ...common] }
  return { fitScore, reasons: [`超卖条件${signal ? '已满足' : '未满足'}：RSI14 ≤ 32 且价格低于 MA20`, `当前 RSI14 为 ${indicator.rsi14.toFixed(1)}`, ...common] }
}

/**
 * 单只股票单策略回测。
 *
 * 相对旧实现的真实化（docs/research/china-rules.md 第 6.2 节）：
 * - 止损出场价 = min(保护位, 次日开盘)；目标出场价 = max(目标位, 次日开盘)（跳空按可成交价）；
 * - 涨停买不到：买入日开盘触及涨停（或一字板）→ 顺延下一交易日重试一次，仍不能买则记 unfilled；
 * - 跌停卖不掉：卖出日开盘触及跌停（或一字板）→ 延迟卖出并记 slippage_wait；
 * - 整手：股数 floor 到 100 股，不足 1 手不成交；
 * - 成本：佣金 max(成交额 × bps, 最低 5 元) 双边 + 印花税 0.05% 卖出单边；
 * - 停牌/缺 bar：当前 bar 无有效 open/close 则跳过（不产生成交）。
 */
export function runBacktest(id: BacktestStrategyId, bars: Bar[], options: BacktestOptions = {}): BacktestResult {
  const meta = backtestMeta[id]
  const costs = options.costs ?? DEFAULT_COST_OPTIONS
  const initialCapital = finitePositive(options.initialCapital) ? options.initialCapital : DEFAULT_INITIAL_CAPITAL
  const code = options.code ?? ''
  if (bars.length < 45) {
    return {
      id, ...meta, equity: [], trades: [], totalReturnPct: 0, winRate: 0, maxDrawdownPct: 0,
      profitFactor: null, fitScore: 0, performanceScore: 0, score: 0,
      currentReasons: ['至少需要 45 根日线才能进行指标计算与回测'], sampleNote: '数据不足',
      unfilledEntries: 0, unfilledReasons: [], slippageWaits: 0,
    }
  }

  let cash = initialCapital
  let lastClose = finitePositive(bars[0]?.close) ? bars[0].close : 0
  let position: Position | undefined
  let pendingEntry: PendingEntry | undefined
  let pendingExit: PendingExit | undefined
  let unfilledEntries = 0
  let slippageWaits = 0
  const unfilledReasons: string[] = []
  const trades: BacktestTrade[] = []
  const equity: EquityPoint[] = bars.map((bar, index) => ({ index, date: bar.date, value: 1 }))

  const markValue = () => {
    const held = position && finitePositive(lastClose) ? position.units * lastClose : 0
    return (cash + held) / initialCapital
  }

  for (let index = 20; index < bars.length; index += 1) {
    const bar = bars[index]

    // 停牌 / 缺 bar：没有有效开收盘价则跳过该 bar，不产生任何成交
    if (!isValidBar(bar)) {
      equity[index].value = markValue()
      continue
    }

    const indicator = indicatorsAt(bars, index)
    lastClose = bar.close
    const limitPct = limitPctFor(code, { isSt: options.isSt, tradeDate: bar.date })
    const prices = limitPricesAt(bars, index, limitPct)

    // 1) 次日开盘执行买入（涨停买不到 → 顺延一次 → 放弃）
    if (pendingEntry && !position) {
      if (isLimitUp(bar, prices)) {
        pendingEntry.attempts += 1
        if (pendingEntry.attempts >= 2) {
          unfilledEntries += 1
          unfilledReasons.push(`涨停未能买入（信号日 ${bars[pendingEntry.signalIndex]?.date ?? ''}，已顺延一次）`)
          pendingEntry = undefined
        }
      } else {
        const entryPrice = bar.open
        const levels = entryLevels(id, entryPrice, indicatorsAt(bars, pendingEntry.signalIndex))
        const units = affordableUnits(cash, entryPrice, costs)
        if (units < LOT_SIZE) {
          // 不足 1 手：不成交
          unfilledEntries += 1
          unfilledReasons.push(`不足 1 手（信号日 ${bars[pendingEntry.signalIndex]?.date ?? ''}，可用资金 ${Math.floor(cash)} 元）`)
          pendingEntry = undefined
        } else {
          const amount = units * entryPrice
          const buyFee = buyFeeFor(amount, costs)
          cash -= amount + buyFee
          position = {
            signalIndex: pendingEntry.signalIndex,
            stop: levels.stop,
            target: levels.target,
            entryIndex: index,
            entryPrice,
            units,
            buyFee,
          }
          pendingEntry = undefined
        }
      }
    }

    // 2) 出场（T+1：entryIndex 之后才检查）
    if (position && index > position.entryIndex) {
      if (!pendingExit) {
        const high = barHigh(bar)
        const low = barLow(bar)
        if (low <= position.stop) {
          pendingExit = { kind: 'stop', reason: '触及保护位', delayed: false }
        } else if (high >= position.target) {
          pendingExit = { kind: 'target', reason: '达到目标位', delayed: false }
        } else if (shouldExitAtClose(id, bar, indicator, index - position.entryIndex)) {
          pendingExit = { kind: 'close', reason: '收盘退出条件', delayed: false }
        } else if (index === bars.length - 1) {
          pendingExit = { kind: 'close', reason: '样本期末结算', delayed: false }
        }
      }

      if (pendingExit) {
        const isLastBar = index === bars.length - 1
        // 跌停卖不掉：顺延到下一交易日；样本末日按收盘估值强制结算
        if (!isLastBar && isLimitDown(bar, prices)) {
          if (!pendingExit.delayed) slippageWaits += 1
          pendingExit.delayed = true
        } else {
          let exitPrice: number
          if (pendingExit.delayed) {
            exitPrice = isLastBar ? bar.close : bar.open
          } else if (pendingExit.kind === 'stop') {
            // 跳空低开时按实际可成交的开盘价
            exitPrice = Math.min(position.stop, bar.open)
          } else if (pendingExit.kind === 'target') {
            // 跳空高开时按实际可成交的开盘价
            exitPrice = Math.max(position.target, bar.open)
          } else {
            exitPrice = bar.close
          }
          if (!finitePositive(exitPrice)) exitPrice = bar.close

          const reason = pendingExit.delayed
            ? `${pendingExit.reason}（跌停顺延${isLastBar ? '，样本期末按收盘估值' : ''}）`
            : pendingExit.reason
          const sellAmount = position.units * exitPrice
          const sellFee = sellFeeFor(sellAmount, costs)
          cash += sellAmount - sellFee
          const buyTotal = position.units * position.entryPrice + position.buyFee
          const returnPct = buyTotal > 0 ? ((sellAmount - sellFee) / buyTotal - 1) * 100 : 0
          trades.push({
            signalIndex: position.signalIndex,
            entryIndex: position.entryIndex,
            exitIndex: index,
            entryDate: bars[position.entryIndex].date,
            exitDate: bar.date,
            entryPrice: round(position.entryPrice),
            exitPrice: round(exitPrice),
            returnPct,
            exitReason: reason,
            units: position.units,
            entryFee: round(position.buyFee),
            exitFee: round(sellFee),
            stop: round(position.stop),
            target: Number.isFinite(position.target) ? round(position.target) : position.target,
          })
          position = undefined
          pendingExit = undefined
        }
      }
    }

    // 3) 收盘出信号：只能用当日及之前的数据，次日开盘执行
    if (!position && !pendingEntry && index < bars.length - 1 && hasSignal(id, bar, indicator)) {
      pendingEntry = { signalIndex: index, ...entryLevels(id, bar.close, indicator), attempts: 0 }
    }

    equity[index].value = markValue()
  }

  const totalReturnPct = (equity.at(-1)!.value - 1) * 100
  const wins = trades.filter((trade) => trade.returnPct > 0)
  const grossProfit = wins.reduce((sum, trade) => sum + trade.returnPct, 0)
  const grossLoss = Math.abs(trades.filter((trade) => trade.returnPct <= 0).reduce((sum, trade) => sum + trade.returnPct, 0))
  let maxDrawdownPct = 0
  let peak = 0
  equity.forEach((point) => {
    peak = Math.max(peak, point.value)
    maxDrawdownPct = Math.min(maxDrawdownPct, (point.value / peak - 1) * 100)
  })

  const latestIndex = bars.length - 1
  const fit = currentFit(id, bars[latestIndex], indicatorsAt(bars, latestIndex))
  let performanceScore = trades.length ? clamp(50 + totalReturnPct * 1.1 + (wins.length / trades.length * 100 - 50) * 0.25, 5, 95) : 18
  if (trades.length < 3) performanceScore = Math.min(performanceScore, 42)
  const score = Math.round(fit.fitScore * 0.7 + performanceScore * 0.3)
  const sampleNote = trades.length < 3 ? `仅 ${trades.length} 笔样本，评分已降权` : `${trades.length} 笔完整交易样本`

  return {
    id,
    ...meta,
    equity,
    trades,
    totalReturnPct,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    maxDrawdownPct,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    fitScore: fit.fitScore,
    performanceScore: Math.round(performanceScore),
    score,
    currentReasons: fit.reasons,
    sampleNote,
    unfilledEntries,
    unfilledReasons,
    slippageWaits,
  }
}

export function runAllBacktests(bars: Bar[], options: BacktestOptions = {}) {
  return (Object.keys(backtestMeta) as BacktestStrategyId[]).map((id) => runBacktest(id, bars, options))
}

export function buildStoryFrame(result: BacktestResult, bars: Bar[], index: number): StoryFrame {
  const safeIndex = clamp(index, 20, bars.length - 1)
  const bar = bars[safeIndex]
  const indicator = indicatorsAt(bars, safeIndex)
  const entry = result.trades.find((trade) => trade.entryIndex === safeIndex)
  const exit = result.trades.find((trade) => trade.exitIndex === safeIndex)
  const signal = result.trades.find((trade) => trade.signalIndex === safeIndex)
  const active = result.trades.find((trade) => trade.entryIndex <= safeIndex && trade.exitIndex >= safeIndex)
  const signalNow = hasSignal(result.id, bar, indicator)
  const trendUp = indicator.ma5 > indicator.ma10 && indicator.ma10 > indicator.ma20
  const reasons = [
    `MA5 ${indicator.ma5.toFixed(2)} · MA10 ${indicator.ma10.toFixed(2)} · MA20 ${indicator.ma20.toFixed(2)}`,
    `RSI14 ${indicator.rsi14.toFixed(1)} · 量比 ${indicator.volumeRatio.toFixed(2)}`,
    result.id === 'breakout' ? `前 20 日高点 ${indicator.high20.toFixed(2)}` : `趋势结构${trendUp ? '向上' : '未形成多头排列'}`,
  ]

  if (exit) return { index: safeIndex, date: bar.date, title: `退出交易 · ${exit.exitReason}`, narrative: `本笔收益 ${exit.returnPct >= 0 ? '+' : ''}${exit.returnPct.toFixed(2)}%。先执行退出，再等待下一次完整信号。`, tone: exit.returnPct >= 0 ? 'opportunity' : 'risk', reasons, close: bar.close, changePct: bar.changePct }
  if (entry) return { index: safeIndex, date: bar.date, title: '次日开盘执行', narrative: `前一交易日收盘信号成立，今日以开盘价计入双边成本。保护位 ${active ? '已同步生效' : '按规则设置'}。`, tone: 'holding', reasons, close: bar.close, changePct: bar.changePct }
  if (signal || signalNow) return { index: safeIndex, date: bar.date, title: `${result.name}信号出现`, narrative: '收盘后确认条件，不在当天收盘前偷用数据；下一交易日开盘才进入回测。', tone: 'opportunity', reasons, close: bar.close, changePct: bar.changePct }
  if (active) return { index: safeIndex, date: bar.date, title: '持仓管理 · 条件未触发', narrative: '价格仍在规则允许范围内，继续持有并检查保护位、目标位和收盘退出条件。', tone: 'holding', reasons, close: bar.close, changePct: bar.changePct }
  return { index: safeIndex, date: bar.date, title: '等待完整信号', narrative: `${result.name}的入场条件没有同时成立。这一帧不交易，也是回测纪律的一部分。`, tone: 'wait', reasons, close: bar.close, changePct: bar.changePct }
}
