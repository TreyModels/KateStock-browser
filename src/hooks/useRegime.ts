import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Bar } from '@/types'
import { loadRegimeDetail, readRegimeCache } from '@/lib/regime'
import type { RegimeInfo } from '@/lib/regime'

/**
 * 市场状态 hook（供 UI 做徽标/主题配色）。
 * 契约：useRegime(watchlistBars) → { regime, loading, error, refresh }。
 *
 * 行为：
 * - 挂载/标的日线变化时：先同步读 localStorage 缓存立即上屏，再调用 loadRegimeDetail 后台刷新；
 * - loadRegimeDetail 内部「当天已成功拉过则不重复拉」（缓存命中），手动 refresh 时 force=true；
 * - 沪深300 拉取失败：错误写入 error；若已有 source='index' 的结果则保留旧结果（不要用宽度结果覆盖），
 *   没有旧结果时才展示宽度兜底结果；不抛错；
 * - 卸载后丢弃 in-flight 响应，避免 setState-after-unmount。
 */
export interface UseRegimeResult {
  /** 最近一次可用的市场状态；缓存/首次加载完成前为 null */
  regime: RegimeInfo | null
  loading: boolean
  /** 上一次加载的失败原因（如沪深300 两条源都失败）；成功时为 null */
  error: string | null
  /** 手动强制刷新（忽略「当天不重复拉」缓存） */
  refresh: () => Promise<void>
}

export function useRegime(watchlistBars: Bar[][]): UseRegimeResult {
  const [regime, setRegime] = useState<RegimeInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const aliveRef = useRef(true)
  const seqRef = useRef(0)
  const barsRef = useRef(watchlistBars)
  barsRef.current = watchlistBars

  // 用「每只标的最后日期 + 根数」做签名，避免数组引用每次渲染都触发重拉
  const signature = useMemo(
    () => watchlistBars.map((series) => `${series.at(-1)?.date ?? ''}:${series.length}`).join('|'),
    [watchlistBars],
  )

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const run = useCallback(async (force: boolean) => {
    const seq = seqRef.current + 1
    seqRef.current = seq
    setLoading(true)
    try {
      const detail = await loadRegimeDetail(barsRef.current, { force })
      if (!aliveRef.current || seq !== seqRef.current) return
      setError(detail.error)
      setRegime((previous) => {
        // 指数源失败时保留上一次的 index 结果，不被宽度兜底结果覆盖
        if (detail.error && detail.info.source !== 'index' && previous && previous.source === 'index') return previous
        return detail.info
      })
    } catch (loadError) {
      if (!aliveRef.current || seq !== seqRef.current) return
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      if (aliveRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const cached = readRegimeCache()
    if (cached) setRegime(cached.info)
    void run(false)
  }, [signature, run])

  const refresh = useCallback(async () => {
    await run(true)
  }, [run])

  return { regime, loading, error, refresh }
}
