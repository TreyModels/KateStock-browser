import { AlertTriangle, ArrowUpRight, ChevronRight, Crosshair, Shield, Target } from 'lucide-react'
import type { LiveQuote, MarketPhase, Strategy } from '@/types'
import { evaluateLive, isHoldingStrategy } from '@/lib/live-signals'
import { LivePrice } from './live/LivePrice'
import {
  alertKindLabel,
  distanceFromLevelPct,
  distanceToLevelPct,
  formatBeijingClock,
  isLivePricePhase,
  stopDistanceLabel,
  targetDistanceLabel,
  triggerDistanceLabel,
} from './live/quote-utils'
import { Sparkline } from './Sparkline'

const actionClass: Record<Strategy['action'], string> = {
  breakout: 'signal-buy',
  pullback: 'signal-buy',
  hold: 'signal-hold',
  reduce: 'signal-risk',
  stop: 'signal-risk',
  watch: 'signal-wait',
}

export function formatPrice(value?: number) {
  return value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(2)
}

/**
 * 策略卡：在原有收盘日线策略上叠加盘中报价。
 * - 有盘中报价时以现价覆盖收盘价，涨红跌绿，变化时短暂高亮
 * - 显示「距触发 +x%」以及触发/保护/目标命中态
 * - 收盘、非交易日明确标注「收盘」；本轮刷新失败沿用上次报价时标注「上次报价 HH:mm:ss」
 */
export function StrategyCard({ strategy, liveQuote, liveError, phase, onOpen }: {
  strategy: Strategy
  liveQuote?: LiveQuote
  /** 本轮刷新该代码失败时的错误信息（报价为上一次成功结果） */
  liveError?: string
  phase: MarketPhase
  onOpen: () => void
}) {
  const status = liveQuote ? evaluateLive(strategy, liveQuote) : undefined
  const price = liveQuote?.price ?? strategy.price
  const changePct = liveQuote?.changePct ?? strategy.changePct
  const positive = changePct >= 0
  const hits = status?.hits ?? []
  const holding = isHoldingStrategy(strategy)
  const livePhase = isLivePricePhase(phase)
  const staleLive = Boolean(liveError) && Boolean(liveQuote) && livePhase

  // 距离文案照常显示（含非持仓的 stop/target）；但只使用 evaluateLive 的命中语义，不在 UI 侧补高亮。
  const triggerDistancePct = status?.distanceToTriggerPct ?? distanceToLevelPct(strategy.trigger, price)
  const stopDistancePct = status?.distanceToStopPct ?? distanceFromLevelPct(strategy.stop, price)
  const targetDistancePct = distanceToLevelPct(strategy.target, price)
  const triggerDistance = triggerDistanceLabel(triggerDistancePct)
  const stopDistance = stopDistanceLabel(stopDistancePct)
  const targetDistance = targetDistanceLabel(targetDistancePct)

  const primaryHit = hits[0]
  const bearWatch = strategy.actionLabel === '熊市观望'
  const hitSummary = hits.map((kind) => alertKindLabel[kind]).join(' · ')
  const quoteLine = liveQuote
    ? staleLive
      ? `上次报价 ${formatBeijingClock(liveQuote.updatedAt)}（未刷新）· 收盘日线 ${strategy.tradeDate}`
      : livePhase
        ? `盘中报价 ${formatBeijingClock(liveQuote.updatedAt)} · 收盘日线 ${strategy.tradeDate}`
        : `${strategy.source === 'auto' ? '自动日线' : '手动行情'} · ${strategy.tradeDate}`
    : `${strategy.source === 'auto' ? '自动日线' : '手动行情'} · ${strategy.tradeDate}`

  return (
    <article className={`strategy-card${primaryHit ? ` strategy-card-hit-${primaryHit}` : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[17px] font-semibold tracking-tight">{strategy.name}</h3>
            <span className="code-label">{strategy.code}</span>
            {holding && <span className="status-tag status-holding">持仓</span>}
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-2">
            <LivePrice value={price} changePct={changePct} phase={phase} live={Boolean(liveQuote)} stale={staleLive} quoteAt={liveQuote?.updatedAt} />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className={`signal-pill ${actionClass[strategy.action]}`}>{strategy.actionLabel}</span>
          <span className="text-xs text-muted-foreground">强度 {strategy.score}</span>
        </div>
      </div>

      {primaryHit && (
        <div className={`strategy-hit-banner strategy-hit-${primaryHit}`}>
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{staleLive ? '上次报价命中' : livePhase ? '盘中命中' : '价格触及'}：{hitSummary}</span>
        </div>
      )}

      <p className="mt-4 text-[15px] leading-6 text-foreground/80">{strategy.summary}</p>
      {bearWatch && <p className="strategy-bear-note">熊市：不加仓，只管理持仓/等结构修复</p>}

      <div className="mt-4 grid grid-cols-3 gap-2 border-y border-border/80 py-3">
        <div className={`level-item${hits.includes('trigger') ? ' level-hit level-hit-trigger' : ''}`}>
          <span className="level-label"><Crosshair size={12} />触发</span>
          <strong className="number-text mt-1 block text-sm">{formatPrice(strategy.trigger)}</strong>
          {triggerDistance && <span className={`level-distance${hits.includes('trigger') ? ' market-up' : ''}`}>{triggerDistance}</span>}
        </div>
        <div className={`level-item${hits.includes('stop') ? ' level-hit level-hit-stop' : ''}`}>
          <span className="level-label"><Shield size={12} />保护</span>
          <strong className="number-text mt-1 block text-sm">{formatPrice(strategy.stop)}</strong>
          {stopDistance && <span className={`level-distance${hits.includes('stop') ? ' market-down' : ''}`}>{stopDistance}</span>}
        </div>
        <div className={`level-item${hits.includes('target') ? ' level-hit level-hit-target' : ''}`}>
          <span className="level-label"><Target size={12} />目标</span>
          <strong className="number-text mt-1 block text-sm">{formatPrice(strategy.target)}</strong>
          {targetDistance && <span className={`level-distance${hits.includes('target') ? ' market-up' : ''}`}>{targetDistance}</span>}
        </div>
      </div>

      <div className="mt-3 flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <Sparkline bars={strategy.bars} positive={positive} />
        </div>
        <div className="shrink-0 text-right">
          {strategy.suggestedShares !== undefined && (
            <>
              <span className="block text-xs text-muted-foreground">{strategy.suggestedShares > 0 ? '参考上限' : '参考仓位'}</span>
              <span className="number-text text-sm font-semibold">{strategy.suggestedShares > 0 ? `${strategy.suggestedShares} 股` : '不足 1 手'}</span>
            </>
          )}
          <button type="button" className="mt-1 flex min-h-11 w-full items-center justify-end gap-1 text-sm font-medium text-primary" onClick={onOpen}>
            完整计划 <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>{quoteLine}</span>
        <ArrowUpRight size={13} aria-hidden="true" />
      </div>
    </article>
  )
}
