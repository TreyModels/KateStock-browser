import { useEffect, useState } from 'react'
import { localeOf, useI18n } from '@/lib/i18n'
import type { Snapshot } from '@/lib/snapshot'

export function ReportStatus({ report, loading, cached, error, onRetry }: { report: Snapshot | null; loading: boolean; cached: boolean; error: boolean; onRetry: () => void }) {
  const { t, lang } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer) }, [])
  const age = report ? Math.max(0, Math.floor((now - Date.parse(report.generatedAt)) / 3600000)) : 0
  const stale = report ? age >= 48 : true
  const time = report ? new Intl.DateTimeFormat(localeOf(lang), { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.generatedAt)) : '—'
  const state = report
    ? (error || cached ? t('report.state.cached') : t('report.state.loaded'))
    : loading ? t('report.state.loading') : t('report.state.none')
  return <section className="report-status" aria-live="polite">
    <div><strong>{t('report.title')}</strong><span className="report-badge">{t('report.badge', { state })}</span></div>
    {report ? <><p>{t('report.tradeDate', { date: report.tradeDate })} {t('report.generated', { time })} {t('report.age', { n: age })}</p><p>{t('report.source')} <a href={report.sourceUrl} target="_blank" rel="noreferrer">{report.source} ↗</a> {t('report.coverage')} {report.coverage}</p>{report.ai?.status === 'available' ? <p><b>{t('report.ai')}</b>{report.ai.text} <small>{t('report.aiNote')}</small></p> : <p>{t('report.aiUnavailable')}</p>}{(stale || report.partial || error) && <p className="report-warning">{stale ? `${t('report.stale')} ` : ''}{report.partial ? t('report.partial', { list: report.failures.join('、') || '—' }) : ''}{error ? t('report.updateFailed') : ''}</p>}</> : <p>{t('report.none')}</p>}
    <button type="button" className="text-button" onClick={onRetry} disabled={loading}>{loading ? t('report.checking') : t('report.check')}</button>
  </section>
}
