import type { Snapshot } from '@/lib/snapshot'
import { useI18n } from '@/lib/i18n'
import type { MarketRegime } from '@/lib/regime'
import type { LiveQuote, MarketPhase, Stock, StrategyAction } from '@/types'
import { LivePrice } from './live/LivePrice'
import { formatBeijingClock, formatBeijingDate, isLivePricePhase } from './live/quote-utils'

export function PublicStocks({ report, stocks, onImport, liveQuotes = {}, liveErrors = {}, phase, regime, actionFilter = null, actionFilterLabel, onClearFilter }: {
  report: Snapshot | null
  stocks: Stock[]
  onImport: () => void
  liveQuotes?: Record<string, LiveQuote>
  liveErrors?: Record<string, string>
  phase: MarketPhase
  regime?: MarketRegime
  /** 策略排名选中的 action：同时过滤公开清单（个人清单由 App 过滤） */
  actionFilter?: StrategyAction | null
  actionFilterLabel?: string
  onClearFilter?: () => void
}) {
  const { t } = useI18n()
  const quotes = report ? Object.values(report.quotes).sort((a, b) => a.code.localeCompare(b.code)) : []
  const names = new Map(stocks.map(stock => [stock.code, stock.name]))
  if (!report) return null
  const displayedQuotes = actionFilter
    ? quotes.filter((quote) => report.signals?.[quote.code]?.action === actionFilter)
    : quotes

  const liveCount = quotes.filter(quote => liveQuotes[quote.code]).length
  const freshLiveCount = quotes.filter(quote => liveQuotes[quote.code] && !liveErrors[quote.code]).length
  const latestAt = quotes.reduce<string | undefined>((latest, quote) => {
    const at = liveQuotes[quote.code]?.updatedAt
    return at && (!latest || at > latest) ? at : latest
  }, undefined)
  const latestDate = formatBeijingDate(latestAt)
  const snapshotDate = report.tradeDate
  const liveNow = isLivePricePhase(phase)
  const closedPhase = phase === 'closed' || phase === 'non-trading'

  // 区分「快照交易日」与「最新收盘/最新报价」，15:00–16:45 快照未重算时不误导。
  let stamp: string
  if (liveNow && freshLiveCount > 0) {
    stamp = `${t('public.intradayQuote', { time: formatBeijingClock(latestAt) })} · ${t('public.snapshotDay', { date: snapshotDate })}`
  } else if (liveNow && liveCount > 0) {
    stamp = `${t('quote.lastQuote', { time: formatBeijingClock(latestAt) })} · ${t('public.snapshotDay', { date: snapshotDate })}`
  } else if (latestDate) {
    const latestLabel = t(closedPhase ? 'public.latestClose' : 'public.latestQuote', { date: latestDate })
    stamp = latestDate === snapshotDate
      ? t('public.snapshotSame', { date: snapshotDate })
      : `${t('public.snapshotDay', { date: snapshotDate })} · ${latestLabel}${closedPhase ? t('public.snapshotOutdated') : ''}`
  } else {
    stamp = `${t('public.snapshotDay', { date: snapshotDate })} · ${t('public.baseNote')}`
  }
  const snapshotOutdated = latestDate !== undefined && latestDate > snapshotDate

  return <section className="public-stocks" aria-labelledby="public-stocks-title">
    <div className="public-stocks-heading"><div><span className="section-kicker">{t('public.kicker')}</span><h2 id="public-stocks-title">{t('public.title')}</h2><p>{stamp} · {t('public.quotesCount', { n: displayedQuotes.length })}</p></div><button type="button" className="button-secondary" onClick={onImport}>{t('public.importPrivate')}</button></div>
    <p className="public-stocks-note">{t('public.note')} {t('public.regimeNote')}</p>
    {actionFilter && (
      <div className="public-filter-bar">
        <span>{t('public.filterActive', { label: actionFilterLabel ?? actionFilter, n: displayedQuotes.length })}</span>
        {onClearFilter && <button type="button" onClick={onClearFilter}>{t('public.clearFilter')}</button>}
      </div>
    )}
    {snapshotOutdated && <p className="public-stocks-stale-note">{t('public.staleNote', { date: snapshotDate })}</p>}
    <div className="public-stocks-grid">{displayedQuotes.map(quote => {
      const live = liveQuotes[quote.code]
      const liveFailed = Boolean(liveErrors[quote.code])
      const price = live?.price ?? quote.price
      const changePct = live?.changePct ?? quote.changePct
      const signal = report.signals?.[quote.code]
      const isBuy = signal?.action === 'breakout' || signal?.action === 'pullback'
      const blocked = regime === 'bear' && isBuy
      const half = regime === 'range' && isBuy
      const displayLabel = blocked ? t('public.bearWait') : signal?.actionLabel
      const badge = blocked ? t('public.bearDisabled') : half ? t('public.rangeHalf') : null
      return <article className={`public-stock${blocked ? ' is-blocked' : ''}`} key={quote.code}>
        <div><strong>{names.get(quote.code) || quote.code}</strong>{names.has(quote.code) && <small>{quote.code}</small>}</div>
        <div className="public-stock-price"><LivePrice value={price} changePct={changePct} phase={phase} live={Boolean(live)} stale={liveFailed} quoteAt={live?.updatedAt} size="compact" /></div>
        {signal && <div className={`public-stock-signal${blocked ? ' is-blocked' : ''}`}>
          <strong>{displayLabel}</strong>
          {badge && <span className="public-stock-badge">{badge}</span>}
          {badge
            ? <span>{t('public.originalSignal', { label: signal.actionLabel, score: signal.score })}</span>
            : <span>{signal.actionLabel} · {signal.score}</span>}
          <p>{signal.summary}</p>
          <details><summary>{t('public.reasons')}</summary>{signal.reasons.map(reason => <p key={reason}>{reason}</p>)}</details>
        </div>}
      </article>
    })}</div>
    {actionFilter && displayedQuotes.length === 0 && <p className="public-stock-warning">{t('public.emptyFiltered')}</p>}
    {report.partial && <p className="public-stock-warning">{t('public.warning')}</p>}
  </section>
}
