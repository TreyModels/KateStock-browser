import type { AlertEvent, AlertKind, LiveQuote, MarketPhase, Strategy } from '@/types'
import { getMarketPhase } from './live.ts'
import { evaluateLive } from './live-signals.ts'

/**
 * 盘中提醒层（signals-alerts 负责人实现）。
 *
 * 职责：
 * 1. buildAlertEvent —— 把「命中」变成带去重键的 AlertEvent（id = `${code}:${kind}:${tradeDate}`）。
 * 2. scanAlerts —— 纯函数：墙钟时段校验 + 报价新鲜度 + id 去重 + 同 (code,kind) 5 分钟兜底节流。
 * 3. localStorage 持久化 —— 带版本号的 key，解析失败/不可用一律静默降级为空状态。
 * 4. 通知权限探测 —— 供 hook 判断浏览器 Notification 是否可用。
 *
 * 语义约定（重要）：
 * - 「当天一次」：id 自带 tradeDate，且 scanAlerts 先查已见集合，所以同一交易日的
 *   同一 (code, kind) 只会提醒一次；5 分钟节流只是兜底防抖（已见集合丢失/手工状态时），
 *   并不表示「每 5 分钟复报一次」。跨日由 id 中的 tradeDate 变化自动重置。
 * - 「墙钟优先」：不信任 quote.phase —— 它是数据请求发起时的快照，跨 11:30/15:00 边界的
 *   响应可能带着过期的 trading。消费报价时用 getMarketPhase(now) 重新判定时段，
 *   11:29:59 拿到 phase=trading 的报价、now=11:30:01 时不会提醒；15:00 同理。
 *
 * 该模块不碰 DOM/React，方便用固定时间与假报价离线单测。
 */

/** 已见集合持久化 key（带版本号，升级数据结构时换 key 即可自愈）。 */
export const ALERT_STORAGE_KEY = 'kate-dashboard:alerts:seen:v1'
export const ALERT_STATE_VERSION = 1
/** 报价超过 2 分钟未更新视为陈旧，不再提醒。 */
export const ALERT_STALE_MS = 2 * 60 * 1000
/**
 * 同一 (code, kind) 的兜底节流窗口：5 分钟。
 * 正常路径下当天同一信号已被 id 去重拦住，这里只防「已见集合未持久化/被清空/手工构造状态」
 * 等边界下的重复弹窗，不承担「5 分钟后复报」的语义。
 */
export const ALERT_REPEAT_MS = 5 * 60 * 1000
/**
 * 只有集合竞价与连续竞价阶段才产生提醒（午休/盘前/收盘/非交易日不提醒）。
 * 判定依据是消费时刻的墙钟相位（getMarketPhase(now)），不是报价自带的 quote.phase 快照。
 */
export const ALERT_PHASES: readonly MarketPhase[] = ['auction', 'trading']

export interface AlertState {
  /** 已提醒过的 AlertEvent.id 集合（按天裁剪）。 */
  seenIds: string[]
  /** `${code}:${kind}` → 最近一次提醒的时间戳（ms），用于 5 分钟节流。 */
  lastFiredAt: Record<string, number>
}

/** 语言字面量类型（不 import i18n.ts，避免循环依赖；默认 zh 保证向后兼容）。 */
export type AlertLang = 'zh' | 'en'

export interface AlertScanOptions {
  now?: Date
  staleMs?: number
  repeatMs?: number
  /** 可选语言；默认 'zh'（完全向后兼容）。 */
  lang?: AlertLang
}

export interface AlertScanResult {
  state: AlertState
  events: AlertEvent[]
}

/** localStorage 的最小切口，便于测试注入假实现。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const KIND_LABELS: Record<AlertKind, string> = {
  stop: '跌破止损',
  target: '触及目标',
  trigger: '触发买点',
}

const KIND_LABELS_EN: Record<AlertKind, string> = {
  stop: 'Stop-loss breached',
  target: 'Target reached',
  trigger: 'Entry triggered',
}

export function createAlertState(): AlertState {
  return { seenIds: [], lastFiredAt: {} }
}

export function isAlertPhase(phase: MarketPhase): boolean {
  return ALERT_PHASES.includes(phase)
}
export function alertThrottleKey(code: string, kind: AlertKind): string {
  return `${code}:${kind}`
}

const beijingDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** 任意时间 → 北京时间交易日 `YYYY-MM-DD`（无效输入返回空串）。 */
export function beijingTradeDate(input: string | Date | number): string {
  const date = input instanceof Date ? input : new Date(input)
  const time = date.getTime()
  if (!Number.isFinite(time)) return ''
  const parts = beijingDateFormatter.formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  const year = get('year')
  const month = get('month')
  const day = get('day')
  if (!year || !month || !day) return ''
  return `${year}-${month}-${day}`
}

/** 报价的交易日取 updatedAt 的北京时间日期（LiveQuote 没有显式 tradeDate 字段）。 */
export function quoteTradeDate(quote: LiveQuote): string {
  return beijingTradeDate(quote.updatedAt)
}

/** 报价是否陈旧（超过 maxAgeMs 未更新，或时间无法解析）。 */
export function isQuoteStale(
  quote: LiveQuote,
  now: Date = new Date(),
  maxAgeMs: number = ALERT_STALE_MS,
): boolean {
  const updated = Date.parse(quote.updatedAt)
  if (!Number.isFinite(updated)) return true
  return now.getTime() - updated > maxAgeMs
}

/**
 * 提醒文案模板（含价位/现价插值）。
 * lang 默认 'zh' 完全向后兼容；'en' 输出英文模板。
 */
export function alertMessage(
  name: string,
  kind: AlertKind,
  level: number,
  price: number,
  lang: AlertLang = 'zh',
): string {
  const levelText = Number.isFinite(level) ? level.toFixed(2) : '—'
  const priceText = Number.isFinite(price) ? price.toFixed(2) : '—'
  if (lang === 'en') {
    return `${name}: ${KIND_LABELS_EN[kind]} at ${levelText} (price ${priceText})`
  }
  return `${name} ${KIND_LABELS[kind]} ${levelText}（现价 ${priceText}）`
}

/** 命中类型对应的策略价位（缺失时退回现价，保证 level 始终有限）。 */
function alertLevel(strategy: Strategy, kind: AlertKind, price: number): number {
  const raw = kind === 'stop' ? strategy.stop : kind === 'target' ? strategy.target : strategy.trigger
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : price
}

export function buildAlertEvent(
  strategy: Strategy,
  quote: LiveQuote,
  kind: AlertKind,
  now: Date = new Date(),
  lang: AlertLang = 'zh',
): AlertEvent {
  const tradeDate = quoteTradeDate(quote)
  const level = alertLevel(strategy, kind, quote.price)
  return {
    id: `${strategy.code}:${kind}:${tradeDate}`,
    code: strategy.code,
    name: strategy.name,
    kind,
    level,
    price: quote.price,
    at: now.toISOString(),
    message: alertMessage(strategy.name, kind, level, quote.price, lang),
  }
}

/** 解析持久化状态：坏数据/版本不符/字段类型错误一律降级为空状态，绝不抛错。 */
export function parseAlertState(raw: string | null | undefined): AlertState {
  if (!raw) return createAlertState()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return createAlertState()
    const record = parsed as { version?: unknown; seenIds?: unknown; lastFiredAt?: unknown }
    if (record.version !== ALERT_STATE_VERSION) return createAlertState()

    const seenIds = Array.isArray(record.seenIds)
      ? [...new Set(record.seenIds.filter((id): id is string => typeof id === 'string'))]
      : []

    const lastFiredAt: Record<string, number> = {}
    if (record.lastFiredAt && typeof record.lastFiredAt === 'object') {
      for (const [key, value] of Object.entries(record.lastFiredAt)) {
        if (typeof value === 'number' && Number.isFinite(value)) lastFiredAt[key] = value
      }
    }

    return { seenIds, lastFiredAt }
  } catch {
    return createAlertState()
  }
}

export function serializeAlertState(state: AlertState): string {
  return JSON.stringify({
    version: ALERT_STATE_VERSION,
    seenIds: state.seenIds,
    lastFiredAt: state.lastFiredAt,
  })
}

function defaultStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage
    return storage ?? null
  } catch {
    return null
  }
}

export function loadAlertState(storage: StorageLike | null = defaultStorage()): AlertState {
  if (!storage) return createAlertState()
  try {
    return parseAlertState(storage.getItem(ALERT_STORAGE_KEY))
  } catch {
    return createAlertState()
  }
}

export function saveAlertState(
  state: AlertState,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(ALERT_STORAGE_KEY, serializeAlertState(state))
  } catch {
    // 隐私模式/配额超限：放弃持久化，本次会话内存去重仍然有效
  }
}

/**
 * 单条命中是否在 5 分钟兜底节流窗口内（仅防抖，不改变「当天一次」语义）。
 * 正常流程中 id 去重先生效，见 scanAlerts 的「当天一次」说明。
 */
export function isThrottled(
  state: AlertState,
  code: string,
  kind: AlertKind,
  now: Date = new Date(),
  repeatMs: number = ALERT_REPEAT_MS,
): boolean {
  const last = state.lastFiredAt[alertThrottleKey(code, kind)]
  if (typeof last !== 'number' || !Number.isFinite(last)) return false
  return now.getTime() - last < repeatMs
}

/**
 * 扫描一批策略 + 报价，返回本次应提醒的事件与更新后的状态（纯函数，不改入参）。
 *
 * 过滤顺序：无报价 → 墙钟相位非 auction/trading（getMarketPhase(now)，忽略 quote.phase 快照）
 * → 报价陈旧 → id 已见（当天一次）→ 5 分钟内同 (code,kind) 兜底节流。
 *
 * 注意：id 含 tradeDate，因此同一交易日的同一 (code,kind) 只会提醒一次（「当天一次」）；
 * ALERT_REPEAT_MS 的 5 分钟窗口仅作兜底防抖，不是「每 5 分钟复报」。
 */
export function scanAlerts(
  strategies: Strategy[],
  quotes: Record<string, LiveQuote>,
  state: AlertState,
  options: AlertScanOptions = {},
): AlertScanResult {
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const staleMs = options.staleMs ?? ALERT_STALE_MS
  const repeatMs = options.repeatMs ?? ALERT_REPEAT_MS
  const lang: AlertLang = options.lang === 'en' ? 'en' : 'zh'
  const today = beijingTradeDate(now)

  // 按天裁剪已见集合：跨日（新的 tradeDate 进入 id）自动重置
  const seen = new Set(state.seenIds.filter((id) => !today || id.endsWith(`:${today}`)))
  const lastFiredAt = { ...state.lastFiredAt }

  // 墙钟二次校验：消费时重新判定时段，避免跨 11:30/15:00 边界的响应仍带 phase=trading 快照
  const phase = getMarketPhase(now)
  if (!isAlertPhase(phase)) {
    return { state: { seenIds: [...seen], lastFiredAt }, events: [] }
  }

  const events: AlertEvent[] = []

  for (const strategy of strategies) {
    const quote = quotes[strategy.code]
    if (!quote) continue
    if (isQuoteStale(quote, now, staleMs)) continue

    for (const kind of evaluateLive(strategy, quote).hits) {
      const event = buildAlertEvent(strategy, quote, kind, now, lang)
      if (seen.has(event.id)) continue
      if (isThrottled({ seenIds: [], lastFiredAt }, strategy.code, kind, now, repeatMs)) continue
      seen.add(event.id)
      lastFiredAt[alertThrottleKey(strategy.code, kind)] = nowMs
      events.push(event)
    }
  }

  return { state: { seenIds: [...seen], lastFiredAt }, events }
}

/* ─────────────────────────────────────────────────────────────
 * 浏览器 Notification 能力探测（hook 复用，纯函数便于测试）
 * ───────────────────────────────────────────────────────────── */

export type NotificationAvailability = NotificationPermission | 'unsupported'

export interface NotificationConstructor {
  permission: NotificationPermission
  requestPermission?: () => Promise<NotificationPermission>
  new (title: string, options?: NotificationOptions): Notification
}

export interface NotificationScope {
  Notification?: NotificationConstructor
}

/** 取全局通知作用域：浏览器里 Notification 挂在 window（部分环境挂在 document）。 */
export function getNotificationScope(): NotificationScope | undefined {
  if (typeof window !== 'undefined') return window as unknown as NotificationScope
  if (typeof document !== 'undefined') return document as unknown as NotificationScope
  return undefined
}

/** 当前通知权限；没有 Notification API 时返回 'unsupported'。 */
export function notificationPermission(
  scope: NotificationScope | undefined = getNotificationScope(),
): NotificationAvailability {
  const ctor = scope?.Notification
  if (!ctor || typeof ctor.permission !== 'string') return 'unsupported'
  return ctor.permission
}

export function canNotify(permission: NotificationAvailability): permission is NotificationPermission {
  return permission === 'granted'
}
