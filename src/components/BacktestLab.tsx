import { useEffect, useMemo, useState } from 'react'
import { quantsBacktests } from '@/lib/quants'
import { Activity, ArrowLeft, ArrowRight, BarChart3, CircleAlert, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react'
import { buildStoryFrame, runAllBacktests, type BacktestResult, type BacktestStrategyId } from '@/lib/backtest'
import type { Quote, Stock } from '@/types'

interface BacktestLabProps {
  stocks: Stock[]
  quotes: Record<string, Quote>
  refreshing: boolean
  onRefresh: () => void
}

const percent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
const dateShort = (date: string) => date.slice(5).replace('-', '/')

function ScoreRing({ score }: { score: number }) {
  const radius = 44
  const circumference = 2 * Math.PI * radius
  return (
    <div className="score-ring">
      <svg viewBox="0 0 108 108" aria-hidden="true">
        <circle cx="54" cy="54" r={radius} fill="none" stroke="currentColor" strokeOpacity=".14" strokeWidth="6" />
        <circle cx="54" cy="54" r={radius} fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - score / 100)} transform="rotate(-90 54 54)" />
      </svg>
      <span><strong>{score}</strong><small>适配分</small></span>
    </div>
  )
}

function EquityChart({ result, bars }: { result: BacktestResult; bars: import('@/types').Bar[] }) {
  const start = 20
  const strategyPoints = result.equity.slice(start)
  const base = bars[start]?.close ?? 1
  const benchmark = bars.slice(start).map((bar, offset) => ({ index: offset + start, date: bar.date, value: bar.close / base }))
  const allValues = [...strategyPoints.map((point) => point.value), ...benchmark.map((point) => point.value)]
  const min = Math.min(...allValues) * 0.98
  const max = Math.max(...allValues) * 1.02
  const range = max - min || 1
  const path = (points: Array<{ value: number }>) => points.map((point, index) => {
    const x = 48 + index * 656 / Math.max(1, points.length - 1)
    const y = 174 - (point.value - min) / range * 144
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  return (
    <div className="equity-chart-wrap">
      <div className="chart-legend"><span><i style={{ background: result.color }} />{result.name}</span><span><i className="benchmark-line" />同期买入持有</span></div>
      <svg className="equity-chart" viewBox="0 0 720 200" role="img" aria-label={`${result.name}与买入持有的归一化权益曲线`}>
        {[0, 1, 2, 3].map((line) => {
          const y = 30 + line * 48
          const value = max - line * range / 3
          return <g key={line}><line x1="48" x2="704" y1={y} y2={y} stroke="currentColor" strokeOpacity=".1" /><text x="42" y={y + 4} textAnchor="end" className="chart-axis-text">{(value * 100).toFixed(0)}%</text></g>
        })}
        <path d={path(benchmark)} fill="none" stroke="currentColor" strokeOpacity=".36" strokeWidth="1.5" strokeDasharray="5 5" />
        <path d={path(strategyPoints)} fill="none" stroke={result.color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <text x="48" y="194" className="chart-axis-text">{dateShort(bars[start].date)}</text>
        <text x="704" y="194" textAnchor="end" className="chart-axis-text">{dateShort(bars.at(-1)!.date)}</text>
      </svg>
    </div>
  )
}

function StoryChart({ result, bars, frameIndex }: { result: BacktestResult; bars: import('@/types').Bar[]; frameIndex: number }) {
  const start = Math.max(20, bars.length - 80)
  const visible = bars.slice(start)
  const lows = visible.map((bar) => bar.low)
  const highs = visible.map((bar) => bar.high)
  const min = Math.min(...lows) * 0.99
  const max = Math.max(...highs) * 1.01
  const range = max - min || 1
  const point = (index: number, price: number) => ({
    x: 36 + (index - start) * 668 / Math.max(1, bars.length - 1 - start),
    y: 216 - (price - min) / range * 182,
  })
  const path = (endIndex: number) => bars.slice(start, endIndex + 1).map((bar, offset) => {
    const p = point(start + offset, bar.close)
    return `${offset === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`
  }).join(' ')
  const cursor = point(frameIndex, bars[frameIndex].close)
  const markers = result.trades.flatMap((trade) => {
    const items = []
    if (trade.entryIndex >= start && trade.entryIndex <= frameIndex) items.push({ index: trade.entryIndex, type: 'entry' as const, price: bars[trade.entryIndex].low })
    if (trade.exitIndex >= start && trade.exitIndex <= frameIndex) items.push({ index: trade.exitIndex, type: 'exit' as const, price: bars[trade.exitIndex].high })
    return items
  })
  return (
    <svg className="story-chart" viewBox="0 0 720 250" role="img" aria-label={`截至${bars[frameIndex].date}的动态价格复盘`}>
      {[0, 1, 2, 3].map((line) => <line key={line} x1="36" x2="704" y1={34 + line * 60.5} y2={34 + line * 60.5} stroke="currentColor" strokeOpacity=".09" />)}
      <path d={path(bars.length - 1)} fill="none" stroke="currentColor" strokeOpacity=".16" strokeWidth="1.5" />
      <path d={path(frameIndex)} fill="none" stroke={result.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <line x1={cursor.x} x2={cursor.x} y1="20" y2="222" stroke={result.color} strokeOpacity=".45" strokeDasharray="3 4" />
      {markers.map((marker, markerIndex) => {
        const p = point(marker.index, marker.price)
        return <g key={`${marker.index}-${marker.type}-${markerIndex}`} transform={`translate(${p.x} ${marker.type === 'entry' ? p.y + 14 : p.y - 14})`}><circle r="7" fill={marker.type === 'entry' ? '#d84a40' : '#14805f'} /><text y="3" textAnchor="middle" className="marker-text">{marker.type === 'entry' ? 'B' : 'S'}</text></g>
      })}
      <circle cx={cursor.x} cy={cursor.y} r="5" fill={result.color} stroke="#f4f5f1" strokeWidth="2" />
      <text x="36" y="242" className="story-axis-text">{dateShort(bars[start].date)}</text>
      <text x="704" y="242" textAnchor="end" className="story-axis-text">{dateShort(bars.at(-1)!.date)}</text>
    </svg>
  )
}

export function BacktestLab({ stocks, quotes, refreshing, onRefresh }: BacktestLabProps) {
  const available = stocks.filter((stock) => (quotes[stock.code]?.bars.length ?? 0) >= 45)
  const [selectedCode, setSelectedCode] = useState(available[0]?.code ?? stocks[0]?.code ?? '')
  const [selectedId, setSelectedId] = useState<BacktestStrategyId>('breakout')
  const [frameIndex, setFrameIndex] = useState(20)
  const [playing, setPlaying] = useState(false)
  const stock = stocks.find((item) => item.code === selectedCode)
  const bars = useMemo(() => quotes[selectedCode]?.bars ?? [], [quotes, selectedCode])
  const results = useMemo(() => runAllBacktests(bars), [bars])
  const selected = results.find((result) => result.id === selectedId) ?? results[0]
  const best = [...results].sort((a, b) => b.score - a.score)[0]
  const stockResults = useMemo(() => stocks.map((item) => {
    const history = quotes[item.code]?.bars ?? []
    if (history.length < 100) return { item, history, result: undefined, validation: undefined }
    const split = Math.floor(history.length * 0.7)
    const training = runAllBacktests(history.slice(0, split)).filter((r) => r.trades.length >= 3)
      .sort((a, b) => b.totalReturnPct - a.totalReturnPct)
    const chosen = training[0]
    const validation = chosen ? runAllBacktests(history.slice(split - 20)).find((r) => r.id === chosen.id) : undefined
    return { item, history, result: chosen, validation }
  }), [stocks, quotes])

  useEffect(() => {
    // Reset playback when the selected series changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (bars.length) setFrameIndex(bars.length - 1)
    setPlaying(false)
  }, [selectedCode, selectedId, bars.length])

  useEffect(() => {
    if (!playing || bars.length < 45) return
    const timer = window.setInterval(() => setFrameIndex((current) => Math.min(current + 1, bars.length - 1)), 650)
    return () => window.clearInterval(timer)
  }, [playing, bars.length])

  useEffect(() => {
    // Stop playback once it reaches the end of the series.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (frameIndex >= bars.length - 1) setPlaying(false)
  }, [frameIndex, bars.length])

  if (!stock || !bars.length || !selected || !best) {
    return (
      <section className="standard-page">
        <div className="page-heading"><div><span className="section-kicker">BACKTEST LAB</span><h1>回测实验室</h1><p>先加载最近日线，再让策略接受历史检验。</p></div></div>
        <div className="empty-state"><BarChart3 size={32} /><h3>需要至少 45 根日线</h3><p>刷新自动行情后，即可生成策略回测与动态复盘。</p><button className="button-primary" onClick={onRefresh} disabled={refreshing}><RefreshCw size={17} className={refreshing ? 'spin' : ''} />加载历史行情</button></div>
      </section>
    )
  }

  const frame = buildStoryFrame(selected, bars, frameIndex)
  const hasStrongFit = best.fitScore >= 50
  const startDate = bars[20].date
  const endDate = bars.at(-1)!.date
  const play = () => {
    if (frameIndex >= bars.length - 1) setFrameIndex(20)
    setPlaying(true)
  }

  return (
    <section className="backtest-page">
      <div className="page-heading backtest-heading">
        <div><span className="section-kicker">BACKTEST LAB</span><h1>让策略在时间中<br className="mobile-only" />证明自己。</h1><p>历史表现 × 当前状态 × 每一帧的交易理由</p></div>
        <label className="backtest-stock-select">复盘标的
          <select value={selectedCode} onChange={(event) => setSelectedCode(event.target.value)}>
            {available.map((item) => <option value={item.code} key={item.id}>{item.name} · {item.code}</option>)}
          </select>
        </label>
      </div>

      <section className="performance-panel" style={{ marginBottom: 24, overflowX: 'auto' }}>
        <div className="performance-title"><div><span className="section-kicker">DAILY RESEARCH</span><h2>每只股票的策略表现</h2></div></div>
        <p>先用前 70% 的历史选择策略，再用后 30% 检验。验证期至少需要 3 笔完整交易，才显示可参考的结果。</p>
        <table style={{ width: '100%', minWidth: 650, textAlign: 'left', borderSpacing: '0 12px' }}>
          <thead><tr><th>股票</th><th>历史优选</th><th>验证收益</th><th>最大回撤</th><th>交易</th><th>最新条件</th></tr></thead>
          <tbody>{stockResults.map(({ item, history, result, validation }) => {
            const valid = validation && validation.trades.length >= 3
            const latest = result && history.length ? runAllBacktests(history).find((r) => r.id === result.id) : undefined
            return <tr key={item.id} onClick={() => { if (history.length >= 45) { setSelectedCode(item.code); if (result) setSelectedId(result.id) } }} style={{ cursor: 'pointer' }}>
              <td>{item.name} · {item.code}</td><td>{result?.name ?? '样本不足'}</td>
              <td>{valid ? percent(validation.totalReturnPct) : '证据不足'}</td><td>{valid ? percent(validation.maxDrawdownPct) : '—'}</td>
              <td>{validation?.trades.length ?? 0}</td><td>{latest?.currentReasons[0] ?? '请加载历史行情'}</td>
            </tr>
          })}</tbody>
        </table>
        <p>点选股票查看完整回测。验证结果描述历史，未来表现可能不同；价格数据截至最近一个交易日。</p>
      </section>

      <section className="performance-panel" style={{ marginBottom: 24 }}>
        <h2>策略解读</h2>
        <p>{stock.name} 的{best.name}当前适配分为 {best.fitScore}。{best.currentReasons[0]}。在所选历史期间，策略收益 {percent(best.totalReturnPct)}，最大回撤 {percent(best.maxDrawdownPct)}，共完成 {best.trades.length} 笔交易。{best.trades.length < 3 ? '交易样本太少，暂时无法据此判断策略是否可靠。' : '请结合上方验证期结果和交易明细判断。'}</p>
      </section>

      <section className="performance-panel" style={{ marginBottom: 24 }}>
        <h2>quants.md adaptations / 策略改编</h2>
        <p>Single-stock adaptations, next-open fills and 0.1% per side. Original portfolio sizing differs. / 单只股票改编，次日开盘成交，单边成本 0.1%；仓位与原版不同。</p>
        {bars.length < 60 ? <p>At least 60 daily bars required. / 至少需要 60 根日线。</p> : quantsBacktests(bars).map(r => <div key={r.id} style={{ padding: '12px 0', borderBottom: '1px solid #ddd' }}><strong>{r.id} {r.name}</strong><p>{r.signal} · Return / 收益 {percent(r.ret)} · Drawdown / 回撤 {percent(r.drawdown)} · Trades / 交易 {r.trades}</p><p>{r.trades < 3 ? 'Too few completed trades to assess. / 完成交易过少，无法评估。' : `Win rate / 胜率 ${(r.wins / r.trades * 100).toFixed(0)}%`}</p></div>)}
      </section>
      <section className="match-hero">
        <div className="match-copy">
          <span className="match-label"><Activity size={14} />当前规则匹配，而非收益预测</span>
          <h2>{hasStrongFit ? best.name : '等待规则共振'}<small>{hasStrongFit ? '在此刻相对更适配' : '当前无强适配策略'}</small></h2>
          <p>{stock.name} · {stock.code} · 截至 {endDate}</p>
          <div className="match-reasons">
            {best.currentReasons.slice(0, 3).map((reason) => <span key={reason}><ArrowRight size={14} />{reason}</span>)}
          </div>
        </div>
        <ScoreRing score={best.score} />
        <div className="match-meta">
          <div><span>当前状态</span><strong>{best.fitScore}</strong></div>
          <div><span>历史样本</span><strong>{best.performanceScore}</strong></div>
          <p>{best.sampleNote}。适配分中当前状态占 70%，历史样本占 30%。</p>
        </div>
      </section>

      <div className="backtest-layout">
        <section className="backtest-main">
          <div className="section-heading"><div><span className="section-kicker">STRATEGY RANKING</span><h2>四种策略，同一段历史</h2></div><span className="data-stamp">{startDate} — {endDate}</span></div>
          <div className="strategy-ranking">
            {results.map((result) => (
              <button key={result.id} className={selectedId === result.id ? 'active' : ''} onClick={() => setSelectedId(result.id)}>
                <span className="ranking-top"><i style={{ background: result.color }} /><strong>{result.name}</strong><b>{result.score}</b></span>
                <span className="ranking-subtitle">{result.subtitle}</span>
                <span className="ranking-metrics"><em className={result.totalReturnPct >= 0 ? 'market-up' : 'market-down'}>{percent(result.totalReturnPct)}</em><em>胜率 {result.winRate.toFixed(0)}%</em><em>{result.trades.length} 笔</em></span>
                <span className="ranking-bar"><i style={{ width: `${result.score}%`, background: result.color }} /></span>
              </button>
            ))}
          </div>

          <div className="performance-panel">
            <div className="performance-title"><div><span className="section-kicker">EQUITY & RISK</span><h2>{selected.name}</h2></div><span className={selected.trades.length < 3 ? 'sample-badge warning' : 'sample-badge'}>{selected.sampleNote}</span></div>
            <div className="performance-metrics">
              <div><span>区间收益</span><strong className={selected.totalReturnPct >= 0 ? 'market-up' : 'market-down'}>{percent(selected.totalReturnPct)}</strong></div>
              <div><span>最大回撤</span><strong>{selected.maxDrawdownPct.toFixed(2)}%</strong></div>
              <div><span>交易胜率</span><strong>{selected.winRate.toFixed(1)}%</strong></div>
              <div><span>盈利因子</span><strong>{selected.profitFactor === null ? '∞' : selected.profitFactor.toFixed(2)}</strong></div>
            </div>
            <EquityChart result={selected} bars={bars} />
            <details className="assumptions"><summary>回测假设与限制</summary><p>收盘生成信号，下一交易日开盘执行；单边成本 0.10%。止损与目标在同一交易日均触及时，保守地按止损优先。单策略归一化满仓，仅用于比较规则；不含分红、涨跌停无法成交、流动性和实际滑点差异。</p></details>
          </div>

          <section className="storyboard">
            <div className="storyboard-header">
              <div><span className="section-kicker">DYNAMIC STORYBOARD</span><h2>动态复盘</h2></div>
              <div className="playback-controls">
                <button aria-label="回到起点" onClick={() => { setPlaying(false); setFrameIndex(20) }}><RotateCcw size={16} /></button>
                <button aria-label="上一帧" disabled={frameIndex <= 20} onClick={() => { setPlaying(false); setFrameIndex((current) => Math.max(20, current - 1)) }}><ArrowLeft size={18} /></button>
                <button className="play-button" aria-label={playing ? '暂停复盘' : '播放复盘'} onClick={() => playing ? setPlaying(false) : play()}>{playing ? <Pause size={18} /> : <Play size={18} />}{playing ? '暂停' : '播放'}</button>
                <button aria-label="下一帧" disabled={frameIndex >= bars.length - 1} onClick={() => { setPlaying(false); setFrameIndex((current) => Math.min(bars.length - 1, current + 1)) }}><ArrowRight size={18} /></button>
              </div>
            </div>
            <div className="story-price"><span>{frame.date}</span><strong>{frame.close.toFixed(2)}</strong><em className={frame.changePct >= 0 ? 'market-up' : 'market-down'}>{percent(frame.changePct)}</em></div>
            <StoryChart result={selected} bars={bars} frameIndex={frameIndex} />
            <input className="timeline-range" aria-label="复盘时间轴" type="range" min={20} max={bars.length - 1} value={frameIndex} onChange={(event) => { setPlaying(false); setFrameIndex(Number(event.target.value)) }} style={{ '--timeline-progress': `${(frameIndex - 20) / (bars.length - 21) * 100}%` } as React.CSSProperties} />
            <div className={`frame-narrative frame-${frame.tone}`}>
              <span className="frame-count">FRAME {String(frameIndex - 19).padStart(3, '0')}</span>
              <h3>{frame.title}</h3><p>{frame.narrative}</p>
              <div>{frame.reasons.map((reason) => <span key={reason}>{reason}</span>)}</div>
            </div>
          </section>
        </section>

        <aside className="trade-log">
          <div className="section-heading compact"><div><span className="section-kicker">TRADE LOG</span><h2>最近交易</h2></div><span>{selected.trades.length} 笔</span></div>
          {selected.trades.length ? [...selected.trades].reverse().slice(0, 8).map((trade) => (
            <button key={`${trade.entryIndex}-${trade.exitIndex}`} onClick={() => { setPlaying(false); setFrameIndex(trade.exitIndex) }}>
              <span><strong>{trade.exitDate}</strong><small>{trade.exitReason}</small></span>
              <span><b className={trade.returnPct >= 0 ? 'market-up' : 'market-down'}>{percent(trade.returnPct)}</b><small>{trade.entryDate.slice(5)} 买入</small></span>
            </button>
          )) : <div className="no-trades"><CircleAlert size={22} /><p>这段历史没有完整交易样本。策略适配分已降权，不把“没有交易”解释为“表现稳定”。</p></div>}
          <p className="trade-log-note">点击一笔交易，时间轴会跳到退出日。B / S 分别标记回测买入与卖出。</p>
        </aside>
      </div>
    </section>
  )
}
