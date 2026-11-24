import { useState } from 'react'
import { AlertTriangle, LoaderCircle, RefreshCw, TrendingDown, TrendingUp, Waves } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** 大盘状态（与 useRegime 契约一致）。 */
export type RegimeKey = 'bull' | 'range' | 'bear'

export interface RegimeInfo {
  regime?: RegimeKey
  confidence?: number
  asOf?: string
  source?: 'index' | 'breadth' | string
  evidence?: string[]
  breadthPct?: number
  loading?: boolean
  error?: string | null
  refresh?: () => void
  /** source=breadth 时的公开清单样本数（只用于文案说明） */
  sampleSize?: number
}

const regimeLabels: Record<RegimeKey, string> = { bull: '牛市', range: '震荡市', bear: '熊市' }

const regimeIcons: Record<RegimeKey, typeof TrendingUp> = {
  bull: TrendingUp,
  range: Waves,
  bear: TrendingDown,
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatAsOf(iso?: string): string {
  if (!iso) return '—'
  const time = Date.parse(iso)
  return Number.isNaN(time) ? '—' : dateFormatter.format(time)
}

/** 置信度统一成 0–100（兼容 0–1 小数）。 */
function toPercent(value?: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const pct = value <= 1 ? value * 100 : value
  return Math.min(100, Math.max(0, Math.round(pct)))
}

/**
 * 大盘状态徽标：文字 + 置信度（不只靠颜色），点击展开 evidence 与数据日期。
 * 徽标和详情弹窗都使用主题强调色，切换 regime 时随 CSS 变量过渡。
 */
export function RegimeBadge({ info }: { info: RegimeInfo }) {
  const [open, setOpen] = useState(false)
  const { regime, confidence, asOf, source, evidence = [], breadthPct, loading, error, refresh, sampleSize } = info
  const confidencePct = toPercent(confidence)
  const label = regime ? regimeLabels[regime] : error ? '大盘状态不可用' : loading ? '大盘状态加载中' : '大盘状态待定'
  const confidenceText = confidencePct !== undefined ? `置信度 ${confidencePct}%` : ''
  const Icon = regime ? regimeIcons[regime] : Waves
  const ariaLabel = regime
    ? `大盘状态：${label}${confidenceText ? `，${confidenceText}` : ''}，点击查看依据与数据日期`
    : `${label}，点击查看详情与重试`
  const breadthText = breadthPct !== undefined && Number.isFinite(breadthPct) ? `${breadthPct.toFixed(1)}%` : undefined
  const sourceText = source === 'breadth'
    ? `公开清单广度${sampleSize ? `（样本：公开清单 ${sampleSize} 只）` : '（样本：公开清单）'}`
    : source === 'index'
      ? '指数趋势（上证/深证等）'
      : source ?? '数据来源待确认'

  return (
    <>
      <button
        type="button"
        className={`regime-badge${regime ? ` regime-${regime}` : ''}`}
        onClick={() => setOpen(true)}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        title={evidence.length ? evidence.join('；') : undefined}
      >
        {/* 视觉上是紧凑徽标，按钮本体保持 44px 触控高度 */}
        <span className="regime-pill">
          <Icon size={13} aria-hidden="true" />
          <span className="regime-label">{label}</span>
          {confidenceText && <span className="regime-confidence">{confidenceText}</span>}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="stock-dialog regime-dialog">
          <DialogHeader>
            <DialogTitle>大盘状态 · {label}</DialogTitle>
            <DialogDescription>用于页面配色与情绪参考，不是买卖信号，也不构成投资建议。</DialogDescription>
          </DialogHeader>
          {loading && !regime && !error && (
            <p className="regime-status-line"><LoaderCircle size={16} className="spin" aria-hidden="true" />正在判断大盘状态…</p>
          )}
          {error && (
            <p className="regime-status-line regime-error"><AlertTriangle size={16} aria-hidden="true" />{error}</p>
          )}
          {regime && (
            <>
              <div className="regime-dialog-headline">
                <Icon size={20} aria-hidden="true" />
                <strong>{label}</strong>
                {confidencePct !== undefined && <span>置信度 {confidencePct}%</span>}
              </div>
              {confidencePct !== undefined && (
                <div className="regime-meter" role="img" aria-label={`置信度 ${confidencePct}%`}>
                  <span style={{ width: `${confidencePct}%` }} />
                </div>
              )}
              <div className="regime-facts">
                <div><span>数据日期</span><strong>{formatAsOf(asOf)}</strong></div>
                <div><span>判断依据</span><strong>{sourceText}</strong></div>
                {breadthText && <div><span>上涨占比</span><strong>{breadthText}</strong></div>}
              </div>
              {evidence.length > 0 && (
                <div>
                  <h4 className="regime-evidence-title">依据明细</h4>
                  <ul className="regime-evidence">
                    {evidence.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
          {!regime && !error && !loading && (
            <p className="regime-status-line">暂未取得大盘状态数据，可以稍后重试。</p>
          )}
          <div className="regime-dialog-actions">
            {refresh && (
              <button type="button" className="button-secondary" onClick={() => void refresh()} disabled={loading}>
                <RefreshCw size={16} className={loading ? 'spin' : ''} aria-hidden="true" />
                {loading ? '刷新中…' : '刷新判断'}
              </button>
            )}
          </div>
          <p className="regime-footnote">大盘状态由公开指数或公开清单广度推断，可能延迟或误判；不构成任何收益承诺。</p>
        </DialogContent>
      </Dialog>
    </>
  )
}
