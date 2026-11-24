import { useState } from 'react'
import { AlertTriangle, Check, Copy } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/lib/i18n'
import { evaluateLive, isHoldingStrategy } from '@/lib/live-signals'
import type { LiveQuote, MarketPhase, Strategy } from '@/types'
import { LivePrice } from './live/LivePrice'
import {
  alertKindLabel,
  distanceFromLevelPct,
  distanceToLevelPct,
  isLivePricePhase,
  stopDistanceLabel,
  targetDistanceLabel,
  triggerDistanceLabel,
} from './live/quote-utils'
import { formatPrice } from './StrategyCard'
import { Sparkline } from './Sparkline'

export function StrategyDetailDialog({ strategy, open, onOpenChange, liveQuote, liveFailed = false, phase = 'closed' }: {
  strategy?: Strategy
  open: boolean
  onOpenChange: (open: boolean) => void
  liveQuote?: LiveQuote
  /** 本轮刷新失败、报价来自上一次成功结果 */
  liveFailed?: boolean
  phase?: MarketPhase
}) {
  const [copied, setCopied] = useState(false)
  const { t } = useI18n()
  if (!strategy) return null

  const status = liveQuote ? evaluateLive(strategy, liveQuote) : undefined
  const hits = status?.hits ?? []
  const price = liveQuote?.price ?? strategy.price
  const changePct = liveQuote?.changePct ?? strategy.changePct
  const staleLive = Boolean(liveFailed) && Boolean(liveQuote) && isLivePricePhase(phase)
  const holding = isHoldingStrategy(strategy)
  // 闭市/盘前/午休不能把报价写成「盘中现价」（N-3）。
  const copyPriceLabel = staleLive ? '上次报价' : isLivePricePhase(phase) ? '盘中现价' : '最新价格（收盘）'
  const primaryHit = hits[0]
  const triggerDistance = triggerDistanceLabel(status?.distanceToTriggerPct ?? distanceToLevelPct(strategy.trigger, price))
  const stopDistance = stopDistanceLabel(status?.distanceToStopPct ?? distanceFromLevelPct(strategy.stop, price))
  const targetDistance = targetDistanceLabel(distanceToLevelPct(strategy.target, price))
  const bearWatch = strategy.actionLabel === '熊市观望'
  const levels = [
    { label: t('detail.triggerPrice'), value: strategy.trigger, distance: triggerDistance, kind: 'trigger' as const },
    { label: t('detail.stopPrice'), value: strategy.stop, distance: stopDistance, kind: 'stop' as const },
    { label: t('detail.targetPrice'), value: strategy.target, distance: targetDistance, kind: 'target' as const },
  ]

  const copyPlan = async () => {
    const text = `${strategy.name} ${strategy.code}｜${strategy.actionLabel}\n${strategy.summary}\n${liveQuote ? `${copyPriceLabel}：${formatPrice(price)}（${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%）\n` : ''}触发：${formatPrice(strategy.trigger)}｜保护：${formatPrice(strategy.stop)}｜目标：${formatPrice(strategy.target)}\n${strategy.reasons.join('；')}\n数据日期：${strategy.tradeDate}。仅为量化规则参考，不构成投资建议。`
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="stock-dialog">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <DialogTitle>{t('detail.planTitle', { name: strategy.name })}</DialogTitle>
          </div>
          <DialogDescription>{strategy.code} · {strategy.tradeDate} · {strategy.source === 'auto' ? t('detail.autoDaily') : t('detail.manualQuote')}{holding ? ' · ' + t('strategy.holdingTag') : ''}{liveQuote ? (staleLive ? ' · ' + t('detail.lastQuoteMode') : isLivePricePhase(phase) ? ' · ' + t('detail.liveQuote') : ' · ' + t('detail.recentClose')) : ''}</DialogDescription>
        </DialogHeader>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <LivePrice value={price} changePct={changePct} phase={phase} live={Boolean(liveQuote)} stale={staleLive} quoteAt={liveQuote?.updatedAt} size="detail" />
          <span className={`signal-pill ${strategy.action === 'stop' || strategy.action === 'reduce' ? 'signal-risk' : strategy.action === 'watch' ? 'signal-wait' : strategy.action === 'hold' ? 'signal-hold' : 'signal-buy'}`}>{strategy.actionLabel}</span>
        </div>
        {primaryHit && (
          <div className={`strategy-hit-banner strategy-hit-${primaryHit}`}>
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{staleLive ? t('detail.lastQuoteHit') : t('detail.hit')}：{hits.map(kind => alertKindLabel[kind]).join(' · ')}</span>
          </div>
        )}
        <Sparkline bars={strategy.bars} positive={changePct >= 0} large />
        <p className="text-[15px] leading-6">{strategy.summary}</p>
        {bearWatch && <p className="strategy-bear-note">{t('strategy.bearNote')}</p>}
        <div className="grid grid-cols-3 gap-2">
          {levels.map(({ label, value, distance, kind }) => (
            <div className={`level-box${hits.includes(kind) ? ' level-box-hit' : ''}`} key={label}>
              <span>{label}</span>
              <strong className="number-text">{formatPrice(value)}</strong>
              {distance && <small className="level-box-distance">{distance}</small>}
            </div>
          ))}
        </div>
        {strategy.suggestedShares !== undefined && (
          <div className="risk-ticket">
            <span>{t('detail.riskTicket')}</span>
            <strong>{strategy.suggestedShares > 0 ? t('detail.riskTicketLine', { n: strategy.suggestedShares, pct: strategy.suggestedPositionPct ?? 0 }) : t('detail.sublotLine')}</strong>
            <small>{t('detail.riskTicketNote')}</small>
          </div>
        )}
        <div>
          <h4 className="mb-2 text-sm font-semibold">{t('detail.reasons')}</h4>
          <ul className="space-y-2 text-sm leading-6 text-muted-foreground">
            {strategy.reasons.map((reason) => <li key={reason} className="flex gap-2"><Check size={16} className="mt-1 shrink-0 text-primary" />{reason}</li>)}
          </ul>
        </div>
        <div className="indicator-grid">
          <span>MA5 <b>{formatPrice(strategy.indicators.ma5)}</b></span>
          <span>MA10 <b>{formatPrice(strategy.indicators.ma10)}</b></span>
          <span>MA20 <b>{formatPrice(strategy.indicators.ma20)}</b></span>
          <span>ATR14 <b>{formatPrice(strategy.indicators.atr14)}</b></span>
          <span>RSI14 <b>{strategy.indicators.rsi14.toFixed(1)}</b></span>
          <span>量比 <b>{strategy.indicators.volumeRatio.toFixed(2)}</b></span>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t('detail.disclaimer')}{staleLive ? t('detail.priceClosed') : liveQuote && isLivePricePhase(phase) ? t('detail.priceLive') : t('detail.priceClosed')}</p>
        <button type="button" className="button-primary w-full" onClick={copyPlan}>
          {copied ? <Check size={17} /> : <Copy size={17} />}{copied ? t('detail.copied') : t('detail.copy')}
        </button>
      </DialogContent>
    </Dialog>
  )
}
