import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownToLine, ArrowUpRight, BarChart3, BookOpen, ChevronRight,
  Database, Gauge, History, LayoutDashboard, List, LoaderCircle,
  Plus, RefreshCw, Search, Settings, ShieldCheck, Smartphone, Trash2, Upload,
} from 'lucide-react'
import { Toaster, toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { PublicStocks } from '@/components/PublicStocks'
import { ReportStatus } from '@/components/ReportStatus'
import { mergeImportedStocks, parseStocksJson, portfolioMarkdown, readPortfolioFile } from '@/lib/stockImport'
import { mergeSnapshotQuotes, readCachedSnapshot, saveSnapshot, snapshotSchema } from '@/lib/snapshot'
import type { Snapshot } from '@/lib/snapshot'
import { ResearchSettings } from '@/components/ResearchSettings'
import { QuantsLibrary } from '@/components/QuantsLibrary'
import { BacktestLab } from '@/components/BacktestLab'
import { StockDialog } from '@/components/StockDialog'
import { StrategyCard, formatPrice } from '@/components/StrategyCard'
import { StrategyDetailDialog } from '@/components/StrategyDetailDialog'
import { useLocalData } from '@/hooks/useLocalData'
import { fetchQuotes } from '@/lib/market'
import { generateStrategy } from '@/lib/strategy'
import type { Quote, Stock, StockStatus } from '@/types'
import './App.css'

type View = 'today' | 'stocks' | 'backtest' | 'rules' | 'settings' | 'library'
type SignalFilter = 'all' | 'buy' | 'risk' | 'wait'

const views: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'today', label: '今日', icon: LayoutDashboard },
  { id: 'stocks', label: '股票', icon: List },
  { id: 'library', label: '策略库', icon: BookOpen },
  { id: 'backtest', label: '回测', icon: BarChart3 },
  { id: 'rules', label: '策略', icon: BookOpen },
  { id: 'settings', label: '我的', icon: Settings },
]

const statusLabels: Record<StockStatus, string> = { history: '历史记录', holding: '当前持仓', watch: '当前自选' }
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function App() {
  const { data, setData, resetData } = useLocalData()
  const [view, setView] = useState<View>('today')
  const [signalFilter, setSignalFilter] = useState<SignalFilter>('all')
  const [stockFilter, setStockFilter] = useState<'all' | StockStatus>('all')
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [progress, setProgress] = useState<[number, number]>([0, 0])
  const [stockDialogOpen, setStockDialogOpen] = useState(false)
  const [editingStock, setEditingStock] = useState<Stock | undefined>()
  const [selectedCode, setSelectedCode] = useState<string>()
  const [deleteStock, setDeleteStock] = useState<Stock | undefined>()
  const [resetOpen, setResetOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const zipRef = useRef<HTMLInputElement>(null)
  const [report, setReport] = useState<Snapshot | null>(readCachedSnapshot)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState(false)
  const [reportCached, setReportCached] = useState(true)

  const strategies = useMemo(() => data.stocks.flatMap((stock) => {
    const quote = data.quotes[stock.code]
    return quote && /^(600|601|603|605|000|001|002|510|511|512|513|515|516|518|588|159)\d{3}$/.test(stock.code) ? [generateStrategy(stock, quote, data.settings)] : []
  }), [data.stocks, data.quotes, data.settings])

  const selectedStrategy = strategies.find((strategy) => strategy.code === selectedCode)
  const buyCount = strategies.filter((item) => item.action === 'breakout' || item.action === 'pullback').length
  const riskCount = strategies.filter((item) => item.action === 'reduce' || item.action === 'stop').length
  const holdingCount = data.stocks.filter((stock) => stock.status === 'holding').length
  const dateText = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())

  async function refreshCodes(codes?: string[]) {
    const targetCodes = (codes ?? data.stocks.map((stock) => stock.code)).filter(code => /^(600|601|603|605|000|001|002|510|511|512|513|515|516|518|588|159)\d{3}$/.test(code))
    if (!targetCodes.length || refreshing) return
    setRefreshing(true)
    setProgress([0, targetCodes.length])
    const { results, errors } = await fetchQuotes(targetCodes, (completed, total) => setProgress([completed, total]))
    setData((current) => ({ ...current, quotes: { ...current.quotes, ...results } }))
    setRefreshing(false)
    const successCount = Object.keys(results).length
    if (successCount) toast.success(`已更新 ${successCount} 只股票的日线与策略`)
    if (Object.keys(errors).length) toast.error(`${Object.keys(errors).length} 只获取失败，可在编辑中改用手动行情`)
  }

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [view])

  async function loadReport() {
    setReportLoading(true)
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}data/latest.json`, { cache: 'no-store' })
      if (!response.ok) throw new Error('report unavailable')
      const parsed = snapshotSchema.parse(await response.json())
      const previous = readCachedSnapshot()
      if (previous && (parsed.tradeDate < previous.tradeDate || (parsed.tradeDate === previous.tradeDate && parsed.generatedAt < previous.generatedAt))) throw new Error('older report')
      saveSnapshot(parsed)
      setReport(parsed)
      setReportCached(false)
      setReportError(false)
      setData(current => ({ ...current, quotes: mergeSnapshotQuotes(current.quotes, parsed) }))
    } catch { setReportError(true) } finally { setReportLoading(false) }
  }
  useEffect(() => {
    const cached = readCachedSnapshot()
    if (cached) setData(current => ({ ...current, quotes: mergeSnapshotQuotes(current.quotes, cached) }))
    void loadReport()
    // Load the public snapshot once; never upload private portfolio data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openAdd = () => {
    setEditingStock(undefined)
    setStockDialogOpen(true)
  }

  const openEdit = (stock: Stock) => {
    setEditingStock(stock)
    setStockDialogOpen(true)
  }

  const saveStock = (stock: Stock, quote?: Quote) => {
    const duplicate = data.stocks.find((item) => item.code === stock.code && item.id !== stock.id)
    if (duplicate) return toast.error('这只股票已经在清单中')
    setData((current) => {
      const exists = current.stocks.some((item) => item.id === stock.id)
      const quotes = { ...current.quotes }
      if (quote) quotes[stock.code] = quote
      else if (editingStock && quotes[stock.code]?.source === 'manual') delete quotes[stock.code]
      return {
        ...current,
        stocks: exists ? current.stocks.map((item) => item.id === stock.id ? stock : item) : [stock, ...current.stocks],
        quotes,
      }
    })
    setStockDialogOpen(false)
    toast.success(quote ? '已保存手动行情并更新策略' : '已保存，正在获取最新日线')
    if (!quote) void refreshCodes([stock.code])
  }

  const confirmDelete = () => {
    if (!deleteStock) return
    setData((current) => {
      const quotes = { ...current.quotes }
      delete quotes[deleteStock.code]
      return { ...current, stocks: current.stocks.filter((stock) => stock.id !== deleteStock.id), quotes }
    })
    setDeleteStock(undefined)
    toast.success('已从清单移除')
  }

  const filteredStrategies = strategies.filter((strategy) => {
    if (signalFilter === 'buy') return strategy.action === 'breakout' || strategy.action === 'pullback'
    if (signalFilter === 'risk') return strategy.action === 'reduce' || strategy.action === 'stop'
    if (signalFilter === 'wait') return strategy.action === 'watch' || strategy.action === 'hold'
    return true
  }).sort((a, b) => b.score - a.score)

  const filteredStocks = data.stocks.filter((stock) => {
    const matchesQuery = `${stock.name}${stock.code}`.toLowerCase().includes(query.toLowerCase())
    return matchesQuery && (stockFilter === 'all' || stock.status === stockFilter)
  })

  const exportData = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `A股策略备份-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast.success('备份已导出')
  }

  const importData = async (file?: File) => {
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      if (!Array.isArray(parsed.stocks) || !parsed.settings || !parsed.quotes) throw new Error('invalid')
      const stocks = parsed.stocks.length ? parseStocksJson({ stocks: parsed.stocks }).stocks : []
      const settings = { capital: Number(parsed.settings.capital), riskPct: Number(parsed.settings.riskPct), maxPositionPct: Number(parsed.settings.maxPositionPct), refreshOnOpen: Boolean(parsed.settings.refreshOnOpen) }
      if (![settings.capital, settings.riskPct, settings.maxPositionPct].every(Number.isFinite) || settings.capital <= 0 || settings.riskPct <= 0 || settings.riskPct > 100 || settings.maxPositionPct <= 0 || settings.maxPositionPct > 100) throw new Error('invalid settings')
      const quotes: Record<string, Quote> = {}
      for (const [code, raw] of Object.entries(parsed.quotes)) {
        const q = raw as Quote
        if (!/^\d{6}$/.test(code) || !q || q.code !== code || !Number.isFinite(q.price) || q.price <= 0 || !Array.isArray(q.bars) || !['auto', 'manual'].includes(q.source)) continue
        const bars = q.bars.map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: b.amount, changePct: b.changePct, turnoverPct: b.turnoverPct }))
        const m = q.manual
        const manual = m ? { ma5: m.ma5, ma10: m.ma10, ma20: m.ma20, high20: m.high20, atr14: m.atr14, rsi14: m.rsi14, volumeRatio: m.volumeRatio } : undefined
        quotes[code] = { code, price: q.price, prevClose: q.prevClose, changePct: q.changePct, open: q.open, high: q.high, low: q.low, volume: q.volume, amount: q.amount, tradeDate: q.tradeDate, fetchedAt: q.fetchedAt, source: q.source, bars, manual }
      }
      const goldValueCny = typeof parsed.goldValueCny === 'number' && Number.isFinite(parsed.goldValueCny) && parsed.goldValueCny >= 0 ? parsed.goldValueCny : undefined
      setData({ stocks, quotes, settings, goldValueCny })
      toast.success(`已导入 ${stocks.length} 条记录`)
    } catch {
      toast.error('备份文件格式不正确')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const importPortfolio = async (file?: File) => {
    if (!file) return
    try {
      const imported = await readPortfolioFile(file)
      const stocks = imported.stocks
      const newCount = stocks.filter(stock => !data.stocks.some(existing => existing.code === stock.code)).length
      setData(current => ({ ...current, stocks: mergeImportedStocks(current.stocks, stocks), goldValueCny: current.goldValueCny ?? imported.goldValueCny }))
      toast.success(`已导入 ${newCount} 条新记录；已有记录未覆盖`)
    } catch (error) {
      toast.error(error instanceof Error ? `无法导入文件：${error.message}` : '无法导入文件')
    } finally { if (zipRef.current) zipRef.current.value = '' }
  }

  return (
    <div className="app-shell">
      <aside className="desktop-sidebar">
        <button className="brand" onClick={() => setView('today')} aria-label="返回今日策略">
          <span className="brand-mark"><Activity size={21} /></span>
          <span><strong>日内</strong><small>A股策略工作台</small></span>
        </button>
        <nav className="desktop-nav" aria-label="主导航">
          {views.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><Icon size={18} />{label}<ChevronRight size={15} /></button>
          ))}
        </nav>
        <div className="sidebar-note"><ShieldCheck size={18} /><p>本地保存<br /><span>不上传持仓，不连接券商</span></p></div>
      </aside>

      <div className="main-column">
        <header className="mobile-header">
          <button className="brand" onClick={() => setView('today')}><span className="brand-mark"><Activity size={19} /></span><strong>日内</strong></button>
          <button className="icon-button" onClick={openAdd} aria-label="添加股票"><Plus size={21} /></button>
        </header>

        <main className="page-content">
          {view === 'today' && (
            <>
              {data.goldValueCny !== undefined && <section className="report-status"><strong>黄金产品 · 手动参考价值</strong><p>¥{money.format(data.goldValueCny)} · 非实时；未确认产品代码</p></section>}
              <ReportStatus report={report} loading={reportLoading} cached={reportCached} error={reportError} onRetry={() => void loadReport()} />
              <PublicStocks report={report} stocks={data.stocks} onImport={() => setView('settings')} />
              <ResearchSettings />
              <section className="briefing-panel">
                <div className="briefing-copy">
                  <div className="briefing-meta"><span>DAILY PLAYBOOK</span><span>{dateText}</span></div>
                  <h1>先处理风险，<br />再寻找突破。</h1>
                  <p>短线积极模式 · 日线信号 · 条件单思维</p>
                  <button className="briefing-button" onClick={() => void refreshCodes()} disabled={refreshing}>
                    <RefreshCw size={17} className={refreshing ? 'spin' : ''} />
                    {refreshing ? `更新中 ${progress[0]}/${progress[1]}` : '刷新今日策略'}
                  </button>
                </div>
                <div className="briefing-stats">
                  <div><strong>{buyCount}</strong><span>关注机会</span></div>
                  <div><strong>{riskCount}</strong><span>风险信号</span></div>
                  <div><strong>{holdingCount}</strong><span>当前持仓</span></div>
                  <div><strong>{strategies.length}<small>/{data.stocks.length}</small></strong><span>已生成策略</span></div>
                </div>
              </section>

              <div className="today-grid">
                <section>
                  <div className="section-heading">
                    <div><span className="section-kicker">TODAY'S SIGNALS</span><h2>今日优先清单</h2></div>
                    <span className="data-stamp">{refreshing ? <LoaderCircle size={15} className="spin" /> : <Database size={15} />}{strategies.length ? '策略已计算' : '等待行情'}</span>
                  </div>
                  <div className="filter-tabs" role="tablist" aria-label="策略信号筛选">
                    {([['all', '全部'], ['buy', '机会'], ['risk', '风险'], ['wait', '等待']] as Array<[SignalFilter, string]>).map(([id, label]) => (
                      <button key={id} role="tab" aria-selected={signalFilter === id} className={signalFilter === id ? 'active' : ''} onClick={() => setSignalFilter(id)}>{label}</button>
                    ))}
                  </div>

                  {filteredStrategies.length ? (
                    <div className="strategy-list">
                      {filteredStrategies.map((strategy) => <StrategyCard key={strategy.stockId} strategy={strategy} onOpen={() => setSelectedCode(strategy.code)} />)}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <Gauge size={30} />
                      <h3>{strategies.length ? '当前筛选下没有信号' : '还没有生成策略'}</h3>
                      <p>{strategies.length ? '切换筛选查看其他股票。' : '刷新行情，或在股票页手动录入现价与指标。'}</p>
                      <button className="button-primary" onClick={() => strategies.length ? setSignalFilter('all') : void refreshCodes()}>{strategies.length ? '查看全部' : '获取行情'}</button>
                    </div>
                  )}
                </section>

                <aside className="right-rail">
                  <section className="discipline-panel">
                    <div className="section-heading compact"><div><span className="section-kicker">RISK FIRST</span><h2>盘前纪律</h2></div><ShieldCheck size={21} /></div>
                    <ul className="rule-list">
                      <li><span>01</span>开盘急涨不追，等待触发价确认</li>
                      <li><span>02</span>先设保护位，再计算买入股数</li>
                      <li><span>03</span>触及止损条件，不用补仓摊薄替代</li>
                    </ul>
                  </section>
                  <section className="risk-panel">
                    <div className="section-heading compact"><div><span className="section-kicker">POSITION SIZING</span><h2>风险预算</h2></div></div>
                    <div className="risk-number"><strong>{data.settings.riskPct.toFixed(1)}%</strong><span>单笔风险 / ¥{Math.round(data.settings.capital * data.settings.riskPct / 100).toLocaleString('zh-CN')}</span></div>
                    <input aria-label="单笔风险百分比" type="range" min="0.2" max="2" step="0.1" value={data.settings.riskPct} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, riskPct: Number(event.target.value) } }))} />
                    <div className="flex justify-between text-xs text-muted-foreground"><span>账户 ¥{data.settings.capital.toLocaleString('zh-CN')}</span><span>单票上限 {data.settings.maxPositionPct}%</span></div>
                    <button className="text-button" onClick={() => setView('settings')}>调整风险参数 <ArrowUpRight size={14} /></button>
                  </section>
                  <p className="source-note">行情来自公开日线接口，可能延迟或中断。策略仅为规则化研究参考，不构成收益承诺。</p>
                </aside>
              </div>
            </>
          )}

          {view === 'stocks' && (
            <section className="standard-page">
              <div className="page-heading">
                <div><span className="section-kicker">MY UNIVERSE</span><h1>我的股票</h1><p>持仓、自选与历史记录分开管理。</p></div>
                <button className="button-primary desktop-action" onClick={openAdd}><Plus size={17} />添加股票</button>
              </div>
              <div className="stock-toolbar">
                <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或代码" aria-label="搜索股票" /></label>
                <select value={stockFilter} onChange={(event) => setStockFilter(event.target.value as 'all' | StockStatus)} aria-label="筛选清单类型">
                  <option value="all">全部清单</option><option value="holding">当前持仓</option><option value="watch">当前自选</option><option value="history">历史记录</option>
                </select>
                <button className="button-secondary" onClick={() => void refreshCodes()} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''} />更新</button>
              </div>
              <div className="list-caption"><span>{filteredStocks.length} 条记录</span><span>个人记录仅保存在当前设备</span></div>
              <div className="stock-list">
                {filteredStocks.map((stock) => {
                  const quote = data.quotes[stock.code]
                  return (
                    <article className="stock-row" key={stock.id}>
                      <button className="stock-identity" onClick={() => openEdit(stock)}>
                        <span className="stock-name">{stock.name}</span><span className="code-label">{stock.code}</span>
                        <span className={`status-tag status-${stock.status}`}>{statusLabels[stock.status]}</span>
                      </button>
                      <div className="stock-quote">
                        {quote ? <><strong className="number-text">{formatPrice(quote.price)}</strong><span className={quote.changePct >= 0 ? 'market-up' : 'market-down'}>{quote.changePct >= 0 ? '+' : ''}{quote.changePct.toFixed(2)}%</span></> : <span className="text-muted-foreground">等待行情</span>}
                      </div>
                      <div className="stock-pnl">
                        <span>2026 收益额</span><strong className={`number-text ${(stock.annualPnl ?? 0) >= 0 ? 'market-up' : 'market-down'}`}>{stock.annualPnl === undefined ? '—' : `${stock.annualPnl >= 0 ? '+' : '−'}${money.format(Math.abs(stock.annualPnl))}`}</strong>
                      </div>
                      <div className="stock-actions">
                        {quote && <button className="text-button" onClick={() => setSelectedCode(stock.code)}>策略 <ArrowUpRight size={14} /></button>}
                        <button className="icon-button subtle" onClick={() => openEdit(stock)} aria-label={`编辑${stock.name}`}><Settings size={17} /></button>
                        <button className="icon-button subtle danger" onClick={() => setDeleteStock(stock)} aria-label={`删除${stock.name}`}><Trash2 size={17} /></button>
                      </div>
                    </article>
                  )
                })}
              </div>
              {!filteredStocks.length && <div className="empty-state"><Search size={28} /><h3>没有匹配的股票</h3><p>更换关键词或清单筛选。</p></div>}
              <button className="button-primary mobile-fab" onClick={openAdd}><Plus size={18} />添加股票</button>
            </section>
          )}

          {view === 'library' && <QuantsLibrary />}
          {view === 'backtest' && <BacktestLab stocks={data.stocks} quotes={data.quotes} refreshing={refreshing} onRefresh={() => void refreshCodes()} />}

          {view === 'rules' && (
            <section className="standard-page">
              <div className="page-heading"><div><span className="section-kicker">TRANSPARENT RULES</span><h1>策略不是黑箱</h1><p>每个结论都能回到价格、趋势、成交量与风险预算。</p></div></div>
              <div className="rules-intro"><Activity size={24} /><p>当前使用<strong>短线积极</strong>参数。优先检查止损与过热风险，再评估突破和回踩；所有价位均为条件参考，不是自动委托。</p></div>
              <div className="rule-cards">
                <article><span className="rule-index">01 / BREAKOUT</span><h2>突破跟随</h2><p>价格触及前 20 日高点附近，当日涨幅不低于 1%，量比不低于 1.15。以 MA10 或 1.4 倍 ATR 设置保护位。</p><div><span>趋势</span><span>量能</span><span>突破</span></div></article>
                <article><span className="rule-index">02 / PULLBACK</span><h2>回踩低吸</h2><p>MA5、MA10、MA20 保持多头排列，价格回到短期均线区域。等待止跌确认，不在下跌途中盲目补仓。</p><div><span>多头</span><span>回踩</span><span>确认</span></div></article>
                <article><span className="rule-index">03 / RISK</span><h2>减仓与止损</h2><p>RSI14 超过 76 或价格显著偏离 MA5 时提示减仓。持仓触及约 7% 成本风险线，或跌破 MA20 与 ATR 缓冲区时优先止损。</p><div><span>过热</span><span>保护</span><span>退出</span></div></article>
                <article><span className="rule-index">04 / SIZING</span><h2>风险定仓</h2><p>参考股数取“单笔风险预算 ÷ 每股风险”和“单票仓位上限”两者较小值，按 A 股 100 股整手向下取整。</p><div><span>预算</span><span>ATR</span><span>整手</span></div></article>
              </div>
              <a className="reference-link" href="https://quants.md/" target="_blank" rel="noreferrer">查看策略设计参考 quants.md <ArrowUpRight size={17} /></a>
            </section>
          )}

          {view === 'settings' && (
            <section className="standard-page settings-page">
              <div className="page-heading"><div><span className="section-kicker">YOUR WORKSPACE</span><h1>我的设置</h1><p>修改后立即重算策略，并自动保存在当前浏览器。</p></div></div>
              <div className="settings-grid">
                <section>
                  <div className="settings-section-title"><Gauge size={19} /><h2>风险参数</h2></div>
                  <div className="settings-fields">
                    <label className="form-field">账户参考本金（元）<input type="number" min="1000" step="1000" value={data.settings.capital} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, capital: Math.max(1000, Number(event.target.value)) } }))} /></label>
                    <label className="form-field">单笔风险（%）<input type="number" min="0.2" max="2" step="0.1" value={data.settings.riskPct} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, riskPct: Math.min(2, Math.max(0.2, Number(event.target.value))) } }))} /></label>
                    <label className="form-field">单票仓位上限（%）<input type="number" min="1" max="50" step="1" value={data.settings.maxPositionPct} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, maxPositionPct: Math.min(50, Math.max(1, Number(event.target.value))) } }))} /></label>
                  </div>
                  <p className="settings-note">打开应用时读取已发布的公共快照；如需个股最新行情，请手动刷新。</p>
                </section>
                <section>
                  <div className="settings-section-title"><Smartphone size={19} /><h2>在 iPhone / iPad 上使用</h2></div>
                  <ol className="install-steps"><li><span>1</span>用 Safari 打开本应用</li><li><span>2</span>点击“分享”按钮</li><li><span>3</span>选择“添加到主屏幕”</li></ol>
                  <p className="settings-note">数据只保存在当前浏览器。清除网站数据会删除清单；换设备前请先导出备份。</p>
                </section>
                <section>
                  <div className="settings-section-title"><Database size={19} /><h2>数据与备份</h2></div>
                  <label className="form-field">非实物黄金参考价值（元，可选）<input type="number" inputMode="decimal" min="0" value={data.goldValueCny ?? ''} onChange={(event) => { const value = event.target.value; setData(current => ({ ...current, goldValueCny: value === '' ? undefined : Math.max(0, Number(value)) })) }} /></label>
                  <p className="settings-note">手动输入，仅保存在本设备；不是实时价格。确认具体产品后才能自动更新。</p>
                  <div className="data-actions">
                    <button className="button-secondary" onClick={exportData}><ArrowDownToLine size={17} />导出完整备份</button>
                    <button className="button-secondary" onClick={() => { const url = URL.createObjectURL(new Blob([portfolioMarkdown(data)], { type: 'text/markdown;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'stocks.md'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) }}><ArrowDownToLine size={17} />导出 Markdown 清单</button>
                    <button className="button-secondary" onClick={() => fileRef.current?.click()}><Upload size={17} />导入备份</button>
                    <button className="button-secondary" onClick={() => zipRef.current?.click()}><Upload size={17} />导入清单文件</button>
                    <input ref={zipRef} type="file" accept=".zip,.json,.md,.txt,text/plain,text/markdown,application/json,application/zip" className="hidden" onChange={(event) => void importPortfolio(event.target.files?.[0])} />
                    <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importData(event.target.files?.[0])} />
                  </div>
                  <p className="settings-note">JSON 备份导入会替换当前数据，请先导出。清单支持 JSON、Markdown、文本或 ZIP（内含 stocks.json / stocks.md / stocks.txt），只添加新股票，已有记录和黄金价值不会覆盖。ZIP 中的其他文件（包括密钥）会被忽略。Markdown 包含私人财务信息，请妥善保存。定时 AI 密钥须在 GitHub Actions 机密中单独设置。</p>
                  <button className="text-button danger-text" onClick={() => setResetOpen(true)}><History size={15} />清空当前设备数据</button>
                </section>
              </div>
            </section>
          )}
        </main>

        <nav className="bottom-nav" aria-label="移动端主导航">
          {views.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><Icon size={21} /><span>{label}</span></button>)}
        </nav>
      </div>

      <StockDialog open={stockDialogOpen} onOpenChange={setStockDialogOpen} stock={editingStock} quote={editingStock ? data.quotes[editingStock.code] : undefined} onSave={saveStock} />
      <StrategyDetailDialog strategy={selectedStrategy} open={Boolean(selectedCode)} onOpenChange={(open) => !open && setSelectedCode(undefined)} />
      <AlertDialog open={Boolean(deleteStock)} onOpenChange={(open) => !open && setDeleteStock(undefined)}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>移除{deleteStock?.name}？</AlertDialogTitle><AlertDialogDescription>该股票及其本地行情缓存会被移除，此操作可通过备份恢复。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground">确认移除</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>清空当前设备数据？</AlertDialogTitle><AlertDialogDescription>当前清单、行情缓存与设置会被清空。建议先导出备份，之后可以重新导入。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => { resetData(); setResetOpen(false); toast.success('已清空当前设备数据') }}>确认清空</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <Toaster position="top-center" richColors closeButton />
    </div>
  )
}

export default App
