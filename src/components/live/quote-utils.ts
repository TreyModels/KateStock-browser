import type { AlertKind, MarketPhase } from '@/types'

/**
 * 盘中 UI 的展示辅助函数。
 * 原则：只有交易中/集合竞价才把价格称为「盘中」，其余时段明确标注收盘或暂停，
 * 避免把上一交易日收盘价伪装成实时行情。
 */

/** 只有这两个时段的价格才可以标注为「盘中」。 */
export function isLivePricePhase(phase: MarketPhase): boolean {
  return phase === 'auction' || phase === 'trading'
}

export interface PriceTag {
  label: string
  live: boolean
}

/** 价格旁的时段标记：收盘、非交易日一律显示「收盘」。 */
export function phasePriceTag(phase: MarketPhase): PriceTag {
  if (phase === 'trading') return { label: '盘中', live: true }
  if (phase === 'auction') return { label: '竞价', live: true }
  if (phase === 'lunch') return { label: '午休', live: false }
  if (phase === 'preopen') return { label: '盘前', live: false }
  return { label: '收盘', live: false }
}

export const alertKindLabel: Record<AlertKind, string> = {
  trigger: '触发',
  stop: '保护',
  target: '目标',
}

const clockFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** 北京时间 HH:mm:ss；无法解析时返回破折号。 */
export function formatBeijingClock(iso?: string): string {
  if (!iso) return '—'
  const time = Date.parse(iso)
  return Number.isNaN(time) ? '—' : clockFormatter.format(time)
}

/** 北京时间日期 YYYY-MM-DD；无法解析返回 undefined。用于区分快照交易日与最新报价日。 */
export function formatBeijingDate(iso?: string): string | undefined {
  if (!iso) return undefined
  const time = Date.parse(iso)
  return Number.isNaN(time) ? undefined : dateFormatter.format(time)
}

/** 报价数据年龄：刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前。 */
export function formatDataAge(iso: string | undefined, now: number): string {
  if (!iso) return '—'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return '—'
  const seconds = Math.max(0, Math.floor((now - time) / 1000))
  if (seconds < 5) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** (level / price - 1) * 100；价位或现价无效时返回 undefined，与 evaluateLive 的 priceLevel 规则一致。 */
export function distanceToLevelPct(level: number | undefined, price: number): number | undefined {
  if (level === undefined || !Number.isFinite(level) || level <= 0 || !Number.isFinite(price) || price <= 0) return undefined
  return (level / price - 1) * 100
}

/** (price / level - 1) * 100；价位或现价无效时返回 undefined。 */
export function distanceFromLevelPct(level: number | undefined, price: number): number | undefined {
  if (level === undefined || !Number.isFinite(level) || level <= 0 || !Number.isFinite(price) || price <= 0) return undefined
  return (price / level - 1) * 100
}

/** 「距触发 +x%」；已越过触发价时明确说明。 */
export function triggerDistanceLabel(distancePct?: number): string | undefined {
  if (distancePct === undefined || !Number.isFinite(distancePct)) return undefined
  return distancePct >= 0 ? `距触发 +${distancePct.toFixed(1)}%` : `已越过触发 ${Math.abs(distancePct).toFixed(1)}%`
}

/** 「距保护 +x%」；正数表示现价仍在保护位上方。 */
export function stopDistanceLabel(distancePct?: number): string | undefined {
  if (distancePct === undefined || !Number.isFinite(distancePct)) return undefined
  return distancePct >= 0 ? `距保护 +${distancePct.toFixed(1)}%` : `已跌破保护 ${Math.abs(distancePct).toFixed(1)}%`
}

/** 「距目标 +x%」；负数表示已经越过目标位。 */
export function targetDistanceLabel(distancePct?: number): string | undefined {
  if (distancePct === undefined || !Number.isFinite(distancePct)) return undefined
  return distancePct >= 0 ? `距目标 +${distancePct.toFixed(1)}%` : `已越过目标 ${Math.abs(distancePct).toFixed(1)}%`
}
