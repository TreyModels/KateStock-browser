import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { MarketRegime } from '@/lib/regime'
import type { EvidenceState, StrategyScore } from '@/lib/strategy-ranking'
import type { StrategyAction } from '@/types'

const STATUS_LABELS: Record<StrategyScore['status'], string> = {
  active: '生效',
  degraded: '降级',
  blocked: '禁用',
}

const EVIDENCE_LABELS: Record<EvidenceState, string> = {
  PASS: '证据：通过',
  PARTIAL: '证据：部分验证',
  UNKNOWN: '证据：未验证',
  FAIL: '证据：未通过',
}

/**
 * 今日策略排名（第一屏主面板）：按适配度排序，点击一行筛选下方优先清单。
 * 禁用策略（熊市里的突破/回踩）保留并灰化，显式展示「现在不该做什么」。
 */
export function StrategyRanking({
  rows,
  regime,
  selectedAction,
  selectedId,
  onSelect,
  onScrollToList,
}: {
  rows: StrategyScore[]
  regime?: MarketRegime
  /** 供筛选清单用（action 可能与多行共享，例如「观望等待」与「超跌反弹」） */
  selectedAction: StrategyAction | null
  /** 供高亮行用（唯一 id，避免同 action 多行同时高亮） */
  selectedId: string | null
  onSelect: (action: StrategyAction | null, id?: string) => void
  onScrollToList: () => void
}) {
  const [expandedId, setExpandedId] = useState<StrategyScore['id'] | null>(null)
  const sorted = [...rows].sort((a, b) => b.confidence - a.confidence)
  const selectedRow = sorted.find((row) => row.id === selectedId)

  return (
    <section className="rank-panel" aria-labelledby="rank-title">
      <div className="rank-panel-heading">
        <div>
          <span className="section-kicker">STRATEGY RANKING</span>
          <h2 id="rank-title">今日策略排名</h2>
          <p className="rank-panel-sub">按适配度排序 · 点击一行筛选下方「今日优先清单」</p>
          <p className="rank-evidence-note">适配度 = 市场状态匹配 × 证据强度 × 当前命中数；买入类策略在中国市场的证据多为未验证（缺 ≥5 年扣费样本），不构成投资建议。</p>
        </div>
        {selectedAction && (
          <button type="button" className="rank-clear" onClick={() => onSelect(null)}>取消筛选</button>
        )}
      </div>

      {sorted.length > 0 ? (
        <ol className="rank-list">
          {sorted.map((row, index) => {
            const blocked = row.status === 'blocked'
            const selected = selectedId === row.id
            const expanded = expandedId === row.id
            const statusText = blocked && regime === 'bear' ? '熊市禁用' : STATUS_LABELS[row.status]
            const confidence = Math.round(row.confidence)
            const evidenceUnknown = row.evidence === 'UNKNOWN'
            return (
              <li key={row.id} className={`rank-row${index === 0 ? ' is-top' : ''}${selected ? ' is-selected' : ''}${blocked ? ' is-blocked' : ''}${evidenceUnknown ? ' is-evidence-unknown' : ''}`}>
                <button
                  type="button"
                  className="rank-main"
                  onClick={() => onSelect(selected ? null : row.action, selected ? undefined : row.id)}
                  aria-pressed={selected}
                  aria-label={`${row.label}，${statusText}，适配度 ${confidence}，命中 ${row.matched} 股，${selected ? '点击取消筛选' : '点击筛选下方清单'}`}
                >
                  <span className="rank-index">{index + 1}</span>
                  <span className="rank-name">{row.label}</span>
                  <span className={`rank-status rank-status-${row.status}`}>{statusText}</span>
                  <span className={`rank-evidence rank-evidence-${row.evidence.toLowerCase()}`}>{EVIDENCE_LABELS[row.evidence]}</span>
                  <span className="rank-confidence-wrap">
                    <strong className="rank-confidence">{confidence}</strong>
                    <small>适配度·非胜率</small>
                  </span>
                </button>
                <div className="rank-row-actions">
                  <button
                    type="button"
                    className="rank-matched"
                    onClick={onScrollToList}
                    aria-label={`命中 ${row.matched} 股，滚动到今日优先清单`}
                  >
                    命中 <b>{row.matched}</b> 股
                  </button>
                  <button
                    type="button"
                    className="rank-reasons-toggle"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : row.id)}
                  >
                    {expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}依据
                  </button>
                </div>
                {expanded && (
                  <ul className="rank-reasons">
                    {row.reasons.length > 0
                      ? row.reasons.map((reason) => <li key={reason}>{reason}</li>)
                      : <li>暂无更多说明</li>}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="rank-empty">暂无可排名的策略：先在「股票」页添加自选/持仓，刷新日线后这里会按市场状态排序。</p>
      )}

      {selectedAction && selectedRow && (
        <p className="rank-filter-note">已按「{selectedRow.label}」筛选下方清单；再点该行取消。</p>
      )}
      <p className="rank-foot">适配度为当前市场状态下的规则适配评分，不是胜率或收益预测；证据状态来自稳健性门槛结论，不构成投资建议。</p>
    </section>
  )
}
