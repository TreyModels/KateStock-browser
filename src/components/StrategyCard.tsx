import { ArrowUpRight, ChevronRight, Crosshair, Shield, Target } from 'lucide-react'
import type { Strategy } from '@/types'
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

export function StrategyCard({ strategy, onOpen }: { strategy: Strategy; onOpen: () => void }) {
  const positive = strategy.changePct >= 0
  return (
    <article className="strategy-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[17px] font-semibold tracking-tight">{strategy.name}</h3>
            <span className="code-label">{strategy.code}</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="number-text text-[22px] font-semibold">{formatPrice(strategy.price)}</span>
            <span className={`number-text text-sm font-medium ${positive ? 'market-up' : 'market-down'}`}>
              {positive ? '+' : ''}{strategy.changePct.toFixed(2)}%
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className={`signal-pill ${actionClass[strategy.action]}`}>{strategy.actionLabel}</span>
          <span className="text-xs text-muted-foreground">强度 {strategy.score}</span>
        </div>
      </div>

      <p className="mt-4 text-[15px] leading-6 text-foreground/80">{strategy.summary}</p>

      <div className="mt-4 grid grid-cols-3 gap-2 border-y border-border/80 py-3">
        <div>
          <span className="level-label"><Crosshair size={12} />触发</span>
          <strong className="number-text mt-1 block text-sm">{formatPrice(strategy.trigger)}</strong>
        </div>
        <div>
          <span className="level-label"><Shield size={12} />保护</span>
          <strong className="number-text mt-1 block text-sm">{formatPrice(strategy.stop)}</strong>
        </div>
        <div>
          <span className="level-label"><Target size={12} />目标</span>
          <strong className="number-text mt-1 block text-sm">{formatPrice(strategy.target)}</strong>
        </div>
      </div>

      <div className="mt-3 flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <Sparkline bars={strategy.bars} positive={positive} />
        </div>
        <div className="shrink-0 text-right">
          {strategy.suggestedShares !== undefined && (
            <>
              <span className="block text-xs text-muted-foreground">参考上限</span>
              <span className="number-text text-sm font-semibold">{strategy.suggestedShares} 股</span>
            </>
          )}
          <button type="button" className="mt-1 flex min-h-11 w-full items-center justify-end gap-1 text-sm font-medium text-primary" onClick={onOpen}>
            完整计划 <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>{strategy.source === 'auto' ? '自动日线' : '手动行情'} · {strategy.tradeDate}</span>
        <ArrowUpRight size={13} aria-hidden="true" />
      </div>
    </article>
  )
}
