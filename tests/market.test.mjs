import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchQuote, parseTencentKline, tencentKlineSymbol } from '../src/lib/market.ts'

/* ─────────────────────────────────────────────────────────────
 * 离线 fixture：2026-11-24 实测腾讯日线接口
 *   https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,320,qfq
 * 取真实响应的最后 24 根 [[date,open,close,high,low,volume], ...]（前复权），
 * 最后一根为 2026-11-23 收盘；qt[symbol][30] 为北京时间实时快照时间。
 * 全程不访问网络。
 * ───────────────────────────────────────────────────────────── */
const KLINE_ROWS = [
  ['2026-10-21', '1331.880', '1309.690', '1331.980', '1302.360', '33514.000'],
  ['2026-10-22', '1303.210', '1318.490', '1322.000', '1296.000', '42491.000'],
  ['2026-10-23', '1311.840', '1335.000', '1343.880', '1310.000', '57686.000'],
  ['2026-10-26', '1325.400', '1349.980', '1350.000', '1324.790', '41599.000'],
  ['2026-10-27', '1343.880', '1355.900', '1357.000', '1338.010', '38669.000'],
  ['2026-10-28', '1354.980', '1330.750', '1354.980', '1322.600', '38805.000'],
  ['2026-10-29', '1349.990', '1354.000', '1356.000', '1330.010', '42992.000'],
  ['2026-10-30', '1363.000', '1392.050', '1393.370', '1352.980', '59927.000'],
  ['2026-11-02', '1410.000', '1439.100', '1447.000', '1395.020', '82691.000'],
  ['2026-11-03', '1450.000', '1480.000', '1480.000', '1435.100', '74121.000'],
  ['2026-11-04', '1470.000', '1446.440', '1480.600', '1439.000', '65434.000'],
  ['2026-11-05', '1446.700', '1452.000', '1466.000', '1430.000', '46712.000'],
  ['2026-11-06', '1450.000', '1453.000', '1457.720', '1436.000', '42848.000'],
  ['2026-11-09', '1440.060', '1444.990', '1449.990', '1435.080', '24801.000'],
  ['2026-11-10', '1438.230', '1439.000', '1444.500', '1431.260', '23038.000'],
  ['2026-11-11', '1445.000', '1402.300', '1445.620', '1402.000', '39848.000'],
  ['2026-11-12', '1395.130', '1410.270', '1411.000', '1388.110', '32373.000'],
  ['2026-11-13', '1404.000', '1435.260', '1437.690', '1394.000', '41780.000'],
  ['2026-11-16', '1426.300', '1453.900', '1454.930', '1425.000', '39967.000'],
  ['2026-11-17', '1458.880', '1457.700', '1461.600', '1437.710', '35116.000'],
  ['2026-11-18', '1450.000', '1442.660', '1456.000', '1431.700', '29847.000'],
  ['2026-11-19', '1442.000', '1460.210', '1464.990', '1432.100', '42692.000'],
  ['2026-11-20', '1450.890', '1485.750', '1489.090', '1423.900', '67229.000'],
  ['2026-11-23', '1475.350', '1439.000', '1478.000', '1428.000', '56976.000'],
]

const REALTIME_20261123 = '20261123161441' // 2026-11-23 16:14:41 北京
const FIXTURE_NOW = new Date('2026-11-23T08:00:00Z') // 2026-11-23 16:00 北京

function makePayload(symbol, rows, realtime = REALTIME_20261123) {
  const snapshot = Array.from({ length: 31 }, () => '')
  if (realtime) snapshot[30] = realtime
  return {
    code: 0,
    msg: '',
    data: {
      [symbol]: {
        qfqday: rows,
        qt: { [symbol]: snapshot },
      },
    },
  }
}

/** 生成连续自然日行情，用于「>160 根截断」等边界（价格自增，日期严格递增）。 */
function makeRows(count, endDate = '2026-11-23', startPrice = 100) {
  const end = new Date(`${endDate}T00:00:00Z`)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end.getTime() - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10)
    const close = startPrice + index
    return [date, String(close - 1), String(close), String(close + 1), String(close - 2), '1000.000']
  })
}

/* ─────────────────────────────────────────────────────────────
 * 1) 解析 / 字段映射 / 缩放
 * ───────────────────────────────────────────────────────────── */

test('腾讯日线正常解析：字段映射、provider/adjustment、amount=0', () => {
  const quote = parseTencentKline(makePayload('sh600519', KLINE_ROWS), '600519', FIXTURE_NOW)
  assert.equal(quote.code, '600519')
  assert.equal(quote.source, 'auto')
  assert.equal(quote.provider, 'Tencent kline (qfq)')
  assert.equal(quote.adjustment, '前复权')
  assert.equal(quote.fetchedAt, FIXTURE_NOW.toISOString())
  assert.equal(quote.bars.length, KLINE_ROWS.length)
  assert.equal(quote.tradeDate, '2026-11-23')

  const latest = quote.bars.at(-1)
  assert.deepEqual(latest, {
    date: '2026-11-23',
    open: 1475.35,
    close: 1439.0,
    high: 1478.0,
    low: 1428.0,
    volume: 56976,
    amount: 0,
    changePct: latest.changePct,
  })
  assert.equal(quote.price, 1439.0)
  assert.equal(quote.prevClose, 1485.75)
  assert.equal(quote.open, 1475.35)
  assert.equal(quote.high, 1478.0)
  assert.equal(quote.low, 1428.0)
  assert.equal(quote.volume, 56976)
  assert.equal(quote.amount, 0)
  assert.ok(quote.bars.every((bar) => bar.amount === 0))

  // 第一根没有前收 → changePct = 0
  assert.equal(quote.bars[0].changePct, 0)
})

test('changePct 用前一根 close 计算，最新一根 = (1439/1485.75 - 1) * 100', () => {
  const quote = parseTencentKline(makePayload('sh600519', KLINE_ROWS), '600519', FIXTURE_NOW)
  const expected = (1439.0 / 1485.75 - 1) * 100
  assert.ok(Math.abs(quote.changePct - expected) < 1e-9)
  assert.ok(Math.abs(quote.bars.at(-1).changePct - expected) < 1e-9)
  // 中间某一根也按前收计算
  const rowIndex = KLINE_ROWS.length - 1 // 2026-11-23
  const prevClose = Number(KLINE_ROWS[rowIndex - 1][2])
  const close = Number(KLINE_ROWS[rowIndex][2])
  assert.ok(Math.abs(quote.bars.at(-1).changePct - (close / prevClose - 1) * 100) < 1e-9)
  assert.equal(quote.bars.at(-2).date, '2026-11-20')
})

test('取最后 160 根（>160 时截断，保留最新）', () => {
  const rows = makeRows(170)
  const quote = parseTencentKline(makePayload('sh600519', rows), '600519', FIXTURE_NOW)
  assert.equal(quote.bars.length, 160)
  assert.equal(quote.bars[0].date, rows[rows.length - 160][0])
  assert.equal(quote.bars.at(-1).date, '2026-11-23')
  assert.equal(quote.tradeDate, '2026-11-23')
})

/* ─────────────────────────────────────────────────────────────
 * 2) 拒绝条件
 * ───────────────────────────────────────────────────────────── */

test('不足 21 根拒绝', () => {
  assert.throws(
    () => parseTencentKline(makePayload('sh600519', KLINE_ROWS.slice(-20)), '600519', FIXTURE_NOW),
    /日线数据不足/,
  )
  // 恰好 21 根可以接受
  const quote = parseTencentKline(makePayload('sh600519', makeRows(21)), '600519', FIXTURE_NOW)
  assert.equal(quote.bars.length, 21)
})

test('日期倒序 / 重复拒绝', () => {
  assert.throws(
    () => parseTencentKline(makePayload('sh600519', [...KLINE_ROWS].reverse()), '600519', FIXTURE_NOW),
    /日期顺序异常/,
  )
  const duplicated = [KLINE_ROWS[0], KLINE_ROWS[0], ...KLINE_ROWS.slice(1)]
  assert.throws(
    () => parseTencentKline(makePayload('sh600519', duplicated), '600519', FIXTURE_NOW),
    /日期顺序异常/,
  )
})

test('最后一根不是最新交易日时拒绝（落后 2 个交易日以上）', () => {
  // qt 实时快照是 2026-11-23；允许滞后一个交易日（11-20），但 11-19 及更旧必须拒绝
  const staleRows = makeRows(24, '2026-11-19')
  assert.throws(
    () => parseTencentKline(makePayload('sh600519', staleRows), '600519', FIXTURE_NOW),
    /不是最新交易日/,
  )
})

test('允许滞后一个交易日（盘前/盘中腾讯日线可能只到上一交易日）', () => {
  // qt 是 2026-11-23，最后一根是 2026-11-20（上一交易日）→ 接受
  const lagRows = makeRows(24, '2026-11-20')
  const quote = parseTencentKline(makePayload('sh600519', lagRows), '600519', FIXTURE_NOW)
  assert.equal(quote.tradeDate, '2026-11-20')
})

test('响应结构异常（code!=0 / 缺 symbol / 缺 qfqday）统一报中文错误', () => {
  for (const payload of [
    null,
    {},
    { code: 1, data: {} },
    { code: 0, data: {} },
    { code: 0, data: { sh600519: { qt: {} } } },
    { code: 0, data: { sh600519: { qfqday: [] } } },
  ]) {
    assert.throws(() => parseTencentKline(payload, '600519', FIXTURE_NOW), /暂未返回有效日线/)
  }
})

/* ─────────────────────────────────────────────────────────────
 * 3) symbol 前缀（与 marketId 规则一致；159 开头 ETF 是深市 sz）
 * ───────────────────────────────────────────────────────────── */

test('symbol：5/6/9 → sh，其余 → sz（159 ETF 归深市）', () => {
  assert.equal(tencentKlineSymbol('600519'), 'sh600519')
  assert.equal(tencentKlineSymbol('510300'), 'sh510300')
  assert.equal(tencentKlineSymbol('588000'), 'sh588000')
  assert.equal(tencentKlineSymbol('900901'), 'sh900901')
  assert.equal(tencentKlineSymbol('000001'), 'sz000001')
  assert.equal(tencentKlineSymbol('300750'), 'sz300750')
  assert.equal(tencentKlineSymbol('159915'), 'sz159915')
  assert.equal(tencentKlineSymbol('159919'), 'sz159919')

  // ETF 159 的 payload 也走 sz 前缀解析
  const quote = parseTencentKline(makePayload('sz159915', makeRows(24)), '159915', FIXTURE_NOW)
  assert.equal(quote.code, '159915')
  assert.equal(quote.bars.length, 24)
})

/* ─────────────────────────────────────────────────────────────
 * 4) 回退链（mock 全局 fetch，离线）
 * ───────────────────────────────────────────────────────────── */

const EASTMONEY_FIXTURE = {
  rc: 0,
  data: {
    code: '600519',
    name: '贵州茅台',
    klines: [
      '2026-11-20,10.00,10.10,10.20,9.90,1000,10100,0,1.00,0,2.00',
      '2026-11-23,10.10,10.20,10.30,10.00,1200,12240,0,0.99,0,2.10',
    ],
  },
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

test('回退链：东财 fetch 失败 → 东财 JSONP 不可用 → 腾讯 kline 成功', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('push2his.eastmoney.com')) return { ok: false, status: 502 }
    if (url.includes('web.ifzq.gtimg.cn')) return { ok: true, json: async () => makePayload('sh600519', KLINE_ROWS) }
    throw new Error(`unexpected url ${url}`)
  })
  try {
    const quote = await fetchQuote('600519')
    assert.equal(quote.provider, 'Tencent kline (qfq)')
    assert.equal(quote.adjustment, '前复权')
    assert.equal(quote.tradeDate, '2026-11-23')
    assert.equal(quote.price, 1439.0)
    assert.equal(quote.bars.length, KLINE_ROWS.length)
    assert.equal(mock.calls.length, 2) // 东财 kline 1 次（JSONP 走 script 标签不发 fetch）+ 腾讯 1 次
    assert.match(mock.calls[0], /push2his\.eastmoney\.com/)
    assert.match(mock.calls[1], /web\.ifzq\.gtimg\.cn.*param=sh600519/)
  } finally {
    mock.restore()
  }
})

test('回退链：东财 fetch 成功时短路，不请求腾讯', async () => {
  const mock = mockFetch(() => ({ ok: true, json: async () => EASTMONEY_FIXTURE }))
  try {
    const quote = await fetchQuote('600519')
    assert.equal(quote.price, 10.2)
    assert.equal(quote.provider, undefined)
    assert.equal(quote.bars.length, 2)
    assert.equal(mock.calls.length, 1)
    assert.match(mock.calls[0], /push2his\.eastmoney\.com/)
    assert.ok(!mock.calls[0].includes('ifzq'))
  } finally {
    mock.restore()
  }
})

test('回退链：东财与腾讯全失败时抛错（保留中文错误文案）', async () => {
  const mock = mockFetch(() => ({ ok: false, status: 502 }))
  try {
    await assert.rejects(() => fetchQuote('600519'))
  } finally {
    mock.restore()
  }
})

test('非法代码直接报中文错误（不进入任何网络回退）', async () => {
  const mock = mockFetch(() => {
    throw new Error('should not fetch')
  })
  try {
    await assert.rejects(() => fetchQuote('60051'), /请输入 6 位股票或 ETF 代码/)
    await assert.rejects(() => fetchQuote('abcdef'), /请输入 6 位股票或 ETF 代码/)
    assert.equal(mock.calls.length, 0)
  } finally {
    mock.restore()
  }
})
