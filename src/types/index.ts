export type StockStatus = 'history' | 'holding' | 'watch'
export type DataSource = 'auto' | 'manual'

export interface Stock {
  id: string
  code: string
  name: string
  status: StockStatus
  annualPnl?: number
  shares?: number
  cost?: number
  createdAt: string
}

export interface Bar {
  date: string
  open: number
  close: number
  high: number
  low: number
  volume: number
  amount: number
  changePct: number
  turnoverPct?: number
}

export interface ManualIndicators {
  ma5?: number
  ma10?: number
  ma20?: number
  high20?: number
  atr14?: number
  rsi14?: number
  volumeRatio?: number
}

export interface Quote {
  code: string
  price: number
  prevClose: number
  changePct: number
  open: number
  high: number
  low: number
  volume: number
  amount: number
  tradeDate: string
  fetchedAt: string
  source: DataSource
  provider?: string
  adjustment?: string
  bars: Bar[]
  manual?: ManualIndicators
}

export interface RiskSettings {
  capital: number
  riskPct: number
  maxPositionPct: number
  refreshOnOpen: boolean
}

export type StrategyAction = 'breakout' | 'pullback' | 'hold' | 'reduce' | 'stop' | 'watch'

export interface Strategy {
  stockId: string
  code: string
  name: string
  action: StrategyAction
  actionLabel: string
  score: number
  summary: string
  reasons: string[]
  /** 是否持仓（由 stock.status === 'holding' 且 shares > 0 推导；盘中提醒据此区分持仓/非持仓语义） */
  isHolding?: boolean
  trigger?: number
  stop?: number
  target?: number
  suggestedShares?: number
  suggestedPositionPct?: number
  price: number
  changePct: number
  tradeDate: string
  source: DataSource
  indicators: Required<ManualIndicators>
  bars: Bar[]
}

/* ─────────────────────────────────────────────────────────────
 * 盘中（intraday）契约 —— 跨 data / signals / ui 三层共享。
 * 由 Lead 维护；实现方不得改变字段名与含义。
 * ───────────────────────────────────────────────────────────── */
export type MarketPhase = 'preopen' | 'auction' | 'trading' | 'lunch' | 'closed' | 'non-trading'

export interface LiveQuote {
  code: string
  price: number
  prevClose: number
  open: number
  high: number
  low: number
  changePct: number
  volume: number
  amount: number
  /** 报价数据时间（ISO 8601，含时区） */
  updatedAt: string
  phase: MarketPhase
  provider: 'eastmoney' | 'sina' | 'tencent'
}

export type AlertKind = 'trigger' | 'stop' | 'target'

export interface LiveStatus {
  code: string
  price: number
  changePct: number
  updatedAt: string
  phase: MarketPhase
  /** (触发价 / 现价 - 1) * 100，无触发价则为 undefined */
  distanceToTriggerPct?: number
  /** (现价 / 保护位 - 1) * 100，无保护位则为 undefined */
  distanceToStopPct?: number
  /** 当前价格已经触发的提醒类型（按 止损 > 目标 > 触发 排序） */
  hits: AlertKind[]
}

export interface AlertEvent {
  /** 去重键：`${code}:${kind}:${tradeDate}` */
  id: string
  code: string
  name: string
  kind: AlertKind
  level: number
  price: number
  at: string
  message: string
}

export interface AppData {
  goldValueCny?: number
  stocks: Stock[]
  quotes: Record<string, Quote>
  settings: RiskSettings
}
