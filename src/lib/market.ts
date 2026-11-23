import type { Bar, Quote } from '@/types'

const FIELDS_1 = 'f1,f2,f3,f4,f5,f6'
const FIELDS_2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'

interface EastmoneyResponse {
  rc: number
  data?: {
    code: string
    name: string
    klines?: string[]
  }
}

export function marketId(code: string) {
  return `${/^(5|6|9)/.test(code) ? 1 : 0}.${code}`
}

function endpoint(code: string) {
  const begin = new Date()
  begin.setDate(begin.getDate() - 240)
  const beg = begin.toISOString().slice(0, 10).replaceAll('-', '')
  const params = new URLSearchParams({
    secid: marketId(code),
    fields1: FIELDS_1,
    fields2: FIELDS_2,
    klt: '101',
    fqt: '1',
    beg,
    end: '20500101',
  })
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`
}

function parseResponse(payload: EastmoneyResponse, code: string): Quote {
  if (payload.rc !== 0 || !payload.data?.klines?.length) {
    throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
  }

  const bars: Bar[] = payload.data.klines.map((line) => {
    const [date, open, close, high, low, volume, amount, , changePct, , turnoverPct] = line.split(',')
    return {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: Number(amount),
      changePct: Number(changePct),
      turnoverPct: Number(turnoverPct),
    }
  }).filter((bar) => Number.isFinite(bar.close)).slice(-160)

  const latest = bars.at(-1)
  const previous = bars.at(-2)
  if (!latest || !previous) throw new Error('日线数据不足，请改用手动行情')

  return {
    code,
    price: latest.close,
    prevClose: previous.close,
    changePct: latest.changePct,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    volume: latest.volume,
    amount: latest.amount,
    tradeDate: latest.date,
    fetchedAt: new Date().toISOString(),
    source: 'auto',
    bars,
  }
}

async function fetchJson(code: string): Promise<Quote> {
  const controller = new AbortController()
  // 用全局 setTimeout（而非 window.setTimeout）以便该链路在 Node 单测里可被 mock fetch 覆盖
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetch(endpoint(code), { signal: controller.signal })
    if (!response.ok) throw new Error(`行情服务返回 ${response.status}`)
    return parseResponse(await response.json(), code)
  } finally {
    clearTimeout(timer)
  }
}

function fetchJsonp(code: string): Promise<Quote> {
  return new Promise((resolve, reject) => {
    const callback = `__quote_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const script = document.createElement('script')
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('行情请求超时，请稍后重试或手动录入'))
    }, 12000)

    const cleanup = () => {
      window.clearTimeout(timer)
      script.remove()
      delete (window as unknown as Record<string, unknown>)[callback]
    }

    ;(window as unknown as Record<string, unknown>)[callback] = (payload: EastmoneyResponse) => {
      try {
        resolve(parseResponse(payload, code))
      } catch (error) {
        reject(error)
      } finally {
        cleanup()
      }
    }
    script.onerror = () => {
      cleanup()
      reject(new Error('无法连接行情服务，请检查网络或手动录入'))
    }
    script.src = `${endpoint(code)}&cb=${callback}`
    document.head.appendChild(script)
  })
}

/* ─────────────────────────────────────────────────────────────
 * 第三级回退：腾讯日线（东财 push2his 被反爬 / 无 CORS 时的可用数据源）
 *
 * 实测（2026-11-24，本机）：
 *   GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,320,qfq
 *   → 200，`access-control-allow-origin: *`，body：
 *     { code:0, data: { sh600519: { qfqday: [[date,open,close,high,low,volume], ...], qt: {...} } } }
 *   当天最后一条为 2026-11-23 收盘（前复权），qt[symbol][30] 是北京时间实时快照时间。
 * 注意：日线的 volume 单位与东财一致为「手」，amount 该接口不提供（置 0）。
 * ───────────────────────────────────────────────────────────── */

const TENCENT_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
/** 腾讯日线单次请求超时（8–12s 区间）。 */
const TENCENT_KLINE_TIMEOUT_MS = 10_000
/** 失败后 1 次重试的间隔。 */
const TENCENT_KLINE_RETRY_DELAY_MS = 500
/** 至少需要的日线根数（否则策略指标无法计算）。 */
const MIN_KLINE_BARS = 21
/** 最多保留的日线根数。 */
const MAX_KLINE_BARS = 160

/** 与 marketId 相同的沪市规则：5/6/9 开头 → sh，其余 → sz（159 开头的 ETF 属于深市）。 */
export function tencentKlineSymbol(code: string): string {
  return `${/^(5|6|9)/.test(code) ? 'sh' : 'sz'}${code}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const beijingCalendarFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function beijingCalendar(now: Date): { date: string; weekday: number; minutes: number } {
  const parts = beijingCalendarFormatter.formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: weekdayMap[get('weekday')] ?? 0,
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  }
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function weekdayOfDate(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

/** 上一个工作日（不含当天；周末跳过）。 */
function previousTradingDate(date: string): string {
  let candidate = shiftDate(date, -1)
  let guard = 0
  while ((weekdayOfDate(candidate) === 0 || weekdayOfDate(candidate) === 6) && guard < 8) {
    candidate = shiftDate(candidate, -1)
    guard += 1
  }
  return candidate
}

/** 无 qt 实时快照时的兜底「最新交易日」：按北京时间工作日估算（节假日未识别，注释已说明限制）。 */
function latestTradingDateByCalendar(now: Date): string {
  const { date, weekday, minutes } = beijingCalendar(now)
  const isTradingDay = weekday >= 1 && weekday <= 5
  // 交易日 09:30 前当日 bar 通常尚未生成；盘中/收盘后按当天
  if (!isTradingDay || minutes < 9 * 60 + 30) return previousTradingDate(date)
  return date
}

/** 从腾讯 qt 实时快照取「最新交易日」：qt[symbol][30] = YYYYMMDDHHmmss（北京时间）。 */
function tencentRealtimeTradingDate(node: Record<string, unknown>, symbol: string): string | undefined {
  const qt = node.qt
  if (!isRecord(qt)) return undefined
  const snapshot = qt[symbol]
  if (!Array.isArray(snapshot) || snapshot.length <= 30) return undefined
  const raw = snapshot[30]
  if (typeof raw !== 'string') return undefined
  const match = /^(\d{4})(\d{2})(\d{2})\d{6}$/.exec(raw.trim())
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined
}

/**
 * 解析腾讯日线响应（纯函数，便于离线单测）。
 *
 * 输入：`data.<symbol>.qfqday = [[date, open, close, high, low, volume], ...]`
 * 输出：Quote（provider='Tencent kline (qfq)'，adjustment='前复权'，amount=0）。
 *
 * 校验（不满足则抛中文错误，交给上层降级）：
 * - 至少 21 根；日期严格递增；取最后 160 根；
 * - 每根 changePct = (close / 前一根 close - 1) * 100，首根无前收记 0；
 * - 最后一根日期必须等于「最新交易日」：优先用响应内 qt 实时快照时间推导（节假日也适用），
 *   缺失时按北京时间工作日推算。盘前/盘中腾讯日线可能只到上一交易日，因此允许滞后一个交易日；
 *   再旧视为数据异常拒绝。
 */
export function parseTencentKline(payload: unknown, code: string, now: Date = new Date()): Quote {
  if (!isRecord(payload) || (payload.code !== undefined && payload.code !== 0) || !isRecord(payload.data)) {
    throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
  }
  const symbol = tencentKlineSymbol(code)
  const node = payload.data[symbol]
  if (!isRecord(node)) throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
  const rows = Array.isArray(node.qfqday) ? node.qfqday : Array.isArray(node.day) ? node.day : undefined
  if (!rows || rows.length === 0) throw new Error('暂未返回有效日线，请检查代码或改用手动行情')

  const bars: Bar[] = []
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
    const [date, open, close, high, low, volume] = row as unknown[]
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
    }
    const bar: Bar = {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: 0,
      changePct: 0,
    }
    if (![bar.open, bar.close, bar.high, bar.low].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
    }
    bars.push(bar)
  }

  if (bars.length < MIN_KLINE_BARS) {
    throw new Error(`日线数据不足（仅 ${bars.length} 个交易日，至少需要 ${MIN_KLINE_BARS} 个），请改用手动行情`)
  }
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].date <= bars[index - 1].date) throw new Error('日线日期顺序异常，请稍后重试或改用手动行情')
  }
  for (let index = 1; index < bars.length; index += 1) {
    const previousClose = bars[index - 1].close
    bars[index].changePct = previousClose > 0 ? (bars[index].close / previousClose - 1) * 100 : 0
  }

  const latestTradingDate = tencentRealtimeTradingDate(node, symbol) ?? latestTradingDateByCalendar(now)
  const lastDate = bars[bars.length - 1].date
  // 允许滞后一个交易日：盘前/盘中腾讯日线可能尚未补今日 bar
  const acceptableDates = new Set([latestTradingDate, previousTradingDate(latestTradingDate)])
  if (!acceptableDates.has(lastDate)) {
    throw new Error(`日线数据不是最新交易日（最后 ${lastDate}，最新 ${latestTradingDate}），请稍后重试或改用手动行情`)
  }

  const kept = bars.slice(-MAX_KLINE_BARS)
  const latest = kept[kept.length - 1]
  const previous = kept[kept.length - 2]
  return {
    code,
    price: latest.close,
    prevClose: previous.close,
    changePct: latest.changePct,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    volume: latest.volume,
    amount: latest.amount,
    tradeDate: latest.date,
    fetchedAt: now.toISOString(),
    source: 'auto',
    provider: 'Tencent kline (qfq)',
    adjustment: '前复权',
    bars: kept,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 腾讯日线请求：超时 10s + 1 次重试；失败抛错，由 fetchQuote 决定最终错误文案。 */
async function fetchTencentKlineQuote(code: string): Promise<Quote> {
  const symbol = tencentKlineSymbol(code)
  const url = `${TENCENT_KLINE_URL}?param=${symbol},day,,,320,qfq`
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(TENCENT_KLINE_RETRY_DELAY_MS)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TENCENT_KLINE_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json, text/plain, */*' },
      })
      if (!response.ok) throw new Error(`行情服务返回 ${response.status}`)
      return parseTencentKline(await response.json(), code)
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('腾讯日线请求失败，请检查网络或手动录入')
}

/* ─────────────────────────────────────────────────────────────
 * 第四级回退：新浪日线 JSONP（腾讯 fqkline 返回 501 WAF 时的可用数据源）
 *
 * 实测（2026-11-24 07:3x，本机）：
 *   - Node JSON：https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData
 *       ?symbol=sh600519&scale=240&ma=no&datalen=320
 *     → 200，`[{ "day","open","high","low","close","volume" }, ...]`；无 CORS 头（浏览器 fetch 不可用）。
 *   - 浏览器 JSONP：https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20<name>=/CN_MarketDataService.getKLineData
 *       ?symbol=sh600519&scale=240&ma=no&datalen=320
 *     → 一段安全注释前缀（含 location 跳转）后跟 `var <name>=([...]);`，script 标签可执行、全局变量名可控。
 *
 * **复权口径实测（2026-11-24）**：新浪此接口是「不复权」原始价，不是前复权。
 *   600519 重叠 320 根对比腾讯 qfq：2025-07-29 腾讯 1387.019 / 新浪 1439.000（比值 0.9639），
 *   2026-03-16 腾讯 1432.156 / 新浪 1460.180（0.9808），2026-11-23 两者均 1439.000（比值 1），
 *   差异随除权除息累积 → 新浪为不复权。故 provider='Sina kline (不复权)'、adjustment='不复权（tushare 未验证）'，
 *   绝不冒充前复权。
 *   另：新浪 volume 单位为「股」，统一换算为「手」（÷100 取整）以对齐东财/腾讯口径；amount 不提供置 0。
 * ───────────────────────────────────────────────────────────── */

const SINA_JSONP_ENDPOINT = 'https://quotes.sina.cn/cn/api/jsonp_v2.php'
const SINA_DATALEN = 320
/** 新浪 JSONP 单次超时（10s）。 */
const SINA_JSONP_TIMEOUT_MS = 10_000
const SINA_PROVIDER = 'Sina kline (不复权)'
const SINA_ADJUSTMENT = '不复权（tushare 未验证）'

function sinaSymbol(code: string): string {
  return tencentKlineSymbol(code)
}

/** 新浪 JSONP 地址（变量名随机，避免并发覆盖全局）；导出便于调试/单测断言。 */
export function sinaJsonpUrl(code: string, variableName: string): string {
  return `${SINA_JSONP_ENDPOINT}/var%20${encodeURIComponent(variableName)}=/CN_MarketDataService.getKLineData?symbol=${sinaSymbol(code)}&scale=240&ma=no&datalen=${SINA_DATALEN}`
}

/**
 * 解析新浪 JSONP 包裹文本，提取 `var <name>=(...);` 的数组（纯函数，用于离线测试/调试）。
 * 浏览器路径不需要解析文本（script 执行后直接读全局变量），此函数用于验证包裹格式。
 */
export function extractSinaJsonpPayload(scriptText: string, variableName: string): unknown {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`var\\s+${escaped}\\s*=\\s*\\(([\\s\\S]*)\\)\\s*;?\\s*$`).exec(scriptText.trim())
  if (!match) throw new Error('新浪 JSONP 包裹格式非法')
  return JSON.parse(match[1])
}

/**
 * 解析新浪日线数组 → Quote（纯函数，便于离线单测）。
 *
 * 输入：`[{ day, open, high, low, close, volume }, ...]`（按日期升序；volume 单位「股」）
 * 校验：≥21 根、日期严格递增、最后一根 = 最新交易日（按北京时间工作日推算，允许滞后 1 个交易日）、取最后 160 根；
 * value: amount=0、volume 换算成「手」、changePct 按前收（首根 0）。
 */
export function parseSinaKline(payload: unknown, code: string, now: Date = new Date()): Quote {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
  }
  const bars: Bar[] = []
  for (const row of payload) {
    if (!isRecord(row)) throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
    const date = typeof row.day === 'string' ? row.day : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
    const volumeShares = Number(row.volume)
    const bar: Bar = {
      date,
      open: Number(row.open),
      close: Number(row.close),
      high: Number(row.high),
      low: Number(row.low),
      // 新浪 volume 单位是「股」，东财/腾讯是「手」；÷100 取整以保持 Quote.volume 口径一致
      volume: Number.isFinite(volumeShares) && volumeShares >= 0 ? Math.round(volumeShares / 100) : NaN,
      amount: 0,
      changePct: 0,
    }
    if (![bar.open, bar.close, bar.high, bar.low].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
    }
    if (!Number.isFinite(bar.volume) || !Number.isFinite(bar.high) || bar.high < Math.max(bar.open, bar.close, bar.low)) {
      throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
    }
    if (bar.low > Math.min(bar.open, bar.close)) throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
    bars.push(bar)
  }

  if (bars.length < MIN_KLINE_BARS) {
    throw new Error(`日线数据不足（仅 ${bars.length} 个交易日，至少需要 ${MIN_KLINE_BARS} 个），请改用手动行情`)
  }
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].date <= bars[index - 1].date) throw new Error('日线日期顺序异常，请稍后重试或改用手动行情')
  }
  for (let index = 1; index < bars.length; index += 1) {
    const previousClose = bars[index - 1].close
    bars[index].changePct = previousClose > 0 ? (bars[index].close / previousClose - 1) * 100 : 0
  }

  const latestTradingDate = latestTradingDateByCalendar(now)
  const lastDate = bars[bars.length - 1].date
  const acceptableDates = new Set([latestTradingDate, previousTradingDate(latestTradingDate)])
  if (!acceptableDates.has(lastDate)) {
    throw new Error(`日线数据不是最新交易日（最后 ${lastDate}，最新 ${latestTradingDate}），请稍后重试或改用手动行情`)
  }

  const kept = bars.slice(-MAX_KLINE_BARS)
  const latest = kept[kept.length - 1]
  const previous = kept[kept.length - 2]
  return {
    code,
    price: latest.close,
    prevClose: previous.close,
    changePct: latest.changePct,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    volume: latest.volume,
    amount: latest.amount,
    tradeDate: latest.date,
    fetchedAt: now.toISOString(),
    source: 'auto',
    provider: SINA_PROVIDER,
    adjustment: SINA_ADJUSTMENT,
    bars: kept,
  }
}

/** 新浪 JSONP script 注入：随机全局变量名 → onload 读值并清理 → 10s 超时。 */
async function fetchSinaJsonpQuote(code: string): Promise<Quote> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw new Error('新浪日线仅支持浏览器 script 注入')
  }
  const variableName = `__sina_kline_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const globalScope = window as unknown as Record<string, unknown>
  let loaded = false
  try {
    loaded = await new Promise<boolean>((resolve) => {
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
      const timer = setTimeout(() => finish(false), SINA_JSONP_TIMEOUT_MS)
      script.src = sinaJsonpUrl(code, variableName)
      script.async = true
      script.onload = () => finish(true)
      script.onerror = () => finish(false)
      document.head.appendChild(script)
    })
    if (!loaded) throw new Error('新浪日线请求超时或加载失败')
    return parseSinaKline(globalScope[variableName], code)
  } finally {
    // script 里的 `var <name>=...` 会在 window 上创建**不可配置**属性，严格模式下 delete 会抛 TypeError！
    // 用 try/delete + 赋值兜底清掉引用（属性名随机且唯一，残留 undefined 属性无副作用）。
    try {
      delete globalScope[variableName]
    } catch {
      globalScope[variableName] = undefined
    }
  }
}

export async function fetchQuote(code: string): Promise<Quote> {
  if (!/^\d{6}$/.test(code)) throw new Error('请输入 6 位股票或 ETF 代码')
  let eastmoneyError: unknown
  try {
    return await fetchJson(code)
  } catch (error) {
    eastmoneyError = error
  }
  try {
    return await fetchJsonp(code)
  } catch (error) {
    eastmoneyError = error
  }
  // 第三级回退：腾讯日线（此前实测 CORS 全开；2026-11-24 07:44 起本机被 501 WAF 拦截）
  try {
    return await fetchTencentKlineQuote(code)
  } catch {
    // 第四级回退：新浪日线 JSONP（不复权，见上方实测注释）
    try {
      return await fetchSinaJsonpQuote(code)
    } catch {
      // 四级全失败：保留东财链路的原中文错误文案
      throw eastmoneyError instanceof Error ? eastmoneyError : new Error('行情获取失败，请检查网络或手动录入')
    }
  }
}

export async function fetchQuotes(
  codes: string[],
  onProgress?: (completed: number, total: number) => void,
) {
  const results: Record<string, Quote> = {}
  const errors: Record<string, string> = {}
  let cursor = 0
  let completed = 0
  const workers = Array.from({ length: Math.min(4, codes.length) }, async () => {
    while (cursor < codes.length) {
      const code = codes[cursor++]
      try {
        results[code] = await fetchQuote(code)
      } catch (error) {
        errors[code] = error instanceof Error ? error.message : '行情获取失败'
      } finally {
        completed += 1
        onProgress?.(completed, codes.length)
      }
    }
  })
  await Promise.all(workers)
  return { results, errors }
}
