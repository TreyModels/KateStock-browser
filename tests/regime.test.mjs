import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REGIME_BREADTH_BULL,
  REGIME_DRAWDOWN_SAFE,
  REGIME_MIN_INDEX_BARS,
  beijingToday,
  clearRegimeCache,
  computeBreadth,
  computeRegime,
  loadRegime,
  loadRegimeDetail,
  normalizeBars,
  readRegimeCache,
} from '../src/lib/regime.ts'

/* ─────────────────────────────────────────────────────────────
 * 离线 fixture：合成日线（不访问网络）。
 * ───────────────────────────────────────────────────────────── */

function makeBars(closes, start = '2025-01-02') {
  const startDate = new Date(`${start}T00:00:00Z`)
  return closes.map((close, index) => {
    const date = new Date(startDate.getTime() + index * 86_400_000).toISOString().slice(0, 10)
    const previous = index > 0 ? closes[index - 1] : close
    const open = previous
    return {
      date,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: 1000,
      amount: 0,
      changePct: index > 0 ? (close / previous - 1) * 100 : 0,
    }
  })
}

/** 稳定上涨：100 → 179.5（160 根）。 */
const UP_BARS = makeBars(Array.from({ length: 160 }, (_, i) => 100 + i * 0.5))
/** 稳定下跌：200 → 120.5（160 根）。 */
const DOWN_BARS = makeBars(Array.from({ length: 160 }, (_, i) => 200 - i * 0.5))
/** 震荡：先跌后温和反弹、仍在 MA120 下方且回撤 ≥15%（160 根，评分 4/7）。 */
const RANGE_BARS = makeBars([
  ...Array.from({ length: 120 }, (_, i) => 140 - i * (40 / 119)),
  ...Array.from({ length: 40 }, (_, i) => 100 + (i + 1) * (12 / 40)),
])

const INDEX_UPTREND = UP_BARS
const INDEX_DOWNTREND = DOWN_BARS
const INDEX_RANGE = RANGE_BARS

/* ─────────────────────────────────────────────────────────────
 * 1) 三组样例判定
 * ───────────────────────────────────────────────────────────── */

test('上涨组：bull，confidence 100，source=index，asOf=最后一根日期', () => {
  const info = computeRegime({ indexBars: INDEX_UPTREND, watchlist: [UP_BARS, UP_BARS, UP_BARS] })
  assert.equal(info.regime, 'bull')
  assert.equal(info.source, 'index')
  assert.equal(info.confidence, 100)
  assert.ok(info.confidence >= 0 && info.confidence <= 100)
  assert.equal(info.asOf, INDEX_UPTREND.at(-1).date)
  assert.equal(info.breadthPct, 100)
  assert.ok(info.evidence.length >= 5)
  assert.ok(info.evidence.some((line) => line.includes('沪深300 收盘')))
  assert.ok(info.evidence.some((line) => line.includes('评分 7/7')))
})

test('下跌组：bear，confidence 100，评分 0/7', () => {
  const info = computeRegime({ indexBars: INDEX_DOWNTREND, watchlist: [DOWN_BARS, DOWN_BARS, DOWN_BARS] })
  assert.equal(info.regime, 'bear')
  assert.equal(info.source, 'index')
  assert.equal(info.confidence, 100)
  assert.equal(info.breadthPct, 0)
  assert.ok(info.evidence.some((line) => line.includes('评分 0/7')))
  assert.ok(info.evidence.some((line) => line.includes('回撤')))
})

test('震荡组：range，评分 4/7，confidence 在 0-100', () => {
  const info = computeRegime({ indexBars: INDEX_RANGE, watchlist: [DOWN_BARS, DOWN_BARS, DOWN_BARS] })
  assert.equal(info.regime, 'range')
  assert.equal(info.source, 'index')
  assert.ok(info.confidence >= 0 && info.confidence <= 100)
  assert.ok(info.evidence.some((line) => line.includes('评分 4/7')))
  assert.ok(info.evidence.some((line) => line.includes('判定震荡')))
})

test('computeRegime 是纯函数：同输入结果稳定、不修改入参', () => {
  const indexCopy = INDEX_UPTREND.map((bar) => ({ ...bar }))
  const watchlist = [UP_BARS, DOWN_BARS]
  const first = computeRegime({ indexBars: INDEX_UPTREND, watchlist })
  const second = computeRegime({ indexBars: INDEX_UPTREND, watchlist })
  assert.deepEqual(first, second)
  assert.equal(INDEX_UPTREND.length, indexCopy.length)
  assert.deepEqual(INDEX_UPTREND, indexCopy)
})

/* ─────────────────────────────────────────────────────────────
 * 2) 宽度
 * ───────────────────────────────────────────────────────────── */

test('宽度：close>MA20 占比（涨 2 / 共 3 = 66.67%）', () => {
  const breadth = computeBreadth([UP_BARS, UP_BARS, DOWN_BARS])
  assert.equal(breadth.total, 3)
  assert.equal(breadth.above, 2)
  assert.ok(Math.abs(breadth.pct - (2 / 3) * 100) < 1e-9)
})

test('宽度分母只统计 ≥20 根日线的标的', () => {
  const shortBars = makeBars(Array.from({ length: 10 }, () => 100))
  const breadth = computeBreadth([UP_BARS, DOWN_BARS, shortBars])
  assert.equal(breadth.total, 2) // 10 根的标的被排除
  assert.equal(breadth.above, 1)
  assert.equal(computeBreadth([]).pct, undefined)
})

/* ─────────────────────────────────────────────────────────────
 * 3) index 缺失 / 不足 → 宽度兜底
 * ───────────────────────────────────────────────────────────── */

test('index 缺失：source=breadth，判定按宽度（≥60% → bull）', () => {
  const info = computeRegime({ watchlist: [UP_BARS, UP_BARS, DOWN_BARS] })
  assert.equal(info.source, 'breadth')
  assert.equal(info.regime, 'bull')
  assert.ok(info.breadthPct > REGIME_BREADTH_BULL)
  assert.equal(info.asOf, UP_BARS.at(-1).date)
  assert.ok(info.evidence.some((line) => line.includes('沪深300 日线缺失或不足')))
})

test('index 不足 120 根：退回宽度', () => {
  const shortIndex = INDEX_UPTREND.slice(0, REGIME_MIN_INDEX_BARS - 1)
  const info = computeRegime({ indexBars: shortIndex, watchlist: [UP_BARS, DOWN_BARS] })
  assert.equal(info.source, 'breadth')
  assert.ok(info.breadthPct !== undefined)
})

test('宽度 ≤40% → bear（仅宽度模式）', () => {
  const info = computeRegime({ watchlist: [DOWN_BARS, DOWN_BARS, DOWN_BARS, UP_BARS] })
  assert.equal(info.source, 'breadth')
  assert.equal(info.regime, 'bear')
  assert.equal(info.breadthPct, 25)
})

test('完全没有数据：range / confidence 0 / asOf 空，不抛错', () => {
  const info = computeRegime({ watchlist: [] })
  assert.equal(info.regime, 'range')
  assert.equal(info.confidence, 0)
  assert.equal(info.source, 'breadth')
  assert.equal(info.asOf, '')
  assert.equal(info.breadthPct, undefined)
})

/* ─────────────────────────────────────────────────────────────
 * 4) 日期 / 无未来函数
 * ───────────────────────────────────────────────────────────── */

test('asOf 截断：只使用当日及之前 bar（未来 bar 不影响结果）', () => {
  const cutoff = INDEX_UPTREND[139].date
  const withFuture = [...INDEX_UPTREND, ...makeBars(Array.from({ length: 40 }, (_, i) => 500 + i), '2025-09-01')]
  const truncated = computeRegime({ indexBars: INDEX_UPTREND, watchlist: [UP_BARS] })
  const withAsOf = computeRegime({ indexBars: withFuture, watchlist: [UP_BARS], asOf: cutoff })
  const withFutureIgnored = computeRegime({ indexBars: INDEX_UPTREND.slice(0, 140), watchlist: [UP_BARS.slice(0, 140)] })

  // asOf 截断后应完全等价于「只喂到 cutoff」的输入
  assert.deepEqual(withAsOf, withFutureIgnored)
  assert.notEqual(withAsOf.asOf, truncated.asOf) // 截断后 asOf 就是 cutoff
  assert.equal(withAsOf.asOf, cutoff)
})

test('乱序输入会按日期升序归一，结果与排序后一致', () => {
  const shuffled = [...INDEX_UPTREND].reverse()
  const sorted = computeRegime({ indexBars: INDEX_UPTREND, watchlist: [UP_BARS] })
  const fromShuffled = computeRegime({ indexBars: shuffled, watchlist: [UP_BARS] })
  assert.deepEqual(fromShuffled, sorted)
  assert.equal(normalizeBars(shuffled).at(-1).date, INDEX_UPTREND.at(-1).date)
})

test('normalizeBars 丢弃非法 bar、同日去重保留最后一条', () => {
  const bars = [...UP_BARS, { ...UP_BARS.at(-1), date: 'bad-date', close: Number.NaN }]
  bars.push({ ...UP_BARS[10], close: 999 }) // 同日重复，保留这一条
  const normalized = normalizeBars(bars)
  assert.equal(normalized.length, UP_BARS.length)
  const duplicateDate = UP_BARS[10].date
  assert.equal(normalized.find((bar) => bar.date === duplicateDate).close, 999)
  assert.equal(normalizeBars(undefined).length, 0)
})

/* ─────────────────────────────────────────────────────────────
 * 5) loadRegime：数据源回退 + localStorage 缓存
 * ───────────────────────────────────────────────────────────── */

const FIXED_NOW = new Date('2026-11-24T10:00:00Z') // 北京 2026-11-24 18:00

function tencentIndexPayload(bars) {
  return {
    code: 0,
    data: {
      sh000300: {
        day: bars.map((bar) => [bar.date, String(bar.open), String(bar.close), String(bar.high), String(bar.low), '1000']),
      },
    },
  }
}

function sinaIndexPayload(bars) {
  return bars.map((bar) => ({
    day: bar.date,
    open: String(bar.open),
    high: String(bar.high),
    low: String(bar.low),
    close: String(bar.close),
    volume: '100000',
  }))
}

function mockFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    return handler(String(url), init)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

function mockStorage() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  }
  return {
    store,
    restore() {
      delete globalThis.localStorage
    },
  }
}

test('loadRegime：腾讯失败 → 新浪成功，source=index；当天缓存不重复拉，force 可强制刷新', async () => {
  const storage = mockStorage()
  const mock = mockFetch((url) => {
    if (url.includes('web.ifzq.gtimg.cn')) return { ok: false, status: 501 }
    if (url.includes('quotes.sina.cn')) return { ok: true, json: async () => sinaIndexPayload(INDEX_UPTREND) }
    throw new Error(`unexpected url ${url}`)
  })
  try {
    const watchlist = [UP_BARS, UP_BARS, DOWN_BARS]
    const detail = await loadRegimeDetail(watchlist, { fetcher: globalThis.fetch, now: FIXED_NOW })
    assert.equal(detail.error, null)
    assert.equal(detail.fromCache, false)
    assert.equal(detail.info.source, 'index')
    assert.equal(detail.info.regime, 'bull')
    assert.equal(detail.info.asOf, INDEX_UPTREND.at(-1).date)
    assert.equal(mock.calls.length, 2) // 腾讯 1 次（501）+ 新浪 1 次
    assert.ok(mock.calls[0].includes('ifzq'))
    assert.ok(mock.calls[1].includes('quotes.sina.cn'))

    // 缓存已写入，可被读取
    const cached = readRegimeCache(FIXED_NOW)
    assert.equal(cached?.info.asOf, INDEX_UPTREND.at(-1).date)
    assert.equal(cached?.fetchedOn, beijingToday(FIXED_NOW))

    // 当天第二次：直接命中缓存，不再发请求
    const again = await loadRegimeDetail(watchlist, { fetcher: globalThis.fetch, now: FIXED_NOW })
    assert.equal(again.fromCache, true)
    assert.equal(mock.calls.length, 2)

    // force 强制刷新
    await loadRegimeDetail(watchlist, { fetcher: globalThis.fetch, now: FIXED_NOW, force: true })
    assert.equal(mock.calls.length, 4)

    // 契约入口只返回 info
    const info = await loadRegime(watchlist, { fetcher: globalThis.fetch, now: FIXED_NOW })
    assert.equal(info.source, 'index')
  } finally {
    mock.restore()
    storage.restore()
  }
})

test('loadRegime：两条源都失败 → 退回宽度（source=breadth）并带 error，不抛错', async () => {
  const storage = mockStorage()
  const mock = mockFetch(() => ({ ok: false, status: 503 }))
  try {
    const watchlist = [DOWN_BARS, DOWN_BARS, UP_BARS]
    const detail = await loadRegimeDetail(watchlist, { fetcher: globalThis.fetch, now: FIXED_NOW })
    assert.equal(detail.info.source, 'breadth')
    assert.equal(detail.info.regime, 'bear') // 宽度 33.3% ≤ 40%
    assert.ok(detail.info.breadthPct !== undefined)
    assert.match(detail.error, /沪深300 日线获取失败/)
    assert.equal(mock.calls.length, 2) // 腾讯 + 新浪各一次

    const info = await loadRegime(watchlist, { fetcher: globalThis.fetch, now: FIXED_NOW })
    assert.equal(info.source, 'breadth')
    assert.equal(mock.calls.length, 4) // loadRegime 再试一轮腾讯+新浪

    // breadth 缓存不短路：下次加载会重试数据源（手动 refresh 也走这条）
    const again = await loadRegimeDetail(watchlist, { fetcher: globalThis.fetch, now: FIXED_NOW })
    assert.equal(again.fromCache, false)
    assert.equal(mock.calls.length, 6)
  } finally {
    mock.restore()
    storage.restore()
  }
})

test('缓存版本不符/非法内容 → 忽略缓存并重新拉取', async () => {
  const storage = mockStorage()
  storage.store.set('katestock-market-regime-v1', JSON.stringify({ version: 999, fetchedOn: '2026-11-24', info: {} }))
  assert.equal(readRegimeCache(FIXED_NOW), null)
  storage.store.set('katestock-market-regime-v1', '{not json')
  assert.equal(readRegimeCache(FIXED_NOW), null)

  const mock = mockFetch((url) =>
    url.includes('quotes.sina.cn')
      ? { ok: true, json: async () => sinaIndexPayload(INDEX_UPTREND) }
      : { ok: false, status: 501 },
  )
  try {
    const detail = await loadRegimeDetail([UP_BARS], { fetcher: globalThis.fetch, now: FIXED_NOW })
    assert.equal(detail.info.source, 'index')
    assert.equal(mock.calls.length, 2)
  } finally {
    mock.restore()
    storage.restore()
  }
})

test('clearRegimeCache 清除缓存', () => {
  const storage = mockStorage()
  try {
    assert.equal(readRegimeCache(FIXED_NOW), null)
    // 先写入合法缓存再清除
    const info = computeRegime({ indexBars: INDEX_UPTREND, watchlist: [UP_BARS] })
    storage.store.set(
      'katestock-market-regime-v1',
      JSON.stringify({ version: 1, fetchedOn: beijingToday(FIXED_NOW), info }),
    )
    assert.notEqual(readRegimeCache(FIXED_NOW), null)
    clearRegimeCache()
    assert.equal(readRegimeCache(FIXED_NOW), null)
  } finally {
    storage.restore()
  }
})

test('beijingToday 用 Asia/Shanghai 日期', () => {
  assert.equal(beijingToday(new Date('2026-11-24T15:59:00Z')), '2026-11-24') // 北京 23:59
  assert.equal(beijingToday(new Date('2026-11-24T16:00:00Z')), '2026-11-25') // 北京次日 00:00
})

/* ─────────────────────────────────────────────────────────────
 * 6) 真实数据形态回归（不访问网络；数据取自 2026-11-24 实测沪深300）
 * ───────────────────────────────────────────────────────────── */

test('实测沪深300 指标形态：close 低于 MA20/60/120、回撤 >20% → bear', () => {
  // 2026-11-24 实测：close 3963.82 / MA20 4022.94 / MA60 4273.87 / MA120 4516.29 / 回撤 -21.66%
  const closes = Array.from({ length: 160 }, (_, i) => 5000 - i * 6.5)
  const bars = makeBars(closes)
  const info = computeRegime({ indexBars: bars, watchlist: [DOWN_BARS] })
  assert.equal(info.source, 'index')
  assert.equal(info.regime, 'bear')
  assert.ok(info.confidence >= 50)
})
