import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { phaseLabel } from '@/lib/live'
import type { MarketPhase } from '@/types'
import { RegimeBadge } from './RegimeBadge'
import type { RegimeInfo } from './RegimeBadge'
import { formatBeijingClock, formatDataAge, isLivePricePhase } from './quote-utils'

const phaseNotes: Record<MarketPhase, string> = {
  preopen: '盘前时段，暂无盘中报价',
  auction: '集合竞价中，价格可能跳动',
  trading: '盘中报价来自公开接口，可能有延迟',
  lunch: '午间休市，报价暂停更新',
  closed: '已收盘，显示收盘价',
  'non-trading': '非交易日，显示最近收盘价',
}

export interface MarketStatusBarProps {
  phase: MarketPhase
  /** 最近一笔报价的 provider 时间（ISO，来自 LiveQuote.updatedAt）；无报价为 undefined */
  updatedAt?: string
  /** 最近一次真正发起拉取的时刻（ISO，无论成败）；用于说明「上次尝试」 */
  lastAttemptAt?: string
  loading: boolean
  /** 本轮失败且属于「当前订阅集合」的代码（由 App 按 liveCodes 过滤，保证与成功数同一口径） */
  failedCodes: string[]
  /** 本轮刷新成功的代码数 */
  successCount: number
  /** 本轮失败但仍沿用上次报价的代码数 */
  retainedCount: number
  /** 订阅代码数 */
  covered: number
  /** 大盘状态徽标数据（useRegime）；未提供时不渲染徽标 */
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
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const failedCount = failedCodes.length
  const errorPreview = failedCodes.slice(0, 3).join('、')
  // 交易时段内数据年龄超过 2 分钟，提示可能延迟；非交易时段的陈旧属预期（收盘价）。
  const staleInLivePhase = isLivePricePhase(phase) && updatedAt !== undefined
    && now - Date.parse(updatedAt) > 2 * 60 * 1000
  const attemptSuffix = lastAttemptAt ? `（上次尝试 ${formatBeijingClock(lastAttemptAt)}）` : ''

  return (
    <section className={`market-status${compact ? ' market-status-compact' : ''}`} aria-label="盘中状态">
      <div className="market-status-main">
        <div className="market-status-phase">
          <span className={`phase-badge phase-${phase}`}>
            <span className="phase-dot" aria-hidden="true" />
            {phaseLabel(phase)}
          </span>
          {regimeInfo && <RegimeBadge info={regimeInfo} />}
          <span className={`market-status-note${staleInLivePhase ? ' market-status-stale' : ''}`}>{staleInLivePhase ? '盘中报价可能延迟，请注意数据年龄' : phaseNotes[phase]}</span>
        </div>
        <div className="market-status-meta">
          <span>最近报价 <b>{formatBeijingClock(updatedAt)}</b></span>
          <span>数据年龄 <b>{formatDataAge(updatedAt, now)}</b></span>
          {covered > 0
            ? <span>成功 <b>{successCount}</b> / 失败 <b>{failedCount}</b> / 订阅 <b>{covered}</b></span>
            : <span>尚未订阅代码</span>}
        </div>
        <div className="market-status-actions">
          <label className="live-switch">
            <Switch className="live-switch-control" checked={autoRefresh} onCheckedChange={() => onToggleAutoRefresh()} aria-label="自动刷新盘中报价" />
            <span>自动刷新</span>
          </label>
          <button type="button" className="button-secondary live-refresh" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            {loading ? '刷新中…' : '刷新报价'}
          </button>
        </div>
      </div>
      {failedCount > 0 && (
        <p className="market-status-error" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {retainedCount > 0
              ? `${failedCount} 只沿用上次报价，未刷新${attemptSuffix}${failedCount > retainedCount ? `（其中 ${failedCount - retainedCount} 只暂无报价）` : ''}：${errorPreview}${failedCount > 3 ? '…' : ''}。价格旁标注了上次报价时间。`
              : `${failedCount} 只报价失败，暂无可用盘中报价${attemptSuffix}：${errorPreview}${failedCount > 3 ? '…' : ''}。`}
          </span>
        </p>
      )}
      {!compact && (
        <p className="market-status-foot">
          <Activity size={12} aria-hidden="true" /> 盘中报价来自公开行情接口，可能延迟或中断；失败时沿用上次报价并标注时间，不冒充实时。收盘后显示收盘价。提醒仅为规则化提示，不构成投资建议。
        </p>
      )}
    </section>
  )
}
