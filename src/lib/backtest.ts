import type { Bar } from '@/types'

export type BacktestStrategyId = 'breakout' | 'pullback' | 'trend' | 'reversion'

export interface BacktestTrade {
  signalIndex: number
  entryIndex: number
  exitIndex: number
  entryDate: string
  exitDate: string
  entryPrice: number
  exitPrice: number
  returnPct: number
  exitReason: string
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
}

interface Position extends PendingEntry {
  entryIndex: number
  entryPrice: number
  units: number
}

const COST = 0.001
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const round = (value: number) => Math.round(value * 100) / 100
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

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
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose))
  })
  const previousVolumes = bars.slice(Math.max(0, index - 5), index).map((bar) => bar.volume)
  return {
    ma5: average(closes.slice(-5)),
    ma10: average(closes.slice(-10)),
    ma20: average(closes.slice(-20)),
    high20: Math.max(0, ...previous20.map((bar) => bar.high)),
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

export function runBacktest(id: BacktestStrategyId, bars: Bar[]): BacktestResult {
  const meta = backtestMeta[id]
  if (bars.length < 45) {
    return {
      id, ...meta, equity: [], trades: [], totalReturnPct: 0, winRate: 0, maxDrawdownPct: 0,
      profitFactor: null, fitScore: 0, performanceScore: 0, score: 0,
      currentReasons: ['至少需要 45 根日线才能进行指标计算与回测'], sampleNote: '数据不足',
    }
  }

  let cash = 1
  let position: Position | undefined
  let pending: PendingEntry | undefined
  const trades: BacktestTrade[] = []
  const equity: EquityPoint[] = bars.map((bar, index) => ({ index, date: bar.date, value: 1 }))

  for (let index = 20; index < bars.length; index += 1) {
    const bar = bars[index]
    const indicator = indicatorsAt(bars, index)

    if (pending && !position) {
      const entryPrice = bar.open * (1 + COST)
      const levels = entryLevels(id, entryPrice, indicatorsAt(bars, pending.signalIndex))
      position = {
        ...pending,
        ...levels,
        entryIndex: index,
        entryPrice,
        units: cash / entryPrice,
      }
      pending = undefined
    }

    if (position && index > position.entryIndex) {
      let exitPrice: number | undefined
      let exitReason = ''
      if (bar.low <= position.stop) {
        exitPrice = position.stop * (1 - COST)
        exitReason = '触及保护位'
      } else if (bar.high >= position.target) {
        exitPrice = position.target * (1 - COST)
        exitReason = '达到目标位'
      } else if (shouldExitAtClose(id, bar, indicator, index - position.entryIndex)) {
        exitPrice = bar.close * (1 - COST)
        exitReason = '收盘退出条件'
      } else if (index === bars.length - 1) {
        exitPrice = bar.close * (1 - COST)
        exitReason = '样本期末结算'
      }

      if (exitPrice !== undefined) {
        const returnPct = (exitPrice / position.entryPrice - 1) * 100
        cash = position.units * exitPrice
        trades.push({
          signalIndex: position.signalIndex,
          entryIndex: position.entryIndex,
          exitIndex: index,
          entryDate: bars[position.entryIndex].date,
          exitDate: bar.date,
          entryPrice: round(position.entryPrice),
          exitPrice: round(exitPrice),
          returnPct,
          exitReason,
        })
        position = undefined
      }
    }

    if (!position && !pending && index < bars.length - 1 && hasSignal(id, bar, indicator)) {
      pending = { signalIndex: index, ...entryLevels(id, bar.close, indicator) }
    }
    equity[index].value = position ? position.units * bar.close : cash
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
  }
}

export function runAllBacktests(bars: Bar[]) {
  return (Object.keys(backtestMeta) as BacktestStrategyId[]).map((id) => runBacktest(id, bars))
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
