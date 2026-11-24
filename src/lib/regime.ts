import type { Bar } from '@/types'

/**
 * 市场状态（regime）计算层。
 *
 * 目的：给 UI 提供「牛 / 震荡 / 熊」判定 + 置信度 + 中文证据，用于徽标与主题配色。
 * 契约（UI 按此实现，不得改字段名）：
 *   MarketRegime / RegimeInfo / computeRegime(input) / loadRegime(watchlistBars)
 *
 * 数据口径：
 * - 只用日线收盘价；所有指标只用「当日及之前」的 bar（computeRegime 支持可选 asOf 截断；
 *   未传 asOf 时以输入序列最后一天为当日，天然无未来函数）。
 * - 输入会被清洗：丢弃非法 bar、按日期升序、同日去重（保留最后一条），不会因为乱序而偷看未来。
 *
 * 评分（provisional，等 regime-research 结论后再微调阈值；所有阈值集中在本文件常量区）：
 *   7 个条件各 +1：
 *     ① close > MA20   ② close > MA60   ③ close > MA120
 *     ④ MA20 > MA60    ⑤ MA60 近 20 日斜率 > 0
 *     ⑥ 距 250 日高点回撤 < 15%          ⑦ 宽度（close>MA20 占比）≥ 60%
 *   bull：score ≥ 5 且 close > MA60
 *   bear：score ≤ 2 或 (close < MA60 且回撤 ≥ 20%)
 *   其余：range
 *
 * confidence 公式（0-100，可解释）：
 *   每个条件把「实际值 vs 阈值」的偏离按该指标的带宽归一为 m_i ∈ [-1, 1]：
 *     价格 vs 均线： (close/MA - 1) / 2%       （上限 ±1）
 *     MA20 vs MA60：(MA20/MA60 - 1) / 1%
 *     MA60 斜率：   (MA60/20日前MA60 - 1)*100 / 2（单位：百分点）
 *     回撤：        (回撤% + 15) / 10（回撤 -15% 记 0，-5% 记 +1，-25% 记 -1）
 *     宽度：        (宽度% - 60) / 20
 *   alignment = mean(m_i) ∈ [-1, 1]
 *   bull：confidence = 50 + 50 × alignment
 *   bear：confidence = 50 − 50 × alignment
 *   range：confidence = 100 × (1 − |alignment|)（多空越均衡、震荡越可信）
 *   最后 clamp 到 [0, 100] 并保留 1 位小数。
 *
 * 仅宽度（沪深300 日线缺失/不足 120 根）时的替代规则：
 *   宽度 ≥ 60% → bull；≤ 40% → bear；其余 range。
 *   confidence 用同一 alignment 思路：alignment = (宽度% - 50) / 50。
 */

/* ─────────────────────────────────────────────────────────────
 * 契约类型
 * ───────────────────────────────────────────────────────────── */

/**
 * 文案语言（可选，默认 'zh'；由 UI 传入，避免 import i18n.ts 造成循环依赖）。
 * 只影响 evidence / error 文案，数值、百分比、日期格式中英文完全一致。
 */
export type RegimeLang = 'zh' | 'en'

export type MarketRegime = 'bull' | 'range' | 'bear'

export interface RegimeInfo {
  regime: MarketRegime
  confidence: number
  asOf: string
  source: 'index' | 'breadth'
  evidence: string[]
  breadthPct?: number
}

export interface RegimeInput {
  indexBars?: Bar[]
  watchlist: Bar[][]
  /** 可选：只用该日期（含）之前的 bar，防未来函数；缺省以各序列最后一天为当日。 */
  asOf?: string
  /** 可选文案语言（默认 'zh'）。 */
  lang?: RegimeLang
}

/* ─────────────────────────────────────────────────────────────
 * 阈值（provisional；集中暴露便于研究结论落地后微调/测试引用）
 * ───────────────────────────────────────────────────────────── */

export const REGIME_MA_SHORT = 20
export const REGIME_MA_MID = 60
export const REGIME_MA_LONG = 120
export const REGIME_SLOPE_LOOKBACK = 20
export const REGIME_HIGH_LOOKBACK = 250
/** 沪深300 日线少于该根数时不用 index 判定，退回宽度。 */
export const REGIME_MIN_INDEX_BARS = 120
/** 回撤「安全」条件：回撤 < 15%（即 drawdownPct > -15）。 */
export const REGIME_DRAWDOWN_SAFE = 15
/** 熊市强条件：回撤 ≥ 20%。 */
export const REGIME_DRAWDOWN_BEAR = 20
/** 宽度牛市阈值：占比 ≥ 60%。 */
export const REGIME_BREADTH_BULL = 60
/** 仅宽度模式下的熊市阈值：占比 ≤ 40%。 */
export const REGIME_BREADTH_BEAR = 40
export const REGIME_BULL_MIN_SCORE = 5
export const REGIME_BEAR_MAX_SCORE = 2

/** 网络请求超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 10_000
const TENCENT_INDEX_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000300,day,,,320,qfq'
const SINA_INDEX_URL =
  'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh000300&scale=240&ma=no&datalen=320'
const INDEX_SYMBOL = 'sh000300'
const CACHE_KEY = 'katestock-market-regime-v1'
const CACHE_VERSION = 1

/* ─────────────────────────────────────────────────────────────
 * 内部工具
 * ───────────────────────────────────────────────────────────── */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function clamp(value: number, min = -1, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 数字展示：保留至多 2 位小数并去掉多余的 0。 */
function fmt(value: number, digits = 2): string {
  return String(Number(value.toFixed(digits)))
}

/** 百分比展示（入参是比例，如 0.0123 → "1.23%"）。 */
function pct(ratio: number, digits = 2): string {
  const value = Number((ratio * 100).toFixed(digits))
  return `${value > 0 ? '+' : ''}${value}%`
}

/** 清洗日线：丢弃非法 bar、按日期升序、同日去重（保留最后出现的一条）。 */
export function normalizeBars(bars: Bar[] | undefined): Bar[] {
  if (!Array.isArray(bars) || bars.length === 0) return []
  const byDate = new Map<string, Bar>()
  for (const bar of bars) {
    if (!bar || typeof bar.date !== 'string' || !DATE_PATTERN.test(bar.date)) continue
    if (!isFinitePositive(bar.close)) continue
    byDate.set(bar.date, bar)
  }
  return [...byDate.values()].sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0))
}

function closesOf(bars: Bar[]): number[] {
  return bars.map((bar) => bar.close)
}

/** 以 endExclusive 为终点、向前 period 根的均值；数据不足返回 undefined。 */
function smaAt(closes: number[], period: number, endExclusive: number = closes.length): number | undefined {
  if (!Number.isInteger(period) || period <= 0) return undefined
  const end = Math.min(Math.max(endExclusive, 0), closes.length)
  const start = end - period
  if (start < 0) return undefined
  let sum = 0
  for (let index = start; index < end; index += 1) sum += closes[index]
  return sum / period
}

export interface BreadthResult {
  pct?: number
  above: number
  total: number
}

/**
 * 宽度：watchlist 中「收盘 > MA20」的标的占比（0-100）。
 * 分母只统计有 ≥20 根有效日线的标的；全部不足则 pct 为 undefined。
 */
export function computeBreadth(watchlist: Bar[][]): BreadthResult {
  let above = 0
  let total = 0
  for (const series of watchlist ?? []) {
    const bars = normalizeBars(series)
    if (bars.length < REGIME_MA_SHORT) continue
    const ma20 = smaAt(closesOf(bars), REGIME_MA_SHORT)
    if (ma20 === undefined) continue
    total += 1
    if (bars[bars.length - 1].close > ma20) above += 1
  }
  if (total === 0) return { above: 0, total: 0 }
  return { pct: (above / total) * 100, above, total }
}

/** 最新日期（跨多条序列取最大值）；无数据返回 ''. */
function latestDate(seriesList: Bar[][]): string {
  let latest = ''
  for (const series of seriesList) {
    const bars = normalizeBars(series)
    const date = bars.at(-1)?.date
    if (date && date > latest) latest = date
  }
  return latest
}

/* ─────────────────────────────────────────────────────────────
 * 文案（zh / en）：只影响 evidence / error；数值与百分比格式完全一致
 * ───────────────────────────────────────────────────────────── */

interface RegimeMessages {
  regimeLabel: (regime: MarketRegime) => string
  index: {
    closeMa20: (close: string, ma20: string, diff: string) => string
    closeMa60: (ma60: string, diff: string, ma60Diff: string) => string
    closeMa120: (ma120: string, diff: string) => string
    slope: (lookback: number, slopePct: string, up: boolean) => string
    drawdown: (lookback: number, high: string, drawdown: string) => string
    breadth: (pct: string, above: number, total: number, threshold: number) => string
    breadthUnavailable: string
    score: (score: number, total: number, label: string, alignment: string, confidence: string) => string
  }
  breadth: {
    indexMissing: string
    breadthLine: (pct: string, above: number, total: number, bull: number, bear: number) => string
    score: (label: string, alignment: string, confidence: string) => string
    noDataIndex: string
    noDataBreadth: string
  }
  fetchError: (tencentReason: string, sinaReason: string) => string
  parse: {
    tencentMissingSymbol: string
    tencentMissingBars: string
    tencentIncomplete: string
    tencentDate: string
    sinaNotArray: string
    sinaFormat: string
    sinaDate: string
  }
}

const MESSAGES: Record<RegimeLang, RegimeMessages> = {
  zh: {
    regimeLabel: (regime) => (regime === 'bull' ? '强势（牛）' : regime === 'bear' ? '弱势（熊）' : '震荡'),
    index: {
      closeMa20: (close, ma20, diff) => `沪深300 收盘 ${close}，MA20 ${ma20}（${diff}）`,
      closeMa60: (ma60, diff, ma60Diff) => `收盘 vs MA60 ${ma60}（${diff}）；MA20 vs MA60（${ma60Diff}）`,
      closeMa120: (ma120, diff) => `收盘 vs MA120 ${ma120}（${diff}）`,
      slope: (lookback, slopePct, up) => `MA60 近 ${lookback} 日斜率 ${slopePct}%（${up ? '上行' : '下行'}）`,
      drawdown: (lookback, high, drawdown) => `距 ${lookback} 日高点 ${high} 回撤 ${drawdown}%`,
      breadth: (pct, above, total, threshold) => `宽度 ${pct}%（${above}/${total} 只收盘 > MA20，阈值 ≥${threshold}%）`,
      breadthUnavailable: '宽度不可用（没有 ≥20 根日线的标的）',
      score: (score, total, label, alignment, confidence) => `评分 ${score}/${total} → 判定${label}；alignment ${alignment}，confidence ${confidence}`,
    },
    breadth: {
      indexMissing: '沪深300 日线缺失或不足 120 根，改用宽度判定',
      breadthLine: (pct, above, total, bull, bear) =>
        `宽度 ${pct}%（${above}/${total} 只收盘 > MA20；阈值 ≥${bull}% 牛 / ≤${bear}% 熊）`,
      score: (label, alignment, confidence) => `判定${label}；alignment ${alignment}，confidence ${confidence}`,
      noDataIndex: '沪深300 日线缺失或不足 120 根',
      noDataBreadth: '宽度不可用（没有 ≥20 根日线的标的），暂按震荡处理',
    },
    fetchError: (tencentReason, sinaReason) => `沪深300 日线获取失败（腾讯：${tencentReason}；新浪：${sinaReason}）`,
    parse: {
      tencentMissingSymbol: '腾讯响应缺少 sh000300',
      tencentMissingBars: '腾讯响应缺少 sh000300 日线',
      tencentIncomplete: '腾讯指数日线字段不完整',
      tencentDate: '腾讯指数日线日期非法',
      sinaNotArray: '新浪响应不是有效日线数组',
      sinaFormat: '新浪指数日线格式非法',
      sinaDate: '新浪指数日线日期非法',
    },
  },
  en: {
    regimeLabel: (regime) => (regime === 'bull' ? 'Bullish (bull)' : regime === 'bear' ? 'Bearish (bear)' : 'Neutral (range)'),
    index: {
      closeMa20: (close, ma20, diff) => `CSI 300 close ${close} vs MA20 ${ma20} (${diff})`,
      closeMa60: (ma60, diff, ma60Diff) => `Close vs MA60 ${ma60} (${diff}); MA20 vs MA60 (${ma60Diff})`,
      closeMa120: (ma120, diff) => `Close vs MA120 ${ma120} (${diff})`,
      slope: (lookback, slopePct, up) => `MA60 ${lookback}-day slope ${slopePct}% (${up ? 'rising' : 'falling'})`,
      drawdown: (lookback, high, drawdown) => `${lookback}-day high ${high}, drawdown ${drawdown}%`,
      breadth: (pct, above, total, threshold) => `Breadth ${pct}% (${above}/${total} closes above MA20, threshold >=${threshold}%)`,
      breadthUnavailable: 'Breadth unavailable (no symbol with >=20 daily bars)',
      score: (score, total, label, alignment, confidence) => `Score ${score}/${total} -> ${label}; alignment ${alignment}, confidence ${confidence}`,
    },
    breadth: {
      indexMissing: 'CSI 300 daily bars missing or fewer than 120; using breadth only',
      breadthLine: (pct, above, total, bull, bear) =>
        `Breadth ${pct}% (${above}/${total} closes above MA20; thresholds >=${bull}% bull / <=${bear}% bear)`,
      score: (label, alignment, confidence) => `Regime ${label}; alignment ${alignment}, confidence ${confidence}`,
      noDataIndex: 'CSI 300 daily bars missing or fewer than 120',
      noDataBreadth: 'Breadth unavailable (no symbol with >=20 daily bars); treated as range',
    },
    fetchError: (tencentReason, sinaReason) =>
      `CSI 300 daily bars fetch failed (Tencent: ${tencentReason}; Sina: ${sinaReason})`,
    parse: {
      tencentMissingSymbol: 'Tencent response is missing sh000300',
      tencentMissingBars: 'Tencent response has no sh000300 daily bars',
      tencentIncomplete: 'Tencent index daily bar fields are incomplete',
      tencentDate: 'Tencent index daily bar has an invalid date',
      sinaNotArray: 'Sina response is not a valid daily-bar array',
      sinaFormat: 'Sina index daily bar has an invalid format',
      sinaDate: 'Sina index daily bar has an invalid date',
    },
  },
}

function messagesFor(lang: RegimeLang | undefined): RegimeMessages {
  return lang === 'en' ? MESSAGES.en : MESSAGES.zh
}

/** 可选 asOf 截断：只用 asOf 当天及之前的 bar。 */
function truncateAt(bars: Bar[], asOf?: string): Bar[] {
  if (!asOf || !DATE_PATTERN.test(asOf)) return bars
  return bars.filter((bar) => bar.date <= asOf)
}

/* ─────────────────────────────────────────────────────────────
 * 纯函数计算
 * ───────────────────────────────────────────────────────────── */

/**
 * 纯函数：计算市场状态。优先用沪深300 日线（≥120 根），不足则只用宽度。
 * 不抛错：数据全缺时返回 source='breadth'、range、confidence 0。
 * `input.lang` 控制 evidence 文案（'zh' 默认 / 'en'），数值与百分比格式一致。
 */
export function computeRegime(input: RegimeInput): RegimeInfo {
  const t = messagesFor(input.lang)
  const indexBars = truncateAt(normalizeBars(input.indexBars), input.asOf)
  const watchlist = (input.watchlist ?? []).map((series) => truncateAt(normalizeBars(series), input.asOf))
  const breadth = computeBreadth(watchlist)

  if (indexBars.length >= REGIME_MIN_INDEX_BARS) {
    return computeIndexRegime(indexBars, breadth, t)
  }
  return computeBreadthRegime(watchlist, breadth, t)
}

function computeIndexRegime(indexBars: Bar[], breadth: BreadthResult, t: RegimeMessages): RegimeInfo {
  const closes = closesOf(indexBars)
  const close = closes[closes.length - 1]
  const ma20 = smaAt(closes, REGIME_MA_SHORT) as number
  const ma60 = smaAt(closes, REGIME_MA_MID) as number
  const ma120 = smaAt(closes, REGIME_MA_LONG) as number
  const ma60Before = smaAt(closes, REGIME_MA_MID, closes.length - REGIME_SLOPE_LOOKBACK) as number
  const slopePct = ma60Before > 0 ? (ma60 / ma60Before - 1) * 100 : 0
  const highLookback = closes.slice(-REGIME_HIGH_LOOKBACK)
  const high250 = Math.max(...highLookback)
  const drawdownPct = high250 > 0 ? (close / high250 - 1) * 100 : 0
  const breadthPct = breadth.pct

  const conditions = [
    close > ma20,
    close > ma60,
    close > ma120,
    ma20 > ma60,
    slopePct > 0,
    drawdownPct > -REGIME_DRAWDOWN_SAFE,
    breadthPct !== undefined && breadthPct >= REGIME_BREADTH_BULL,
  ]
  const score = conditions.filter(Boolean).length

  // 各条件「实际值 vs 阈值」的归一化强度 m_i ∈ [-1, 1]
  const margins = [
    clamp((close / ma20 - 1) / 0.02),
    clamp((close / ma60 - 1) / 0.02),
    clamp((close / ma120 - 1) / 0.02),
    clamp((ma20 / ma60 - 1) / 0.01),
    clamp(slopePct / 2),
    clamp((drawdownPct + REGIME_DRAWDOWN_SAFE) / 10),
    breadthPct === undefined ? 0 : clamp((breadthPct - REGIME_BREADTH_BULL) / 20),
  ]
  const alignment = clamp(margins.reduce((sum, value) => sum + value, 0) / margins.length)

  let regime: MarketRegime
  if (score >= REGIME_BULL_MIN_SCORE && close > ma60) {
    regime = 'bull'
  } else if (score <= REGIME_BEAR_MAX_SCORE || (close < ma60 && drawdownPct <= -REGIME_DRAWDOWN_BEAR)) {
    regime = 'bear'
  } else {
    regime = 'range'
  }

  const rawConfidence =
    regime === 'bull'
      ? 50 + 50 * clamp(alignment, 0, 1)
      : regime === 'bear'
        ? 50 + 50 * clamp(-alignment, 0, 1)
        : 100 * (1 - Math.abs(alignment))
  const confidence = round1(clamp(rawConfidence, 0, 100))

  const evidence = [
    t.index.closeMa20(fmt(close), fmt(ma20), pct(close / ma20 - 1)),
    t.index.closeMa60(fmt(ma60), pct(close / ma60 - 1), pct(ma20 / ma60 - 1)),
    t.index.closeMa120(fmt(ma120), pct(close / ma120 - 1)),
    t.index.slope(REGIME_SLOPE_LOOKBACK, fmt(slopePct), slopePct > 0),
    t.index.drawdown(highLookback.length, fmt(high250), fmt(drawdownPct)),
    breadthPct === undefined
      ? t.index.breadthUnavailable
      : t.index.breadth(fmt(breadthPct), breadth.above, breadth.total, REGIME_BREADTH_BULL),
    t.index.score(score, 7, t.regimeLabel(regime), fmt(alignment, 3), fmt(confidence, 1)),
  ]

  return {
    regime,
    confidence,
    asOf: indexBars[indexBars.length - 1].date,
    source: 'index',
    evidence,
    ...(breadthPct === undefined ? {} : { breadthPct: round1(breadthPct) }),
  }
}

function computeBreadthRegime(watchlist: Bar[][], breadth: BreadthResult, t: RegimeMessages): RegimeInfo {
  const asOf = latestDate(watchlist)
  if (breadth.pct === undefined) {
    return {
      regime: 'range',
      confidence: 0,
      asOf,
      source: 'breadth',
      evidence: [t.breadth.noDataIndex, t.breadth.noDataBreadth],
    }
  }

  const breadthPct = breadth.pct
  const alignment = clamp((breadthPct - 50) / 50)
  const regime: MarketRegime =
    breadthPct >= REGIME_BREADTH_BULL ? 'bull' : breadthPct <= REGIME_BREADTH_BEAR ? 'bear' : 'range'
  const rawConfidence =
    regime === 'bull'
      ? 50 + 50 * clamp(alignment, 0, 1)
      : regime === 'bear'
        ? 50 + 50 * clamp(-alignment, 0, 1)
        : 100 * (1 - Math.abs(alignment))
  const confidence = round1(clamp(rawConfidence, 0, 100))

  return {
    regime,
    confidence,
    asOf,
    source: 'breadth',
    evidence: [
      t.breadth.indexMissing,
      t.breadth.breadthLine(fmt(breadthPct), breadth.above, breadth.total, REGIME_BREADTH_BULL, REGIME_BREADTH_BEAR),
      t.breadth.score(t.regimeLabel(regime), fmt(alignment, 3), fmt(confidence, 1)),
    ],
    breadthPct: round1(breadthPct),
  }
}

/* ─────────────────────────────────────────────────────────────
 * 数据加载（沪深300 日线：腾讯 fqkline → 新浪 JSON）
 * ───────────────────────────────────────────────────────────── */

async function requestJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json, text/plain, */*' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 组装 Bar：amount=0，changePct 按前收计算（首根 0）。 */
function buildBar(date: string, open: number, high: number, low: number, close: number, volume: number, previousClose?: number): Bar {
  return {
    date,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
    amount: 0,
    changePct: previousClose && previousClose > 0 ? (close / previousClose - 1) * 100 : 0,
  }
}

function barsFromTencentIndex(payload: unknown, t: RegimeMessages): Bar[] {
  const data =
    typeof payload === 'object' && payload !== null && typeof (payload as { data?: unknown }).data === 'object'
      ? (payload as { data: Record<string, unknown> }).data
      : undefined
  const node = data?.[INDEX_SYMBOL] as Record<string, unknown> | undefined
  if (!node) throw new Error(t.parse.tencentMissingSymbol)
  const rows = (Array.isArray(node.qfqday) ? node.qfqday : node.day) as unknown
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(t.parse.tencentMissingBars)
  const bars: Bar[] = []
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) throw new Error(t.parse.tencentIncomplete)
    const [date, open, close, high, low, volume] = row as unknown[]
    if (typeof date !== 'string' || !DATE_PATTERN.test(date)) throw new Error(t.parse.tencentDate)
    const previousClose = bars.length > 0 ? bars[bars.length - 1].close : undefined
    bars.push(
      buildBar(
        date,
        Number(open),
        Number(high),
        Number(low),
        Number(close),
        Number(volume),
        previousClose,
      ),
    )
  }
  return normalizeBars(bars)
}

function barsFromSinaIndex(payload: unknown, t: RegimeMessages): Bar[] {
  if (!Array.isArray(payload) || payload.length === 0) throw new Error(t.parse.sinaNotArray)
  const bars: Bar[] = []
  for (const row of payload) {
    if (typeof row !== 'object' || row === null) throw new Error(t.parse.sinaFormat)
    const record = row as Record<string, unknown>
    const date = typeof record.day === 'string' ? record.day : ''
    if (!DATE_PATTERN.test(date)) throw new Error(t.parse.sinaDate)
    const previousClose = bars.length > 0 ? bars[bars.length - 1].close : undefined
    bars.push(
      buildBar(
        date,
        Number(record.open),
        Number(record.high),
        Number(record.low),
        Number(record.close),
        Number(record.volume),
        previousClose,
      ),
    )
  }
  return normalizeBars(bars)
}

/**
 * 拉沪深300 日线：腾讯优先，失败换新浪；都失败抛错（由调用方退回宽度）。
 * `lang` 只影响抛出的错误文案（默认 zh）。
 */
export async function fetchIndexBars(fetcher: typeof fetch = fetch, lang: RegimeLang = 'zh'): Promise<Bar[]> {
  const t = messagesFor(lang)
  let tencentError: unknown
  try {
    return barsFromTencentIndex(await requestJson(TENCENT_INDEX_URL, fetcher), t)
  } catch (error) {
    tencentError = error
  }
  try {
    return barsFromSinaIndex(await requestJson(SINA_INDEX_URL, fetcher), t)
  } catch (error) {
    const message = (value: unknown) => (value instanceof Error ? value.message : String(value))
    throw new Error(t.fetchError(message(tencentError), message(error)))
  }
}

/* ─────────────────────────────────────────────────────────────
 * localStorage 缓存（版本化；当天不重复拉；按 lang 区分）
 * ───────────────────────────────────────────────────────────── */

interface RegimeCache {
  version: number
  fetchedOn: string
  lang?: RegimeLang
  info: RegimeInfo
}

function getStorage(): Storage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage
  } catch {
    return undefined
  }
}

/** 北京时间的日期字符串 YYYY-MM-DD。 */
export function beijingToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function isRegimeInfo(value: unknown): value is RegimeInfo {
  if (typeof value !== 'object' || value === null) return false
  const info = value as Record<string, unknown>
  return (
    (info.regime === 'bull' || info.regime === 'range' || info.regime === 'bear') &&
    typeof info.confidence === 'number' &&
    Number.isFinite(info.confidence) &&
    typeof info.asOf === 'string' &&
    (info.source === 'index' || info.source === 'breadth') &&
    Array.isArray(info.evidence) &&
    info.evidence.every((item) => typeof item === 'string')
  )
}

/** 读缓存；版本不符/解析失败/内容非法一律返回 null。 */
export function readRegimeCache(now: Date = new Date()): RegimeCache | null {
  const storage = getStorage()
  if (!storage) return null
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CACHE_KEY) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) return null
    const cache = parsed as Record<string, unknown>
    if (cache.version !== CACHE_VERSION) return null
    if (typeof cache.fetchedOn !== 'string') return null
    if (!isRegimeInfo(cache.info)) return null
    void now
    const lang: RegimeLang | undefined = cache.lang === 'en' ? 'en' : cache.lang === 'zh' ? 'zh' : undefined
    return { version: CACHE_VERSION, fetchedOn: cache.fetchedOn, lang, info: cache.info }
  } catch {
    return null
  }
}

function writeRegimeCache(info: RegimeInfo, now: Date, lang: RegimeLang): void {
  const storage = getStorage()
  if (!storage) return
  try {
    const cache: RegimeCache = { version: CACHE_VERSION, fetchedOn: beijingToday(now), lang, info }
    storage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // 隐私模式/配额不足：静默降级
  }
}

export function clearRegimeCache(): void {
  const storage = getStorage()
  if (!storage) return
  try {
    storage.removeItem(CACHE_KEY)
  } catch {
    // 忽略
  }
}

/* ─────────────────────────────────────────────────────────────
 * 加载入口
 * ───────────────────────────────────────────────────────────── */

export interface LoadRegimeOptions {
  /** 强制重新拉取（忽略「当天不重复拉」缓存）。 */
  force?: boolean
  fetcher?: typeof fetch
  now?: Date
  /** 可选文案语言（默认 'zh'）；缓存按 lang 区分，避免中英混用。 */
  lang?: RegimeLang
}

export interface RegimeLoadDetail {
  info: RegimeInfo
  /** 沪深300 拉取失败时的错误文案（随 lang）；成功为 null。 */
  error: string | null
  fromCache: boolean
}

/**
 * 加载并计算市场状态（供 hook 使用，带失败原因）。
 * 成功：source='index'；沪深300 两条源都失败：退回宽度（source='breadth'）并返回 error。
 * 结果写 localStorage 缓存（版本化，记录 fetchedOn + lang）；当天已成功拉过且同语言则直接返回缓存（force 覆盖）。
 */
export async function loadRegimeDetail(
  watchlistBars: Bar[][],
  options: LoadRegimeOptions = {},
): Promise<RegimeLoadDetail> {
  const now = options.now ?? new Date()
  const fetcher = options.fetcher ?? fetch
  const lang = options.lang ?? 'zh'
  const cached = readRegimeCache(now)
  const today = beijingToday(now)

  if (!options.force && cached && cached.fetchedOn === today && cached.info.source === 'index' && (cached.lang ?? 'zh') === lang) {
    return { info: cached.info, error: null, fromCache: true }
  }

  let indexBars: Bar[] | undefined
  let error: string | null = null
  try {
    indexBars = await fetchIndexBars(fetcher, lang)
  } catch (fetchError) {
    error = fetchError instanceof Error ? fetchError.message : String(fetchError)
  }

  const info = computeRegime({ indexBars, watchlist: watchlistBars, lang })
  writeRegimeCache(info, now, lang)
  return { info, error, fromCache: false }
}

/** 契约入口：返回 RegimeInfo（失败不抛，退回宽度；lang 控制文案）。 */
export async function loadRegime(watchlistBars: Bar[][], options: LoadRegimeOptions = {}): Promise<RegimeInfo> {
  return (await loadRegimeDetail(watchlistBars, options)).info
}
