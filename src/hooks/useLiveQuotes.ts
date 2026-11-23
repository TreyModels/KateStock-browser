import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LiveQuote, MarketPhase } from '@/types'
import { fetchLiveQuotes, getMarketPhase, isLivePhase, latestQuoteUpdatedAt, nextPollDelay, nextWakeAt } from '@/lib/live'

/**
 * 盘中报价轮询 hook（data-live 实现）。
 * 契约：src/types/index.ts 的 LiveQuote / MarketPhase。
 *
 * 行为：
 * - `enabled` 为 false 时完全不发请求；
 * - 挂载/代码变化/启用时先刷新一次（任何时段都允许这一次，用于拿「收盘价」）；
 * - **只有 auction / trading 相位会自动轮询行情**（15s）；
 * - 其余相位只挂一个「相位看门」定时器，且用 nextWakeAt 精确排到 09:15/09:30/13:00/下一工作日
 *   （P1-4：09:25–09:30 不再等 60s，而是精确等到 09:30:00 开盘），到点只重新判断相位、不请求行情；
 * - 卸载/禁用时清理所有定时器，并丢弃 in-flight 响应，避免 setState-after-unmount；
 * - 并发刷新（定时器 + 手动 refresh）用序号丢弃过期响应，fetchLiveQuotes 内部也会合并同批请求。
 *
 * updatedAt 语义（P1-7）：返回的是**本批报价里 provider 行情时间的最大值**（ISO），
 * 不是抓取时间；本批没有拿到任何报价时为 undefined（不拿 new Date() 兜底，避免「最近报价=刚才」的误导）。
 * 是否陈旧请用 `isStale(quote)`（src/lib/live.ts 导出）；非交易时段陈旧是预期行为（收盘价）。
 *
 * lastAttemptAt（P1-1 数据侧）：最近一次真正发起拉取的时刻（ISO），无论成败；
 * UI 可据此区分「本次请求失败、报价仍是上一轮」的情况。从未尝试时 undefined。
 */
export interface UseLiveQuotesResult {
  liveQuotes: Record<string, LiveQuote>
  phase: MarketPhase
  /** 本批报价里 provider 的最新行情时间（ISO）；本批无报价则为 undefined */
  updatedAt?: string
  /** 最近一次真正发起拉取的时刻（ISO，无论成功失败）；从未尝试则为 undefined */
  lastAttemptAt?: string
  loading: boolean
  errors: Record<string, string>
  refresh: () => Promise<void>
}

export function useLiveQuotes(codes: string[], options: { enabled?: boolean } = {}): UseLiveQuotesResult {
  const enabled = options.enabled ?? true
  const key = useMemo(() => {
    const unique = [...new Set(codes.map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code)))]
    unique.sort()
    return unique.join(',')
  }, [codes])
  const [liveQuotes, setLiveQuotes] = useState<Record<string, LiveQuote>>({})
  const [phase, setPhase] = useState<MarketPhase>(() => getMarketPhase())
  const [updatedAt, setUpdatedAt] = useState<string>()
  const [lastAttemptAt, setLastAttemptAt] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const aliveRef = useRef(true)
  const seqRef = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const currentPhase = getMarketPhase()
    setPhase(currentPhase)
    if (!enabled) return

    const requested = key ? key.split(',') : []
    if (requested.length === 0) {
      setLiveQuotes({})
      setErrors({})
      setUpdatedAt(undefined)
      return
    }

    const seq = seqRef.current + 1
    seqRef.current = seq
    setLoading(true)
    setLastAttemptAt(new Date().toISOString())
    try {
      const result = await fetchLiveQuotes(requested)
      if (!aliveRef.current || seq !== seqRef.current) return
      setLiveQuotes((current) => {
        const next: Record<string, LiveQuote> = {}
        for (const code of requested) {
          const quote = result.quotes[code] ?? current[code]
          if (quote) next[code] = quote
        }
        return next
      })
      setErrors(result.errors)
      // 本批报价的 provider 行情时间（无报价 → undefined，不用抓取时间兜底）
      setUpdatedAt(latestQuoteUpdatedAt(result.quotes))
    } catch (error) {
      if (!aliveRef.current || seq !== seqRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setErrors(Object.fromEntries(requested.map((code) => [code, `拉取行情失败：${message}`])))
      setUpdatedAt(undefined)
    } finally {
      if (aliveRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [enabled, key])

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let quoteTimer: number | undefined
    let phaseTimer: number | undefined

    const clearTimers = () => {
      if (quoteTimer !== undefined) {
        window.clearTimeout(quoteTimer)
        quoteTimer = undefined
      }
      if (phaseTimer !== undefined) {
        window.clearTimeout(phaseTimer)
        phaseTimer = undefined
      }
    }

    // 非交易时段：只判断相位、不发请求；精确排到下一个开盘/时点（P1-4）
    const schedulePhaseWatch = () => {
      const wake = nextWakeAt(new Date())
      const delay = Math.max(0, wake.getTime() - Date.now())
      phaseTimer = window.setTimeout(() => {
        void watchPhase()
      }, delay)
    }

    // 交易/竞价：拉行情 + 按相位安排下一次
    const poll = async () => {
      if (disposed) return
      await refresh()
      if (disposed) return
      const currentPhase = getMarketPhase()
      setPhase(currentPhase)
      if (isLivePhase(currentPhase)) {
        quoteTimer = window.setTimeout(() => {
          void poll()
        }, nextPollDelay(currentPhase))
      } else {
        schedulePhaseWatch()
      }
    }

    // 非交易时段：只看看是否开盘了，不发行情请求
    const watchPhase = async () => {
      if (disposed) return
      const currentPhase = getMarketPhase()
      setPhase(currentPhase)
      if (isLivePhase(currentPhase)) {
        await poll()
        return
      }
      schedulePhaseWatch()
    }

    void poll()

    return () => {
      disposed = true
      clearTimers()
    }
  }, [enabled, refresh])

  return { liveQuotes, phase, updatedAt, lastAttemptAt, loading, errors, refresh }
}
