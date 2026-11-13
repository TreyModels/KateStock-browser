import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { buildManualQuote } from '@/lib/strategy'
import type { Quote, Stock, StockStatus } from '@/types'

interface StockDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  stock?: Stock
  quote?: Quote
  onSave: (stock: Stock, quote?: Quote) => void
}

const numberValue = (value: string) => value === '' ? undefined : Number(value)

export function StockDialog({ open, onOpenChange, stock, quote, onSave }: StockDialogProps) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [status, setStatus] = useState<StockStatus>('watch')
  const [shares, setShares] = useState('')
  const [cost, setCost] = useState('')
  const [annualPnl, setAnnualPnl] = useState('')
  const [manualMode, setManualMode] = useState(false)
  const [manual, setManual] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    // Reinitialize the form when editing a different stock.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCode(stock?.code ?? '')
    setName(stock?.name ?? '')
    setStatus(stock?.status ?? 'watch')
    setShares(stock?.shares?.toString() ?? '')
    setCost(stock?.cost?.toString() ?? '')
    setAnnualPnl(stock?.annualPnl?.toString() ?? '')
    setManualMode(quote?.source === 'manual')
    setManual(quote?.source === 'manual' ? {
      price: quote.price.toString(),
      prevClose: quote.prevClose.toString(),
      open: quote.open.toString(),
      high: quote.high.toString(),
      low: quote.low.toString(),
      ma5: quote.manual?.ma5?.toString() ?? '',
      ma10: quote.manual?.ma10?.toString() ?? '',
      ma20: quote.manual?.ma20?.toString() ?? '',
      high20: quote.manual?.high20?.toString() ?? '',
      atr14: quote.manual?.atr14?.toString() ?? '',
      rsi14: quote.manual?.rsi14?.toString() ?? '',
      volumeRatio: quote.manual?.volumeRatio?.toString() ?? '',
    } : {})
    setError('')
  }, [open, stock, quote])

  const setManualField = (key: string, value: string) => setManual((current) => ({ ...current, [key]: value }))

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!/^\d{6}$/.test(code)) return setError('请输入 6 位数字代码')
    if (!name.trim()) return setError('请输入股票或 ETF 名称')
    if (status === 'holding' && (!Number(shares) || !Number(cost))) return setError('当前持仓需要填写有效股数和成本价')
    if (manualMode && (!Number(manual.price) || !Number(manual.prevClose))) return setError('手动行情至少需要现价与昨收价')

    const saved: Stock = {
      id: stock?.id ?? `stock-${code}-${Date.now()}`,
      code,
      name: name.trim(),
      status,
      shares: numberValue(shares),
      cost: numberValue(cost),
      annualPnl: numberValue(annualPnl),
      createdAt: stock?.createdAt ?? new Date().toISOString(),
    }
    const manualQuote = manualMode ? buildManualQuote(code, {
      price: Number(manual.price),
      prevClose: Number(manual.prevClose),
      open: numberValue(manual.open ?? ''),
      high: numberValue(manual.high ?? ''),
      low: numberValue(manual.low ?? ''),
      ma5: numberValue(manual.ma5 ?? ''),
      ma10: numberValue(manual.ma10 ?? ''),
      ma20: numberValue(manual.ma20 ?? ''),
      high20: numberValue(manual.high20 ?? ''),
      atr14: numberValue(manual.atr14 ?? ''),
      rsi14: numberValue(manual.rsi14 ?? ''),
      volumeRatio: numberValue(manual.volumeRatio ?? ''),
    }) : undefined
    onSave(saved, manualQuote)
  }

  const manualFields = [
    ['price', '现价 *'], ['prevClose', '昨收 *'], ['ma5', 'MA5'], ['ma10', 'MA10'],
    ['ma20', 'MA20'], ['high20', '20日高点'], ['atr14', 'ATR14'], ['rsi14', 'RSI14'],
    ['volumeRatio', '量比'], ['open', '今开'], ['high', '最高'], ['low', '最低'],
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="stock-dialog">
        <DialogHeader>
          <DialogTitle>{stock ? '编辑股票与行情' : '添加股票或 ETF'}</DialogTitle>
          <DialogDescription>持仓只用于本地策略计算，不会连接券商账户。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="mt-2 space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <label className="form-field">证券代码
              <input inputMode="numeric" maxLength={6} value={code} disabled={Boolean(stock)} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="输入 6 位证券代码" />
            </label>
            <label className="form-field">名称
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="输入证券名称" />
            </label>
          </div>
          <label className="form-field">清单类型
            <select value={status} onChange={(event) => setStatus(event.target.value as StockStatus)}>
              <option value="watch">当前自选</option>
              <option value="holding">当前持仓</option>
              <option value="history">历史记录</option>
            </select>
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="form-field">持有股数
              <input inputMode="decimal" type="number" min="0" value={shares} onChange={(event) => setShares(event.target.value)} placeholder="0" />
            </label>
            <label className="form-field">成本价
              <input inputMode="decimal" type="number" min="0" step="0.01" value={cost} onChange={(event) => setCost(event.target.value)} placeholder="选填" />
            </label>
            <label className="form-field">年度收益
              <input inputMode="decimal" type="number" step="0.01" value={annualPnl} onChange={(event) => setAnnualPnl(event.target.value)} placeholder="选填" />
            </label>
          </div>

          <label className="toggle-row">
            <span><strong>使用手动行情</strong><small>接口不可用或需要离线策略时开启</small></span>
            <input type="checkbox" checked={manualMode} onChange={(event) => setManualMode(event.target.checked)} />
          </label>

          {manualMode && (
            <div className="grid grid-cols-2 gap-3 border-t border-border pt-4 sm:grid-cols-3">
              {manualFields.map(([key, label]) => (
                <label className="form-field" key={key}>{label}
                  <input inputMode="decimal" type="number" step="any" value={manual[key] ?? ''} onChange={(event) => setManualField(key, event.target.value)} />
                </label>
              ))}
            </div>
          )}
          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className="button-secondary" onClick={() => onOpenChange(false)}>取消</button>
            <button type="submit" className="button-primary">保存并生成策略</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
