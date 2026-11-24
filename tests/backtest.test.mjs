import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_INITIAL_CAPITAL,
  DEFAULT_MIN_COMMISSION,
  LOT_SIZE,
  STAMP_DUTY_RATE,
  buyFeeFor,
  limitPctFor,
  roundTripCostBps,
  runAllBacktests,
  runBacktest,
  sellFeeFor,
} from '../src/lib/backtest.ts'

/* ── 离线 fixture：60 根平价日线 + 指定位置注入突破信号 ─────── */

const DAY_MS = 86_400_000
const dateAt = (index) => new Date(Date.UTC(2026, 0, 1) + index * DAY_MS).toISOString().slice(0, 10)

const makeBar = (index, open, high, low, close, changePct = 0, volume = 100) => ({
  date: dateAt(index),
  open,
  high,
  low,
  close,
  volume,
  amount: close * volume,
  changePct,
})

const flatBar = (index) => makeBar(index, 10, 10.02, 9.98, 10, 0, 100)

const SIGNAL_INDEX = 25

/** 平价日线；第 SIGNAL_INDEX 根注入 breakout 信号（放量 + 涨幅 ≥1%）。 */
const signalBars = (length = 60) => {
  const bars = Array.from({ length }, (_, index) => flatBar(index))
  bars[SIGNAL_INDEX] = makeBar(SIGNAL_INDEX, 10, 10.08, 10, 10.05, 1.2, 300)
  return bars
}

/** 默认入场：信号次日 10.06 开盘（stop≈10.00，target≈10.17）。 */
const withEntryBar = (bars, overrides = {}) => {
  const entryIndex = SIGNAL_INDEX + 1
  bars[entryIndex] = makeBar(entryIndex, 10.06, 10.1, 10.02, 10.06, 0.1, 100)
  for (const [index, bar] of Object.entries(overrides)) bars[Number(index)] = bar
  return bars
}

const entryOf = (result) => result.trades[0]

/* ── 1) 跳空后按实际可成交价 ────────────────────────────────── */

test('止损跳空低开：按 min(保护位, 开盘) 成交，而不是保护位', () => {
  const bars = withEntryBar(signalBars(), {
    [SIGNAL_INDEX + 2]: makeBar(SIGNAL_INDEX + 2, 9.98, 10.0, 9.95, 9.97, -0.9, 100),
  })
  const result = runBacktest('breakout', bars, { code: '600000' })
  const trade = entryOf(result)

  assert.equal(trade.entryPrice, 10.06)
  assert.ok(trade.stop !== undefined)
  // 开盘 9.98 低于保护位 ≈10.00 → 成交价 9.98（跳空，不是保护位）
  assert.equal(trade.exitPrice, 9.98)
  assert.ok(trade.exitPrice < trade.stop)
  assert.equal(trade.exitReason, '触及保护位')
})

test('目标跳空高开：按 max(目标位, 开盘) 成交', () => {
  const bars = withEntryBar(signalBars(), {
    [SIGNAL_INDEX + 2]: makeBar(SIGNAL_INDEX + 2, 10.2, 10.25, 10.15, 10.2, 1.4, 100),
  })
  const result = runBacktest('breakout', bars, { code: '600000' })
  const trade = entryOf(result)

  assert.ok(trade.target !== undefined && Number.isFinite(trade.target))
  assert.equal(trade.exitPrice, 10.2)
  assert.ok(trade.exitPrice > trade.target)
  assert.equal(trade.exitReason, '达到目标位')
})

test('无跳空的日内止损：仍按保护位成交（与旧口径一致的价位）', () => {
  const bars = withEntryBar(signalBars(), {
    [SIGNAL_INDEX + 2]: makeBar(SIGNAL_INDEX + 2, 10.05, 10.06, 9.95, 10.0, -0.6, 100),
  })
  const result = runBacktest('breakout', bars, { code: '600000' })
  const trade = entryOf(result)
  assert.ok(Math.abs(trade.exitPrice - trade.stop) < 0.01)
})

/* ── 2) 涨停买不到 / 跌停卖不掉 ─────────────────────────────── */

test('买入日开盘涨停（一字板）→ 顺延下一交易日成交', () => {
  const bars = signalBars()
  // 次日一字涨停：10.05 × 1.1 = 11.06（主板 10%）
  bars[SIGNAL_INDEX + 1] = makeBar(SIGNAL_INDEX + 1, 11.06, 11.06, 11.06, 11.06, 10.05, 50)
  bars[SIGNAL_INDEX + 2] = makeBar(SIGNAL_INDEX + 2, 10.6, 10.7, 10.5, 10.6, -4.2, 100)

  const result = runBacktest('breakout', bars, { code: '600000' })
  const trade = entryOf(result)
  assert.equal(trade.entryIndex, SIGNAL_INDEX + 2, '顺延到下一交易日开盘成交')
  assert.equal(trade.entryPrice, 10.6)
  assert.equal(result.unfilledEntries, 0)
})

test('连续两次涨停买不到 → 放弃入场并记 unfilled', () => {
  const bars = signalBars()
  bars[SIGNAL_INDEX + 1] = makeBar(SIGNAL_INDEX + 1, 11.06, 11.06, 11.06, 11.06, 10.05, 50)
  bars[SIGNAL_INDEX + 2] = makeBar(SIGNAL_INDEX + 2, 12.17, 12.17, 12.17, 12.17, 10.0, 50)

  const result = runBacktest('breakout', bars, { code: '600000' })
  assert.equal(result.trades.length, 0)
  assert.equal(result.unfilledEntries, 1)
  assert.ok(result.unfilledReasons.some((reason) => reason.includes('涨停')), '应记录涨停未成交原因')
})

test('卖出日一字跌停 → 延迟卖出并记 slippage_wait，下一日按开盘价成交', () => {
  const bars = withEntryBar(signalBars(), {
    // 10.06 × 0.9 = 9.05，一字跌停（触发保护位但卖不掉）
    [SIGNAL_INDEX + 2]: makeBar(SIGNAL_INDEX + 2, 9.05, 9.05, 9.05, 9.05, -10.0, 20),
    // 下一交易日打开跌停：按开盘价 9.0 卖出
    [SIGNAL_INDEX + 3]: makeBar(SIGNAL_INDEX + 3, 9.0, 9.1, 8.9, 9.0, -0.6, 100),
  })
  const result = runBacktest('breakout', bars, { code: '600000' })
  const trade = entryOf(result)

  assert.equal(result.slippageWaits, 1)
  assert.equal(trade.exitIndex, SIGNAL_INDEX + 3, '跌停日不能卖，顺延到下一日')
  assert.equal(trade.exitPrice, 9.0)
  assert.match(trade.exitReason, /跌停顺延/)
})

/* ── 3) 整手与最低佣金 ─────────────────────────────────────── */

test('买入股数 floor 到 100 股整手', () => {
  const bars = withEntryBar(signalBars(), {
    [SIGNAL_INDEX + 2]: makeBar(SIGNAL_INDEX + 2, 10.2, 10.25, 10.15, 10.2, 1.4, 100),
  })
  const result = runBacktest('breakout', bars, { code: '600000', initialCapital: 2000 })
  const trade = entryOf(result)
  // 2000 元 / 10.06 ≈ 198 股 → floor 到 100 股
  assert.equal(LOT_SIZE, 100)
  assert.equal(trade.units, 100)
  assert.equal(trade.units % LOT_SIZE, 0)

  const large = runBacktest('breakout', bars, { code: '600000' })
  assert.equal(large.trades[0].units % LOT_SIZE, 0)
  assert.ok(large.trades[0].units > 100)
})

test('资金不足 1 手 → 不成交并记 unfilled', () => {
  const bars = withEntryBar(signalBars())
  const result = runBacktest('breakout', bars, { code: '600000', initialCapital: 500 })
  assert.equal(result.trades.length, 0)
  assert.ok(result.unfilledEntries >= 1)
  assert.ok(result.unfilledReasons.some((reason) => reason.includes('不足 1 手')))
})

test('最低佣金 5 元生效：小额交易买入/卖出各至少 5 元', () => {
  const bars = withEntryBar(signalBars(), {
    [SIGNAL_INDEX + 2]: makeBar(SIGNAL_INDEX + 2, 10.2, 10.25, 10.15, 10.2, 1.4, 100),
  })
  const result = runBacktest('breakout', bars, { code: '600000', initialCapital: 2000 })
  const trade = entryOf(result)

  assert.equal(DEFAULT_MIN_COMMISSION, 5)
  assert.equal(trade.entryFee, 5)
  // 卖出：佣金下限 5 + 印花税 0.05%
  const sellAmount = 100 * 10.2
  assert.ok(Math.abs(trade.exitFee - (5 + sellAmount * STAMP_DUTY_RATE)) < 1e-6)
  assert.ok(trade.exitFee > 5)
})

test('1 万元级别往返成本约 15bp（佣金万 2.5 + 最低 5 元 + 印花税）', () => {
  const roundTrip = roundTripCostBps(10_000)
  assert.ok(Math.abs(roundTrip - 15) < 1e-9, `期望 15bp，实际 ${roundTrip}bp`)

  // 大额交易不再被最低佣金主导：10 万元往返约 10bp
  assert.ok(Math.abs(roundTripCostBps(100_000) - 10) < 1e-9)

  assert.equal(buyFeeFor(10_000), 5)
  assert.equal(sellFeeFor(10_000), 10)
  assert.equal(buyFeeFor(0), 0)
})

test('默认成本（万2.5 + 最低5元 + 印花税）低于零成本，收益差约 10bp', () => {
  const bars = withEntryBar(signalBars(), {
    [SIGNAL_INDEX + 2]: makeBar(SIGNAL_INDEX + 2, 10.2, 10.25, 10.15, 10.2, 1.4, 100),
  })
  const withDefaultCost = runBacktest('breakout', bars, { code: '600000', initialCapital: DEFAULT_INITIAL_CAPITAL })
  const zeroCost = runBacktest('breakout', bars, {
    code: '600000',
    initialCapital: DEFAULT_INITIAL_CAPITAL,
    costs: { commissionBps: 0, minCommission: 0 },
  })

  assert.ok(withDefaultCost.trades.length === 1 && zeroCost.trades.length === 1)
  assert.ok(withDefaultCost.totalReturnPct < zeroCost.totalReturnPct, '默认成本应降低收益')
  // 约 10 万元单笔往返 ~10bp → 收益差约 0.1 个百分点
  const gap = zeroCost.totalReturnPct - withDefaultCost.totalReturnPct
  assert.ok(gap > 0.05 && gap < 0.2, `成本差应在 5-20bp，实际 ${gap.toFixed(3)}%`)
})

/* ── 4) 停牌 / 缺 bar ──────────────────────────────────────── */

test('停牌（无有效 open/close）的 bar 跳过，不成交', () => {
  const bars = signalBars()
  bars[SIGNAL_INDEX + 1] = makeBar(SIGNAL_INDEX + 1, 0, 0, 0, 0, 0, 0)
  bars[SIGNAL_INDEX + 2] = makeBar(SIGNAL_INDEX + 2, 10.6, 10.7, 10.5, 10.6, 0.5, 100)

  const result = runBacktest('breakout', bars, { code: '600000' })
  const trade = entryOf(result)
  assert.equal(trade.entryIndex, SIGNAL_INDEX + 2, '停牌 bar 被跳过，下一有效 bar 才成交')
  assert.equal(result.equity.length, bars.length)
  assert.ok(result.equity.every((point) => Number.isFinite(point.value) && point.value > 0))
})

/* ── 5) limitPctFor 各板块 / ST ─────────────────────────────── */

test('limitPctFor：主板 10%、创业板/科创板 20%、北交所 30%', () => {
  assert.equal(limitPctFor('600519'), 0.1)
  assert.equal(limitPctFor('000001'), 0.1)
  assert.equal(limitPctFor('sh600519'), 0.1)
  assert.equal(limitPctFor('300750'), 0.2)
  assert.equal(limitPctFor('301001'), 0.2)
  assert.equal(limitPctFor('688981'), 0.2)
  assert.equal(limitPctFor('689009'), 0.2)
  assert.equal(limitPctFor('920575'), 0.3)
  assert.equal(limitPctFor('830799'), 0.3)
  assert.equal(limitPctFor('430047'), 0.3)
})

test('limitPctFor：ST 主板 2026-07-06 起 10%（此前 5%），创业板 20%、北交所 30%', () => {
  assert.equal(limitPctFor('600530', { isSt: true, tradeDate: '2026-11-24' }), 0.1)
  assert.equal(limitPctFor('600530', { isSt: true, tradeDate: '2026-01-05' }), 0.05)
  assert.equal(limitPctFor('300205', { isSt: true, tradeDate: '2026-11-24' }), 0.2)
  assert.equal(limitPctFor('920575', { isSt: true, tradeDate: '2026-11-24' }), 0.3)
})

/* ── 6) 结果结构与正常路径 / 与旧实现差异 ──────────────────── */

test('结果结构包含真实化计数，正常路径仍产出交易', () => {
  const bars = withEntryBar(signalBars(), {
    [SIGNAL_INDEX + 2]: makeBar(SIGNAL_INDEX + 2, 10.2, 10.25, 10.15, 10.2, 1.4, 100),
  })
  const result = runBacktest('breakout', bars, { code: '600000' })
  assert.equal(result.unfilledEntries, 0)
  assert.equal(result.slippageWaits, 0)
  assert.equal(result.trades.length >= 1, true)
  const trade = result.trades[0]
  for (const key of ['signalIndex', 'entryIndex', 'exitIndex', 'entryDate', 'exitDate', 'entryPrice', 'exitPrice', 'returnPct', 'exitReason']) {
    assert.ok(key in trade, `trade 缺字段 ${key}`)
  }
  assert.equal(typeof trade.returnPct, 'number')
  assert.ok(Number.isFinite(trade.returnPct))
})

test('runAllBacktests 对四种策略都返回含新计数的结果', () => {
  const results = runAllBacktests(signalBars())
  assert.deepEqual(results.map((result) => result.id), ['breakout', 'pullback', 'trend', 'reversion'])
  for (const result of results) {
    assert.equal(typeof result.unfilledEntries, 'number')
    assert.ok(Array.isArray(result.unfilledReasons))
    assert.equal(typeof result.slippageWaits, 'number')
    assert.equal(result.equity.length, 60)
  }
})

test('旧 vs 新：止损跳空 + 成本使收益低于旧「触发价×(1-0.1%)」口径', () => {
  const bars = withEntryBar(signalBars(), {
    [SIGNAL_INDEX + 2]: makeBar(SIGNAL_INDEX + 2, 9.98, 10.0, 9.95, 9.97, -0.9, 100),
  })
  const result = runBacktest('breakout', bars, { code: '600000', initialCapital: 2000 })
  const trade = entryOf(result)

  // 旧口径：止损价 × 0.999 成交，且不扣最低佣金
  const legacyCost = { commissionBps: 0, minCommission: 0 }
  const legacyLike = runBacktest('breakout', bars, { code: '600000', initialCapital: 2000, costs: legacyCost })
  const legacyTrade = legacyLike.trades[0]

  assert.equal(legacyTrade.exitPrice, 9.98)
  assert.ok(trade.returnPct < legacyTrade.returnPct, '默认成本 + 跳空价应低于零成本口径')
  // 旧实现按 stop×(1-0.1%) 估约 9.99；新实现开盘跳空成交 9.98
  assert.ok(trade.exitPrice <= Math.min(trade.stop, 9.98))
})
