import type { LiveQuote, MarketPhase } from '@/types'

/**
 * 盘中行情层（data-live 实现）。
 * 契约定义见 src/types/index.ts 的 LiveQuote / MarketPhase / LiveStatus。
 *
 * 数据源与实测结论（2026-11-23，macOS / 本机网络）：
 *
 * 1) 主源：`https://push2.eastmoney.com/api/qt/ulist.np/get`
 *    - 请求参数：`secids=1.600519,0.000001&fields=f2,f3,f4,f5,f6,f12,f14,f15,f16,f17,f18,f124&fltt=2&invt=2`
 *    - 本机直连 push2 会被反爬拦截：curl 返回 `Empty reply from server`（exit 52），
 *      对真实回源 IP 直连返回 nginx 502；用只读代理取到的真实响应证明：
 *      **`fltt=2` 已经是小数（f2=1439.0、f3=-3.15、f18=1485.75），不需要再 /100**。
 *      但为防端点未来退化为未缩放的 ×100（f2=143900），parse 层仍保留
 *      normalizeEastmoneyPricing 防御性归一，见该函数注释。
 *    - 响应字段：f2 现价 / f3 涨跌幅(%) / f4 涨跌额 / f5 成交量(手) / f6 成交额(元) /
 *      f12 代码 / f14 名称 / f15 最高 / f16 最低 / f17 开盘 / f18 昨收 / f124 行情时间(秒级 Unix 时间戳)。
 *    - 响应头 `Access-Control-Allow-Origin: *`（Lead 实测；本机被反爬无法复测）。
 *    - 响应里的 `f124` 是「最后一次行情时间」，可能早于当前时间（盘后/延迟行情），
 *      因此 updatedAt 一律取 provider 时间，**绝不用 fetch 的 new Date() 伪造**。
 *
 * 2) 回退一：`push2.eastmoney.com/api/qt/stock/get`（单只，f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f169,f170）。
 *    只在批量源部分成功（说明网络本身通）且缺失数量很少时使用，避免失败时放大请求。
 *
 * 3) 回退二：`qt.gtimg.cn/q=sh600519,sz000001`（script 标签跨域执行，得到全局变量
 *    `v_sh600519="1~贵州茅台~600519~1439.00~..."`）。实测直连返回
 *    `Access-Control-Allow-Origin: *`，编码 GBK（script 标签由浏览器按 charset 解码，无需自行转码）。
 *    字段下标：3 现价 / 4 昨收 / 5 今开 / 6 成交量(手) / 30 时间(YYYYMMDDHHmmss，北京时间) /
 *    32 涨跌幅(%) / 33 最高 / 34 最低 / 37 成交额(万元)。
 *
 * 4) 反爬保护：单次 fetch 超时 9s，失败后 2 次指数退避（600ms / 1800ms），
 *    主源与备用源各自有 30s 全局冷却；并发调用同一批代码时复用同一个 in-flight Promise，
 *    一次 fetchLiveQuotes 只发 1 个批量请求（重试属于同一请求的容错，不拆批）。
 *
 * 5) 时段：getMarketPhase 是纯函数，用 Intl.DateTimeFormat + Asia/Shanghai 取北京时间；
 *    周末优先判 non-trading；法定节假日暂按工作日处理（限制见 getMarketPhase 注释）。
 *
 * 6) 陈旧：提供纯函数 isStale / rejectStaleQuotes。交易/竞价时段内超过 2 分钟未更新的报价
 *    不返回（记入 errors），非交易时段保留「最后一次行情」并带 closed/lunch/non-trading 相位。
 *    响应返回后按「返回时刻」重算相位（finalizeResponseQuotes），避免跨 11:30/15:00 边界时
 *    仍带请求开始时的旧 phase；latestQuoteUpdatedAt 供 hook 计算本批报价的真实行情时间；
 *    nextWakeAt 供相位看门精确排到 09:15/09:30/13:00/下一工作日，避免开盘后最多延迟 ~60s。
 */

const WEEKEND = new Set([0, 6])

const beijingFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function beijingClock(now: Date): { weekday: number; minutes: number } {
  const parts = beijingFormatter.formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  return { weekday: weekdayMap[get('weekday')] ?? 0, minutes: hour * 60 + minute }
}

const beijingPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

interface BeijingParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function beijingParts(now: Date): BeijingParts {
  const parts = beijingPartsFormatter.formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '0'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  }
}

/** 北京时间墙上时刻 → 绝对时刻（Asia/Shanghai 无夏令时，按 UTC+8 固定换算）。 */
function beijingDateAt(parts: BeijingParts, hour: number, minute: number, dayOffset = 0): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, hour - 8, minute, 0))
}

/**
 * A 股交易时段判断（纯函数）。
 *
 * 时段（北京时间）：preopen < 09:15 | auction 09:15–09:25 | preopen 09:25–09:30 |
 * trading 09:30–11:30 | lunch 11:30–13:00 | trading 13:00–15:00 | closed >= 15:00；周末 non-trading。
 *
 * 限制：暂不识别法定节假日/调休（节假日按工作日处理，会返回 preopen/closed 等相位但无行情），
 * 交易日历需后续用交易所日历数据补强；补强前上层应把「拿不到行情」当正常状态而不是错误。
 */
export function getMarketPhase(now: Date = new Date()): MarketPhase {
  const { weekday, minutes } = beijingClock(now)
  if (WEEKEND.has(weekday)) return 'non-trading'
  if (minutes < 9 * 60 + 15) return 'preopen'
  if (minutes < 9 * 60 + 25) return 'auction'
  if (minutes < 9 * 60 + 30) return 'preopen'
  if (minutes < 11 * 60 + 30) return 'trading'
  if (minutes < 13 * 60) return 'lunch'
  if (minutes < 15 * 60) return 'trading'
  return 'closed'
}

export const phaseLabels: Record<MarketPhase, string> = {
  preopen: '盘前',
  auction: '集合竞价',
  trading: '交易中',
  lunch: '午休',
  closed: '已收盘',
  'non-trading': '非交易日',
}

export function phaseLabel(phase: MarketPhase): string {
  return phaseLabels[phase]
}

export function isLivePhase(phase: MarketPhase): boolean {
  return phase === 'auction' || phase === 'trading'
}

/** 各时段轮询间隔（毫秒）：盘中/竞价 15s，盘前/午休 60s，收盘 5min，非交易日 10min。 */
export function nextPollDelay(phase: MarketPhase): number {
  switch (phase) {
    case 'trading':
    case 'auction':
      return 15_000
    case 'lunch':
    case 'preopen':
      return 60_000
    case 'closed':
      return 300_000
    default:
      return 600_000
  }
}

/**
 * 相位看门的下一次唤醒时刻（纯函数，按北京时间墙钟计算）。
 *
 * 与 nextPollDelay 的区别：nextPollDelay 是「轮询间隔」，这里返回「下一个应该醒来的绝对时刻」，
 * 用来避免开盘/午后开盘被整段间隔拖后（P1-4）：
 * - preopen 09:25–09:30 → 精确排到 09:30:00 开盘，而不是最多再等 ~60s；
 * - preopen 09:00–09:15 → 排到 09:15:00 集合竞价开始；
 * - lunch → 排到 13:00:00 下午开盘；
 * - closed / non-trading → 排到下一个工作日 09:15:00（周末跳过；节假日未识别，届时靠真实请求报错）。
 * - auction / trading → now + nextPollDelay（15s），供轮询循环复用。
 */
export function nextWakeAt(now: Date = new Date()): Date {
  const phase = getMarketPhase(now)
  const parts = beijingParts(now)
  const minutes = parts.hour * 60 + parts.minute
  switch (phase) {
    case 'auction':
    case 'trading':
      return new Date(now.getTime() + nextPollDelay(phase))
    case 'preopen':
      // 09:25–09:30：精确等到 09:30:00，避免开盘后首次行情/提醒最多晚 ~60s
      if (minutes >= 9 * 60 + 25) return beijingDateAt(parts, 9, 30)
      // 盘前其余时间：等到 09:15 集合竞价开始
      return beijingDateAt(parts, 9, 15)
    case 'lunch':
      return beijingDateAt(parts, 13, 0)
    default: {
      // closed / non-trading：等下一个工作日 09:15:00（周末跳过）
      let dayOffset = 1
      let candidate = beijingDateAt(parts, 9, 15, dayOffset)
      let guard = 0
      while (WEEKEND.has(beijingClock(candidate).weekday) && guard < 8) {
        dayOffset += 1
        candidate = beijingDateAt(parts, 9, 15, dayOffset)
        guard += 1
      }
      // 时钟回拨等异常时兜底，保证不会返回过去时刻造成忙等
      if (candidate.getTime() <= now.getTime()) return new Date(now.getTime() + nextPollDelay(phase))
      return candidate
    }
  }
}

/* ─────────────────────────────────────────────────────────────
 * 常量
 * ───────────────────────────────────────────────────────────── */

/** 超过该时长未更新的报价不得当作实时行情。 */
export const STALE_QUOTE_MS = 120_000

/** 单次 fetch 超时（8–10s 区间）。 */
export const FETCH_TIMEOUT_MS = 9_000

/** 失败后的指数退避延迟（2 次重试）。 */
export const RETRY_DELAYS_MS = [600, 1_800] as const

/** 主源/备用源连续失败后的全局冷却窗口。 */
export const LIVE_COOLDOWN_MS = 30_000

/** 备用源单只回退最多请求的数量，避免批量失败时放大请求。 */
const MAX_SINGLE_FALLBACK = 3

const EASTMONEY_BATCH_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const EASTMONEY_SINGLE_URL = 'https://push2.eastmoney.com/api/qt/stock/get'
const TENCENT_SCRIPT_URL = 'https://qt.gtimg.cn/q='

const EASTMONEY_BATCH_FIELDS = 'f2,f3,f4,f5,f6,f12,f14,f15,f16,f17,f18,f124'
const EASTMONEY_SINGLE_FIELDS = 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f169,f170'

/* ─────────────────────────────────────────────────────────────
 * 代码 / 市场映射
 * ───────────────────────────────────────────────────────────── */

/** 6 位 A 股/基金代码 → 东财 secid：5/6/9 开头归沪市（1），其余归深市/北交所（0）。 */
export function secidFor(code: string): string {
  return /^[569]/.test(code) ? `1.${code}` : `0.${code}`
}

/** 6 位代码 → 腾讯行情符号：5/6/9 沪市 sh，4/8 北交所 bj，其余 sz。 */
export function tencentSymbolFor(code: string): string {
  if (/^[569]/.test(code)) return `sh${code}`
  if (/^[48]/.test(code)) return `bj${code}`
  return `sz${code}`
}

/* ─────────────────────────────────────────────────────────────
 * 解析工具（纯函数）
 * ───────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed === '-' || trimmed === 'null') return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 东财时间字段（秒级 Unix 时间戳）→ ISO 字符串；无效返回 undefined（上层据此报错，不伪造时间）。 */
export function parseEastmoneyTimestamp(value: unknown): string | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  // 兼容毫秒级时间戳（> 1e11 视为毫秒）
  const millis = seconds > 100_000_000_000 ? seconds : seconds * 1000
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** 腾讯时间字段（YYYYMMDDHHmmss，北京时间 UTC+8）→ ISO 字符串；无效返回 undefined。 */
export function parseTencentTimestamp(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined
  const utcMillis = Date.UTC(year, month - 1, day, hour - 8, minute, second)
  const date = new Date(utcMillis)
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== month - 1) return undefined
  return date.toISOString()
}

export interface EastmoneyPricing {
  price: number
  prevClose: number
  open: number
  high: number
  low: number
  changePct: number
  volume: number
  amount: number
}

/**
 * 东财价格缩放防御性归一（纯函数）。
 *
 * 基准结论：`fltt=2` 返回的 f2/f3/f4/f15/f16/f17/f18 已是小数（实测 f2=1439.0），无需除以 100。
 * 但若端点参数失效返回 ×100（如 f2=143900），用「成交额 / (成交量 × 100) ≈ 均价」交叉校验：
 * - volume、amount 均为正时：price / 均价 > 20 ⇒ 判定为 ×100 并统一除以 100；
 * - 停牌（无成交量）时退化为 price > 10000 ⇒ 判定 ×100。
 * 涨跌幅与价格共用同一缩放（fltt 对所有字段生效），避免把 IPO 首日 +400% 误当 ×100 处理。
 */
export function normalizeEastmoneyPricing(raw: EastmoneyPricing): EastmoneyPricing {
  let scale = 1
  if (raw.price > 0 && raw.volume > 0 && raw.amount > 0) {
    const averagePrice = raw.amount / (raw.volume * 100)
    if (averagePrice > 0 && raw.price / averagePrice > 20) scale = 100
  }
  if (scale === 1 && raw.price > 10_000) scale = 100
  return {
    price: raw.price / scale,
    prevClose: raw.prevClose / scale,
    open: raw.open / scale,
    high: raw.high / scale,
    low: raw.low / scale,
    changePct: raw.changePct / scale,
    volume: raw.volume,
    amount: raw.amount,
  }
}

export interface SingleQuoteResult {
  quote?: LiveQuote
  error?: string
}

function buildQuote(
  code: string,
  pricing: EastmoneyPricing,
  updatedAt: string,
  phase: MarketPhase,
  provider: LiveQuote['provider'],
): LiveQuote {
  return {
    code,
    price: pricing.price,
    prevClose: pricing.prevClose,
    open: pricing.open,
    high: pricing.high,
    low: pricing.low,
    changePct: pricing.changePct,
    volume: pricing.volume,
    amount: pricing.amount,
    updatedAt,
    phase,
    provider,
  }
}

/** 东财单只 stock/get 字段 → 报价；缺价格/昨收/行情时间时返回 error（降级给上层记 errors）。 */
function quoteFromEastmoneyFields(fields: Record<string, unknown>, code: string, phase: MarketPhase): SingleQuoteResult {
  const price = readNumber(fields, 'f43')
  const prevClose = readNumber(fields, 'f60')
  if (price === undefined || price <= 0) return { error: '主源未返回有效现价（可能停牌）' }
  if (prevClose === undefined || prevClose <= 0) return { error: '主源缺少昨收价' }
  const updatedAt = parseEastmoneyTimestamp(fields.f86)
  if (!updatedAt) return { error: '主源缺少有效行情时间' }
  const rawChangePct = readNumber(fields, 'f170')
  const pricing = normalizeEastmoneyPricing({
    price,
    prevClose,
    open: readNumber(fields, 'f46') ?? price,
    high: readNumber(fields, 'f44') ?? price,
    low: readNumber(fields, 'f45') ?? price,
    changePct: rawChangePct ?? (price / prevClose - 1) * 100,
    volume: readNumber(fields, 'f47') ?? 0,
    amount: readNumber(fields, 'f48') ?? 0,
  })
  return { quote: buildQuote(code, pricing, updatedAt, phase, 'eastmoney') }
}

/** 东财批量 ulist.np 字段 → 报价。 */
function quoteFromEastmoneyBatchFields(fields: Record<string, unknown>, code: string, phase: MarketPhase): SingleQuoteResult {
  const price = readNumber(fields, 'f2')
  const prevClose = readNumber(fields, 'f18')
  if (price === undefined || price <= 0) return { error: '主源未返回有效现价（可能停牌）' }
  if (prevClose === undefined || prevClose <= 0) return { error: '主源缺少昨收价' }
  const updatedAt = parseEastmoneyTimestamp(fields.f124)
  if (!updatedAt) return { error: '主源缺少有效行情时间' }
  const rawChangePct = readNumber(fields, 'f3')
  const pricing = normalizeEastmoneyPricing({
    price,
    prevClose,
    open: readNumber(fields, 'f17') ?? price,
    high: readNumber(fields, 'f15') ?? price,
    low: readNumber(fields, 'f16') ?? price,
    changePct: rawChangePct ?? (price / prevClose - 1) * 100,
    volume: readNumber(fields, 'f5') ?? 0,
    amount: readNumber(fields, 'f6') ?? 0,
  })
  return { quote: buildQuote(code, pricing, updatedAt, phase, 'eastmoney') }
}

export interface LiveFetchResult {
  quotes: Record<string, LiveQuote>
  errors: Record<string, string>
}

/** 解析东财批量响应；缺失的代码写入 errors，交给上层走回退。 */
export function parseEastmoneyUlist(payload: unknown, codes: string[], phase: MarketPhase): LiveFetchResult {
  const requested = [...new Set(codes.map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code)))]
  const quotes: Record<string, LiveQuote> = {}
  const errors: Record<string, string> = {}

  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.diff)) {
    for (const code of requested) errors[code] = '主源响应缺少 data.diff'
    return { quotes, errors }
  }

  const requestedSet = new Set(requested)
  for (const item of payload.data.diff) {
    if (!isRecord(item)) continue
    const code = typeof item.f12 === 'string' ? item.f12.trim() : ''
    if (!requestedSet.has(code)) continue
    const { quote, error } = quoteFromEastmoneyBatchFields(item, code, phase)
    if (quote) quotes[code] = quote
    else if (error) errors[code] = error
  }

  for (const code of requested) {
    if (!quotes[code] && !errors[code]) errors[code] = '主源未返回该代码'
  }
  return { quotes, errors }
}

/** 解析东财单只 stock/get 响应。 */
export function parseEastmoneyStock(payload: unknown, code: string, phase: MarketPhase): SingleQuoteResult {
  if (!isRecord(payload) || !isRecord(payload.data)) return { error: '主源单只响应缺少 data' }
  return quoteFromEastmoneyFields(payload.data, code, phase)
}

/** 腾讯字段值数组 → 单只报价。 */
function quoteFromTencentValues(value: string, code: string, phase: MarketPhase): SingleQuoteResult {
  const fields = value.split('~')
  if (fields.length < 38) return { error: '备用源返回字段不完整' }
  const price = Number(fields[3])
  const prevClose = Number(fields[4])
  if (!Number.isFinite(price) || price <= 0) return { error: '备用源未返回有效现价（可能停牌）' }
  if (!Number.isFinite(prevClose) || prevClose <= 0) return { error: '备用源缺少昨收价' }
  const updatedAt = parseTencentTimestamp(fields[30])
  if (!updatedAt) return { error: '备用源缺少有效行情时间' }
  const rawChangePct = Number(fields[32])
  const amountFromWan = Number(fields[37]) * 10_000
  // fields[35] = "现价/成交量(手)/成交额(元)"，用于成交额兜底（fields[37] 为万元，四舍五入）
  const amountFromDetail = Number(fields[35]?.split('/')[2])
  const amount =
    Number.isFinite(amountFromWan) && amountFromWan > 0 ? amountFromWan : Number.isFinite(amountFromDetail) ? amountFromDetail : 0
  const pricing = normalizeEastmoneyPricing({
    price,
    prevClose,
    open: Number.isFinite(Number(fields[5])) ? Number(fields[5]) : price,
    high: Number.isFinite(Number(fields[33])) ? Number(fields[33]) : price,
    low: Number.isFinite(Number(fields[34])) ? Number(fields[34]) : price,
    changePct: Number.isFinite(rawChangePct) ? rawChangePct : (price / prevClose - 1) * 100,
    volume: Number.isFinite(Number(fields[6])) ? Number(fields[6]) : 0,
    amount,
  })
  return { quote: buildQuote(code, pricing, updatedAt, phase, 'tencent') }
}

/**
 * 解析腾讯 script 标签全局变量文本，例如：
 * `v_sh600519="1~贵州茅台~600519~1439.00~1485.75~..."`。
 * 腾讯返回 GBK，但 script 标签由浏览器按响应 charset 解码，若文本来自 fetch 需先自行解码。
 */
export function parseTencentScript(script: string, codes: string[], phase: MarketPhase): LiveFetchResult {
  const requested = [...new Set(codes.map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code)))]
  const requestedBySymbol = new Map<string, string>()
  for (const code of requested) requestedBySymbol.set(tencentSymbolFor(code), code)

  const values: Record<string, string> = {}
  const pattern = /\bv_([a-z]{2}\d{6})\s*=\s*"([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(script)) !== null) {
    if (requestedBySymbol.has(match[1])) values[match[1]] = match[2]
  }
  return parseTencentValues(values, requested, phase)
}

/** 解析已按 symbol 收集的腾讯字段值（script 全局变量读取后直接复用）。 */
export function parseTencentValues(values: Record<string, string>, codes: string[], phase: MarketPhase): LiveFetchResult {
  const quotes: Record<string, LiveQuote> = {}
  const errors: Record<string, string> = {}
  for (const code of codes) {
    const value = values[tencentSymbolFor(code)]
    if (typeof value !== 'string') {
      errors[code] = '备用源未返回该代码'
      continue
    }
    const { quote, error } = quoteFromTencentValues(value, code, phase)
    if (quote) quotes[code] = quote
    else if (error) errors[code] = error
  }
  return { quotes, errors }
}

/* ─────────────────────────────────────────────────────────────
 * 陈旧报价判断（纯函数，供 data / signals / ui 三层共用）
 * ───────────────────────────────────────────────────────────── */

/**
 * 报价是否陈旧：updatedAt 缺失/非法，或与 now 的偏差超过 maxAgeMs 都算陈旧。
 * 注意：非交易时段返回的报价 updatedAt 是最后一个交易时刻，按定义会「陈旧」，
 * 上层应结合 phase 判断——closed/lunch/non-trading 下陈旧是预期行为（收盘价）。
 */
export function isStale(
  quote: Pick<LiveQuote, 'updatedAt'> | undefined,
  now: Date = new Date(),
  maxAgeMs: number = STALE_QUOTE_MS,
): boolean {
  if (!quote || !quote.updatedAt) return true
  const timestamp = Date.parse(quote.updatedAt)
  if (!Number.isFinite(timestamp)) return true
  return Math.abs(now.getTime() - timestamp) > maxAgeMs
}

/** 过滤掉陈旧报价并把原因写入 errors（交易/竞价时段用于拒绝旧数据冒充实时）。 */
export function rejectStaleQuotes(
  quotes: Record<string, LiveQuote>,
  now: Date = new Date(),
  maxAgeMs: number = STALE_QUOTE_MS,
): LiveFetchResult {
  const fresh: Record<string, LiveQuote> = {}
  const errors: Record<string, string> = {}
  for (const [code, quote] of Object.entries(quotes)) {
    if (!isStale(quote, now, maxAgeMs)) {
      fresh[code] = quote
      continue
    }
    const parsed = quote.updatedAt ? Date.parse(quote.updatedAt) : NaN
    const diffMs = Number.isFinite(parsed) ? now.getTime() - parsed : undefined
    errors[code] =
      diffMs === undefined
        ? '行情缺少有效时间戳，拒绝作为实时报价'
        : diffMs < 0
          ? `行情时间戳晚于本机时间 ${Math.round(-diffMs / 1000)} 秒，拒绝作为实时报价`
          : `行情已 ${Math.round(diffMs / 1000)} 秒未更新，拒绝作为实时报价`
  }
  return { quotes: fresh, errors }
}

/** 本批报价中 provider 的最新行情时间（ISO 字符串最大值）；没有有效报价返回 undefined。 */
export function latestQuoteUpdatedAt(quotes: Record<string, LiveQuote>): string | undefined {
  let latest: string | undefined
  let latestMs = Number.NEGATIVE_INFINITY
  for (const quote of Object.values(quotes)) {
    const ms = Date.parse(quote.updatedAt)
    if (!Number.isFinite(ms)) continue
    if (ms > latestMs) {
      latestMs = ms
      latest = quote.updatedAt
    }
  }
  return latest
}

export interface FinalizedQuotes {
  phase: MarketPhase
  quotes: Record<string, LiveQuote>
  errors: Record<string, string>
}

/**
 * 响应返回后按「返回时刻」的墙钟重算 phase，并覆盖本批报价的 phase（P1-2）。
 *
 * 修复：请求开始时会快照一次 phase，若响应跨过 11:30 / 15:00 边界，
 * 旧实现会把 11:30:01 之后的报价仍标成 trading，提醒层可能误报一次。
 * 这里在响应返回后重新 getMarketPhase()，并只在「最终相位」是 auction/trading 时才做陈旧拒绝；
 * 非交易时段保留最后一次行情（phase=closed/lunch/non-trading），供上层标注收盘价。
 */
export function finalizeResponseQuotes(quotes: Record<string, LiveQuote>, now: Date = new Date()): FinalizedQuotes {
  const phase = getMarketPhase(now)
  const restamped: Record<string, LiveQuote> = {}
  for (const [code, quote] of Object.entries(quotes)) restamped[code] = { ...quote, phase }
  if (!isLivePhase(phase)) return { phase, quotes: restamped, errors: {} }
  const stale = rejectStaleQuotes(restamped, now)
  return { phase, quotes: stale.quotes, errors: stale.errors }
}

/**
 * 集合竞价降级文案（P1-3，纯函数）：
 * 腾讯字段 30 在 09:15–09:25 是否随竞价更新**未经实测**；若 stale 过滤拒掉全部报价，
 * 这里给每个缺失代码附加「集合竞价时间戳可能未更新」的明确原因，避免上层只看到「0 只报价」。
 */
export function annotateAuctionErrors(
  requested: string[],
  quotes: Record<string, LiveQuote>,
  errors: Record<string, string>,
): Record<string, string> {
  const next = { ...errors }
  for (const code of requested) {
    if (quotes[code]) continue
    next[code] = next[code]
      ? `${next[code]}（集合竞价：provider 时间戳可能尚未更新，该字段在竞价时段的行为未经实测）`
      : '集合竞价未获取到带有效时间戳的报价（provider 时间戳在竞价时段的行为未经实测）'
  }
  return next
}

/* ─────────────────────────────────────────────────────────────
 * 网络层：超时 / 重试 / 退避 / 全局冷却
 * ───────────────────────────────────────────────────────────── */

let eastmoneyCooldownUntil = 0
let tencentCooldownUntil = 0
let inflightKey = ''
let inflight: Promise<LiveFetchResult> | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function cooldownLeft(until: number, now: number): number {
  return Math.max(0, until - now)
}

/** 带超时 + 指数退避重试的 JSON 请求；全部失败返回 undefined。 */
async function requestJson(url: string, retryDelays: readonly number[]): Promise<unknown | undefined> {
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) await sleep(retryDelays[attempt - 1])
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json, text/plain, */*' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return (await response.json()) as unknown
    } catch {
      // 网络错误 / 超时 / HTTP 非 2xx：走下一次退避重试
    } finally {
      clearTimeout(timer)
    }
  }
  return undefined
}

/** 主源批量请求（含重试与冷却）。 */
async function fetchEastmoneyBatch(codes: string[], phase: MarketPhase): Promise<LiveFetchResult> {
  const now = Date.now()
  const cooling = cooldownLeft(eastmoneyCooldownUntil, now)
  if (cooling > 0) {
    return {
      quotes: {},
      errors: Object.fromEntries(codes.map((code) => [code, `主源冷却中，约 ${Math.ceil(cooling / 1000)}s 后可重试`])),
    }
  }
  const url = `${EASTMONEY_BATCH_URL}?secids=${codes.map(secidFor).join(',')}&fields=${EASTMONEY_BATCH_FIELDS}&fltt=2&invt=2`
  const payload = await requestJson(url, RETRY_DELAYS_MS)
  if (payload === undefined) {
    eastmoneyCooldownUntil = Date.now() + LIVE_COOLDOWN_MS
    return { quotes: {}, errors: Object.fromEntries(codes.map((code) => [code, '主源请求失败（网络/反爬），已进入冷却'])) }
  }
  const parsed = parseEastmoneyUlist(payload, codes, phase)
  if (Object.keys(parsed.quotes).length === 0) {
    // 响应可解析但一只都没拿到：视为反爬/参数失效，同样进入冷却，避免继续压测
    eastmoneyCooldownUntil = Date.now() + LIVE_COOLDOWN_MS
  } else {
    eastmoneyCooldownUntil = 0
  }
  return parsed
}

/** 回退一：单只 push2 stock/get（不重试，避免放大请求）。 */
async function fetchEastmoneySingle(code: string, phase: MarketPhase): Promise<SingleQuoteResult> {
  const payload = await requestJson(
    `${EASTMONEY_SINGLE_URL}?secid=${secidFor(code)}&fields=${EASTMONEY_SINGLE_FIELDS}&fltt=2&invt=2`,
    [],
  )
  if (payload === undefined) return { error: '单只回退请求失败' }
  return parseEastmoneyStock(payload, code, phase)
}

/**
 * 回退二：qt.gtimg.cn script 标签（浏览器跨域执行后读全局变量 v_shXXXXXX）。
 *
 * ⚠ P1-3 未验证风险：腾讯字段 30（时间 YYYYMMDDHHmmss）在集合竞价 09:15–09:25 是否随竞价更新，
 * 本机只盘后取过行情（2026-11-23 16:14–16:15），无法在竞价窗口实测。若竞价时段该字段停留在
 * 昨收/上一时点，live 相位的 stale 过滤会拒绝全部腾讯报价；上层不会静默「0 只报价」，
 * 而是给出「…行情已 N 秒未更新，拒绝作为实时报价（集合竞价：provider 时间戳可能尚未更新…）」的 errors。
 */
async function fetchTencentScript(codes: string[], phase: MarketPhase): Promise<LiveFetchResult> {
  const now = Date.now()
  const cooling = cooldownLeft(tencentCooldownUntil, now)
  if (cooling > 0) {
    return {
      quotes: {},
      errors: Object.fromEntries(codes.map((code) => [code, `备用源冷却中，约 ${Math.ceil(cooling / 1000)}s 后可重试`])),
    }
  }
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { quotes: {}, errors: Object.fromEntries(codes.map((code) => [code, '备用源仅支持浏览器 script 注入'])) }
  }

  const symbols = codes.map(tencentSymbolFor)
  const url = `${TENCENT_SCRIPT_URL}${symbols.join(',')}&_=${Date.now()}`
  const loaded = await new Promise<boolean>((resolve) => {
    const script = document.createElement('script')
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      script.onload = null
      script.onerror = null
      script.remove()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), FETCH_TIMEOUT_MS)
    script.src = url
    script.async = true
    script.onload = () => finish(true)
    script.onerror = () => finish(false)
    document.head.appendChild(script)
  })

  if (!loaded) {
    tencentCooldownUntil = Date.now() + LIVE_COOLDOWN_MS
    return { quotes: {}, errors: Object.fromEntries(codes.map((code) => [code, '备用源 script 加载失败，已进入冷却'])) }
  }

  const globalScope = window as unknown as Record<string, unknown>
  const values: Record<string, string> = {}
  for (const symbol of symbols) {
    const value = globalScope[`v_${symbol}`]
    if (typeof value === 'string') values[symbol] = value
  }
  const parsed = parseTencentValues(values, codes, phase)
  if (Object.keys(parsed.quotes).length === 0) tencentCooldownUntil = Date.now() + LIVE_COOLDOWN_MS
  else tencentCooldownUntil = 0
  return parsed
}

function mergeErrors(target: Record<string, string>, source: Record<string, string>): void {
  for (const [code, message] of Object.entries(source)) {
    target[code] = target[code] ? `${target[code]}；${message}` : message
  }
}

async function runFetch(requested: string[]): Promise<LiveFetchResult> {
  // 请求开始时只拿一次相位用于解析；响应返回后必须按返回时刻重算（P1-2，见 finalizeResponseQuotes）
  const requestPhase = getMarketPhase()
  let quotes: Record<string, LiveQuote> = {}
  const errors: Record<string, string> = {}

  // 1) 主源批量（1 个批量请求 + 重试）
  const batch = await fetchEastmoneyBatch(requested, requestPhase)
  Object.assign(quotes, batch.quotes)
  mergeErrors(errors, batch.errors)
  let missing = requested.filter((code) => !quotes[code])

  // 2) 回退一：仅批量「部分成功」时用单只接口补齐少量缺失（批量整体失败说明网络不通，直接跳备用源）
  const batchWorked = Object.keys(batch.quotes).length > 0
  if (missing.length > 0 && batchWorked && missing.length <= MAX_SINGLE_FALLBACK) {
    for (const code of missing) {
      const { quote, error } = await fetchEastmoneySingle(code, requestPhase)
      if (quote) {
        quotes[code] = quote
        delete errors[code]
      } else if (error) {
        mergeErrors(errors, { [code]: error })
      }
    }
    missing = requested.filter((code) => !quotes[code])
  }

  // 3) 回退二：腾讯 script 全局变量（一次请求覆盖所有剩余代码）
  if (missing.length > 0) {
    const fallback = await fetchTencentScript(missing, requestPhase)
    Object.assign(quotes, fallback.quotes)
    mergeErrors(errors, fallback.errors)
  }

  // 4) 响应返回后按墙钟重算相位；交易/竞价时段拒绝陈旧报价，绝不拿旧数据冒充实时（P1-2）
  const finalized = finalizeResponseQuotes(quotes)
  quotes = finalized.quotes
  mergeErrors(errors, finalized.errors)

  // 5) 集合竞价降级文案（P1-3）：腾讯字段 30 在竞价时段的行为未经实测；
  //    若 stale 过滤拒掉全部报价，必须明示原因，不能静默返回 0 只报价。
  if (finalized.phase === 'auction') {
    Object.assign(errors, annotateAuctionErrors(requested, quotes, errors))
  }

  // 6) 兜底：既没有报价也没有错误的代码一律给明确文案，禁止静默 0 只报价
  for (const code of requested) {
    if (quotes[code]) delete errors[code]
    else if (!errors[code]) errors[code] = '未获取到可用实时报价（主源与备用源均失败或数据陈旧）'
  }
  return { quotes, errors }
}

/**
 * 批量拉取盘中报价（主源 + 两级回退，自动超时/退避/冷却）。
 * - 同一批代码的并发调用复用同一个 in-flight Promise；
 * - 失败绝不返回旧数据：拿不到就给 errors；
 * - updatedAt 一律是 provider 的行情时间（东财 f124 / 腾讯字段 30），不做 fetch 时间覆盖；
 * - 非交易时段返回的报价保留最后一次行情时间，phase 为 closed/lunch/non-trading。
 */
export async function fetchLiveQuotes(codes: string[]): Promise<LiveFetchResult> {
  const requested = [...new Set(codes.map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code)))]
  if (requested.length === 0) return { quotes: {}, errors: {} }

  const key = requested.slice().sort().join(',')
  const now = Date.now()
  if (now < eastmoneyCooldownUntil && now < tencentCooldownUntil) {
    const waitSeconds = Math.ceil(cooldownLeft(Math.min(eastmoneyCooldownUntil, tencentCooldownUntil), now) / 1000)
    return {
      quotes: {},
      errors: Object.fromEntries(requested.map((code) => [code, `行情源冷却中，约 ${waitSeconds}s 后可重试`])),
    }
  }
  if (inflight && inflightKey === key) return inflight

  inflightKey = key
  const promise = runFetch(requested).finally(() => {
    if (inflight === promise) {
      inflight = null
      inflightKey = ''
    }
  })
  inflight = promise
  return promise
}
