import type { Snapshot } from '@/lib/snapshot'
import type { LiveQuote, MarketPhase, Stock } from '@/types'
import { LivePrice } from './live/LivePrice'
import { formatBeijingClock, formatBeijingDate, isLivePricePhase } from './live/quote-utils'

export function PublicStocks({ report, stocks, onImport, liveQuotes = {}, liveErrors = {}, phase }: {
  report: Snapshot | null
  stocks: Stock[]
  onImport: () => void
  liveQuotes?: Record<string, LiveQuote>
  liveErrors?: Record<string, string>
  phase: MarketPhase
}) {
  const quotes = report ? Object.values(report.quotes).sort((a, b) => a.code.localeCompare(b.code)) : []
  const names = new Map(stocks.map(stock => [stock.code, stock.name]))
  if (!report) return null

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
  const latestLabel = closedPhase ? '最新收盘' : '最新报价'

  // 区分「快照交易日」与「最新收盘/最新报价」：15:00–16:45 快照尚未重算时不能被误读成同一交易日。
  let stamp: string
  if (liveNow && freshLiveCount > 0) {
    stamp = `盘中报价 ${formatBeijingClock(latestAt)} · 快照交易日 ${snapshotDate}`
  } else if (liveNow && liveCount > 0) {
    // 本轮全部刷新失败、只沿用上次报价：不能写「盘中报价」。
    stamp = `上次报价 ${formatBeijingClock(latestAt)}（未刷新）· 快照交易日 ${snapshotDate}`
  } else if (latestDate) {
    stamp = latestDate === snapshotDate
      ? `快照交易日/${latestLabel} ${snapshotDate}`
      : `快照交易日 ${snapshotDate} · ${latestLabel} ${latestDate}${closedPhase ? '（快照尚未更新）' : ''}`
  } else {
    stamp = `快照交易日 ${snapshotDate} · 收盘日线，非实时`
  }
  const snapshotOutdated = latestDate !== undefined && latestDate > snapshotDate

  return <section className="public-stocks" aria-labelledby="public-stocks-title">
    <div className="public-stocks-heading"><div><span className="section-kicker">STOCK WATCHLIST</span><h2 id="public-stocks-title">股票清单行情</h2><p>{stamp} · {quotes.length} 只有行情</p></div><button type="button" className="button-secondary" onClick={onImport}>导入私人清单</button></div>
    <p className="public-stocks-note">以下代码由定时任务计算公开规则信号，不代表当前持仓；规则分数不是收益概率。导入私人清单后，可在本设备计算个人风险。公开清单只有收盘信号、没有触发/保护/目标价位，也不区分持仓状态，因此不会产生盘中提醒。</p>
    {snapshotOutdated && <p className="public-stocks-stale-note">收盘快照与策略信号仍来自 {snapshotDate}；定时任务更新快照前，策略价位以快照为准，价格显示最新报价。</p>}
    <div className="public-stocks-grid">{quotes.map(quote => {
      const live = liveQuotes[quote.code]
      const liveFailed = Boolean(liveErrors[quote.code])
      const price = live?.price ?? quote.price
      const changePct = live?.changePct ?? quote.changePct
      return <article className="public-stock" key={quote.code}>
        <div><strong>{names.get(quote.code) || quote.code}</strong>{names.has(quote.code) && <small>{quote.code}</small>}</div>
        <div className="public-stock-price"><LivePrice value={price} changePct={changePct} phase={phase} live={Boolean(live)} stale={liveFailed} quoteAt={live?.updatedAt} size="compact" /></div>
        {report.signals?.[quote.code] && <div className="public-stock-signal"><strong>{report.signals[quote.code].actionLabel}</strong><span>规则分数 {report.signals[quote.code].score}</span><p>{report.signals[quote.code].summary}</p><details><summary>计算依据</summary>{report.signals[quote.code].reasons.map(reason => <p key={reason}>{reason}</p>)}</details></div>}
      </article>
    })}</div>
    {report.partial && <p className="public-stock-warning">部分证券本次未更新，请查看上方来源状态。未展示失败证券的价格。</p>}
  </section>
}
