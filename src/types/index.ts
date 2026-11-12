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
  turnoverPct: number
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

export interface AppData {
  stocks: Stock[]
  quotes: Record<string, Quote>
  settings: RiskSettings
}
