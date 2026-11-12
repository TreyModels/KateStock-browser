import type { Bar } from '@/types'

// Single-security adaptations of QuantJourney O01 and O02. Signals at close,
// simulated fills at the next open. Portfolio sizing differs from the originals.
export function quantsBacktests(bars: Bar[]) {
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
  const closes = bars.map(b => b.close)
  const sma = (i: number, n: number) => avg(closes.slice(i - n + 1, i + 1))
  const rsi = (i: number) => {
    let up = 0, down = 0
    for (let j = i - 13; j <= i; j++) { const d = closes[j] - closes[j - 1]; if (d > 0) up += d; else down -= d }
    return down === 0 ? (up === 0 ? 50 : 100) : 100 - 100 / (1 + up / down)
  }
  return ['O01', 'O02'].map(id => {
    let cash = 1, units = 0, pending = '', entry = 0, wins = 0, trades = 0, peak = 1, drawdown = 0, signal = 'Wait / 等待'
    for (let i = 50; i < bars.length; i++) {
      const bar = bars[i]
      if (pending === 'buy' && units === 0) { entry = bar.open * 1.001; units = cash / entry; cash = 0 }
      if (pending === 'sell' && units > 0) { cash = units * bar.open * 0.999; if (bar.open * 0.999 > entry) wins++; trades++; units = 0 }
      pending = ''
      const buy = id === 'O01' ? sma(i, 20) > sma(i, 50) && sma(i - 1, 20) <= sma(i - 1, 50) : rsi(i) < 35
      const sell = id === 'O01' ? sma(i, 20) <= sma(i, 50) && sma(i - 1, 20) > sma(i - 1, 50) : rsi(i) > 60
      if (!units && buy) pending = 'buy'
      if (units && sell) pending = 'sell'
      if (i === bars.length - 1) signal = pending === 'buy' ? 'Buy signal / 买入信号' : pending === 'sell' ? 'Sell signal / 卖出信号' : units ? 'Holding / 持有' : 'Wait / 等待'
      const equity = cash + units * bar.close
      peak = Math.max(peak, equity); drawdown = Math.min(drawdown, equity / peak - 1)
    }
    return { id, name: id === 'O01' ? 'SMA crossover / 均线交叉' : 'RSI reversion / RSI 均值回归', ret: (cash + units * (bars.at(-1)?.close ?? 0) - 1) * 100, drawdown: drawdown * 100, trades, wins, signal }
  })
}
