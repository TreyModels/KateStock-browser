import type { Bar, Quote } from '@/types'

const FIELDS_1 = 'f1,f2,f3,f4,f5,f6'
const FIELDS_2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'

interface EastmoneyResponse {
  rc: number
  data?: {
    code: string
    name: string
    klines?: string[]
  }
}

export function marketId(code: string) {
  return `${/^(5|6|9)/.test(code) ? 1 : 0}.${code}`
}

function endpoint(code: string) {
  const begin = new Date()
  begin.setDate(begin.getDate() - 240)
  const beg = begin.toISOString().slice(0, 10).replaceAll('-', '')
  const params = new URLSearchParams({
    secid: marketId(code),
    fields1: FIELDS_1,
    fields2: FIELDS_2,
    klt: '101',
    fqt: '1',
    beg,
    end: '20500101',
  })
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`
}

function parseResponse(payload: EastmoneyResponse, code: string): Quote {
  if (payload.rc !== 0 || !payload.data?.klines?.length) {
    throw new Error('暂未返回有效日线，请检查代码或改用手动行情')
  }

  const bars: Bar[] = payload.data.klines.map((line) => {
    const [date, open, close, high, low, volume, amount, , changePct, , turnoverPct] = line.split(',')
    return {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: Number(amount),
      changePct: Number(changePct),
      turnoverPct: Number(turnoverPct),
    }
  }).filter((bar) => Number.isFinite(bar.close)).slice(-160)

  const latest = bars.at(-1)
  const previous = bars.at(-2)
  if (!latest || !previous) throw new Error('日线数据不足，请改用手动行情')

  return {
    code,
    price: latest.close,
    prevClose: previous.close,
    changePct: latest.changePct,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    volume: latest.volume,
    amount: latest.amount,
    tradeDate: latest.date,
    fetchedAt: new Date().toISOString(),
    source: 'auto',
    bars,
  }
}

async function fetchJson(code: string): Promise<Quote> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetch(endpoint(code), { signal: controller.signal })
    if (!response.ok) throw new Error(`行情服务返回 ${response.status}`)
    return parseResponse(await response.json(), code)
  } finally {
    window.clearTimeout(timer)
  }
}

function fetchJsonp(code: string): Promise<Quote> {
  return new Promise((resolve, reject) => {
    const callback = `__quote_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const script = document.createElement('script')
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('行情请求超时，请稍后重试或手动录入'))
    }, 12000)

    const cleanup = () => {
      window.clearTimeout(timer)
      script.remove()
      delete (window as unknown as Record<string, unknown>)[callback]
    }

    ;(window as unknown as Record<string, unknown>)[callback] = (payload: EastmoneyResponse) => {
      try {
        resolve(parseResponse(payload, code))
      } catch (error) {
        reject(error)
      } finally {
        cleanup()
      }
    }
    script.onerror = () => {
      cleanup()
      reject(new Error('无法连接行情服务，请检查网络或手动录入'))
    }
    script.src = `${endpoint(code)}&cb=${callback}`
    document.head.appendChild(script)
  })
}

export async function fetchQuote(code: string): Promise<Quote> {
  if (!/^\d{6}$/.test(code)) throw new Error('请输入 6 位股票或 ETF 代码')
  try {
    return await fetchJson(code)
  } catch {
    return fetchJsonp(code)
  }
}

export async function fetchQuotes(
  codes: string[],
  onProgress?: (completed: number, total: number) => void,
) {
  const results: Record<string, Quote> = {}
  const errors: Record<string, string> = {}
  let cursor = 0
  let completed = 0
  const workers = Array.from({ length: Math.min(4, codes.length) }, async () => {
    while (cursor < codes.length) {
      const code = codes[cursor++]
      try {
        results[code] = await fetchQuote(code)
      } catch (error) {
        errors[code] = error instanceof Error ? error.message : '行情获取失败'
      } finally {
        completed += 1
        onProgress?.(completed, codes.length)
      }
    }
  })
  await Promise.all(workers)
  return { results, errors }
}
