import { useEffect, useState } from 'react'
import type { Snapshot } from '@/lib/snapshot'

export function ReportStatus({ report, loading, cached, error, onRetry }: { report: Snapshot | null; loading: boolean; cached: boolean; error: boolean; onRetry: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer) }, [])
  const age = report ? Math.max(0, Math.floor((now - Date.parse(report.generatedAt)) / 3600000)) : 0
  const stale = report ? age >= 48 : true
  const time = report ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.generatedAt)) : '—'
  return <section className="report-status" aria-live="polite">
    <div><strong>收盘研究快照</strong><span className="report-badge">非实时行情 · {report ? (error || cached ? '本地缓存' : '已加载') : loading ? '加载中' : '暂无报告'}</span></div>
    {report ? <><p>行情交易日 <b>{report.tradeDate}</b> 生成时间（北京时间）{time} 数据年龄 {age} 小时</p><p>来源 <a href={report.sourceUrl} target="_blank" rel="noreferrer">{report.source} ↗</a> 覆盖范围 {report.coverage}</p>{report.ai?.status === 'available' ? <p><b>DeepSeek 研究简述：</b>{report.ai.text} <small>AI 生成，仅供参考；依据上方公开日线数据。</small></p> : <p>AI 研究简述暂不可用；行情与策略仍可使用。</p>}{(stale || report.partial || error) && <p className="report-warning">{stale ? '快照可能过期，请核对最新交易日。 ' : ''}{report.partial ? `部分失败：${report.failures.join('、') || '数据不完整'}。 ` : ''}{error ? '更新失败，保留上次有效快照。' : ''}</p>}</> : <p>尚无可用的已发布快照；本地持仓和手动行情仍可使用。</p>}
    <button type="button" className="text-button" onClick={onRetry} disabled={loading}>{loading ? '检查中…' : '检查报告更新'}</button>
  </section>
}
