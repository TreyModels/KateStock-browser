import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useI18n, type Lang } from '@/lib/i18n'
import type { MarketPhase } from '@/types'
import { RegimeBadge } from './RegimeBadge'
import type { RegimeInfo } from './RegimeBadge'
import { formatBeijingClock, formatDataAge, isLivePricePhase } from './quote-utils'

const phaseKeys: Record<MarketPhase, string> = {
  preopen: 'phase.preopen',
  auction: 'phase.auction',
  trading: 'phase.trading',
  lunch: 'phase.lunch',
  closed: 'phase.closed',
  'non-trading': 'phase.non-trading',
}

export interface MarketStatusBarProps {
  phase: MarketPhase
  updatedAt?: string
  lastAttemptAt?: string
  loading: boolean
  failedCodes: string[]
  successCount: number
  retainedCount: number
  covered: number
  regimeInfo?: RegimeInfo
  autoRefresh: boolean
  onToggleAutoRefresh: () => void
  onRefresh: () => void
  compact?: boolean
}

/**
 * 盘中状态条：MarketPhase 徽标 + 最近报价时间 + 数据年龄 + 成功/失败数 + 自动刷新开关 + 手动刷新。
 * 失败时明确区分「本轮成功」与「沿用上次报价」，不把旧报价算作覆盖，也不冒充实时。
 */
export function MarketStatusBar({
  phase,
  updatedAt,
  lastAttemptAt,
  loading,
  failedCodes,
  successCount,
  retainedCount,
  covered,
  regimeInfo,
  autoRefresh,
  onToggleAutoRefresh,
  onRefresh,
  compact = false,
}: MarketStatusBarProps) {
  const { t, lang } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const failedCount = failedCodes.length
  const errorPreview = failedCodes.slice(0, 3).join('、')
  const staleInLivePhase = isLivePricePhase(phase) && updatedAt !== undefined
    && now - Date.parse(updatedAt) > 2 * 60 * 1000
  const attemptSuffix = lastAttemptAt ? t('status.attempt', { time: formatBeijingClock(lastAttemptAt) }) : ''
  const phaseLabel = t(phaseKeys[phase])
  const phaseNote = t(`phase.note.${phase}`)

  return (
    <section className={`market-status${compact ? ' market-status-compact' : ''}`} aria-label={compact ? phaseLabel : `${phaseLabel}`}>
      <div className="market-status-main">
        <div className="market-status-phase">
          <span className={`phase-badge phase-${phase}`}>
            <span className="phase-dot" aria-hidden="true" />
            {phaseLabel}
          </span>
          {regimeInfo && <RegimeBadge info={regimeInfo} />}
          <span className={`market-status-note${staleInLivePhase ? ' market-status-stale' : ''}`}>
            {staleInLivePhase ? t('status.stale') : phaseNote}
          </span>
        </div>
        <div className="market-status-meta">
          <span>{t('status.recentQuote')} <b>{formatBeijingClock(updatedAt)}</b></span>
          <span>{t('status.dataAge')} <b>{formatDataAge(updatedAt, now, lang as Lang)}</b></span>
          {covered > 0
            ? <span>{t('status.successFail', { ok: successCount, fail: failedCount, all: covered })}</span>
            : <span>{t('status.noCodes')}</span>}
        </div>
        <div className="market-status-actions">
          <label className="live-switch">
            <Switch className="live-switch-control" checked={autoRefresh} onCheckedChange={() => onToggleAutoRefresh()} aria-label={t('status.refreshAria')} />
            <span>{t('status.autoRefresh')}</span>
          </label>
          <button type="button" className="button-secondary live-refresh" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            {loading ? t('status.refreshing') : t('status.refreshQuote')}
          </button>
        </div>
      </div>
      {failedCount > 0 && (
        <p className="market-status-error" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {retainedCount > 0
              ? `${t('status.errorRetained', { n: failedCount })}${attemptSuffix}${failedCount > retainedCount ? ` (${t('status.fail')} ${failedCount - retainedCount})` : ''}: ${errorPreview}${failedCount > 3 ? '…' : ''}. ${t('status.quoteAnnotated')}`
              : `${t('status.errorNoQuote', { n: failedCount })}${attemptSuffix}: ${errorPreview}${failedCount > 3 ? '…' : ''}.`}
          </span>
        </p>
      )}
      {!compact && (
        <p className="market-status-foot">
          <Activity size={12} aria-hidden="true" /> {t('status.foot')}
        </p>
      )}
    </section>
  )
}
