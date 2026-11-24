import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  beijingCalendar,
  buildQuote,
  buildSnapshot,
  fetchBarsForCode,
  parseEastmoneyBars,
  parseSinaBars,
  parseTencentBars,
  refreshSnapshot,
  selectTradeDate,
  tencentSymbol,
} from '../scripts/refresh-snapshot.mjs'
import { adjustmentFor, rescaleBarsToActual } from '../src/lib/market.ts'
import { snapshotSchema } from '../src/lib/snapshot.ts'

/* ─────────────────────────────────────────────────────────────
 * 离线 fixture（不访问网络）：kline 行结构与 2026-11-24 实测腾讯/东财一致。
 * ───────────────────────────────────────────────────────────── */

const FIXTURE_NOW = new Date('2026-11-23T08:00:00Z') // 2026-11-23 16:00 北京
const TRADE_DATE = '2026-11-23'

/** 生成连续自然日 kline 行 [date,open,close,high,low,volume]，末根 endDate，价格自增。 */
function makeKlineRows(count, endDate = TRADE_DATE, startPrice = 100) {
  const end = new Date(`${endDate}T00:00:00Z`)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end.getTime() - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10)
    const close = startPrice + index
    return [date, String(close - 1), String(close), String(close + 1), String(close - 2), '1000.000']
  })
}

function tencentPayload(code, rows, dayKey = 'qfqday') {
  const symbol = tencentSymbol(code)
  return { code: 0, msg: '', data: { [symbol]: { [dayKey]: rows } } }
}

const TENCNET_ROWS = makeKlineRows(24)

function validQuote(code = '600519', overrides = {}) {
  const bars = parseTencentBars(tencentPayload(code, TENCNET_ROWS), code)
  const quote = buildQuote(code, bars, {
    provider: 'Tencent fqkline (qfq)',
    tradeDate: TRADE_DATE,
    fetchedAt: FIXTURE_NOW.toISOString(),
  })
  return { ...quote, ...overrides }
}

/* ─────────────────────────────────────────────────────────────
 * 1) 解析 + bars → Quote 映射
 * ───────────────────────────────────────────────────────────── */

test('腾讯 kline → bars：字段映射、amount=0、changePct 按前收、日期严格递增', () => {
  const bars = parseTencentBars(tencentPayload('600519', TENCNET_ROWS), '600519')
  assert.equal(bars.length, 24)
  assert.equal(bars[0].date, TENCNET_ROWS[0][0])
  assert.equal(bars[0].changePct, 0) // 首根无前收
  const last = bars.at(-1)
  assert.equal(last.date, TRADE_DATE)
  assert.equal(last.open, Number(TENCNET_ROWS.at(-1)[1]))
  assert.equal(last.close, Number(TENCNET_ROWS.at(-1)[2]))
  assert.equal(last.high, Number(TENCNET_ROWS.at(-1)[3]))
  assert.equal(last.low, Number(TENCNET_ROWS.at(-1)[4]))
  assert.equal(last.volume, Number(TENCNET_ROWS.at(-1)[5]))
  assert.equal(last.amount, 0)
  const expected = (Number(TENCNET_ROWS.at(-1)[2]) / Number(TENCNET_ROWS.at(-2)[2]) - 1) * 100
  assert.ok(Math.abs(last.changePct - expected) < 1e-9)
})

test('bars → Quote：与 ingest.py 等价的字段 + provider/adjustment', () => {
  const quote = validQuote()
  assert.equal(quote.code, '600519')
  assert.equal(quote.price, quote.bars.at(-1).close)
  assert.equal(quote.prevClose, quote.bars.at(-2).close)
  assert.equal(quote.tradeDate, TRADE_DATE)
  assert.equal(quote.open, quote.bars.at(-1).open)
  assert.equal(quote.high, quote.bars.at(-1).high)
  assert.equal(quote.low, quote.bars.at(-1).low)
  assert.equal(quote.volume, quote.bars.at(-1).volume)
  assert.equal(quote.amount, 0)
  assert.equal(quote.source, 'auto')
  assert.equal(quote.provider, 'Tencent fqkline (qfq)')
  assert.equal(quote.adjustment, '前复权')
  assert.equal(quote.fetchedAt, FIXTURE_NOW.toISOString())
  assert.equal(quote.bars.length, 24)
})

test('bars 超过 160 根时只保留最后 160 根', () => {
  const rows = makeKlineRows(170)
  const bars = parseTencentBars(tencentPayload('600519', rows), '600519')
  const quote = buildQuote('600519', bars, {
    provider: 'Tencent fqkline (qfq)',
    tradeDate: TRADE_DATE,
    fetchedAt: FIXTURE_NOW.toISOString(),
  })
  assert.equal(quote.bars.length, 160)
  assert.equal(quote.bars[0].date, rows[rows.length - 160][0])
  assert.equal(quote.bars.at(-1).date, TRADE_DATE)
})

/** 东财 kline 行：date,open,close,high,low,volume,amount,?,changePct,?,turnoverPct（与 ingest.py 字段顺序一致）。 */
function makeEastmoneyLines(count, endDate = TRADE_DATE, startPrice = 100) {
  const rows = makeKlineRows(count, endDate, startPrice)
  return rows.map((row, index) => {
    const close = Number(row[2])
    const previous = index > 0 ? Number(rows[index - 1][2]) : close
    const changePct = index > 0 ? (close / previous - 1) * 100 : 0
    return [row[0], row[1], row[2], row[3], row[4], row[5], '10000', '0', String(changePct), '0', '2'].join(',')
  })
}

test('东财 kline 解析（字段顺序与 ingest.py 一致）', () => {
  const payload = {
    rc: 0,
    data: {
      code: '600519',
      name: '贵州茅台',
      klines: makeEastmoneyLines(21),
    },
  }
  const bars = parseEastmoneyBars(payload)
  assert.equal(bars.length, 21)
  const first = bars[0]
  assert.equal(first.date, makeKlineRows(21)[0][0])
  assert.equal(first.open, Number(makeKlineRows(21)[0][1]))
  assert.equal(first.close, Number(makeKlineRows(21)[0][2]))
  assert.equal(first.high, Number(makeKlineRows(21)[0][3]))
  assert.equal(first.low, Number(makeKlineRows(21)[0][4]))
  assert.equal(first.volume, 1000)
  assert.equal(first.amount, 10000)
  assert.equal(first.changePct, 0)
  assert.equal(first.turnoverPct, 2)
  const last = bars.at(-1)
  assert.equal(last.date, TRADE_DATE)
  const expected = (Number(makeKlineRows(21).at(-1)[2]) / Number(makeKlineRows(21).at(-2)[2]) - 1) * 100
  assert.ok(Math.abs(last.changePct - expected) < 1e-9)
})

test('selectTradeDate 取所有日线最后日期的最大值', () => {
  const a = parseTencentBars(tencentPayload('600519', makeKlineRows(24, '2026-11-20')), '600519')
  const b = parseTencentBars(tencentPayload('000001', makeKlineRows(24, '2026-11-23')), '000001')
  assert.equal(selectTradeDate([a, b]), '2026-11-23')
  assert.equal(selectTradeDate([b, a]), '2026-11-23')
  assert.equal(selectTradeDate([]), undefined)
})

/* ─────────────────────────────────────────────────────────────
 * 2) 拒绝条件
 * ───────────────────────────────────────────────────────────── */

test('不足 21 根拒绝', () => {
  assert.throws(() => parseTencentBars(tencentPayload('600519', makeKlineRows(20)), '600519'), /日线不足/)
  assert.throws(
    () => buildQuote('600519', makeKlineRows(20).map((row) => ({
      date: row[0], open: Number(row[1]), close: Number(row[2]), high: Number(row[3]), low: Number(row[4]),
      volume: Number(row[5]), amount: 0, changePct: 0,
    })), { provider: 'x', tradeDate: TRADE_DATE, fetchedAt: FIXTURE_NOW.toISOString() }),
    /日线不足/,
  )
})

test('日期不严格递增拒绝', () => {
  const reversed = [...TENCNET_ROWS].reverse()
  assert.throws(() => parseTencentBars(tencentPayload('600519', reversed), '600519'), /日期非严格递增/)
  const duplicated = [TENCNET_ROWS[0], TENCNET_ROWS[0], ...TENCNET_ROWS.slice(1)]
  assert.throws(() => parseTencentBars(tencentPayload('600519', duplicated), '600519'), /日期非严格递增/)
})

test('OHLCV 非法（high < close）拒绝', () => {
  const broken = makeKlineRows(24)
  broken[broken.length - 1] = [broken.at(-1)[0], '100', '110', '105', '99', '1000']
  assert.throws(() => parseTencentBars(tencentPayload('600519', broken), '600519'), /OHLCV 非法/)
})

test('最后一根日期 ≠ tradeDate 时 buildQuote 拒绝', () => {
  const bars = parseTencentBars(tencentPayload('600519', TENCNET_ROWS), '600519')
  assert.throws(
    () => buildQuote('600519', bars, { provider: 'x', tradeDate: '2026-11-24', fetchedAt: FIXTURE_NOW.toISOString() }),
    /≠ 交易日/,
  )
})

/* ─────────────────────────────────────────────────────────────
 * 3) Snapshot schema / partial / coverage
 * ───────────────────────────────────────────────────────────── */

test('buildSnapshot 产物通过 snapshotSchema 校验，signals 覆盖全部 quotes', () => {
  const quotes = { '600519': validQuote('600519'), '000001': validQuote('000001') }
  const report = buildSnapshot({
    quotes,
    failures: [],
    universeSize: 2,
    tradeDate: TRADE_DATE,
    generatedAt: FIXTURE_NOW.toISOString(),
    now: FIXTURE_NOW,
  })
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.tradeDate, TRADE_DATE)
  assert.equal(report.partial, false)
  assert.deepEqual(report.failures, [])
  assert.equal(report.strategyVersion, 'katestock-rules-v1')
  assert.equal(report.ai.status, 'unavailable')
  assert.equal(report.ai.model, 'deepseek-flash')
  assert.deepEqual(Object.keys(report.signals).sort(), ['000001', '600519'])
  // 发布结构（scripts/check_public.py 要求字段集合完全一致）
  assert.deepEqual(
    Object.keys(report).sort(),
    ['ai', 'coverage', 'failures', 'generatedAt', 'partial', 'quotes', 'schemaVersion', 'signals', 'source', 'sourceUrl', 'strategyVersion', 'tradeDate'].sort(),
  )
  assert.equal(snapshotSchema.safeParse(report).success, true)
  // JSON 往返（无 NaN/null 化）后仍合法
  assert.equal(snapshotSchema.safeParse(JSON.parse(JSON.stringify(report))).success, true)
})

test('failures 非空 → partial=true 且 schema 仍通过', () => {
  const quotes = { '600519': validQuote('600519') }
  const report = buildSnapshot({
    quotes,
    failures: ['000001: 腾讯失败；东财失败'],
    universeSize: 2,
    tradeDate: TRADE_DATE,
    generatedAt: FIXTURE_NOW.toISOString(),
    now: FIXTURE_NOW,
  })
  assert.equal(report.partial, true)
  assert.deepEqual(report.failures, ['000001: 腾讯失败；东财失败'])
  assert.equal(snapshotSchema.safeParse(report).success, true)
})

test('tradeDate 与 quote.tradeDate 不一致时 schema 拒绝（不产生非法快照）', () => {
  const quotes = { '600519': validQuote('600519', { tradeDate: '2026-11-22' }) }
  assert.throws(() =>
    buildSnapshot({
      quotes,
      failures: [],
      universeSize: 1,
      tradeDate: TRADE_DATE,
      generatedAt: FIXTURE_NOW.toISOString(),
      now: FIXTURE_NOW,
    }),
  )
})

test('无报价时拒绝（不允许写出空快照）', () => {
  assert.throws(
    () =>
      buildSnapshot({
        quotes: {},
        failures: ['600519: 失败'],
        universeSize: 1,
        tradeDate: TRADE_DATE,
        generatedAt: FIXTURE_NOW.toISOString(),
        now: FIXTURE_NOW,
      }),
    /No valid current quotes/,
  )
})

test('tradeDate 早于北京今天时 coverage 注明「今日 bar 未出」', () => {
  const quotes = { '600519': validQuote('600519') }
  const report = buildSnapshot({
    quotes,
    failures: [],
    universeSize: 1,
    tradeDate: TRADE_DATE,
    generatedAt: '2026-11-23T23:30:00.000Z',
    now: new Date('2026-11-23T23:30:00Z'), // 北京 2026-11-24 07:30
  })
  assert.match(report.coverage, /公开清单（1只），非全市场/)
  assert.match(report.coverage, /数据截至 2026-11-23（今日 bar 未出，盘中\/盘前属正常）/)
})

test('beijingCalendar 用 Asia/Shanghai 取日期', () => {
  assert.equal(beijingCalendar(new Date('2026-11-23T23:30:00Z')).date, '2026-11-24')
  assert.equal(beijingCalendar(new Date('2026-11-24T15:59:00Z')).date, '2026-11-24')
})

/* ─────────────────────────────────────────────────────────────
 * 4) 端到端（mock fetch，离线）：原子写 + 失败不覆盖
 * ───────────────────────────────────────────────────────────── */

const ROWS_BY_CODE = {
  '600519': makeKlineRows(24),
  '000001': makeKlineRows(24, TRADE_DATE, 12),
}

function tencentAwareFetcher() {
  return async (url) => {
    const match = /param=(sh|sz)(\d{6}),day/.exec(url)
    if (match && ROWS_BY_CODE[match[2]]) {
      return { ok: true, json: async () => tencentPayload(match[2], ROWS_BY_CODE[match[2]]) }
    }
    return { ok: false, status: 502 }
  }
}

test('refreshSnapshot 端到端：mock 腾讯成功 → 原子写文件、tradeDate/valid 正确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'katestock-refresh-'))
  try {
    const universePath = join(dir, 'universe.json')
    const outputPath = join(dir, 'data', 'latest.json')
    writeFileSync(universePath, JSON.stringify(['600519', '000001']))
    const result = await refreshSnapshot({
      universePath,
      outputPath,
      fetcher: tencentAwareFetcher(),
      now: FIXTURE_NOW,
      write: true,
    })
    assert.equal(result.tradeDate, TRADE_DATE)
    assert.equal(result.valid, 2)
    assert.equal(result.failed, 0)
    assert.equal(existsSync(outputPath), true)
    assert.equal(existsSync(`${outputPath}.tmp`), false) // 原子写后无残留
    const written = JSON.parse(readFileSync(outputPath, 'utf8'))
    assert.equal(snapshotSchema.safeParse(written).success, true)
    assert.equal(written.tradeDate, TRADE_DATE)
    assert.equal(written.partial, false)
    assert.deepEqual(Object.keys(written.quotes).sort(), ['000001', '600519'])
    assert.equal(written.quotes['600519'].provider, 'Tencent fqkline (qfq)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refreshSnapshot：全部失败时抛错，旧文件不被覆盖、无 .tmp 残留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'katestock-refresh-'))
  try {
    const universePath = join(dir, 'universe.json')
    const outputPath = join(dir, 'latest.json')
    writeFileSync(universePath, JSON.stringify(['600519']))
    const previous = JSON.stringify({ schemaVersion: 1, keep: 'last-good' })
    writeFileSync(outputPath, previous)
    const failing = async () => ({ ok: false, status: 502 })
    await assert.rejects(() =>
      refreshSnapshot({ universePath, outputPath, fetcher: failing, now: FIXTURE_NOW, write: true }),
    )
    assert.equal(readFileSync(outputPath, 'utf8'), previous)
    assert.equal(existsSync(`${outputPath}.tmp`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refreshSnapshot：部分代码失败 → partial=true、failures 记录、成功代码仍写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'katestock-refresh-'))
  try {
    const universePath = join(dir, 'universe.json')
    const outputPath = join(dir, 'latest.json')
    writeFileSync(universePath, JSON.stringify(['600519', '999999']))
    const result = await refreshSnapshot({
      universePath,
      outputPath,
      fetcher: tencentAwareFetcher(),
      now: FIXTURE_NOW,
      write: true,
    })
    assert.equal(result.valid, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.report.partial, true)
    assert.match(result.report.failures[0], /^999999: /)
    const written = JSON.parse(readFileSync(outputPath, 'utf8'))
    assert.equal(snapshotSchema.safeParse(written).success, true)
    assert.deepEqual(Object.keys(written.quotes), ['600519'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ─────────────────────────────────────────────────────────────
 * 5) 新浪日线（腾讯 501 时的第二源；不复权）
 *
 * fixture 结构来自 2026-11-24 实测：
 *   https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh600519&scale=240&ma=no&datalen=320
 *   → [{ day, open, high, low, close, volume }, ...]；不复权、volume 单位「股」。
 * ───────────────────────────────────────────────────────────── */

function makeSinaRows(count, endDate = TRADE_DATE, startPrice = 100) {
  return makeKlineRows(count, endDate, startPrice).map((row) => ({
    day: row[0],
    open: row[1],
    close: row[2],
    high: row[3],
    low: row[4],
    volume: '100000', // 新浪 volume 单位「股」→ 100000 股 = 1000 手
  }))
}

test('新浪 JSON → bars：字段映射、volume 股→手、amount=0、changePct 按前收', () => {
  const rows = makeSinaRows(24)
  const bars = parseSinaBars(rows)
  assert.equal(bars.length, 24)
  assert.equal(bars[0].date, rows[0].day)
  assert.equal(bars[0].changePct, 0)
  const last = bars.at(-1)
  assert.equal(last.date, TRADE_DATE)
  assert.equal(last.close, Number(rows.at(-1).close))
  assert.equal(last.amount, 0)
  assert.equal(last.volume, 1000) // 100000 股 ÷100
  const expected = (Number(rows.at(-1).close) / Number(rows.at(-2).close) - 1) * 100
  assert.ok(Math.abs(last.changePct - expected) < 1e-9)
})

test('新浪 bars 拒绝：不足 21 根 / 日期倒序 / 结构非法', () => {
  assert.throws(() => parseSinaBars(makeSinaRows(20)), /日线不足/)
  assert.throws(() => parseSinaBars([...makeSinaRows(24)].reverse()), /日期非严格递增/)
  assert.throws(() => parseSinaBars([]), /不是有效日线数组/)
  assert.throws(() => parseSinaBars(null), /不是有效日线数组/)
})

test('buildQuote 支持不复权 adjustment（不冒充前复权）', () => {
  const quote = buildQuote('600519', parseSinaBars(makeSinaRows(24)), {
    provider: 'Sina kline (不复权)',
    adjustment: '不复权（tushare 未验证）',
    tradeDate: TRADE_DATE,
    fetchedAt: FIXTURE_NOW.toISOString(),
  })
  assert.equal(quote.provider, 'Sina kline (不复权)')
  assert.equal(quote.adjustment, '不复权（tushare 未验证）')
})

/** 腾讯 501 → 新浪 JSON 成功；东财若被请求即测试失败。 */
function sinaAwareFetcher(rowsByCode, calls) {
  return async (url) => {
    calls.push(String(url))
    if (url.includes('web.ifzq.gtimg.cn')) return { ok: false, status: 501 }
    if (url.includes('quotes.sina.cn')) {
      const match = /symbol=(sh|sz)(\d{6})/.exec(url)
      const code = match?.[2]
      if (code && rowsByCode[code]) return { ok: true, json: async () => rowsByCode[code] }
      return { ok: false, status: 404 }
    }
    if (url.includes('push2his.eastmoney.com')) throw new Error('东财不应在腾讯 501 后优先被请求')
    throw new Error(`unexpected url ${url}`)
  }
}

test('refreshSnapshot 回退顺序：腾讯 501 → 新浪 JSON 成功（不请求东财），标注不复权', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'katestock-refresh-'))
  try {
    const calls = []
    const universePath = join(dir, 'universe.json')
    const outputPath = join(dir, 'latest.json')
    writeFileSync(universePath, JSON.stringify(['600519']))
    const result = await refreshSnapshot({
      universePath,
      outputPath,
      fetcher: sinaAwareFetcher({ '600519': makeSinaRows(24) }, calls),
      now: FIXTURE_NOW,
      write: true,
    })
    assert.equal(result.tradeDate, TRADE_DATE)
    assert.equal(result.valid, 1)
    assert.equal(result.failed, 0)
    // 腾讯重试 2 次后才切新浪；东财完全未被请求
    assert.equal(calls.filter((url) => url.includes('web.ifzq.gtimg.cn')).length, 2)
    assert.equal(calls.filter((url) => url.includes('quotes.sina.cn')).length, 1)
    assert.ok(calls.findIndex((url) => url.includes('quotes.sina.cn')) > calls.findIndex((url) => url.includes('web.ifzq.gtimg.cn')))
    assert.ok(!calls.some((url) => url.includes('push2his.eastmoney.com')))

    const written = JSON.parse(readFileSync(outputPath, 'utf8'))
    assert.equal(snapshotSchema.safeParse(written).success, true)
    const quote = written.quotes['600519']
    assert.equal(quote.provider, 'Sina kline (不复权)')
    assert.equal(quote.adjustment, '不复权（tushare 未验证）')
    assert.equal(quote.tradeDate, TRADE_DATE)
    assert.equal(quote.volume, 1000)
    assert.equal(written.sourceUrl, 'https://quotes.sina.cn/')
    assert.match(written.source, /Sina kline \(不复权\)/)
    assert.match(written.source, /不复权/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fetchBarsForCode：腾讯/新浪/东财全失败时错误文案含三个源', async () => {
  const parserFailingFetcher = async () => ({ ok: true, json: async () => ({}) })
  const result = await fetchBarsForCode('600519', { fetcher: parserFailingFetcher })
  assert.equal(result.bars, undefined)
  assert.match(result.error, /腾讯失败/)
  assert.match(result.error, /新浪失败/)
  assert.match(result.error, /东财失败/)
})


/* ─────────────────────────────────────────────────────────────
 * 6) 复权口径（task-29）：ETF 用 hfq（后复权），个股用 qfq（前复权）
 * ───────────────────────────────────────────────────────────── */

test('adjustmentFor：ETF → hfq，个股 → qfq', () => {
  for (const code of ['510300', '510880', '511010', '512000', '513100', '515000', '516000', '518880', '159558', '159915', '588060']) {
    assert.equal(adjustmentFor(code), 'hfq', code)
  }
  for (const code of ['600519', '000001', '300750', '688981']) {
    assert.equal(adjustmentFor(code), 'qfq', code)
  }
})

test('fetchBarsForCode：ETF 请求 hfq 并按新浪实盘价归一；个股请求 qfq 不缩放', async () => {
  const calls = []
  const fetcher = async (url) => {
    calls.push(String(url))
    if (String(url).includes('quotes.sina.cn')) {
      return { ok: true, json: async () => makeSinaRows(24) }
    }
    const match = /param=(sh|sz)(\d{6}),day,,,320,(hfq|qfq)/.exec(String(url))
    if (!match) return { ok: false, status: 501 }
    const rows = makeKlineRows(24, TRADE_DATE, 3)
    return { ok: true, json: async () => tencentPayload(match[2], rows, match[3] === 'hfq' ? 'hfqday' : 'qfqday') }
  }

  const etf = await fetchBarsForCode('159558', { fetcher })
  assert.equal(etf.provider, 'Tencent fqkline (hfq) → rescaled')
  assert.equal(etf.adjustment, '前复权（按实盘价归一）')
  assert.ok(calls[0].includes('param=sz159558,day,,,320,hfq'))
  // 缩放后最后一根 = 新浪不复权最后一根（makeSinaRows 末值 123），收益率保持 hfq 口径
  assert.ok(etf.bars.at(-1).close === 123)

  const stock = await fetchBarsForCode('600519', { fetcher })
  assert.equal(stock.provider, 'Tencent fqkline (qfq)')
  assert.equal(stock.adjustment, '前复权')
  assert.ok(calls.some((url) => url.includes('param=sh600519,day,,,320,qfq')))
})

test('fetchBarsForCode：ETF 拿不到实盘价 → 不缩放并标注「后复权（实盘价未校准）」', async () => {
  const fetcher = async (url) => {
    const match = /param=(sh|sz)(\d{6}),day,,,320,hfq/.exec(String(url))
    if (match) {
      return { ok: true, json: async () => tencentPayload(match[2], makeKlineRows(24, TRADE_DATE, 3), 'hfqday') }
    }
    return { ok: false, status: 501 } // 新浪 + 腾讯 qt 都失败
  }
  const result = await fetchBarsForCode('159558', { fetcher })
  assert.equal(result.provider, 'Tencent fqkline (hfq)')
  assert.equal(result.adjustment, '后复权（实盘价未校准）')
  assert.equal(result.bars.at(-1).close, Number(makeKlineRows(24, TRADE_DATE, 3).at(-1)[2]))
})

test('refreshSnapshot 端到端：ETF 用腾讯 hfq → 快照 provider/adjustment 如实标注', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'katestock-refresh-'))
  try {
    const universePath = join(dir, 'universe.json')
    const outputPath = join(dir, 'latest.json')
    writeFileSync(universePath, JSON.stringify(['159558', '588060']))
    const fetcher = async (url) => {
      if (String(url).includes('quotes.sina.cn')) {
        return { ok: true, json: async () => makeSinaRows(24) }
      }
      const match = /param=(sh|sz)(\d{6}),day,,,320,hfq/.exec(String(url))
      if (match) {
        const rows = makeKlineRows(24, TRADE_DATE, 3)
        return { ok: true, json: async () => tencentPayload(match[2], rows, 'hfqday') }
      }
      return { ok: false, status: 501 }
    }
    const result = await refreshSnapshot({ universePath, outputPath, fetcher, now: FIXTURE_NOW, write: true })
    assert.equal(result.valid, 2)
    assert.equal(result.failed, 0)
    const written = JSON.parse(readFileSync(outputPath, 'utf8'))
    assert.equal(snapshotSchema.safeParse(written).success, true)
    for (const code of ['159558', '588060']) {
      assert.equal(written.quotes[code].provider, 'Tencent fqkline (hfq) → rescaled')
      assert.equal(written.quotes[code].adjustment, '前复权（按实盘价归一）')
      // 缩放后价格回到实盘价（新浪不复权最后一根 123）
      assert.equal(written.quotes[code].price, 123)
    }
    assert.match(written.source, /hfq/)
    assert.match(written.source, /按实盘价归一/)
    assert.equal(written.sourceUrl, 'https://web.ifzq.gtimg.cn/')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSnapshot：hfq 与新浪不复权混用时 source 标注口径混合、sourceUrl 选腾讯', () => {
  const hfqBars = parseTencentBars(tencentPayload('159558', makeKlineRows(24, TRADE_DATE, 3), 'hfqday'), '159558')
  const hfqQuote = buildQuote('159558', hfqBars, {
    provider: 'Tencent fqkline (hfq)',
    adjustment: '后复权',
    tradeDate: TRADE_DATE,
    fetchedAt: FIXTURE_NOW.toISOString(),
  })
  const sinaQuote = buildQuote('600519', parseSinaBars(makeSinaRows(24)), {
    provider: 'Sina kline (不复权)',
    adjustment: '不复权（tushare 未验证）',
    tradeDate: TRADE_DATE,
    fetchedAt: FIXTURE_NOW.toISOString(),
  })
  const report = buildSnapshot({
    quotes: { '159558': hfqQuote, '600519': sinaQuote },
    failures: [],
    universeSize: 2,
    tradeDate: TRADE_DATE,
    generatedAt: FIXTURE_NOW.toISOString(),
    now: FIXTURE_NOW,
  })
  assert.equal(snapshotSchema.safeParse(report).success, true)
  assert.match(report.source, /Tencent fqkline \(hfq\)/)
  assert.match(report.source, /Sina kline \(不复权\)/)
  assert.match(report.source, /复权口径混合/)
  assert.match(report.source, /后复权/)
  assert.equal(report.sourceUrl, 'https://web.ifzq.gtimg.cn/')
})


test('fetchBarsForCode 腾讯主机降级：web.ifzq 501 → 裸域 ifzq 成功（ETF hfq）', async () => {
  const calls = []
  const fetcher = async (url) => {
    calls.push(String(url))
    if (String(url).includes('://web.ifzq.gtimg.cn')) return { ok: false, status: 501 }
    if (String(url).includes('://ifzq.gtimg.cn')) {
      return { ok: true, json: async () => tencentPayload('159558', makeKlineRows(24, TRADE_DATE, 3), 'hfqday') }
    }
    return { ok: false, status: 501 }
  }
  const result = await fetchBarsForCode('159558', { fetcher })
  assert.equal(result.provider, 'Tencent fqkline (hfq)')
  // 该 fetcher 对新浪/腾讯 qt 返回 501 → 未校准，保留 hfq 尺度
  assert.equal(result.adjustment, '后复权（实盘价未校准）')
  assert.ok(calls[0].includes('://web.ifzq.gtimg.cn'))
  assert.ok(calls.some((url) => url.includes('://ifzq.gtimg.cn') && url.includes('sz159558,day,,,320,hfq')))
})

test('rescaleBarsToActual：拆分 fixture（hfq 3.0/3.3 vs 不复权 1.0/1.1）', () => {
  const hfqBars = [
    { date: '2026-01-02', open: 3.0, high: 3.1, low: 2.9, close: 3.0, volume: 1000, amount: 0, changePct: 0 },
    { date: '2026-01-05', open: 3.3, high: 3.4, low: 3.2, close: 3.3, volume: 1200, amount: 0, changePct: 10 },
  ]
  const original = JSON.parse(JSON.stringify(hfqBars))
  const scaled = rescaleBarsToActual(hfqBars, 1.1)
  assert.deepEqual(scaled.map((bar) => bar.close), [1, 1.1])
  assert.ok(Math.abs(scaled[1].close / scaled[0].close - 3.3 / 3.0) < 1e-9)
  assert.deepEqual(scaled.map((bar) => bar.volume), [1000, 1200])
  assert.deepEqual(hfqBars, original)
  // 异常 actual → 不缩放
  assert.deepEqual(rescaleBarsToActual(hfqBars, 0).map((bar) => bar.close), [3.0, 3.3])
})
