import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FETCH_TIMEOUT_MS,
  LIVE_COOLDOWN_MS,
  RETRY_DELAYS_MS,
  STALE_QUOTE_MS,
  annotateAuctionErrors,
  finalizeResponseQuotes,
  getMarketPhase,
  isLivePhase,
  isStale,
  latestQuoteUpdatedAt,
  nextPollDelay,
  nextWakeAt,
  normalizeEastmoneyPricing,
  parseEastmoneyStock,
  parseEastmoneyTimestamp,
  parseEastmoneyUlist,
  parseTencentScript,
  parseTencentTimestamp,
  phaseLabel,
  rejectStaleQuotes,
  secidFor,
  tencentSymbolFor,
} from '../src/lib/live.ts'

/* ─────────────────────────────────────────────────────────────
 * 离线 fixture：2026-11-23 通过只读代理取到的东财真实响应（fltt=2）。
 * 本机直连 push2 被反爬拦截（Empty reply / 52），故 fixture 是唯一可复现证据。
 * f124=1795421501 → 2026-11-23T08:11:41.000Z；f124=1795419243 → 2026-11-23T07:34:03.000Z。
 * ───────────────────────────────────────────────────────────── */
const EASTMONEY_ULIST_FIXTURE = {
  rc: 0,
  rt: 11,
  svr: 177542528,
  lt: 2,
  full: 1,
  dlmkts: '8,10,128',
  dsc: '0',
  data: {
    total: 2,
    diff: [
      {
        f2: 1439.0,
        f3: -3.15,
        f4: -46.75,
        f5: 56976,
        f6: 8223838967.0,
        f12: '600519',
        f14: '贵州茅台',
        f15: 1478.0,
        f16: 1428.0,
        f17: 1475.35,
        f18: 1485.75,
        f124: 1795421501,
      },
      {
        f2: 12.34,
        f3: 0.98,
        f4: 0.12,
        f5: 2444036,
        f6: 3022565998.18,
        f12: '000001',
        f14: '平安银行',
        f15: 12.51,
        f16: 12.15,
        f17: 12.2,
        f18: 12.22,
        f124: 1795419243,
      },
    ],
  },
}

const EASTMONEY_STOCK_FIXTURE = {
  rc: 0,
  rt: 4,
  data: {
    f43: 1439.0,
    f44: 1478.0,
    f45: 1428.0,
    f46: 1475.35,
    f47: 56976,
    f48: 8223838967.0,
    f57: '600519',
    f58: '贵州茅台',
    f60: 1485.75,
    f86: 1795421501,
    f169: -46.75,
    f170: -3.15,
  },
}

// 腾讯 script 全局变量原文（东财取不到的 000001 用它回退），GBK 已转 UTF-8。
const TENCENT_SCRIPT_FIXTURE =
  'v_sh600519="1~贵州茅台~600519~1439.00~1485.75~1475.35~56976~26410~30566~1439.00~3~1438.87~4~1438.71~1~1438.50~1~1438.26~6~1439.05~1~1439.20~6~1439.40~2~1439.44~10~1439.47~1~~20261123161441~-46.75~-3.15~1478.00~1428.00~1439.00/56976/8223838967~56976~822384~0.46~21.89~~1478.00~1428.00~3.37~17988.67~17988.67~6.63~1634.33~1337.18~1.33~-5~1443.39~20.93~21.85~~~-0.06~822383.8967~446.0900~31~   A~GP-A~6.66~-1.02~3.62~30.29~26.74~1539.98~1151.01~-0.41~6.59~13.06~1250081601~1250081601~-14.29~0.84~1250081601~~~1.72~-0.12~~CNY~0~___D__F__N~1438.16~6~";\n' +
  'v_sz000001="51~平安银行~000001~12.34~12.22~12.20~2444036~1400335~1043701~12.34~875~12.33~1723~12.32~1778~12.31~3823~12.30~13281~12.35~2605~12.36~4122~12.37~1433~12.38~858~12.39~1868~~20261123161500~0.12~0.98~12.51~12.15~12.34/2444036/3022565998~2444036~302257~1.26~5.51~~12.51~12.15~2.95~2394.66~2394.69~0.50~13.44~11.00~1.37~10594~12.37~4.58~5.62~~~0.09~302256.5998~32.5776~264~   A~GP-A~14.25~0.33~4.94~7.81~0.73~12.51~9.74~3.78~9.20~10.56~19405684991~19405918198~32.73~19.91~19405684991~~~11.36~0.00~~CNY~0~~12.28~7573~";'

/* ─────────────────────────────────────────────────────────────
 * 1) 解析与缩放
 * ───────────────────────────────────────────────────────────── */

test('fltt=2 的东财批量响应已是小数，不做二次缩放', () => {
  const { quotes, errors } = parseEastmoneyUlist(EASTMONEY_ULIST_FIXTURE, ['600519', '000001'], 'trading')
  assert.deepEqual(errors, {})
  assert.equal(Object.keys(quotes).length, 2)

  const moutai = quotes['600519']
  assert.equal(moutai.code, '600519')
  assert.equal(moutai.price, 1439.0)
  assert.equal(moutai.prevClose, 1485.75)
  assert.equal(moutai.open, 1475.35)
  assert.equal(moutai.high, 1478.0)
  assert.equal(moutai.low, 1428.0)
  assert.equal(moutai.changePct, -3.15)
  assert.equal(moutai.volume, 56976)
  assert.equal(moutai.amount, 8223838967.0)
  assert.equal(moutai.updatedAt, '2026-11-23T08:11:41.000Z')
  assert.equal(moutai.phase, 'trading')
  assert.equal(moutai.provider, 'eastmoney')

  const pingan = quotes['000001']
  assert.equal(pingan.price, 12.34)
  assert.equal(pingan.changePct, 0.98)
  assert.equal(pingan.prevClose, 12.22)
  assert.equal(pingan.updatedAt, '2026-11-23T07:34:03.000Z')
})

test('端点退化为 ×100 时按「成交额/成交量≈均价」防御性归一', () => {
  const scaled = {
    rc: 0,
    data: {
      total: 1,
      diff: [
        {
          f2: 143900.0,
          f3: -315.0,
          f4: -4675.0,
          f5: 56976,
          f6: 8223838967.0,
          f12: '600519',
          f14: '贵州茅台',
          f15: 147800.0,
          f16: 142800.0,
          f17: 147535.0,
          f18: 148575.0,
          f124: 1795421501,
        },
      ],
    },
  }
  const { quotes, errors } = parseEastmoneyUlist(scaled, ['600519'], 'closed')
  assert.deepEqual(errors, {})
  const quote = quotes['600519']
  assert.equal(quote.price, 1439.0)
  assert.equal(quote.prevClose, 1485.75)
  assert.equal(quote.open, 1475.35)
  assert.equal(quote.high, 1478.0)
  assert.equal(quote.low, 1428.0)
  assert.equal(quote.changePct, -3.15)
  assert.equal(quote.updatedAt, '2026-11-23T08:11:41.000Z')
})

test('缩放归一保留成交量/成交额原值（它们不随 fltt 缩放）', () => {
  const normalized = normalizeEastmoneyPricing({
    price: 1439.0,
    prevClose: 1485.75,
    open: 1475.35,
    high: 1478.0,
    low: 1428.0,
    changePct: -3.15,
    volume: 56976,
    amount: 8223838967.0,
  })
  assert.deepEqual(normalized, {
    price: 1439.0,
    prevClose: 1485.75,
    open: 1475.35,
    high: 1478.0,
    low: 1428.0,
    changePct: -3.15,
    volume: 56976,
    amount: 8223838967.0,
  })
})

test('单只 stock/get 字段解析（f43/f60/f86 等）', () => {
  const { quote, error } = parseEastmoneyStock(EASTMONEY_STOCK_FIXTURE, '600519', 'lunch')
  assert.equal(error, undefined)
  assert.equal(quote.price, 1439.0)
  assert.equal(quote.prevClose, 1485.75)
  assert.equal(quote.updatedAt, '2026-11-23T08:11:41.000Z')
  assert.equal(quote.phase, 'lunch')
  assert.equal(quote.provider, 'eastmoney')
})

/* ─────────────────────────────────────────────────────────────
 * 2) 时段边界（固定 UTC 时刻 = 北京时间 UTC+8）
 * ───────────────────────────────────────────────────────────── */

test('交易时段边界：09:15 / 09:25 / 09:30 / 11:30 / 13:00 / 15:00', () => {
  const cases = [
    ['2026-11-23T00:00:00Z', 'preopen'], // 08:00 盘前
    ['2026-11-23T01:14:59Z', 'preopen'], // 09:14:59
    ['2026-11-23T01:15:00Z', 'auction'], // 09:15 集合竞价开始
    ['2026-11-23T01:24:59Z', 'auction'], // 09:24:59
    ['2026-11-23T01:25:00Z', 'preopen'], // 09:25–09:30 竞价结束、等待开盘
    ['2026-11-23T01:29:59Z', 'preopen'], // 09:29:59
    ['2026-11-23T01:30:00Z', 'trading'], // 09:30 开盘
    ['2026-11-23T03:29:59Z', 'trading'], // 11:29:59
    ['2026-11-23T03:30:00Z', 'lunch'], // 11:30 午休
    ['2026-11-23T04:59:59Z', 'lunch'], // 12:59:59
    ['2026-11-23T05:00:00Z', 'trading'], // 13:00 下午开盘
    ['2026-11-23T06:59:59Z', 'trading'], // 14:59:59
    ['2026-11-23T07:00:00Z', 'closed'], // 15:00 收盘
    ['2026-11-23T08:00:00Z', 'closed'], // 16:00 盘后
  ]
  for (const [iso, expected] of cases) {
    assert.equal(getMarketPhase(new Date(iso)), expected, iso)
  }
})

test('周末优先判非交易日；相位标签与轮询间隔符合契约', () => {
  assert.equal(getMarketPhase(new Date('2026-11-21T02:00:00Z')), 'non-trading') // 周六 10:00
  assert.equal(getMarketPhase(new Date('2026-11-22T02:00:00Z')), 'non-trading') // 周日 10:00
  assert.equal(isLivePhase('auction'), true)
  assert.equal(isLivePhase('trading'), true)
  assert.equal(isLivePhase('lunch'), false)
  assert.equal(isLivePhase('closed'), false)
  assert.equal(isLivePhase('preopen'), false)
  assert.equal(isLivePhase('non-trading'), false)
  assert.equal(nextPollDelay('trading'), 15_000)
  assert.equal(nextPollDelay('auction'), 15_000)
  assert.equal(nextPollDelay('lunch'), 60_000)
  assert.equal(nextPollDelay('preopen'), 60_000)
  assert.equal(nextPollDelay('closed'), 300_000)
  assert.equal(nextPollDelay('non-trading'), 600_000)
  assert.equal(phaseLabel('auction'), '集合竞价')
  assert.equal(phaseLabel('closed'), '已收盘')
})

/* ─────────────────────────────────────────────────────────────
 * 3) 失败回退：主源缺代码 → 单只 → 腾讯 script
 * ───────────────────────────────────────────────────────────── */

test('主源缺代码时记 errors，随后可被单只/腾讯回退补齐', () => {
  const partial = {
    rc: 0,
    data: { total: 1, diff: [EASTMONEY_ULIST_FIXTURE.data.diff[0]] },
  }
  const batch = parseEastmoneyUlist(partial, ['600519', '000001'], 'trading')
  assert.equal(Object.keys(batch.quotes).length, 1)
  assert.match(batch.errors['000001'], /主源未返回该代码/)

  const single = parseEastmoneyStock(EASTMONEY_STOCK_FIXTURE, '600519', 'trading')
  assert.equal(single.quote.provider, 'eastmoney')

  const fallback = parseTencentScript(TENCENT_SCRIPT_FIXTURE, ['000001'], 'non-trading')
  assert.deepEqual(fallback.errors, {})
  const tencentQuote = fallback.quotes['000001']
  assert.equal(tencentQuote.provider, 'tencent')
  assert.equal(tencentQuote.phase, 'non-trading')
  assert.equal(tencentQuote.price, 12.34)
  assert.equal(tencentQuote.prevClose, 12.22)
  assert.equal(tencentQuote.open, 12.2)
  assert.equal(tencentQuote.high, 12.51)
  assert.equal(tencentQuote.low, 12.15)
  assert.equal(tencentQuote.changePct, 0.98)
  assert.equal(tencentQuote.volume, 2444036)
  assert.equal(tencentQuote.amount, 302257 * 10_000) // 腾讯成交额单位：万元
  assert.equal(tencentQuote.updatedAt, '2026-11-23T08:15:00.000Z') // YYYYMMDDHHmmss 北京时间
})

test('主源整体失败（data 缺失/污染）时全部报错，不返回伪造报价', () => {
  for (const payload of [null, {}, { data: null }, { data: { diff: 'oops' } }]) {
    const { quotes, errors } = parseEastmoneyUlist(payload, ['600519', '000001'], 'trading')
    assert.deepEqual(quotes, {})
    assert.match(errors['600519'], /data\.diff/)
    assert.match(errors['000001'], /data\.diff/)
  }
})

test('停牌/无价格不伪造报价，只记 error', () => {
  const suspended = {
    rc: 0,
    data: { total: 1, diff: [{ f2: '-', f3: '-', f12: '600519', f124: 1795421501 }] },
  }
  const { quotes, errors } = parseEastmoneyUlist(suspended, ['600519'], 'trading')
  assert.deepEqual(quotes, {})
  assert.match(errors['600519'], /未返回有效现价/)
})

test('腾讯备用源缺代码时记 errors', () => {
  const { quotes, errors } = parseTencentScript(TENCENT_SCRIPT_FIXTURE, ['000001', '300750'], 'trading')
  assert.equal(Object.keys(quotes).length, 1)
  assert.match(errors['300750'], /未返回该代码/)
})

test('secid / 腾讯符号映射：5/6/9 沪市，4/8 北交所，其余深市', () => {
  assert.equal(secidFor('600519'), '1.600519')
  assert.equal(secidFor('510300'), '1.510300')
  assert.equal(secidFor('900901'), '1.900901')
  assert.equal(secidFor('000001'), '0.000001')
  assert.equal(secidFor('300750'), '0.300750')
  assert.equal(tencentSymbolFor('600519'), 'sh600519')
  assert.equal(tencentSymbolFor('510300'), 'sh510300')
  assert.equal(tencentSymbolFor('000001'), 'sz000001')
  assert.equal(tencentSymbolFor('300750'), 'sz300750')
  assert.equal(tencentSymbolFor('830799'), 'bj830799')
  assert.equal(tencentSymbolFor('430047'), 'bj430047')
})

/* ─────────────────────────────────────────────────────────────
 * 4) 时间戳与陈旧数据拒绝
 * ───────────────────────────────────────────────────────────── */

test('provider 时间戳解析：东财秒级 / 腾讯北京时间', () => {
  assert.equal(parseEastmoneyTimestamp(1795421501), '2026-11-23T08:11:41.000Z')
  assert.equal(parseEastmoneyTimestamp(1795421501000), '2026-11-23T08:11:41.000Z')
  assert.equal(parseEastmoneyTimestamp('1795421501'), '2026-11-23T08:11:41.000Z')
  assert.equal(parseEastmoneyTimestamp(0), undefined)
  assert.equal(parseEastmoneyTimestamp('-'), undefined)
  assert.equal(parseEastmoneyTimestamp(undefined), undefined)

  assert.equal(parseTencentTimestamp('20261123161441'), '2026-11-23T08:14:41.000Z')
  assert.equal(parseTencentTimestamp('20261123161500'), '2026-11-23T08:15:00.000Z')
  assert.equal(parseTencentTimestamp('bad'), undefined)
  assert.equal(parseTencentTimestamp(undefined), undefined)
})

test('updatedAt 缺失/非法视为陈旧，避免拿旧数据冒充实时', () => {
  const now = new Date('2026-11-23T08:14:00.000Z')
  assert.equal(isStale(undefined, now), true)
  assert.equal(isStale({ updatedAt: '' }, now), true)
  assert.equal(isStale({ updatedAt: 'not-a-date' }, now), true)
})

test('2 分钟陈旧阈值边界：79s 新鲜 / 正好 120s 新鲜 / 121s 陈旧', () => {
  const updatedAt = '2026-11-23T08:11:41.000Z'
  assert.equal(STALE_QUOTE_MS, 120_000)
  assert.equal(isStale({ updatedAt }, new Date('2026-11-23T08:13:00.000Z')), false) // 79s
  assert.equal(isStale({ updatedAt }, new Date('2026-11-23T08:13:41.000Z')), false) // 120s
  assert.equal(isStale({ updatedAt }, new Date('2026-11-23T08:13:42.000Z')), true) // 121s
})

test('rejectStaleQuotes 只保留新鲜报价并把陈旧原因写进 errors', () => {
  const { quotes: freshQuotes } = parseEastmoneyUlist(EASTMONEY_ULIST_FIXTURE, ['600519', '000001'], 'trading')
  const now = new Date('2026-11-23T08:13:00.000Z')
  const result = rejectStaleQuotes(freshQuotes, now)
  // 600519 更新于 08:11:41（79s 前）→ 保留；000001 更新于 07:34:03（约 39 分钟前）→ 拒绝
  assert.deepEqual(Object.keys(result.quotes), ['600519'])
  assert.equal(result.quotes['600519'].updatedAt, '2026-11-23T08:11:41.000Z')
  assert.match(result.errors['000001'], /秒未更新，拒绝作为实时报价/)
})

test('网络常量符合反爬契约（超时 8–10s、2 次退避、30s 冷却）', () => {
  assert.ok(FETCH_TIMEOUT_MS >= 8_000 && FETCH_TIMEOUT_MS <= 10_000)
  assert.equal(RETRY_DELAYS_MS.length, 2)
  assert.ok(RETRY_DELAYS_MS[1] > RETRY_DELAYS_MS[0]) // 指数退避
  assert.equal(LIVE_COOLDOWN_MS, 30_000)
})

/* ─────────────────────────────────────────────────────────────
 * 5) P1 修复回归（task-5）：跨时段相位 / updatedAt 语义 / 开盘唤醒 / 竞价降级
 * ───────────────────────────────────────────────────────────── */

function quoteAt(updatedAt, overrides = {}) {
  return {
    code: '600519',
    price: 1439.0,
    prevClose: 1485.75,
    open: 1475.35,
    high: 1478.0,
    low: 1428.0,
    changePct: -3.15,
    volume: 56976,
    amount: 8223838967.0,
    updatedAt,
    phase: 'trading',
    provider: 'eastmoney',
    ...overrides,
  }
}

test('P1-2 跨时段相位：11:29:59 发起、11:30:01 返回 → 报价 phase 改为 lunch', () => {
  const startedAt = new Date('2026-11-23T03:29:59Z') // 11:29:59 北京
  const returnedAt = new Date('2026-11-23T03:30:01Z') // 11:30:01 北京
  assert.equal(getMarketPhase(startedAt), 'trading')
  assert.equal(getMarketPhase(returnedAt), 'lunch')

  // 旧实现会沿用请求开始时的 trading 相位
  const requestPhaseQuotes = { '600519': quoteAt('2026-11-23T03:29:58.000Z', { phase: 'trading' }) }
  const { quotes } = parseEastmoneyUlist(EASTMONEY_ULIST_FIXTURE, ['600519'], getMarketPhase(startedAt))
  assert.equal(quotes['600519'].phase, 'trading')

  // 响应返回后按墙钟重算 → 不再沿用旧 trading
  const finalized = finalizeResponseQuotes(requestPhaseQuotes, returnedAt)
  assert.equal(finalized.phase, 'lunch')
  assert.equal(finalized.quotes['600519'].phase, 'lunch')
  assert.deepEqual(finalized.errors, {}) // 午休保留最后行情（不按 trading 拒绝），供标注午休/收盘价
})

test('P1-2 收盘边界：14:59:59 发起、15:00:01 返回 → phase=closed', () => {
  const startedAt = new Date('2026-11-23T06:59:59Z') // 14:59:59 北京
  const returnedAt = new Date('2026-11-23T07:00:01Z') // 15:00:01 北京
  assert.equal(getMarketPhase(startedAt), 'trading')
  assert.equal(getMarketPhase(returnedAt), 'closed')

  const finalized = finalizeResponseQuotes({ '600519': quoteAt('2026-11-23T06:59:40.000Z') }, returnedAt)
  assert.equal(finalized.phase, 'closed')
  assert.equal(finalized.quotes['600519'].phase, 'closed')
  assert.equal(finalized.quotes['600519'].updatedAt, '2026-11-23T06:59:40.000Z') // 仍保留 provider 时间
  assert.deepEqual(finalized.errors, {})
})

test('P1-2 仅在最终相位为交易/竞价时才拒绝陈旧报价', () => {
  const staleQuote = quoteAt('2026-11-23T01:55:00.000Z') // 09:55，早于 now 5 分钟
  const tradingNow = new Date('2026-11-23T02:00:00Z') // 10:00 trading
  assert.equal(getMarketPhase(tradingNow), 'trading')
  const finalized = finalizeResponseQuotes({ '600519': staleQuote }, tradingNow)
  assert.equal(finalized.phase, 'trading')
  assert.deepEqual(finalized.quotes, {})
  assert.match(finalized.errors['600519'], /秒未更新，拒绝作为实时报价/)
})

test('P1-7 updatedAt 语义：取本批 provider 行情时间最大值，无报价为 undefined', () => {
  const { quotes } = parseEastmoneyUlist(EASTMONEY_ULIST_FIXTURE, ['600519', '000001'], 'trading')
  // 600519 的 08:11:41 晚于 000001 的 07:34:03
  assert.equal(latestQuoteUpdatedAt(quotes), '2026-11-23T08:11:41.000Z')
  assert.equal(latestQuoteUpdatedAt({}), undefined)
  assert.equal(latestQuoteUpdatedAt({ broken: quoteAt('not-a-date') }), undefined)
  // 结果只来自 provider updatedAt，与「抓取时间」无关
  assert.notEqual(latestQuoteUpdatedAt(quotes), new Date().toISOString())
})

test('P1-4 开盘唤醒：09:25–09:30 精确排到 09:30:00（不是 60s 后）', () => {
  assert.equal(getMarketPhase(new Date('2026-11-23T01:26:00Z')), 'preopen') // 09:26
  assert.equal(nextWakeAt(new Date('2026-11-23T01:26:00Z')).toISOString(), '2026-11-23T01:30:00.000Z')
  // 09:25:00 边界
  assert.equal(nextWakeAt(new Date('2026-11-23T01:25:00Z')).toISOString(), '2026-11-23T01:30:00.000Z')
  // 若用旧的「60s 看门」会排到 01:27:00，这里必须是整 09:30:00
  assert.notEqual(nextWakeAt(new Date('2026-11-23T01:26:00Z')).toISOString(), '2026-11-23T01:27:00.000Z')
})

test('P1-4 相位看门：盘前 09:15、午休 13:00、收盘/周末下一工作日 09:15', () => {
  assert.equal(nextWakeAt(new Date('2026-11-23T00:10:00Z')).toISOString(), '2026-11-23T01:15:00.000Z') // 08:10 → 09:15
  assert.equal(nextWakeAt(new Date('2026-11-23T03:31:00Z')).toISOString(), '2026-11-23T05:00:00.000Z') // 11:31 → 13:00
  assert.equal(nextWakeAt(new Date('2026-11-23T07:30:00Z')).toISOString(), '2026-11-24T01:15:00.000Z') // 周一 15:30 → 周二 09:15
  assert.equal(nextWakeAt(new Date('2026-11-20T08:00:00Z')).toISOString(), '2026-11-23T01:15:00.000Z') // 周五 16:00 → 周一 09:15
  assert.equal(nextWakeAt(new Date('2026-11-21T02:00:00Z')).toISOString(), '2026-11-23T01:15:00.000Z') // 周六 10:00 → 周一 09:15
  assert.equal(nextWakeAt(new Date('2026-11-23T02:00:00Z')).toISOString(), '2026-11-23T02:00:15.000Z') // 交易中 15s

  for (const iso of [
    '2026-11-20T08:00:00Z',
    '2026-11-21T02:00:00Z',
    '2026-11-23T00:10:00Z',
    '2026-11-23T01:26:00Z',
    '2026-11-23T03:31:00Z',
    '2026-11-23T07:30:00Z',
  ]) {
    const now = new Date(iso)
    assert.ok(nextWakeAt(now).getTime() > now.getTime(), `唤醒时刻必须在未来：${iso}`)
  }
})

test('P1-3 集合竞价 stale 全拒时给出明确 errors（不静默 0 只报价）', () => {
  const auctionNow = new Date('2026-11-23T01:20:00Z') // 09:20 集合竞价
  assert.equal(getMarketPhase(auctionNow), 'auction')

  // 腾讯字段 30 在竞价时段若停留在上一时点（例如 08:55），会被 live 相位拒绝
  const staleQuote = quoteAt('2026-11-23T00:55:00.000Z', { code: '000001', provider: 'tencent' })
  const finalized = finalizeResponseQuotes({ '000001': staleQuote }, auctionNow)
  assert.equal(finalized.phase, 'auction')
  assert.deepEqual(finalized.quotes, {})
  assert.match(finalized.errors['000001'], /拒绝作为实时报价/)

  // 竞价降级文案：明确提示「provider 时间戳可能尚未更新、未经实测」
  const annotated = annotateAuctionErrors(['000001'], finalized.quotes, finalized.errors)
  assert.match(annotated['000001'], /集合竞价/)
  assert.match(annotated['000001'], /未经实测/)
  assert.match(annotated['000001'], /拒绝作为实时报价/)

  // 没有任何 error 时也不能静默：给出明确的集合竞价提示
  const noError = annotateAuctionErrors(['000001'], {}, {})
  assert.match(noError['000001'], /集合竞价未获取到带有效时间戳的报价/)
})

test('未来时间戳给出明确错误文案（避免「已 0 秒未更新」歧义）', () => {
  const future = quoteAt('2026-11-23T04:00:00.000Z')
  const result = rejectStaleQuotes({ '600519': future }, new Date('2026-11-23T02:00:00Z'))
  assert.deepEqual(result.quotes, {})
  assert.match(result.errors['600519'], /晚于本机时间/)
})
