#!/usr/bin/env node
/**
 * 本地快照生成器（Node 版，替代 GitHub Actions + Python akshare）。
 *
 * 作用：读取 scripts/public-universe.json 的公开清单，拉取日线（腾讯 fqkline → 新浪 JSON → 东财 push2his），
 * 生成 public/data/latest.json，供页面在无后端时使用；全部离线逻辑可单测，运行时才访问网络。
 *
 * 数据源（2026-11-24 实测）：
 *   - 腾讯：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<symbol>,day,,,320,<adj>
 *     复权口径按标的类型选择（task-29）：ETF（510/511/512/513/515/516/518/159/588 开头）用 `hfq`（后复权），
 *     个股用 `qfq`（前复权）；响应 key 相应为 hfqday/qfqday，带 CORS，无 amount（置 0）。
 *     rotation-research 实测腾讯 qfq 对 ETF 失真（510300 2014-09→12 算出 +74%，真实 +49%），ETF 必须 hfq。
 *     07:44 起本机被 501 WAF 挑战页拦截（不是永久不可用，仍作为第一优先）。
 *   - 新浪：https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh600519&scale=240&ma=no&datalen=320
 *     → [{ day, open, high, low, close, volume }, ...]，**不复权**、volume 单位「股」（÷100 转「手」）、无 amount。
 *     复权口径实测：600519 2025-07-29 腾讯 qfq 1387.019 vs 新浪 1439.000（比值 0.9639），2026-11-23 两者相等
 *     → 差异随除权除息累积，新浪确为不复权；quotes[].adjustment 如实标 '不复权（tushare 未验证）'。
 *   - 东财：https://push2his.eastmoney.com/api/qt/stock/kline/get?...
 *     → data.klines = ['date,open,close,high,low,volume,amount,...,changePct,...,turnoverPct']，
 *     本机常被反爬（Empty reply/52），允许失败。
 *
 * 产物必须通过 src/lib/snapshot.ts 的 snapshotSchema 校验后才原子写入（.tmp → rename）；
 * 校验失败/无有效报价一律 exit 1 且不覆盖 last-good 快照。
 *
 * 用法：npm run refresh   （等价 node --experimental-strip-types scripts/refresh-snapshot.mjs）
 * 可选：SNAPSHOT_OUTPUT=/path/latest.json 覆盖输出路径。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  HFQ_CALIBRATED_ADJUSTMENT,
  HFQ_UNCALIBRATED_ADJUSTMENT,
  TENCENT_KLINE_HOSTS,
  adjustmentFor,
  rescaleBarsToActual,
  tencentKlineUrl,
} from '../src/lib/market.ts'
import { snapshotSchema } from '../src/lib/snapshot.ts'
import { generateStrategy } from '../src/lib/strategy.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_UNIVERSE_PATH = resolve(SCRIPT_DIR, 'public-universe.json')
const DEFAULT_OUTPUT_PATH = 'public/data/latest.json'

const SINA_ENDPOINT = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData'
const EASTMONEY_ENDPOINT = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
const SOURCE_URL_TENCENT = 'https://web.ifzq.gtimg.cn/'
const SOURCE_URL_SINA = 'https://quotes.sina.cn/'
const SOURCE_URL_EASTMONEY = 'https://www.eastmoney.com/'
const PROVIDER_SINA = 'Sina kline (不复权)'
const PROVIDER_EASTMONEY = 'Eastmoney daily OHLCV (前复权)'
const ADJUSTMENT_QFQ = '前复权'
const ADJUSTMENT_HFQ = '后复权'

/** 腾讯 provider 文案按复权口径动态生成（ETF hfq / 个股 qfq）。 */
function tencentProvider(adjustment) {
  return `Tencent fqkline (${adjustment})`
}
const ADJUSTMENT_SINA = '不复权（tushare 未验证）'
const SINA_DATALEN = 320
const STRATEGY_VERSION = 'katestock-rules-v1'
const STRATEGY_SETTINGS = { capital: 100000, riskPct: 1, maxPositionPct: 10, refreshOnOpen: false }

/** 每只请求超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 10_000
/** 每只最多尝试次数（1 次重试）。 */
const FETCH_ATTEMPTS = 2
/** 重试间隔。 */
const RETRY_DELAY_MS = 1_000
/** 并发数。 */
const CONCURRENCY = 4
/** 最少日线根数。 */
const MIN_BARS = 21
/** 最多保留日线根数。 */
const MAX_BARS = 160

/* ─────────────────────────────────────────────────────────────
 * 通用工具
 * ───────────────────────────────────────────────────────────── */

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/** 6 位代码 → 腾讯 symbol（与 src/lib/market.ts 的 tencentKlineSymbol 一致：5/6/9 → sh，其余 sz）。 */
export function tencentSymbol(code) {
  return `${/^(5|6|9)/.test(code) ? 'sh' : 'sz'}${code}`
}

/** 6 位代码 → 东财 secid（与 src/lib/market.ts 的 marketId 一致）。 */
export function secid(code) {
  return `${/^(5|6|9)/.test(code) ? 1 : 0}.${code}`
}

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 与 snapshotSchema 中 bar refine 等价的 OHLCV 校验（schema 校验前的快速失败）。 */
function isValidBar(bar) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date)) return false
  if (!isPositiveFinite(bar.open) || !isPositiveFinite(bar.close) || !isPositiveFinite(bar.high) || !isPositiveFinite(bar.low)) return false
  if (!isNonNegativeFinite(bar.volume) || !isNonNegativeFinite(bar.amount) || !Number.isFinite(bar.changePct)) return false
  if (bar.high < Math.max(bar.open, bar.close, bar.low)) return false
  if (bar.low > Math.min(bar.open, bar.close)) return false
  return true
}

function assertValidBars(bars, label) {
  if (bars.length < MIN_BARS) throw new Error(`${label}日线不足（${bars.length} 根，至少 ${MIN_BARS} 根）`)
  for (let index = 0; index < bars.length; index += 1) {
    if (!isValidBar(bars[index])) throw new Error(`${label}第 ${index + 1} 根 OHLCV 非法`)
    if (index > 0 && bars[index].date <= bars[index - 1].date) throw new Error(`${label}日期非严格递增`)
  }
  return bars
}

/** 北京时间的日期字符串 YYYY-MM-DD + 当天分钟数（用于 coverage 说明）。 */
const beijingFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function beijingCalendar(now = new Date()) {
  const parts = beijingFormatter.formatToParts(now)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
  const hour = Number(get('hour')) % 24
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: hour * 60 + Number(get('minute')) }
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

/* ─────────────────────────────────────────────────────────────
 * 解析（纯函数，便于离线单测）
 * ───────────────────────────────────────────────────────────── */

/**
 * 解析腾讯 fqkline 响应：data.<symbol>.qfqday = [[date,open,close,high,low,volume], ...]
 * → bars（open=第1、close=第2、high=第3、low=第4、volume=第5，amount=0，changePct 用前收计算，首根 0）。
 * 不做「是否最新交易日」判断（由调用方用全市场最大值统一判定）。
 */
export function parseTencentBars(payload, code) {
  const symbol = tencentSymbol(code)
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data[symbol] : undefined
  if (!isRecord(data)) throw new Error('腾讯响应缺少该代码日线')
  const rows = Array.isArray(data.hfqday)
    ? data.hfqday
    : Array.isArray(data.qfqday)
      ? data.qfqday
      : Array.isArray(data.day)
        ? data.day
        : undefined
  if (!rows || rows.length === 0) throw new Error('腾讯响应没有 hfqday/qfqday')

  const bars = []
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) throw new Error('腾讯日线字段不完整')
    const [date, open, close, high, low, volume] = row
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('腾讯日线日期非法')
    const bar = {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: 0,
      changePct: 0,
    }
    if (!isValidBar(bar)) throw new Error(`腾讯日线 OHLCV 非法（${date}）`)
    bars.push(bar)
  }
  for (let index = 1; index < bars.length; index += 1) {
    const previousClose = bars[index - 1].close
    bars[index].changePct = previousClose > 0 ? (bars[index].close / previousClose - 1) * 100 : 0
  }
  return assertValidBars(bars, '腾讯')
}

/**
 * 解析新浪 JSON：`[{ day, open, high, low, close, volume }, ...]`（按日期升序，volume 单位「股」）。
 * 新浪此接口为**不复权**原始价（见文件头实测），volume ÷100 转「手」以对齐东财/腾讯口径，amount=0。
 * changePct 用前收计算（首根 0）。
 */
export function parseSinaBars(payload) {
  if (!Array.isArray(payload) || payload.length === 0) throw new Error('新浪响应不是有效日线数组')
  const bars = []
  for (const row of payload) {
    if (!isRecord(row)) throw new Error('新浪日线格式非法')
    const date = typeof row.day === 'string' ? row.day : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('新浪日线日期非法')
    const volumeShares = Number(row.volume)
    const bar = {
      date,
      open: Number(row.open),
      close: Number(row.close),
      high: Number(row.high),
      low: Number(row.low),
      // 新浪 volume 单位「股」；东财/腾讯是「手」，÷100 取整保持 Quote.volume 口径一致
      volume: Number.isFinite(volumeShares) && volumeShares >= 0 ? Math.round(volumeShares / 100) : NaN,
      amount: 0,
      changePct: 0,
    }
    if (!isValidBar(bar)) throw new Error(`新浪日线 OHLCV 非法（${date}）`)
    bars.push(bar)
  }
  for (let index = 1; index < bars.length; index += 1) {
    const previousClose = bars[index - 1].close
    bars[index].changePct = previousClose > 0 ? (bars[index].close / previousClose - 1) * 100 : 0
  }
  return assertValidBars(bars, '新浪')
}

/**
 * 解析东财 push2his 响应：data.klines = ['date,open,close,high,low,volume,amount,?,changePct,?,turnoverPct']。
 * 与 scripts/ingest.py 的字段顺序一致。
 */
export function parseEastmoneyBars(payload) {
  if (!isRecord(payload) || payload.rc !== 0 || !isRecord(payload.data) || !Array.isArray(payload.data.klines)) {
    throw new Error('东财响应缺少 klines')
  }
  const bars = []
  for (const line of payload.data.klines) {
    if (typeof line !== 'string') throw new Error('东财日线格式非法')
    const fields = line.split(',')
    if (fields.length < 11) throw new Error('东财日线字段不完整')
    const [date] = fields
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('东财日线日期非法')
    const bar = {
      date,
      open: Number(fields[1]),
      close: Number(fields[2]),
      high: Number(fields[3]),
      low: Number(fields[4]),
      volume: Number(fields[5]),
      amount: Number(fields[6]),
      changePct: Number(fields[8]),
      turnoverPct: Number(fields[10]),
    }
    if (!isValidBar(bar)) throw new Error(`东财日线 OHLCV 非法（${date}）`)
    bars.push(bar)
  }
  return assertValidBars(bars, '东财')
}

/** 最新交易日 = 所有成功解析日线的最后一根日期的最大值。 */
export function selectTradeDate(barsList) {
  let latest
  for (const bars of barsList) {
    if (!Array.isArray(bars) || bars.length === 0) continue
    const date = bars[bars.length - 1].date
    if (!latest || date > latest) latest = date
  }
  return latest
}

/**
 * bars → Quote（字段与 scripts/ingest.py 等价）。
 * 要求：bars ≥21、日期严格递增、最后一根日期 = tradeDate；取最后 160 根。
 */
export function buildQuote(code, bars, { provider, adjustment = ADJUSTMENT_QFQ, tradeDate, fetchedAt }) {
  if (!/^\d{6}$/.test(code)) throw new Error(`代码非法：${code}`)
  if (!Array.isArray(bars)) throw new Error(`${code} 缺少日线`)
  assertValidBars(bars, `${code} `)
  const kept = bars.slice(-MAX_BARS)
  const last = kept[kept.length - 1]
  const previous = kept[kept.length - 2]
  if (last.date !== tradeDate) throw new Error(`${code} 最后一根 ${last.date} ≠ 交易日 ${tradeDate}`)
  return {
    code,
    price: last.close,
    prevClose: previous.close,
    changePct: last.changePct,
    open: last.open,
    high: last.high,
    low: last.low,
    volume: last.volume,
    amount: last.amount,
    tradeDate: last.date,
    fetchedAt,
    source: 'auto',
    provider,
    adjustment,
    bars: kept,
  }
}

/** 复用 generateStrategy，生成与 scripts/generate_signals.mjs 等价的结构。 */
export function buildSignals(quotes, generatedAt) {
  const signals = {}
  for (const [code, quote] of Object.entries(quotes)) {
    const stock = { id: `public-${code}`, code, name: code, status: 'watch', createdAt: generatedAt }
    const strategy = generateStrategy(stock, quote, STRATEGY_SETTINGS)
    signals[code] = {
      action: strategy.action,
      actionLabel: strategy.actionLabel,
      score: strategy.score,
      summary: strategy.summary,
      reasons: strategy.reasons,
      indicators: strategy.indicators,
    }
  }
  return signals
}

/**
 * 组装并通过 snapshotSchema 校验的 Snapshot。
 * partial = failures 非空；若当天的 bar 还没出来（tradeDate < 北京今天）在 coverage 里注明。
 */
export function buildSnapshot({ quotes, failures, universeSize, tradeDate, generatedAt, now = new Date(), signals }) {
  if (!tradeDate) throw new Error('没有可用交易日（quotes 为空）')
  if (!Object.keys(quotes).length) throw new Error('No valid current quotes; last-good snapshot must remain untouched')

  const providers = [...new Set(Object.values(quotes).map((quote) => quote.provider).filter(Boolean))].sort()
  const adjustments = [...new Set(Object.values(quotes).map((quote) => quote.adjustment).filter(Boolean))].sort()
  const adjustmentSuffix =
    adjustments.length === 1
      ? ` (${adjustments[0]})`
      : adjustments.length > 1
        ? `（复权口径混合：${adjustments.join(' / ')}）`
        : ''
  const source = providers.length
    ? `${providers.join(' / ')}${adjustmentSuffix}`
    : `Tencent fqkline (qfq) (${ADJUSTMENT_QFQ})`
  const sourceUrl = providers.some((provider) => provider.startsWith('Tencent fqkline'))
    ? SOURCE_URL_TENCENT
    : providers.some((provider) => provider.startsWith('Sina kline'))
      ? SOURCE_URL_SINA
      : SOURCE_URL_EASTMONEY

  const calendar = beijingCalendar(now)
  let coverage = `公开清单（${universeSize}只），非全市场`
  if (tradeDate < calendar.date) {
    coverage += `；数据截至 ${tradeDate}（今日 bar 未出，盘中/盘前属正常）`
  }

  const report = {
    schemaVersion: 1,
    generatedAt,
    tradeDate,
    source,
    sourceUrl,
    partial: failures.length > 0,
    failures,
    coverage,
    strategyVersion: STRATEGY_VERSION,
    quotes,
    signals: signals ?? buildSignals(quotes, generatedAt),
    // 本地生成器不调用 AI：显式标记 unavailable（scripts/check_public.py 的发布结构要求该字段存在）
    ai: {
      status: 'unavailable',
      text: '本地快照生成器基于腾讯/新浪/东财日线，不生成 AI 点评；盘中提醒与策略信号不受影响。',
      model: 'deepseek-flash',
    },
  }
  // 门禁：不通过则抛错，调用方不得写盘
  return snapshotSchema.parse(report)
}

/* ─────────────────────────────────────────────────────────────
 * 网络抓取
 * ───────────────────────────────────────────────────────────── */

async function fetchJson(url, { fetcher = fetch } = {}) {
  let lastError
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetcher(url, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'Mozilla/5.0 KateStock/2.0' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('source request failed')
}

function sinaUrl(code) {
  return `${SINA_ENDPOINT}?symbol=${tencentSymbol(code)}&scale=240&ma=no&datalen=${SINA_DATALEN}`
}

function eastmoneyUrl(code) {
  const end = new Date()
  end.setDate(end.getDate() - 300)
  const beg = end.toISOString().slice(0, 10).replaceAll('-', '')
  const params = new URLSearchParams({
    secid: secid(code),
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: '101',
    fqt: '1',
    beg,
    end: '20500101',
  })
  return `${EASTMONEY_ENDPOINT}?${params.toString()}`
}

/** 富文本请求（腾讯 qt.gtimg.cn 返回 script 文本而非 JSON），带超时；不重试。 */
async function fetchText(url, { fetcher = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'text/plain, */*', 'User-Agent': 'Mozilla/5.0 KateStock/2.0' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

/** 腾讯实时价（qt.gtimg.cn script 文本）：v_sz159558="...", 字段 3=现价、字段 30=YYYYMMDDHHmmss 北京时间。 */
export function parseTencentRealtime(text, code) {
  const symbol = tencentSymbol(code)
  const match = new RegExp(`v_${symbol}="([^"]*)"`).exec(String(text ?? ''))
  if (!match) throw new Error('腾讯实时价格式非法')
  const fields = match[1].split('~')
  const price = Number(fields[3])
  if (!Number.isFinite(price) || price <= 0) throw new Error('腾讯实时价缺失')
  const rawTime = fields[30] ?? ''
  const timeMatch = /^(\d{4})(\d{2})(\d{2})\d{6}$/.exec(String(rawTime).trim())
  return {
    close: price,
    date: timeMatch ? `${timeMatch[1]}-${timeMatch[2]}-${timeMatch[3]}` : undefined,
  }
}

/**
 * 取「最新实盘收盘」用于 hfq→实盘价归一（task-31）：
 * 1) 新浪不复权日线最后一根 close（带日期，首选）；
 * 2) 失败退回腾讯 gtimg 实时价（qt.gtimg.cn，字段 30 提供日期）。
 * 都失败返回 undefined（调用方不缩放并标注「后复权（实盘价未校准）」）。
 */
async function fetchActualClose(code, options) {
  try {
    const payload = await fetchJson(sinaUrl(code), options)
    const bars = parseSinaBars(payload)
    const last = bars[bars.length - 1]
    return { close: last.close, date: last.date }
  } catch {
    // 继续尝试腾讯实时价
  }
  try {
    const text = await fetchText(`https://qt.gtimg.cn/q=${tencentSymbol(code)}`, options)
    return parseTencentRealtime(text, code)
  } catch {
    return undefined
  }
}

/** ETF hfq 序列按实盘价归一；失败保留 hfq 尺度并标注未校准。 */
async function calibrateHfqBars(code, bars, options) {
  const hfqLast = bars[bars.length - 1]
  const actual = await fetchActualClose(code, options)
  if (!actual || !Number.isFinite(actual.close) || actual.close <= 0 || !actual.date || actual.date !== hfqLast.date) {
    return {
      bars,
      provider: tencentProvider('hfq'),
      adjustment: HFQ_UNCALIBRATED_ADJUSTMENT,
    }
  }
  return {
    bars: rescaleBarsToActual(bars, actual.close),
    provider: `${tencentProvider('hfq')} → rescaled`,
    adjustment: HFQ_CALIBRATED_ADJUSTMENT,
  }
}

/** 单只：腾讯优先（web.ifzq → ifzq 主机降级；ETF hfq→实盘价归一 / 个股 qfq）→ 新浪 → 东财兜底 → 返回 error（不抛）。 */
export async function fetchBarsForCode(code, options = {}) {
  const adjustment = adjustmentFor(code)
  let tencentError
  try {
    let payload
    for (const host of TENCENT_KLINE_HOSTS) {
      try {
        payload = await fetchJson(tencentKlineUrl(code, adjustment, host), options)
        break
      } catch (error) {
        tencentError = error
      }
    }
    if (payload === undefined) throw tencentError instanceof Error ? tencentError : new Error('腾讯日线请求失败')
    const parsedBars = parseTencentBars(payload, code)
    if (adjustment === 'hfq') {
      const calibrated = await calibrateHfqBars(code, parsedBars, options)
      return { code, bars: calibrated.bars, provider: calibrated.provider, adjustment: calibrated.adjustment }
    }
    return { code, bars: parsedBars, provider: tencentProvider('qfq'), adjustment: ADJUSTMENT_QFQ }
  } catch (error) {
    tencentError = error
  }
  let sinaError
  try {
    const payload = await fetchJson(sinaUrl(code), options)
    return { code, bars: parseSinaBars(payload), provider: PROVIDER_SINA, adjustment: ADJUSTMENT_SINA }
  } catch (error) {
    sinaError = error
  }
  try {
    const payload = await fetchJson(eastmoneyUrl(code), options)
    return { code, bars: parseEastmoneyBars(payload), provider: PROVIDER_EASTMONEY, adjustment: ADJUSTMENT_QFQ }
  } catch (eastmoneyError) {
    const message = (error) => (error instanceof Error ? error.message : String(error))
    return { code, error: `腾讯失败（${message(tencentError)}）；新浪失败（${message(sinaError)}）；东财失败（${message(eastmoneyError)}）` }
  }
}

/** 固定并发数的有序 map。 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/* ─────────────────────────────────────────────────────────────
 * 主流程
 * ───────────────────────────────────────────────────────────── */

export async function refreshSnapshot(options = {}) {
  const {
    universePath = DEFAULT_UNIVERSE_PATH,
    outputPath = process.env.SNAPSHOT_OUTPUT || DEFAULT_OUTPUT_PATH,
    fetcher = fetch,
    now = new Date(),
    write = true,
  } = options

  const universe = JSON.parse(readFileSync(universePath, 'utf8'))
  if (!Array.isArray(universe) || !universe.length) throw new Error('public-universe.json 为空或格式非法')

  const generatedAt = now.toISOString()
  const results = await mapWithConcurrency(universe, CONCURRENCY, (code) => fetchBarsForCode(code, { fetcher }))

  const failures = []
  const validBars = []
  for (const result of results) {
    if (result.bars) validBars.push({ code: result.code, bars: result.bars, provider: result.provider, adjustment: result.adjustment })
    else failures.push(`${result.code}: ${result.error}`)
  }

  const tradeDate = selectTradeDate(validBars.map((entry) => entry.bars))
  if (!tradeDate) throw new Error('No valid current quotes; last-good snapshot must remain untouched')

  const calendar = beijingCalendar(now)
  const quotes = {}
  for (const entry of validBars) {
    const lastDate = entry.bars[entry.bars.length - 1].date
    if (lastDate > calendar.date) {
      failures.push(`${entry.code}: 最后一根 ${lastDate} 晚于北京时间今天（${calendar.date}）`)
      continue
    }
    if (lastDate !== tradeDate) {
      // 停牌/停更等：保持 snapshotSchema 的「所有 quote.tradeDate 一致」约束，记 failures
      failures.push(`${entry.code}: 最后一根 ${lastDate} 不是最新交易日 ${tradeDate}`)
      continue
    }
    try {
      quotes[entry.code] = buildQuote(entry.code, entry.bars, {
        provider: entry.provider,
        adjustment: entry.adjustment,
        tradeDate,
        fetchedAt: generatedAt,
      })
    } catch (error) {
      failures.push(`${entry.code}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const report = buildSnapshot({ quotes, failures, universeSize: universe.length, tradeDate, generatedAt, now })

  if (write) {
    const absoluteOutput = resolve(outputPath)
    mkdirSync(dirname(absoluteOutput), { recursive: true })
    const tempPath = `${absoluteOutput}.tmp`
    writeFileSync(tempPath, JSON.stringify(report), 'utf8')
    renameSync(tempPath, absoluteOutput)
  }

  return { report, tradeDate, valid: Object.keys(quotes).length, failed: failures.length, outputPath }
}

async function main() {
  const started = Date.now()
  const result = await refreshSnapshot()
  console.log(
    `date=${result.tradeDate}, valid=${result.valid}, failed=${result.failed}, ` +
      `partial=${result.report.partial}, output=${result.outputPath}, elapsed=${Date.now() - started}ms`,
  )
  if (result.report.failures.length) {
    for (const failure of result.report.failures) console.log(`  failure: ${failure}`)
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main().catch((error) => {
    console.error(`刷新快照失败，未覆盖旧文件：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
