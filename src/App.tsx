import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownToLine, ArrowUpRight, BarChart3, BookOpen, ChevronRight,
  Database, Gauge, History, LayoutDashboard, List, LoaderCircle,
  FileDown, Plus, RefreshCw, Search, Settings, ShieldCheck, Smartphone, Trash2, Upload,
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
import { StrategyCard } from '@/components/StrategyCard'
import { StrategyDetailDialog } from '@/components/StrategyDetailDialog'
import { LiveAlertsPanel } from '@/components/live/LiveAlertsPanel'
import { LivePrice } from '@/components/live/LivePrice'
import { MarketStatusBar } from '@/components/live/MarketStatusBar'
import { StrategyRanking } from '@/components/live/StrategyRanking'
import { isLivePricePhase } from '@/components/live/quote-utils'
import { useI18n, localeOf } from '@/lib/i18n'
import { LanguageToggle } from '@/components/LanguageToggle'
import { useLiveAlerts } from '@/hooks/useLiveAlerts'
import { useLiveQuotes } from '@/hooks/useLiveQuotes'
import { useRegime } from '@/hooks/useRegime'
import { useLocalData } from '@/hooks/useLocalData'
import { getMarketPhase } from '@/lib/live'
import { isHoldingStrategy } from '@/lib/live-signals'
import { applyRegimeFilter } from '@/lib/regime-filter'
import { rankStrategies } from '@/lib/strategy-ranking'
import { readRegimeCache } from '@/lib/regime'
import { fetchQuotes } from '@/lib/market'
import { generateStrategy } from '@/lib/strategy'
import type { MarketPhase, Quote, Stock, StockStatus, Strategy, StrategyAction } from '@/types'
import './App.css'

type View = 'today' | 'stocks' | 'backtest' | 'rules' | 'settings' | 'library'

declare global {
  interface Window {
    __BUILD__?: { id: string; sha: string; time: string }
  }
}

const buildInfo = typeof window !== 'undefined' ? window.__BUILD__ : undefined
type SignalFilter = 'all' | 'buy' | 'risk' | 'wait'

const views: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'today', label: '今日', icon: LayoutDashboard },
  { id: 'stocks', label: '股票', icon: List },
  { id: 'library', label: '策略库', icon: BookOpen },
  { id: 'backtest', label: '回测', icon: BarChart3 },
  { id: 'rules', label: '策略', icon: BookOpen },
  { id: 'settings', label: '我的', icon: Settings },
]

const money = (lang: 'zh' | 'en') => new Intl.NumberFormat(localeOf(lang), { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** 盘中订阅上限：单次批量请求最多 80 只（Lead 裁定 N-5）。 */
const MAX_LIVE_CODES = 80

function App() {
  const { lang, t } = useI18n()
  const { data, setData, resetData } = useLocalData()
  const [view, setView] = useState<View>('today')
  const [signalFilter, setSignalFilter] = useState<SignalFilter>('all')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [rankingSelection, setRankingSelection] = useState<{ action: StrategyAction; id: string } | null>(null)
  const strategyListRef = useRef<HTMLElement>(null)
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
  const portfolioImportRef = useRef<HTMLInputElement>(null)
  const [report, setReport] = useState<Snapshot | null>(readCachedSnapshot)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState(false)
  const [reportCached, setReportCached] = useState(true)

  const strategies = useMemo(() => data.stocks.flatMap((stock) => {
    const quote = data.quotes[stock.code]
    return quote && /^(600|601|603|605|000|001|002|510|511|512|513|515|516|518|588|159)\d{3}$/.test(stock.code) ? [generateStrategy(stock, quote, data.settings)] : []
  }), [data.stocks, data.quotes, data.settings])

  const holdingCount = data.stocks.filter((stock) => stock.status === 'holding').length
  const hasPersonalStocks = data.stocks.length > 0
  const dateText = new Intl.DateTimeFormat(localeOf(lang), { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())

  /* ── 盘中层接线：报价代码优先取个人清单，没有清单时取公开快照的代码 ── */
  const [liveAutoRefresh, setLiveAutoRefresh] = useState(true)
  const [manualLiveRefresh, setManualLiveRefresh] = useState(false)
  // 只在本机时钟真正跨越交易时段时更新相位，避免每 15 秒重渲染整页（P2-4）。
  const [phase, setPhase] = useState<MarketPhase>(() => getMarketPhase())
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = getMarketPhase()
      setPhase((current) => (current === next ? current : next))
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [])

  // 订阅集合取并集：个人清单 ∪ 公开快照（N-5，公开代码本就公开，仍是一次批量请求）。
  const liveCodes = useMemo(() => {
    const personalCodes = data.stocks.map((stock) => stock.code)
    const publicCodes = report ? Object.keys(report.quotes) : []
    const merged = [...new Set([...personalCodes, ...publicCodes].filter((code) => /^\d{6}$/.test(code)))]
    return merged.slice(0, MAX_LIVE_CODES)
  }, [data.stocks, report])

  const { liveQuotes, updatedAt: liveUpdatedAt, lastAttemptAt: liveLastAttemptAt, loading: liveLoading, errors: liveErrors, refresh: refreshLive } = useLiveQuotes(liveCodes, { enabled: liveAutoRefresh || manualLiveRefresh })
  // 盯盘提醒必须用未过滤的 strategies：live-signals 对 action=watch 不发提醒，
  // 若传 displayStrategies，熊市里持仓股的 stop/target 提醒会消失（N-1 回归）。
  const { alerts, dismiss, clear, permission, requestPermission, soundEnabled, toggleSound } = useLiveAlerts(strategies, liveQuotes)

  /* ── 大盘状态 → 页面主题 ────────────────────────────────────
   * 广度样本优先用公开清单（29 只），没有快照时退回本地清单日线。
   * 首帧默认中性（震荡市）配色；缓存命中时同步读缓存先上主题，刷新不闪。
   * 只在 documentElement 上写 data-regime，颜色完全由 CSS 变量驱动；
   * 涨跌红绿（.market-up/.market-down）是固定值，不随主题变化。 */
  const regimeBars = useMemo(() => {
    const publicQuotes = report ? Object.values(report.quotes) : []
    const source = publicQuotes.length ? publicQuotes : Object.values(data.quotes)
    return source.map((quote) => quote.bars).filter((bars) => bars.length > 0)
  }, [report, data.quotes])
  const { regime: regimeDetail, loading: regimeLoading, error: regimeError, refresh: refreshRegime } = useRegime(regimeBars)
  const cachedRegime = useMemo(() => readRegimeCache()?.info.regime, [])
  const activeRegime = regimeDetail?.regime ?? cachedRegime ?? 'range'
  const appliedRegimeRef = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const root = document.documentElement
    const previous = appliedRegimeRef.current
    appliedRegimeRef.current = activeRegime
    root.dataset.regime = activeRegime
    if (previous === undefined || previous === activeRegime) return
    root.classList.add('theme-switching')
    const timer = window.setTimeout(() => root.classList.remove('theme-switching'), 400)
    return () => window.clearTimeout(timer)
  }, [activeRegime])
  const regimeInfo = {
    regime: regimeDetail?.regime,
    confidence: regimeDetail?.confidence,
    asOf: regimeDetail?.asOf,
    source: regimeDetail?.source,
    evidence: regimeDetail?.evidence,
    breadthPct: regimeDetail?.breadthPct,
    loading: regimeLoading,
    error: regimeError,
    refresh: refreshRegime,
    sampleSize: report ? Object.keys(report.quotes).length : undefined,
  }

  // 展示层用 regime 过滤后的列表（熊市禁买/震荡半仓）；提醒层仍用未过滤 strategies（见上方注释）。
  const displayStrategies = useMemo(() => applyRegimeFilter(strategies, regimeDetail?.regime, lang), [strategies, regimeDetail?.regime, lang])
  const selectedStrategy = displayStrategies.find((strategy) => strategy.code === selectedCode)
  const buyCount = displayStrategies.filter((item) => item.action === 'breakout' || item.action === 'pullback').length
  const riskCount = displayStrategies.filter((item) => item.action === 'reduce' || item.action === 'stop').length
  // 排名统计覆盖「个人策略 ∪ 公开快照信号」：把 report.signals 映射成最小 Strategy 形状；
  // 同一代码个人清单优先，避免重复计数。公开信号无持仓语义（isHolding=false）。
  const publicStrategies = useMemo<Strategy[]>(() => {
    const signals = report?.signals
    if (!signals) return []
    return Object.entries(signals).map(([code, signal]) => {
      const quote = report?.quotes[code]
      return {
        stockId: `public-${code}`,
        code,
        name: code,
        action: signal.action,
        actionLabel: signal.actionLabel,
        score: signal.score,
        summary: signal.summary,
        reasons: signal.reasons,
        isHolding: false,
        price: quote?.price ?? 0,
        changePct: quote?.changePct ?? 0,
        tradeDate: report?.tradeDate ?? '',
        source: 'auto',
        indicators: signal.indicators,
        bars: [],
      }
    })
  }, [report])
  const rankingStrategies = useMemo(() => {
    const personalCodes = new Set(strategies.map((strategy) => strategy.code))
    return [...strategies, ...publicStrategies.filter((strategy) => !personalCodes.has(strategy.code))]
  }, [strategies, publicStrategies])
  const rankingRows = useMemo(() => rankStrategies({
    strategies: rankingStrategies,
    regime: regimeDetail?.regime ?? 'range',
    breadthPct: regimeDetail?.breadthPct,
    lang,
  }), [rankingStrategies, regimeDetail?.regime, regimeDetail?.breadthPct, lang])
  const rankingAnyData = rankingStrategies.length > 0
  const scrollToStrategyList = () => {
    strategyListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const selectRankingAction = (action: StrategyAction | null, id?: string) => {
    setRankingSelection(action && id ? { action, id } : null)
    if (action) setSignalFilter('all')
  }

  // 最近报价时间只取 provider 的行情时间（P1-7）：优先 hook 的 updatedAt（本批成功报价的最新 provider 时间），
  // 本轮全部失败时回落到已展示报价里的最新 provider 时间；两者都不是抓取时间，无报价时显示「—」。
  const latestLiveQuoteAt = useMemo(() => Object.values(liveQuotes).reduce<string | undefined>(
    (latest, quote) => (!latest || quote.updatedAt > latest ? quote.updatedAt : latest), undefined), [liveQuotes])
  const recentQuoteAt = liveUpdatedAt ?? latestLiveQuoteAt
  // 本轮刷新成功/失败：失败但仍有旧报价的代码，价格旁标注「上次报价」而不是「盘中」（P1-1）。
  // 持仓语义与 evaluateLive 同源：优先 Strategy.isHolding，旧数据回退 action 推断。
  const holdingByCode = useMemo(() => Object.fromEntries(
    strategies.map((strategy) => [strategy.code, isHoldingStrategy(strategy)])), [strategies])
  const liveFailedCodes = useMemo(() => Object.keys(liveErrors).filter((code) => liveCodes.includes(code)), [liveErrors, liveCodes])
  const liveSuccessCount = useMemo(() => liveCodes.filter((code) => liveQuotes[code] && !liveErrors[code]).length, [liveCodes, liveQuotes, liveErrors])
  const liveRetainedCount = liveFailedCodes.filter((code) => liveQuotes[code]).length

  // 自动刷新关闭时，「刷新」按一次性拉取处理：短暂开启订阅，拉取结束立即回到关闭状态。
  useEffect(() => {
    if (!manualLiveRefresh || liveLoading) return
    const timer = window.setTimeout(() => setManualLiveRefresh(false), 0)
    return () => window.clearTimeout(timer)
  }, [manualLiveRefresh, liveLoading])

  const buildLabel = buildInfo && !buildInfo.id.includes('__') ? `v${buildInfo.sha} · ${buildInfo.time}` : 'vdev'
  // 手动检查新版本：先更新 SW、清掉旧 cache，再 reload，给用户一个「自救」入口。
  const checkForUpdates = async () => {
    setCheckingUpdate(true)
    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations()
        await Promise.all(registrations.map(async (registration) => {
          try { await registration.update() } catch { /* 离线时忽略 */ }
          try { registration.waiting?.postMessage('SKIP_WAITING') } catch { /* 忽略 */ }
        }))
      }
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys()
        await Promise.all(keys.map((key) => caches.delete(key)))
      }
      toast.success(t('version.updated'))
    } catch {
      toast.error(t('version.failed'))
    } finally {
      setCheckingUpdate(false)
      window.setTimeout(() => window.location.reload(), 400)
    }
  }

  const requestLiveRefresh = () => {
    if (liveAutoRefresh) {
      void refreshLive()
      return
    }
    setManualLiveRefresh(true)
  }

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

  const filteredStrategies = displayStrategies.filter((strategy) => {
    if (rankingSelection) return strategy.action === rankingSelection.action
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

  // 下载 public/templates/portfolio.example.md；离线/404 时给 toast，不静默失败。
  const downloadTemplate = async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}templates/portfolio.example.md`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`模板获取失败：${response.status}`)
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'portfolio.example.md'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success('模板已下载，填好后在今日页或「我的」导入')
    } catch {
      toast.error('模板下载失败，请检查网络后重试')
    }
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
        <button className="brand" onClick={() => setView('today')} aria-label={t('nav.today')}>
          <span className="brand-mark"><Activity size={21} /></span>
          <span><strong>{t('app.brand')}</strong><small>{t('app.tagline')}</small></span>
        </button>
        <nav className="desktop-nav" aria-label={t('nav.today')}>
          {views.map(({ id, icon: Icon }) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><Icon size={18} />{t(`nav.${id}`)}<ChevronRight size={15} /></button>
          ))}
        </nav>
        <div className="sidebar-note"><ShieldCheck size={18} /><p>{t('app.privacy1')}<br /><span>{t('app.privacy2')}</span></p></div>
        <LanguageToggle className="sidebar-lang" />
      </aside>

      <div className="main-column">
        <header className="mobile-header">
          <button className="brand" onClick={() => setView('today')}><span className="brand-mark"><Activity size={19} /></span><strong>{t('app.brand')}</strong></button>
          <button className="icon-button" onClick={openAdd} aria-label={t('app.addStock')}><Plus size={21} /></button>
        </header>

        <main className="page-content">
          {view === 'today' && (
            <>
              <MarketStatusBar
                phase={phase}
                updatedAt={recentQuoteAt}
                lastAttemptAt={liveLastAttemptAt}
                loading={liveLoading}
                failedCodes={liveFailedCodes}
                successCount={liveSuccessCount}
                retainedCount={liveRetainedCount}
                covered={liveCodes.length}
                autoRefresh={liveAutoRefresh}
                onToggleAutoRefresh={() => setLiveAutoRefresh((value) => !value)}
                onRefresh={requestLiveRefresh}
                regimeInfo={regimeInfo}
              />
              <StrategyRanking
                rows={rankingRows}
                hasAnyData={rankingAnyData}
                regime={regimeDetail?.regime}
                selectedAction={rankingSelection?.action ?? null}
                selectedId={rankingSelection?.id ?? null}
                onSelect={selectRankingAction}
                onScrollToList={scrollToStrategyList}
              />
              {data.goldValueCny !== undefined && <section className="report-status"><strong>{t('today.goldTitle')}</strong><p>{t('today.goldNote', { value: `¥${money(lang).format(data.goldValueCny)}` })}</p></section>}
              <ReportStatus report={report} loading={reportLoading} cached={reportCached} error={reportError} onRetry={() => void loadReport()} />
              {!hasPersonalStocks && (
                <section className="private-import-card" aria-labelledby="private-import-title">
                  <span className="section-kicker">PRIVATE PORTFOLIO</span>
                  <h2 id="private-import-title">{t('private.title')}</h2>
                  <p className="private-import-note">{t('private.note')}</p>
                  <div className="private-import-actions">
                    <button type="button" className="button-primary" onClick={() => portfolioImportRef.current?.click()}>
                      <Upload size={17} aria-hidden="true" />{t('private.import')}
                    </button>
                    <button type="button" className="button-secondary" onClick={() => void downloadTemplate()}>
                      <FileDown size={17} aria-hidden="true" />{t('private.download')}
                    </button>
                  </div>
                  <input
                    ref={portfolioImportRef}
                    type="file"
                    accept=".zip,.json,.md,.txt,text/plain,text/markdown,application/json,application/zip"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      void importPortfolio(file)
                    }}
                  />
                </section>
              )}
              <PublicStocks
                report={report}
                stocks={data.stocks}
                onImport={() => setView('settings')}
                liveQuotes={liveQuotes}
                liveErrors={liveErrors}
                phase={phase}
                regime={regimeDetail?.regime}
                actionFilter={rankingSelection?.action ?? null}
                actionFilterLabel={rankingSelection ? rankingRows.find((row) => row.action === rankingSelection.action)?.label : undefined}
                onClearFilter={() => setRankingSelection(null)}
              />
              <ResearchSettings />
              <section className="briefing-panel">
                <div className="briefing-copy">
                  <div className="briefing-meta"><span>{t('today.briefingKicker')}</span><span>{dateText}</span></div>
                  <h1>{t('today.briefingTitle1')}<br />{t('today.briefingTitle2')}</h1>
                  <p>{t('today.briefingSub')}</p>
                  <button className="briefing-button" onClick={() => void refreshCodes()} disabled={refreshing}>
                    <RefreshCw size={17} className={refreshing ? 'spin' : ''} />
                    {refreshing ? t('today.updating', { done: progress[0], total: progress[1] }) : t('today.updateDaily')}
                  </button>
                </div>
                <div className="briefing-stats">
                  <div><strong>{buyCount}</strong><span>{t('today.stat.buy')}</span></div>
                  <div><strong>{riskCount}</strong><span>{t('today.stat.risk')}</span></div>
                  <div><strong>{holdingCount}</strong><span>{t('today.stat.holding')}</span></div>
                  <div><strong>{displayStrategies.length}<small>/{data.stocks.length}</small></strong><span>{t('today.stat.strategies')}</span></div>
                </div>
              </section>

              <div className="today-grid">
                <section ref={strategyListRef}>
                  <div className="section-heading">
                    <div><span className="section-kicker">TODAY'S SIGNALS</span><h2>{t('today.signalsTitle')}{hasPersonalStocks && <span className="privacy-badge">{t('today.privacyBadge')}</span>}</h2></div>
                    <span className="data-stamp">{liveLoading ? <LoaderCircle size={15} className="spin" /> : isLivePricePhase(phase) && liveSuccessCount ? <Activity size={15} /> : <Database size={15} />}{isLivePricePhase(phase) && liveSuccessCount ? `盘中 ${liveSuccessCount} 只${liveFailedCodes.length ? ` · 未刷新 ${liveFailedCodes.length}` : ''}` : displayStrategies.length ? '策略已计算' : '等待行情'}</span>
                  </div>
                  <div className="filter-tabs" role="tablist" aria-label="策略信号筛选">
                    {([['all', t('today.filter.all')], ['buy', t('today.filter.buy')], ['risk', t('today.filter.risk')], ['wait', t('today.filter.wait')]] as Array<[SignalFilter, string]>).map(([id, label]) => (
                      <button key={id} role="tab" aria-selected={signalFilter === id} className={signalFilter === id ? 'active' : ''} onClick={() => { setSignalFilter(id); setRankingSelection(null) }}>{label}</button>
                    ))}
                  </div>

                  {filteredStrategies.length ? (
                    <div className="strategy-list">
                      {filteredStrategies.map((strategy) => <StrategyCard key={strategy.stockId} strategy={strategy} liveQuote={liveQuotes[strategy.code]} liveError={liveErrors[strategy.code]} phase={phase} onOpen={() => setSelectedCode(strategy.code)} />)}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <Gauge size={30} />
                      <h3>{displayStrategies.length ? t('today.emptyFiltered') : t('today.emptyAll')}</h3>
                      <p>{displayStrategies.length ? t('today.emptyHintFiltered') : t('today.emptyHintAll')}</p>
                      <button className="button-primary" onClick={() => displayStrategies.length ? setSignalFilter('all') : void refreshCodes()}>{displayStrategies.length ? t('common.viewAll') : t('common.getQuotes')}</button>
                    </div>
                  )}
                </section>

                <aside className="right-rail">
                  <LiveAlertsPanel alerts={alerts} dismiss={dismiss} clear={clear} permission={permission} requestPermission={requestPermission} soundEnabled={soundEnabled} toggleSound={toggleSound} phase={phase} strategyCount={strategies.length} holdingByCode={holdingByCode} />
                  <section className="discipline-panel">
                    <div className="section-heading compact"><div><span className="section-kicker">{t('today.disciplineKicker')}</span><h2>{t('today.disciplineTitle')}</h2></div><ShieldCheck size={21} /></div>
                    <ul className="rule-list">
                      <li><span>01</span>{t('today.discipline1')}</li>
                      <li><span>02</span>{t('today.discipline2')}</li>
                      <li><span>03</span>{t('today.discipline3')}</li>
                    </ul>
                  </section>
                  <section className="risk-panel">
                    <div className="section-heading compact"><div><span className="section-kicker">{t('today.riskKicker')}</span><h2>{t('today.riskTitle')}</h2></div></div>
                    <div className="risk-number"><strong>{data.settings.riskPct.toFixed(1)}%</strong><span>{t('today.riskPerTrade')} / ¥{Math.round(data.settings.capital * data.settings.riskPct / 100).toLocaleString('zh-CN')}</span></div>
                    <input aria-label={t('today.riskSliderAria')} type="range" min="0.2" max="2" step="0.1" value={data.settings.riskPct} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, riskPct: Number(event.target.value) } }))} />
                    <div className="flex justify-between text-xs text-muted-foreground"><span>{t('today.account', { value: `¥${data.settings.capital.toLocaleString(localeOf(lang))}` })}</span><span>{t('today.maxPosition', { pct: data.settings.maxPositionPct })}</span></div>
                    <button className="text-button" onClick={() => setView('settings')}>{t('today.adjustRisk')} <ArrowUpRight size={14} /></button>
                  </section>
                  <p className="source-note">{t('today.sourceNote')}</p>
                </aside>
              </div>
            </>
          )}

          {view === 'stocks' && (
            <section className="standard-page">
              <div className="page-heading">
                <div><span className="section-kicker">MY UNIVERSE</span><h1>{t('stocks.title')}{hasPersonalStocks && <span className="privacy-badge">{t('today.privacyBadge')}</span>}</h1><p>{t('stocks.sub')}</p></div>
                <button className="button-primary desktop-action" onClick={openAdd}><Plus size={17} />{t('stocks.add')}</button>
              </div>
              <MarketStatusBar
                phase={phase}
                updatedAt={recentQuoteAt}
                lastAttemptAt={liveLastAttemptAt}
                loading={liveLoading}
                failedCodes={liveFailedCodes}
                successCount={liveSuccessCount}
                retainedCount={liveRetainedCount}
                covered={liveCodes.length}
                autoRefresh={liveAutoRefresh}
                onToggleAutoRefresh={() => setLiveAutoRefresh((value) => !value)}
                onRefresh={requestLiveRefresh}
                regimeInfo={regimeInfo}
                compact
              />
              <div className="stock-toolbar">
                <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('stocks.search')} aria-label={t('stocks.search')} /></label>
                <select value={stockFilter} onChange={(event) => setStockFilter(event.target.value as 'all' | StockStatus)} aria-label="筛选清单类型">
                  <option value="all">{t('stocks.filter.all')}</option><option value="holding">{t('stocks.filter.holding')}</option><option value="watch">{t('stocks.filter.watch')}</option><option value="history">{t('stocks.filter.history')}</option>
                </select>
                <button className="button-secondary" onClick={() => void refreshCodes()} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''} />更新</button>
              </div>
              <div className="list-caption"><span>{t('stocks.records', { n: filteredStocks.length })} · {isLivePricePhase(phase) ? t('stocks.liveScope', { n: liveCodes.length, ok: liveSuccessCount, fail: liveFailedCodes.length }) : t('stocks.offHours')}</span><span>{t('stocks.privacy')}</span></div>
              <div className="stock-list">
                {filteredStocks.map((stock) => {
                  const quote = data.quotes[stock.code]
                  const liveQuote = liveQuotes[stock.code]
                  const liveError = liveErrors[stock.code]
                  const displayPrice = liveQuote?.price ?? quote?.price
                  const displayChangePct = liveQuote?.changePct ?? quote?.changePct
                  return (
                    <article className="stock-row" key={stock.id}>
                      <button className="stock-identity" onClick={() => openEdit(stock)}>
                        <span className="stock-name">{stock.name}</span><span className="code-label">{stock.code}</span>
                        <span className={`status-tag status-${stock.status}`}>{t(`stocks.status.${stock.status}`)}</span>
                      </button>
                      <div className="stock-quote">
                        {displayPrice !== undefined && displayChangePct !== undefined
                          ? <LivePrice value={displayPrice} changePct={displayChangePct} phase={phase} live={Boolean(liveQuote)} stale={Boolean(liveError)} quoteAt={liveQuote?.updatedAt} size="row" />
                          : <span className="text-muted-foreground">等待行情</span>}
                      </div>
                      <div className="stock-pnl">
                        <span>{t('stocks.pnl', { year: 2026 })}</span><strong className={`number-text ${(stock.annualPnl ?? 0) >= 0 ? 'market-up' : 'market-down'}`}>{stock.annualPnl === undefined ? '—' : `${stock.annualPnl >= 0 ? '+' : '−'}${money(lang).format(Math.abs(stock.annualPnl))}`}</strong>
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
              {!filteredStocks.length && <div className="empty-state"><Search size={28} /><h3>{t('stocks.empty')}</h3><p>{t('stocks.emptyHint')}</p></div>}
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
              <div className="page-heading"><div><span className="section-kicker">YOUR WORKSPACE</span><h1>{t('settings.title')}</h1><p>{t('settings.sub')}</p>
                <LanguageToggle className="settings-lang" /></div></div>
              <div className="settings-grid">
                <section>
                  <div className="settings-section-title"><Gauge size={19} /><h2>{t('settings.riskTitle')}</h2></div>
                  <div className="settings-fields">
                    <label className="form-field">{t('settings.capital')}<input type="number" min="1000" step="1000" value={data.settings.capital} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, capital: Math.max(1000, Number(event.target.value)) } }))} /></label>
                    <label className="form-field">{t('settings.riskPct')}<input type="number" min="0.2" max="2" step="0.1" value={data.settings.riskPct} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, riskPct: Math.min(2, Math.max(0.2, Number(event.target.value))) } }))} /></label>
                    <label className="form-field">{t('settings.maxPosition')}<input type="number" min="1" max="50" step="1" value={data.settings.maxPositionPct} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, maxPositionPct: Math.min(50, Math.max(1, Number(event.target.value))) } }))} /></label>
                  </div>
                  <p className="settings-note">打开应用时读取已发布的公共快照；交易时段会按公开接口轮询盘中报价，收盘后显示收盘价。自动刷新可在今日页状态条关闭。</p>
                </section>
                <section>
                  <div className="settings-section-title"><Smartphone size={19} /><h2>{t('settings.iphoneTitle')}</h2></div>
                  <ol className="install-steps"><li><span>1</span>{t('settings.iphone1')}</li><li><span>2</span>{t('settings.iphone2')}</li><li><span>3</span>{t('settings.iphone3')}</li></ol>
                  <p className="settings-note">{t('settings.iphoneNote')}</p>
                </section>
                <section>
                  <div className="settings-section-title"><Database size={19} /><h2>{t('settings.dataTitle')}</h2></div>
                  <label className="form-field">{t('settings.goldLabel')}<input type="number" inputMode="decimal" min="0" value={data.goldValueCny ?? ''} onChange={(event) => { const value = event.target.value; setData(current => ({ ...current, goldValueCny: value === '' ? undefined : Math.max(0, Number(value)) })) }} /></label>
                  <p className="settings-note">{t('settings.goldNote')}</p>
                  <div className="data-actions">
                    <button className="button-secondary" onClick={exportData}><ArrowDownToLine size={17} />{t('settings.exportBackup')}</button>
                    <button className="button-secondary" onClick={() => { const url = URL.createObjectURL(new Blob([portfolioMarkdown(data)], { type: 'text/markdown;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'stocks.md'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) }}><ArrowDownToLine size={17} />{t('settings.exportMarkdown')}</button>
                    <button className="button-secondary" onClick={() => void downloadTemplate()}><FileDown size={17} />{t('settings.downloadTemplate')}</button>
                    <button className="button-secondary" onClick={() => fileRef.current?.click()}><Upload size={17} />{t('settings.importBackup')}</button>
                    <button className="button-secondary" onClick={() => zipRef.current?.click()}><Upload size={17} />{t('settings.importFile')}</button>
                    <input ref={zipRef} type="file" accept=".zip,.json,.md,.txt,text/plain,text/markdown,application/json,application/zip" className="hidden" onChange={(event) => void importPortfolio(event.target.files?.[0])} />
                    <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importData(event.target.files?.[0])} />
                  </div>
                  <p className="settings-note">JSON 备份导入会替换当前数据，请先导出。清单支持 JSON、Markdown、文本或 ZIP（内含 stocks.json / stocks.md / stocks.txt），只添加新股票，已有记录和黄金价值不会覆盖。ZIP 中的其他文件（包括密钥）会被忽略。Markdown 包含私人财务信息，请妥善保存。定时 AI 密钥须在 GitHub Actions 机密中单独设置。清理浏览器数据前先导出备份。</p>
                  <button className="text-button danger-text" onClick={() => setResetOpen(true)}><History size={15} />{t('settings.clearData')}</button>
                </section>
              </div>
              <section className="app-version" aria-label={t('version.current')}>
                <div><span>{t('version.current')}</span><strong>{buildLabel}</strong></div>
                <button type="button" className="button-secondary" onClick={() => void checkForUpdates()} disabled={checkingUpdate}>
                  <RefreshCw size={16} className={checkingUpdate ? 'spin' : ''} />
                  {checkingUpdate ? t('version.checking') : t('version.check')}
                </button>
              </section>
            </section>
          )}
        </main>

        <nav className="bottom-nav" aria-label={t('nav.today')}>
          {views.map(({ id, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><Icon size={21} /><span>{t(`nav.${id}`)}</span></button>)}
        </nav>
      </div>

      <StockDialog open={stockDialogOpen} onOpenChange={setStockDialogOpen} stock={editingStock} quote={editingStock ? data.quotes[editingStock.code] : undefined} onSave={saveStock} />
      <StrategyDetailDialog strategy={selectedStrategy} open={Boolean(selectedCode)} onOpenChange={(open) => !open && setSelectedCode(undefined)} liveQuote={selectedCode ? liveQuotes[selectedCode] : undefined} liveFailed={selectedCode ? Boolean(liveErrors[selectedCode]) : false} phase={phase} />
      <AlertDialog open={Boolean(deleteStock)} onOpenChange={(open) => !open && setDeleteStock(undefined)}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>移除{deleteStock?.name}？</AlertDialogTitle><AlertDialogDescription>该股票及其本地行情缓存会被移除，此操作可通过备份恢复。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground">确认移除</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('settings.clearData')}？</AlertDialogTitle><AlertDialogDescription>当前清单、行情缓存与设置会被清空。建议先导出备份，之后可以重新导入。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => { resetData(); setResetOpen(false); toast.success(t('settings.clearData')) }}>确认清空</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <Toaster position="top-center" richColors closeButton />
    </div>
  )
}

export default App
