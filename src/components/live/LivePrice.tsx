import { useEffect, useRef, useState } from 'react'
import type { MarketPhase } from '@/types'
import { formatBeijingClock, isLivePricePhase, phasePriceTag } from './quote-utils'

type PriceSize = 'card' | 'row' | 'compact' | 'detail'

function formatPrice(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : '—'
}

function formatChangePct(value: number) {
  if (!Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

/**
 * 统一的盘中价格展示：现价 + 涨跌幅 + 时段标记。
 * - 涨红跌绿（沿用 A 股习惯，与既有 .market-up / .market-down 一致）
 * - 价格变化时短暂高亮
 * - 交易中/竞价显示「盘中/竞价」；收盘/非交易日显示「收盘」，午休/盘前显示暂停标记
 * - 本轮刷新失败、沿用上次报价时显示「上次报价 HH:mm:ss」，不冒充实时
 */
export function LivePrice({
  value,
  changePct,
  phase,
  live,
  stale = false,
  quoteAt,
  size = 'card',
  showTag = true,
  className,
}: {
  value: number
  changePct: number
  phase: MarketPhase
  /** 是否存在盘中报价（数据层给了报价才为 true） */
  live: boolean
  /** 该报价来自上一次成功刷新（本轮失败），仅在交易时段影响标签 */
  stale?: boolean
  /** 报价的 provider 时间（ISO），stale 时显示「上次报价 HH:mm:ss」 */
  quoteAt?: string
  size?: PriceSize
  showTag?: boolean
  className?: string
}) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)
  const previousValue = useRef<number | undefined>(undefined)

  useEffect(() => {
    const previous = previousValue.current
    previousValue.current = value
    if (previous === undefined || previous === value || !Number.isFinite(previous) || !Number.isFinite(value)) return
    // 价格跳变 → 一次性高亮反馈，属于本地瞬时状态而非派生数据。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFlash(value > previous ? 'up' : 'down')
    const timer = window.setTimeout(() => setFlash(null), 900)
    return () => window.clearTimeout(timer)
  }, [value])

  const tag = phasePriceTag(phase)
  const displayLive = live && tag.live
  const staleLive = displayLive && stale
  // 交易时段但没有本轮报价（EOD 收盘价或无数据）时不能标「盘中」，统一标「收盘」。
  const tagText = staleLive
    ? `上次报价 ${formatBeijingClock(quoteAt)}`
    : displayLive
      ? tag.label
      : isLivePricePhase(phase)
        ? '收盘'
        : tag.label
  const tagClass = staleLive ? 'price-tag price-tag-stale' : displayLive ? 'price-tag price-tag-live' : 'price-tag'
  const positive = Number.isFinite(changePct) && changePct >= 0
  const flashClass = flash ? `price-flash-${flash}` : ''

  return (
    <span className={`live-price live-price-${size}${className ? ` ${className}` : ''}`}>
      <span key={value} className={`live-price-number number-text ${flashClass}`}>{formatPrice(value)}</span>
      <span className={`live-price-change number-text ${positive ? 'market-up' : 'market-down'}`}>{formatChangePct(changePct)}</span>
      {showTag && <span className={tagClass}>{tagText}</span>}
    </span>
  )
}
