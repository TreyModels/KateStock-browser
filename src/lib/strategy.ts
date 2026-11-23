import type { Quote, RiskSettings, Stock, Strategy } from '@/types'

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const round = (value: number) => Math.round(value * 100) / 100
const valid = (value: number | undefined, fallback: number) => Number.isFinite(value) && (value as number) > 0 ? value as number : fallback

function rsi(closes: number[], period = 14) {
  if (closes.length <= period) return 50
  const slice = closes.slice(-(period + 1))
  let gains = 0
  let losses = 0
  for (let index = 1; index < slice.length; index += 1) {
    const difference = slice[index] - slice[index - 1]
    if (difference >= 0) gains += difference
    else losses -= difference
  }
  if (losses === 0) return 100
  return 100 - 100 / (1 + gains / losses)
}

function atr(bars: Quote['bars'], period = 14) {
  if (bars.length < 2) return 0
  const ranges = bars.slice(-period).map((bar, index, slice) => {
    const actualIndex = bars.length - slice.length + index
    const previousClose = bars[actualIndex - 1]?.close ?? bar.open
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose))
  })
  return average(ranges)
}

export function generateStrategy(stock: Stock, quote: Quote, settings: RiskSettings): Strategy {
  const bars = quote.bars
  const closes = bars.map((bar) => bar.close)
  const latest = bars.at(-1)
  const price = quote.price
  const manual = quote.manual
  const calculatedAtr = atr(bars)
  const previous20 = bars.slice(-21, -1)
  const ma5 = valid(manual?.ma5, average(closes.slice(-5)) || price)
  const ma10 = valid(manual?.ma10, average(closes.slice(-10)) || price)
  const ma20 = valid(manual?.ma20, average(closes.slice(-20)) || price)
  const high20 = valid(manual?.high20, Math.max(0, ...previous20.map((bar) => bar.high)) || price * 1.03)
  const atr14 = valid(manual?.atr14, calculatedAtr || price * 0.025)
  const rsi14 = valid(manual?.rsi14, rsi(closes))
  const previousVolumes = bars.slice(-6, -1).map((bar) => bar.volume)
  const volumeRatio = valid(manual?.volumeRatio, latest && previousVolumes.length ? latest.volume / average(previousVolumes) : 1)
  const indicators = { ma5, ma10, ma20, high20, atr14, rsi14, volumeRatio }

  const trendUp = ma5 > ma10 && ma10 > ma20
  const trendDown = ma5 < ma10 && ma10 < ma20
  const isHolding = stock.status === 'holding' && (stock.shares ?? 0) > 0
  const costStop = isHolding && stock.cost ? price <= stock.cost * 0.93 : false
  const trendStop = isHolding && price < ma20 - atr14 * 0.5
  const overextended = rsi14 >= 76 || price > ma5 + atr14 * 2.2
  const breakout = price >= high20 * 0.998 && quote.changePct >= 1 && volumeRatio >= 1.15
  const nearPullback = trendUp && price <= ma5 + atr14 * 0.25 && price >= ma10 - atr14 * 0.4 && quote.changePct < 1.5

  let action: Strategy['action'] = 'watch'
  let actionLabel = '等待信号'
  let summary = '趋势与量价尚未共振，不因盘中波动追单。'
  let reasons = ['等待价格接近突破位或回踩均线', '信号不满足时保持现金也是策略']
  let score = 38
  let trigger: number | undefined
  let stop: number | undefined
  let target: number | undefined

  if (costStop || trendStop) {
    action = 'stop'
    actionLabel = '优先止损'
    summary = costStop ? '价格已触及成本风控线，先执行退出纪律。' : '价格跌破中期趋势与波动缓冲区，优先降低风险。'
    reasons = [costStop ? `成本价 ${stock.cost?.toFixed(2)}，已触及约 7% 风险线` : '现价低于 MA20 − 0.5×ATR', '不以摊低成本替代止损']
    stop = round(Math.max(price * 0.995, Math.min(ma20, price + atr14 * 0.2)))
    score = 94
  } else if (isHolding && overextended) {
    action = 'reduce'
    actionLabel = '逢高减仓'
    summary = '短线涨幅或乖离偏大，分批锁定收益，剩余仓位跟随趋势。'
    reasons = [`RSI14 为 ${rsi14.toFixed(1)}`, `现价相对 MA5 乖离 ${((price / ma5 - 1) * 100).toFixed(1)}%`]
    trigger = round(price + atr14 * 0.35)
    stop = round(Math.max(ma5, price - atr14))
    score = 82
  } else if (breakout) {
    action = 'breakout'
    actionLabel = '突破跟随'
    summary = '价格接近或突破前高，成交量同步放大，可按计划小仓跟随。'
    reasons = [`20 日高点 ${high20.toFixed(2)}`, `量比 ${volumeRatio.toFixed(2)}，涨跌幅 ${quote.changePct.toFixed(2)}%`]
    trigger = round(Math.max(price, high20 * 1.001))
    stop = round(Math.min(ma10, trigger - atr14 * 1.4))
    target = round(trigger + Math.max(atr14 * 2.2, (trigger - stop) * 1.8))
    score = Math.min(96, Math.round(72 + volumeRatio * 5 + Math.max(quote.changePct, 0)))
  } else if (nearPullback) {
    action = 'pullback'
    actionLabel = '回踩低吸'
    summary = '上升趋势仍在，价格回到短期均线区域，等待止跌后介入。'
    reasons = ['MA5 > MA10 > MA20，趋势向上', `现价距 MA5 ${((price / ma5 - 1) * 100).toFixed(1)}%`]
    trigger = round(Math.max(price, ma5))
    stop = round(Math.min(ma10 - atr14 * 0.6, ma20 - atr14 * 0.2))
    target = round(Math.max(high20, trigger + atr14 * 1.8))
    score = 74
  } else if (isHolding && trendUp && price >= ma5) {
    action = 'hold'
    actionLabel = '持有待涨'
    summary = '短期趋势保持完整，用移动保护位替代主观预测。'
    reasons = ['多头排列且现价位于 MA5 上方', `ATR14 为 ${atr14.toFixed(2)}，用于设置保护位`]
    stop = round(Math.max(ma10, price - atr14 * 1.3))
    target = round(Math.max(high20, price + atr14 * 1.5))
    score = 66
  } else if (trendDown) {
    summary = '均线空头排列，短线不逆势抄底，等待结构修复。'
    reasons = ['MA5 < MA10 < MA20', '重新站上 MA10 后再评估反弹交易']
    score = 24
  } else if (overextended) {
    actionLabel = '不追高'
    summary = '价格短线过热，未持有者等待回踩，不用市价追单。'
    reasons = [`RSI14 为 ${rsi14.toFixed(1)}`, '等待量价回落后重新评估']
    score = 31
  }

  let suggestedShares: number | undefined
  let suggestedPositionPct: number | undefined
  if ((action === 'breakout' || action === 'pullback') && trigger && stop && trigger > stop) {
    const riskBudget = settings.capital * settings.riskPct / 100
    const riskShares = Math.floor(riskBudget / (trigger - stop) / 100) * 100
    const capShares = Math.floor(settings.capital * settings.maxPositionPct / 100 / trigger / 100) * 100
    suggestedShares = Math.max(0, Math.min(riskShares, capShares))
    suggestedPositionPct = round(suggestedShares * trigger / settings.capital * 100)
  }

  return {
    stockId: stock.id,
    code: stock.code,
    name: stock.name,
    action,
    actionLabel,
    score,
    summary,
    reasons,
    // 是否持仓（status==='holding' 且 shares>0）；盘中提醒据此区分持仓/非持仓语义。
    // 只透传既有推导结果，不影响 EOD 价位算法与回测语义。
    isHolding,
    trigger,
    stop,
    target,
    suggestedShares,
    suggestedPositionPct,
    price,
    changePct: quote.changePct,
    tradeDate: quote.tradeDate,
    source: quote.source,
    indicators,
    bars,
  }
}

export function buildManualQuote(
  code: string,
  values: {
    price: number
    prevClose: number
    open?: number
    high?: number
    low?: number
    ma5?: number
    ma10?: number
    ma20?: number
    high20?: number
    atr14?: number
    rsi14?: number
    volumeRatio?: number
  },
) {
  const changePct = (values.price / values.prevClose - 1) * 100
  const quote: Quote = {
    code,
    price: values.price,
    prevClose: values.prevClose,
    changePct,
    open: valid(values.open, values.price),
    high: valid(values.high, values.price),
    low: valid(values.low, values.price),
    volume: 0,
    amount: 0,
    tradeDate: new Date().toISOString().slice(0, 10),
    fetchedAt: new Date().toISOString(),
    source: 'manual',
    bars: [],
    manual: {
      ma5: values.ma5,
      ma10: values.ma10,
      ma20: values.ma20,
      high20: values.high20,
      atr14: values.atr14,
      rsi14: values.rsi14,
      volumeRatio: values.volumeRatio,
    },
  }
  return quote
}
