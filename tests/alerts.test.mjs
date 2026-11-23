import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALERT_REPEAT_MS,
  ALERT_STALE_MS,
  ALERT_STORAGE_KEY,
  beijingTradeDate,
  buildAlertEvent,
  canNotify,
  createAlertState,
  isQuoteStale,
  loadAlertState,
  notificationPermission,
  parseAlertState,
  saveAlertState,
  scanAlerts,
  serializeAlertState,
} from '../src/lib/alerts.ts'
import { evaluateLive } from '../src/lib/live-signals.ts'
import { getMarketPhase } from '../src/lib/live.ts'

/* 固定时间：北京时间 2026-11-23（周一）10:10:30，trading */
const NOW = new Date('2026-11-23T02:10:30.000Z')
const iso = (date) => date.toISOString()

const makeStrategy = (overrides = {}) => ({
  stockId: 'stock-600000',
  code: '600000',
  name: '测试股份',
  action: 'breakout',
  actionLabel: '突破买入',
  score: 80,
  summary: '测试策略',
  reasons: [],
  trigger: 10,
  stop: 9,
  target: 12,
  price: 10.5,
  changePct: 5,
  tradeDate: '2026-11-23',
  source: 'auto',
  indicators: { ma5: 10, ma10: 10, ma20: 10, high20: 10.5, atr14: 0.3, rsi14: 60, volumeRatio: 1.2 },
  bars: [],
  ...overrides,
})

const makeQuote = (overrides = {}) => ({
  code: '600000',
  price: 10.5,
  prevClose: 10,
  open: 10.1,
  high: 10.6,
  low: 10,
  changePct: 5,
  volume: 1000,
  amount: 10000,
  updatedAt: '2026-11-23T02:10:20.000Z',
  phase: 'trading',
  provider: 'eastmoney',
  ...overrides,
})

/** 构造「消费时刻 now」之前 10 秒更新的新鲜报价。 */
const quoteAt = (now, overrides = {}) =>
  makeQuote({ updatedAt: iso(new Date(now.getTime() - 10_000)), ...overrides })

const quotesOf = (quote) => ({ [quote.code]: quote })

/* ── evaluateLive：动作语义分级（P2-2） ─────────────────────── */

test('evaluateLive：非持仓 breakout 命中触发价，距离公式正确', () => {
  const status = evaluateLive(makeStrategy(), makeQuote())
  assert.deepEqual(status.hits, ['trigger'])
  assert.equal(status.code, '600000')
  assert.equal(status.phase, 'trading')
  assert.equal(status.updatedAt, '2026-11-23T02:10:20.000Z')
  assert.ok(Math.abs(status.distanceToTriggerPct - (10 / 10.5 - 1) * 100) < 1e-9)
  assert.ok(Math.abs(status.distanceToStopPct - (10.5 / 9 - 1) * 100) < 1e-9)
})

test('evaluateLive：非持仓（breakout/pullback）穿越保护位/目标位不发 stop/target 噪音', () => {
  for (const action of ['breakout', 'pullback']) {
    // 跌破保护位：非持仓没有「保护失守」提醒，且未达触发价 → 无任何提醒
    assert.deepEqual(
      evaluateLive(makeStrategy({ action }), makeQuote({ price: 8.8 })).hits,
      [],
      `${action} 跌破保护位不应提醒 stop`,
    )
    // 越过目标位：只有买入触发，没有「止盈」提醒
    assert.deepEqual(
      evaluateLive(makeStrategy({ action }), makeQuote({ price: 12.2 })).hits,
      ['trigger'],
      `${action} 越过目标位不应提醒 target`,
    )
  }
})

test('evaluateLive：watch 只观望，任何价位都不产生提醒', () => {
  for (const price of [8.8, 11, 12.2]) {
    assert.deepEqual(evaluateLive(makeStrategy({ action: 'watch' }), makeQuote({ price })).hits, [])
  }
})

test('evaluateLive：持仓语义（hold/reduce/stop）提示保护位/目标，不提示买入触发', () => {
  for (const action of ['hold', 'reduce', 'stop']) {
    assert.deepEqual(
      evaluateLive(makeStrategy({ action }), makeQuote({ price: 8.8 })).hits,
      ['stop'],
      `${action} 跌破保护位应提醒 stop`,
    )
    assert.deepEqual(
      evaluateLive(makeStrategy({ action }), makeQuote({ price: 12.2 })).hits,
      ['target'],
      `${action} 到达目标应提醒 target`,
    )
    // 越过触发价但未碰保护/目标：持仓语义不发「买入触发」
    assert.deepEqual(
      evaluateLive(makeStrategy({ action }), makeQuote({ price: 11 })).hits,
      [],
      `${action} 不应提醒 trigger`,
    )
  }
})

test('evaluateLive：持仓语义 hits 顺序为 止损 > 目标', () => {
  const status = evaluateLive(
    makeStrategy({ action: 'hold', stop: 11, target: 10.5, trigger: 10 }),
    makeQuote({ price: 10.6 }),
  )
  assert.deepEqual(status.hits, ['stop', 'target'])
})

test('evaluateLive：持仓语义仅目标位命中时 hits=[target]', () => {
  const status = evaluateLive(
    makeStrategy({ action: 'hold', stop: 9, target: 10.4, trigger: 10.6 }),
    makeQuote({ price: 10.5 }),
  )
  assert.deepEqual(status.hits, ['target'])
})

/* ── N-1：isHolding 优先于 action（持仓股也可能 action=breakout/pullback） ── */

test('N-1：isHolding 优先于 action —— 持仓股 + pullback 跌破 stop → stop（不是空）', () => {
  const strategy = makeStrategy({
    action: 'pullback',
    isHolding: true,
    trigger: 11.2,
    stop: 11.15,
    target: 12.05,
  })
  assert.deepEqual(
    evaluateLive(strategy, makeQuote({ price: 11 })).hits,
    ['stop'],
    '持仓 + pullback 现价低于 stop 必须提醒 stop',
  )
})

test('N-1：持仓股 + pullback 高于 target → target（不是 trigger）', () => {
  const strategy = makeStrategy({
    action: 'pullback',
    isHolding: true,
    trigger: 11.2,
    stop: 11.15,
    target: 12.05,
  })
  assert.deepEqual(
    evaluateLive(strategy, makeQuote({ price: 12.05 })).hits,
    ['target'],
    '持仓 + pullback 到达目标必须提醒 target，且不发 trigger',
  )
})

test('N-1：持仓股 + breakout 跌破 stop → stop', () => {
  const strategy = makeStrategy({
    action: 'breakout',
    isHolding: true,
    trigger: 11.2,
    stop: 11.15,
    target: 12.05,
  })
  assert.deepEqual(evaluateLive(strategy, makeQuote({ price: 11 })).hits, ['stop'])
})

test('N-1：持仓股 + breakout/pullback 命中多价位时保持 止损 > 目标 顺序，且不发 trigger', () => {
  for (const action of ['breakout', 'pullback']) {
    const strategy = makeStrategy({
      action,
      isHolding: true,
      trigger: 11,
      stop: 11.5,
      target: 11.2,
    })
    assert.deepEqual(evaluateLive(strategy, makeQuote({ price: 11.3 })).hits, ['stop', 'target'])
  }
})

test('N-1：isHolding=false 的 breakout/pullback 仍只发 trigger（不因 action 名误判持仓）', () => {
  for (const action of ['breakout', 'pullback']) {
    const strategy = makeStrategy({ action, isHolding: false, trigger: 10, stop: 9, target: 12 })
    assert.deepEqual(evaluateLive(strategy, makeQuote({ price: 10.5 })).hits, ['trigger'])
    // 跌破 stop 不提醒（非持仓）
    assert.deepEqual(evaluateLive(strategy, makeQuote({ price: 8.8 })).hits, [])
  }
})

test('N-1：旧数据缺 isHolding 时回退 action 推断（持仓语义兼容）', () => {
  const legacyHolding = makeStrategy({ action: 'hold', trigger: 10, stop: 9, target: 12 })
  assert.equal('isHolding' in legacyHolding, false)
  assert.deepEqual(evaluateLive(legacyHolding, makeQuote({ price: 8.8 })).hits, ['stop'])
  assert.deepEqual(evaluateLive(legacyHolding, makeQuote({ price: 12.2 })).hits, ['target'])

  // 旧数据 action=pullback 无 isHolding：仍按非持仓处理（只发 trigger）
  const legacyEntry = makeStrategy({ action: 'pullback', trigger: 10, stop: 9, target: 12 })
  assert.deepEqual(evaluateLive(legacyEntry, makeQuote({ price: 10.5 })).hits, ['trigger'])
})

test('N-1：watch 不发提醒（含显式 isHolding=false）', () => {
  for (const price of [8.8, 11, 12.2]) {
    const strategy = makeStrategy({ action: 'watch', isHolding: false, trigger: 10, stop: 9, target: 12 })
    assert.deepEqual(evaluateLive(strategy, makeQuote({ price })).hits, [])
  }
})

test('evaluateLive：缺失/非法价位不产生命中且距离为 undefined', () => {
  const status = evaluateLive(
    makeStrategy({ action: 'hold', trigger: undefined, stop: undefined, target: 0 }),
    makeQuote(),
  )
  assert.deepEqual(status.hits, [])
  assert.equal(status.distanceToTriggerPct, undefined)
  assert.equal(status.distanceToStopPct, undefined)

  assert.deepEqual(
    evaluateLive(
      makeStrategy({ trigger: undefined, stop: undefined, target: undefined }),
      makeQuote(),
    ).hits,
    [],
  )
})

/* ── buildAlertEvent / 交易日 ───────────────────────────────── */

test('buildAlertEvent：id = code:kind:tradeDate，level/price/at 正确', () => {
  const event = buildAlertEvent(makeStrategy(), makeQuote(), 'trigger', NOW)
  assert.equal(event.id, '600000:trigger:2026-11-23')
  assert.equal(event.code, '600000')
  assert.equal(event.name, '测试股份')
  assert.equal(event.kind, 'trigger')
  assert.equal(event.level, 10)
  assert.equal(event.price, 10.5)
  assert.equal(event.at, NOW.toISOString())
  assert.match(event.message, /测试股份/)
  assert.match(event.message, /触发买点/)
})

test('buildAlertEvent：止损/目标使用各自价位与文案', () => {
  const stop = buildAlertEvent(makeStrategy(), makeQuote({ price: 8.8 }), 'stop', NOW)
  const target = buildAlertEvent(makeStrategy(), makeQuote({ price: 12.2 }), 'target', NOW)
  assert.equal(stop.level, 9)
  assert.match(stop.message, /跌破止损/)
  assert.equal(target.level, 12)
  assert.match(target.message, /触及目标/)
})

test('交易日按北京时间切分（UTC 17:00 已属次日）', () => {
  assert.equal(beijingTradeDate('2026-11-23T02:00:00.000Z'), '2026-11-23')
  assert.equal(beijingTradeDate('2026-11-23T16:00:00.000Z'), '2026-11-24')
  assert.equal(beijingTradeDate('not-a-date'), '')
})

/* ── 去重：当天一次 + 兜底节流 + 跨日重置 ──────────────────── */

test('当天一次：id 去重保证同日重复扫描不再提醒（5 分钟节流仅兜底防抖）', () => {
  const strategies = [makeStrategy()]
  const quotes = quotesOf(makeQuote())

  const first = scanAlerts(strategies, quotes, createAlertState(), { now: NOW })
  assert.equal(first.events.length, 1)
  assert.equal(first.events[0].id, '600000:trigger:2026-11-23')
  assert.equal(first.state.seenIds.length, 1)

  const second = scanAlerts(strategies, quotes, first.state, { now: NOW })
  assert.deepEqual(second.events, [])

  // 即使外部只构造了「已见」状态（没有 lastFiredAt），也不会重复
  const seeded = scanAlerts(strategies, quotes, { seenIds: [first.events[0].id], lastFiredAt: {} }, { now: NOW })
  assert.deepEqual(seeded.events, [])
})

test('兜底节流：已见集合丢失时 5 分钟内仍不重复，窗口过后放行', () => {
  assert.equal(ALERT_REPEAT_MS, 5 * 60 * 1000)
  const strategies = [makeStrategy()]
  const state = { seenIds: [], lastFiredAt: { '600000:trigger': NOW.getTime() - 60_000 } }

  const throttled = scanAlerts(strategies, quotesOf(makeQuote()), state, { now: NOW })
  assert.deepEqual(throttled.events, [])

  const later = new Date(NOW.getTime() + ALERT_REPEAT_MS + 1000)
  const afterWindow = scanAlerts(strategies, quotesOf(quoteAt(later)), state, { now: later })
  assert.equal(afterWindow.events.length, 1)
  assert.equal(afterWindow.events[0].id, '600000:trigger:2026-11-23')
})

test('跨日重置：新交易日重新提醒，已见集合按天裁剪', () => {
  const strategies = [makeStrategy()]
  const day1 = scanAlerts(
    strategies,
    quotesOf(makeQuote({ updatedAt: '2026-11-23T02:10:20.000Z' })),
    createAlertState(),
    { now: NOW },
  )
  assert.equal(day1.events.length, 1)
  assert.equal(day1.events[0].id, '600000:trigger:2026-11-23')

  const day2Now = new Date('2026-11-24T02:10:30.000Z')
  const day2 = scanAlerts(strategies, quotesOf(quoteAt(day2Now)), day1.state, { now: day2Now })
  assert.equal(day2.events.length, 1)
  assert.equal(day2.events[0].id, '600000:trigger:2026-11-24')
  assert.deepEqual(day2.state.seenIds, ['600000:trigger:2026-11-24'])
  assert.equal(day2.state.lastFiredAt['600000:trigger'], day2Now.getTime())
})

/* ── P1-2：消费时墙钟二次校验（不信任 quote.phase 快照） ───── */

test('P1-2 边界：11:29:59 拿到 phase=trading 的报价，now=11:30:01 不提醒', () => {
  const before = new Date('2026-11-23T03:29:59.000Z')
  const after = new Date('2026-11-23T03:30:01.000Z')
  assert.equal(getMarketPhase(before), 'trading')
  assert.equal(getMarketPhase(after), 'lunch')

  const quote = makeQuote({ updatedAt: iso(before), phase: 'trading' })
  const result = scanAlerts([makeStrategy()], quotesOf(quote), createAlertState(), { now: after })
  assert.deepEqual(result.events, [])
})

test('P1-2 边界：15:00:00 拿到 phase=trading 的报价，now=15:00:01 不提醒', () => {
  const before = new Date('2026-11-23T07:00:00.000Z')
  const after = new Date('2026-11-23T07:00:01.000Z')
  assert.equal(getMarketPhase(before), 'closed')
  assert.equal(getMarketPhase(after), 'closed')

  const quote = makeQuote({ updatedAt: '2026-11-23T06:59:59.000Z', phase: 'trading' })
  const result = scanAlerts([makeStrategy()], quotesOf(quote), createAlertState(), { now: after })
  assert.deepEqual(result.events, [])
})

test('P1-2 反向：报价快照 phase 过期（preopen/lunch）但墙钟已 auction/trading 时以墙钟为准提醒', () => {
  // 报文 phase=preopen，但消费时已是 09:20 集合竞价（报价 1 秒前更新，新鲜）
  const auctionNow = new Date('2026-11-23T01:20:00.000Z')
  const auctionQuote = makeQuote({ updatedAt: '2026-11-23T01:19:59.000Z', phase: 'preopen' })
  const auction = scanAlerts([makeStrategy()], quotesOf(auctionQuote), createAlertState(), { now: auctionNow })
  assert.equal(auction.events.length, 1, '墙钟 auction 时应提醒')

  // 报文 phase=lunch，但消费时已是 10:10 交易中
  const tradingQuote = makeQuote({ updatedAt: '2026-11-23T02:10:20.000Z', phase: 'lunch' })
  const trading = scanAlerts([makeStrategy()], quotesOf(tradingQuote), createAlertState(), { now: NOW })
  assert.equal(trading.events.length, 1, '墙钟 trading 时应提醒')
})

test('墙钟非 auction/trading 不提醒（午休/盘前/收盘/周末），即使报价 phase=trading 且新鲜', () => {
  const cases = [
    ['lunch', new Date('2026-11-23T03:40:00.000Z')],
    ['preopen', new Date('2026-11-23T01:00:00.000Z')],
    ['closed', new Date('2026-11-23T07:00:30.000Z')],
    ['non-trading', new Date('2026-11-28T02:00:00.000Z')],
  ]
  for (const [expectedPhase, now] of cases) {
    assert.equal(getMarketPhase(now), expectedPhase)
    const quote = quoteAt(now, { phase: 'trading' })
    const result = scanAlerts([makeStrategy()], quotesOf(quote), createAlertState(), { now })
    assert.deepEqual(result.events, [], `${expectedPhase} 不应提醒（即使报价 phase=trading）`)
  }
})

/* ── 报价新鲜度 ─────────────────────────────────────────────── */

test('超过 2 分钟未更新的报价不提醒，边界按 2 分钟计', () => {
  assert.equal(ALERT_STALE_MS, 2 * 60 * 1000)
  const strategies = [makeStrategy()]

  const stale = iso(new Date(NOW.getTime() - ALERT_STALE_MS - 1000))
  const staleResult = scanAlerts(strategies, quotesOf(makeQuote({ updatedAt: stale })), createAlertState(), { now: NOW })
  assert.deepEqual(staleResult.events, [])
  assert.equal(isQuoteStale(makeQuote({ updatedAt: stale }), NOW), true)

  const boundary = iso(new Date(NOW.getTime() - ALERT_STALE_MS))
  const boundaryResult = scanAlerts(strategies, quotesOf(makeQuote({ updatedAt: boundary })), createAlertState(), { now: NOW })
  assert.equal(boundaryResult.events.length, 1)
  assert.equal(isQuoteStale(makeQuote({ updatedAt: boundary }), NOW), false)

  const broken = scanAlerts(strategies, quotesOf(makeQuote({ updatedAt: 'garbage' })), createAlertState(), { now: NOW })
  assert.deepEqual(broken.events, [])
})

/* ── 多策略 / 多命中 ────────────────────────────────────────── */

test('无报价的策略跳过，多策略按各自语义产出事件', () => {
  const strategies = [
    makeStrategy({ code: '600000' }),
    makeStrategy({ code: '600519', name: '另一只' }),
    makeStrategy({ code: '000001', name: '无报价' }),
  ]
  const quotes = {
    '600000': makeQuote({ price: 10.6 }),
    '600519': makeQuote({ code: '600519', price: 11.2 }),
  }
  const result = scanAlerts(strategies, quotes, createAlertState(), { now: NOW })
  assert.equal(result.events.length, 2)
  assert.deepEqual(result.events.map((event) => event.code).sort(), ['600000', '600519'])
})

test('持仓语义多命中时按 止损 > 目标 顺序产出事件', () => {
  const strategies = [makeStrategy({ action: 'hold', stop: 11, target: 10.5, trigger: 10 })]
  const quotes = quotesOf(makeQuote({ price: 10.6 }))
  const result = scanAlerts(strategies, quotes, createAlertState(), { now: NOW })
  assert.deepEqual(result.events.map((event) => event.kind), ['stop', 'target'])
})

test('scanAlerts 事件级语义：非持仓只产出 trigger，持仓只产出 stop/target', () => {
  // 非持仓跌破保护位：不产出任何事件
  const breakoutStop = scanAlerts(
    [makeStrategy({ action: 'breakout' })],
    quotesOf(makeQuote({ price: 8.8 })),
    createAlertState(),
    { now: NOW },
  )
  assert.deepEqual(breakoutStop.events, [])

  // 非持仓越过目标位：只产出 trigger（无 target）
  const breakoutTarget = scanAlerts(
    [makeStrategy({ action: 'breakout' })],
    quotesOf(makeQuote({ price: 12.2 })),
    createAlertState(),
    { now: NOW },
  )
  assert.deepEqual(breakoutTarget.events.map((event) => event.kind), ['trigger'])

  // 持仓到达目标位：只产出 target
  const holdingTarget = scanAlerts(
    [makeStrategy({ action: 'hold' })],
    quotesOf(makeQuote({ price: 12.2 })),
    createAlertState(),
    { now: NOW },
  )
  assert.deepEqual(holdingTarget.events.map((event) => event.kind), ['target'])
})

/* ── 持久化：坏数据降级 ────────────────────────────────────── */

test('状态序列化往返保留已见集合与节流时间', () => {
  const state = { seenIds: ['600000:trigger:2026-11-23'], lastFiredAt: { '600000:trigger': 123 } }
  assert.deepEqual(parseAlertState(serializeAlertState(state)), state)
  assert.deepEqual(parseAlertState(null), createAlertState())
  assert.deepEqual(parseAlertState(''), createAlertState())
})

test('损坏/版本不符/字段类型错误的持久化数据降级为空状态且不抛错', () => {
  const badInputs = [
    '{broken json',
    'null',
    '[]',
    '42',
    JSON.stringify({ version: 999, seenIds: ['600000:trigger:2026-11-23'] }),
    JSON.stringify({ version: 1, seenIds: 'not-an-array' }),
    JSON.stringify({ version: 1, seenIds: [1, null, 'ok'], lastFiredAt: { 'a:b': 'x', 'c:d': 42 } }),
  ]
  for (const raw of badInputs) {
    assert.doesNotThrow(() => parseAlertState(raw), raw)
  }
  assert.deepEqual(parseAlertState(badInputs[0]), createAlertState())
  assert.deepEqual(parseAlertState(badInputs[4]), createAlertState())
  assert.deepEqual(parseAlertState(badInputs[5]), createAlertState())
  assert.deepEqual(parseAlertState(badInputs[6]), {
    seenIds: ['ok'],
    lastFiredAt: { 'c:d': 42 },
  })
})

test('localStorage 缺失/抛错时读写静默降级', () => {
  const throwingStorage = {
    getItem() {
      throw new Error('storage blocked')
    },
    setItem() {
      throw new Error('quota exceeded')
    },
  }
  assert.deepEqual(loadAlertState(throwingStorage), createAlertState())
  assert.doesNotThrow(() => saveAlertState(createAlertState(), throwingStorage))

  const memory = new Map()
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
  }
  const state = { seenIds: ['600000:stop:2026-11-23'], lastFiredAt: { '600000:stop': 456 } }
  saveAlertState(state, storage)
  assert.equal(memory.has(ALERT_STORAGE_KEY), true)
  assert.deepEqual(loadAlertState(storage), state)
  assert.deepEqual(loadAlertState(null), createAlertState())
})

/* ── 通知权限缺失/状态 ─────────────────────────────────────── */

test('没有 Notification API 时权限为 unsupported，且不可通知', () => {
  assert.equal(notificationPermission({}), 'unsupported')
  assert.equal(notificationPermission(undefined), 'unsupported')
  assert.equal(canNotify('unsupported'), false)
})

test('读取 Notification 权限并判断是否可通知', () => {
  for (const value of ['default', 'denied', 'granted']) {
    const scope = { Notification: { permission: value } }
    assert.equal(notificationPermission(scope), value)
    assert.equal(canNotify(value), value === 'granted')
  }
})
