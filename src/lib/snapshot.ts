import { z } from 'zod'
import type { Quote } from '@/types'

const bar = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), open: z.number().positive(), high: z.number().positive(), low: z.number().positive(), close: z.number().positive(), volume: z.number().nonnegative(), amount: z.number().nonnegative(), changePct: z.number().finite(), turnoverPct: z.number().finite().optional() }).refine(b => b.high >= Math.max(b.open, b.close, b.low) && b.low <= Math.min(b.open, b.close))
const quote = z.object({ code: z.string().regex(/^\d{6}$/), price: z.number().positive(), prevClose: z.number().positive(), changePct: z.number().finite(), open: z.number().positive(), high: z.number().positive(), low: z.number().positive(), volume: z.number().nonnegative(), amount: z.number().nonnegative(), tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), fetchedAt: z.string().datetime(), source: z.literal('auto'), provider: z.string().optional(), adjustment: z.string().optional(), bars: z.array(bar).min(2) }).superRefine((q, ctx) => {
  if (q.price !== q.bars.at(-1)?.close || q.tradeDate !== q.bars.at(-1)?.date || q.bars.some((b, i) => i > 0 && b.date <= q.bars[i - 1].date)) ctx.addIssue({ code: 'custom', message: 'invalid bar order or latest quote' })
})
export const snapshotSchema = z.object({ schemaVersion: z.literal(1), generatedAt: z.string().datetime(), tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), source: z.string().min(1), sourceUrl: z.string().url().refine(url => url.startsWith('https://')), partial: z.boolean(), failures: z.array(z.string()), coverage: z.string(), ai: z.object({ status: z.enum(['available', 'unavailable']), text: z.string().max(500), model: z.literal('deepseek-flash') }).optional(), quotes: z.record(z.string(), quote) }).superRefine((s, ctx) => {
  if (!Object.keys(s.quotes).length || Object.entries(s.quotes).some(([code, q]) => code !== q.code || q.tradeDate !== s.tradeDate)) ctx.addIssue({ code: 'custom', message: 'invalid or empty quotes' })
})
export type Snapshot = z.infer<typeof snapshotSchema>
const KEY = 'katestock-last-good-public-snapshot-v1'
export function readCachedSnapshot(): Snapshot | null {
  try { const value = snapshotSchema.safeParse(JSON.parse(localStorage.getItem(KEY) || 'null')); return value.success ? value.data : null } catch { return null }
}
export function saveSnapshot(snapshot: Snapshot) { try { localStorage.setItem(KEY, JSON.stringify(snapshot)) } catch { /* private browsing / quota */ } }
export function mergeSnapshotQuotes(current: Record<string, Quote>, snapshot: Snapshot): Record<string, Quote> {
  const next = { ...current }
  for (const [code, incoming] of Object.entries(snapshot.quotes)) {
    const existing = current[code]
    if (!existing || (existing.source !== 'manual' && incoming.tradeDate >= existing.tradeDate)) next[code] = incoming
  }
  return next
}
