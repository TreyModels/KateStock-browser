import type { Snapshot } from '@/lib/snapshot'
import type { Stock } from '@/types'

export function PublicStocks({ report, stocks, onImport }: { report: Snapshot | null; stocks: Stock[]; onImport: () => void }) {
  const quotes = report ? Object.values(report.quotes).sort((a, b) => a.code.localeCompare(b.code)) : []
  const names = new Map(stocks.map(stock => [stock.code, stock.name]))
  if (!report) return null
  return <section className="public-stocks" aria-labelledby="public-stocks-title">
    <div className="public-stocks-heading"><div><span className="section-kicker">STOCK WATCHLIST</span><h2 id="public-stocks-title">股票清单行情</h2><p>交易日 {report.tradeDate} · 收盘日线，非实时 · {quotes.length} 只有行情</p></div><button type="button" className="button-secondary" onClick={onImport}>导入私人清单</button></div>
    <p className="public-stocks-note">以下代码由定时任务计算公开规则信号，不代表当前持仓；规则分数不是收益概率。导入私人清单后，可在本设备计算个人风险。</p>
    <div className="public-stocks-grid">{quotes.map(quote => <article className="public-stock" key={quote.code}>
      <div><strong>{names.get(quote.code) || quote.code}</strong>{names.has(quote.code) && <small>{quote.code}</small>}</div>
      <div className="public-stock-price"><strong>¥{quote.price.toFixed(2)}</strong><span className={quote.changePct >= 0 ? 'market-up' : 'market-down'}>{quote.changePct >= 0 ? '+' : ''}{quote.changePct.toFixed(2)}%</span></div>
      {report.signals?.[quote.code] && <div className="public-stock-signal"><strong>{report.signals[quote.code].actionLabel}</strong><span>规则分数 {report.signals[quote.code].score}</span><p>{report.signals[quote.code].summary}</p><details><summary>计算依据</summary>{report.signals[quote.code].reasons.map(reason => <p key={reason}>{reason}</p>)}</details></div>}
    </article>)}</div>
    {report.partial && <p className="public-stock-warning">部分证券本次未更新，请查看上方来源状态。未展示失败证券的价格。</p>}
  </section>
}
