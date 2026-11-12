import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Strategy } from '@/types'
import { formatPrice } from './StrategyCard'
import { Sparkline } from './Sparkline'

export function StrategyDetailDialog({ strategy, open, onOpenChange }: { strategy?: Strategy; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [copied, setCopied] = useState(false)
  if (!strategy) return null

  const copyPlan = async () => {
    const text = `${strategy.name} ${strategy.code}｜${strategy.actionLabel}\n${strategy.summary}\n触发：${formatPrice(strategy.trigger)}｜保护：${formatPrice(strategy.stop)}｜目标：${formatPrice(strategy.target)}\n${strategy.reasons.join('；')}\n数据日期：${strategy.tradeDate}。仅为量化规则参考。`
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
            <DialogTitle>{strategy.name} · 今日计划</DialogTitle>
          </div>
          <DialogDescription>{strategy.code} · {strategy.tradeDate} · {strategy.source === 'auto' ? '自动日线' : '手动行情'}</DialogDescription>
        </DialogHeader>
        <div className="mt-1 flex items-end justify-between gap-3">
          <div>
            <span className="number-text text-3xl font-semibold">{formatPrice(strategy.price)}</span>
            <span className={`number-text ml-2 text-sm ${strategy.changePct >= 0 ? 'market-up' : 'market-down'}`}>{strategy.changePct >= 0 ? '+' : ''}{strategy.changePct.toFixed(2)}%</span>
          </div>
          <span className={`signal-pill ${strategy.action === 'stop' || strategy.action === 'reduce' ? 'signal-risk' : strategy.action === 'watch' ? 'signal-wait' : strategy.action === 'hold' ? 'signal-hold' : 'signal-buy'}`}>{strategy.actionLabel}</span>
        </div>
        <Sparkline bars={strategy.bars} positive={strategy.changePct >= 0} large />
        <p className="text-[15px] leading-6">{strategy.summary}</p>
        <div className="grid grid-cols-3 gap-2">
          {[['触发价', strategy.trigger], ['保护位', strategy.stop], ['目标位', strategy.target]].map(([label, value]) => (
            <div className="level-box" key={label as string}><span>{label}</span><strong className="number-text">{formatPrice(value as number)}</strong></div>
          ))}
        </div>
        {strategy.suggestedShares !== undefined && (
          <div className="risk-ticket">
            <span>风险预算下的参考上限</span>
            <strong>{strategy.suggestedShares} 股 · 约 {strategy.suggestedPositionPct}% 仓位</strong>
            <small>按整手向下取整，并受单笔风险与最大仓位双重限制。</small>
          </div>
        )}
        <div>
          <h4 className="mb-2 text-sm font-semibold">信号依据</h4>
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
        <p className="text-xs leading-5 text-muted-foreground">策略基于固定规则生成，未考虑涨跌停、流动性、滑点和你的完整财务状况，不构成收益承诺。</p>
        <button type="button" className="button-primary w-full" onClick={copyPlan}>
          {copied ? <Check size={17} /> : <Copy size={17} />}{copied ? '已复制计划' : '复制今日计划'}
        </button>
      </DialogContent>
    </Dialog>
  )
}
