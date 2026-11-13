import { useEffect, useState } from 'react'
import { initialStocks } from '@/data/initialStocks'
import type { AppData, RiskSettings } from '@/types'

const STORAGE_KEY = 'ashare-daily-strategy-v1'

export const defaultSettings: RiskSettings = {
  capital: 200000,
  riskPct: 0.8,
  maxPositionPct: 12,
  refreshOnOpen: true,
}

const initialData: AppData = {
  stocks: initialStocks,
  quotes: {},
  settings: defaultSettings,
}

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialData
    const parsed = JSON.parse(raw) as AppData
    if (!Array.isArray(parsed.stocks) || !parsed.quotes || !parsed.settings) return initialData
    return {
      goldValueCny: typeof parsed.goldValueCny === 'number' && Number.isFinite(parsed.goldValueCny) && parsed.goldValueCny >= 0 ? parsed.goldValueCny : undefined,
      stocks: parsed.stocks,
      quotes: parsed.quotes,
      settings: { ...defaultSettings, ...parsed.settings },
    }
  } catch {
    return initialData
  }
}

export function useLocalData() {
  const [data, setData] = useState<AppData>(loadData)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      // The app remains usable when private browsing blocks local storage.
    }
  }, [data])

  const resetData = () => setData({ ...initialData, quotes: {}, settings: { ...defaultSettings } })
  return { data, setData, resetData }
}
