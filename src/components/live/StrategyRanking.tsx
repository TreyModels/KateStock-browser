import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { MarketRegime } from '@/lib/regime'
import type { EvidenceState, StrategyScore } from '@/lib/strategy-ranking'
import type { StrategyAction } from '@/types'

/**
 * 今日策略排名（第一屏主面板）：按适配度排序，点击一行筛选下方优先清单。
 * 禁用策略（熊市里的突破/回踩）保留并灰化，显式展示「现在不该做什么」。
 */
export function StrategyRanking({
  rows,
  hasAnyData,
  regime,
  selectedAction,
  selectedId,
  onSelect,
  onScrollToList,
}: {
  rows: StrategyScore[]
  /** 个人策略与公开快照信号都为空时，展示空态而不是一排 0 */
  hasAnyData: boolean
  regime?: MarketRegime
  selectedAction: StrategyAction | null
  selectedId: string | null
  onSelect: (action: StrategyAction | null, id?: string) => void
  onScrollToList: () => void
}) {
  const { t } = useI18n()
  const [expandedId, setExpandedId] = useState<StrategyScore['id'] | null>(null)
  const sorted = [...rows].sort((a, b) => b.confidence - a.confidence)
  const selectedRow = sorted.find((row) => row.id === selectedId)
  const statusLabel = (status: StrategyScore['status'], blocked: boolean) => {
    if (blocked && regime === 'bear') return t('ranking.status.bearBlocked')
    return t(`ranking.status.${status}`)
  }
  const evidenceLabel = (evidence: EvidenceState) => t(`ranking.evidence.${evidence.toLowerCase()}`)

  return (
    <section className="rank-panel" aria-labelledby="rank-title">
      <div className="rank-panel-heading">
        <div>
          <span className="section-kicker">{t('ranking.kicker')}</span>
          <h2 id="rank-title">{t('ranking.title')}</h2>
          <p className="rank-panel-sub">{t('ranking.sub')}</p>
          <p className="rank-evidence-note">{t('ranking.note')}</p>
        </div>
        {selectedAction && (
          <button type="button" className="rank-clear" onClick={() => onSelect(null)}>{t('ranking.clear')}</button>
        )}
      </div>

      {hasAnyData && sorted.length > 0 ? (
        <ol className="rank-list">
          {sorted.map((row, index) => {
            const blocked = row.status === 'blocked'
            const selected = selectedId === row.id
            const expanded = expandedId === row.id
            const statusText = statusLabel(row.status, blocked)
            const confidence = Math.round(row.confidence)
            const matchedText = t('ranking.matched', { n: row.matched })
            return (
              <li key={row.id} className={`rank-row${index === 0 ? ' is-top' : ''}${selected ? ' is-selected' : ''}${blocked ? ' is-blocked' : ''}${row.evidence === 'UNKNOWN' ? ' is-evidence-unknown' : ''}`}>
                <button
                  type="button"
                  className="rank-main"
                  onClick={() => onSelect(selected ? null : row.action, selected ? undefined : row.id)}
                  aria-pressed={selected}
                  aria-label={t('ranking.rowAria', {
                    label: row.label,
                    status: statusText,
                    confidence,
                    matched: row.matched,
                    action: selected ? t('ranking.clear') : t('common.strategy'),
                  })}
                >
                  <span className="rank-index">{index + 1}</span>
                  <span className="rank-name">{row.label}</span>
                  <span className={`rank-status rank-status-${row.status}`}>{statusText}</span>
                  <span className={`rank-evidence rank-evidence-${row.evidence.toLowerCase()}`}>{evidenceLabel(row.evidence)}</span>
                  <span className="rank-confidence-wrap">
                    <strong className="rank-confidence">{confidence}</strong>
                    <small>{t('ranking.confidence')}</small>
                  </span>
                </button>
                <div className="rank-row-actions">
                  <button
                    type="button"
                    className="rank-matched"
                    onClick={onScrollToList}
                    aria-label={t('ranking.matchedAria', { n: row.matched })}
                  >
                    <span>{matchedText}</span>
                  </button>
                  <button
                    type="button"
                    className="rank-reasons-toggle"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : row.id)}
                  >
                    {expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}{t('ranking.reasons')}
                  </button>
                </div>
                {expanded && (
                  <ul className="rank-reasons">
                    {row.reasons.length > 0
                      ? row.reasons.map((reason) => <li key={reason}>{reason}</li>)
                      : <li>{t('common.notAdded')}</li>}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="rank-empty">{hasAnyData ? t('ranking.empty') : t('ranking.emptyNoData')}</p>
      )}

      {selectedAction && selectedRow && (
        <p className="rank-filter-note">{t('ranking.filterNote', { label: selectedRow.label })}</p>
      )}
      <p className="rank-foot">{t('ranking.foot')}</p>
    </section>
  )
}
