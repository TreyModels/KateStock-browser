import { unzipSync, strFromU8 } from 'fflate'
import { z } from 'zod'
import type { AppData, Stock } from '@/types'

const MAX_ARCHIVE = 2 * 1024 * 1024
const MAX_DOCUMENT = 512 * 1024
const stockSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  name: z.string().trim().min(1).max(80).refine(value => !/sk-[a-z0-9]{20,}/i.test(value)),
  status: z.enum(['history', 'holding', 'watch']).default('watch'),
  annualPnl: z.number().finite().optional(),
  shares: z.number().finite().nonnegative().optional(),
  cost: z.number().finite().nonnegative().optional(),
  createdAt: z.string().max(64).optional(),
})
export type ImportedPortfolio = { stocks: Stock[]; goldValueCny?: number }

export function parseStocksJson(input: unknown): ImportedPortfolio {
  const object = input && typeof input === 'object' && !Array.isArray(input) ? input as { stocks?: unknown; goldValueCny?: unknown } : undefined
  const list = Array.isArray(input) ? input : object?.stocks
  const result = z.array(stockSchema).max(1000).parse(list)
  const gold = object?.goldValueCny === undefined ? undefined : z.number().finite().nonnegative().parse(object.goldValueCny)
  if (!result.length && gold === undefined) throw new Error('没有股票或黄金参考价值')
  if (new Set(result.map(stock => stock.code)).size !== result.length) throw new Error('股票代码重复')
  return { stocks: result.map(stock => ({ ...stock, id: `stock-${stock.code}`, createdAt: stock.createdAt || new Date().toISOString() })), goldValueCny: gold }
}

export function parseStocksText(text: string): ImportedPortfolio {
  const stocks: Array<Record<string, unknown>> = []
  let goldValueCny: number | undefined
  for (const line of text.split(/\r?\n/)) {
    if (/sk-[a-z0-9]{20,}/i.test(line)) continue
    const gold = line.match(/^\s*(?:goldValueCny|黄金参考价值)\s*[:：]\s*(\d+(?:\.\d+)?)\s*$/i)
    if (gold) { goldValueCny = Number(gold[1]); continue }
    const cleaned = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    const fields = cleaned.split(/\s*[|,，\t]\s*/).map(value => value.trim())
    if (!/^\d{6}$/.test(fields[0] || '') || !fields[1]) continue
    const statusMap: Record<string, string> = { '持仓': 'holding', '自选': 'watch', '历史': 'history', holding: 'holding', watch: 'watch', history: 'history' }
    const number = (value: string | undefined) => value && value !== '—' ? Number(value) : undefined
    stocks.push({ code: fields[0], name: fields[1], status: statusMap[fields[2]] || 'watch', shares: number(fields[3]), cost: number(fields[4]), annualPnl: number(fields[5]) })
  }
  return parseStocksJson({ stocks, goldValueCny })
}

function parseDocument(name: string, data: Uint8Array): ImportedPortfolio {
  if (data.length > MAX_DOCUMENT) throw new Error('文件超过 512 KB')
  const text = strFromU8(data)
  return name.toLowerCase().endsWith('.json') ? parseStocksJson(JSON.parse(text)) : parseStocksText(text)
}

export async function readPortfolioFile(file: File): Promise<ImportedPortfolio> {
  if (file.size > MAX_ARCHIVE) throw new Error('文件超过 2 MB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!file.name.toLowerCase().endsWith('.zip')) return parseDocument(file.name, bytes)
  const selected: string[] = []
  const entries = unzipSync(bytes, { filter: entry => {
    const filename = entry.name.split('/').at(-1)?.toLowerCase()
    if (!filename || !/^stocks\.(json|md|txt)$/.test(filename)) return false
    if (entry.originalSize > MAX_DOCUMENT) throw new Error('股票文件超过 512 KB')
    selected.push(entry.name)
    if (selected.length > 1) throw new Error('ZIP 中只能有一个 stocks.json、stocks.md 或 stocks.txt')
    return true
  } })
  if (selected.length !== 1 || !entries[selected[0]]) throw new Error('ZIP 中未找到 stocks.json、stocks.md 或 stocks.txt')
  return parseDocument(selected[0], entries[selected[0]])
}

export function mergeImportedStocks(existing: Stock[], incoming: Stock[]) {
  const codes = new Set(existing.map(stock => stock.code))
  return [...existing, ...incoming.filter(stock => !codes.has(stock.code))]
}

export function portfolioMarkdown(data: AppData): string {
  const safe = (value: string) => value.replace(/[|\r\n]/g, ' ')
  const rows = data.stocks.map(stock => `| ${stock.code} | ${safe(stock.name)} | ${stock.status} | ${stock.shares ?? ''} | ${stock.cost ?? ''} | ${stock.annualPnl ?? ''} |`)
  return ['# KateStock 私人清单', '', '此文件包含私人财务信息，请妥善保存。密钥不包含在内。', '', ...(data.goldValueCny === undefined ? [] : [`goldValueCny: ${data.goldValueCny}`, '']), '| 代码 | 名称 | 状态 | 股数 | 成本 | 历史收益 |', '| --- | --- | --- | --- | --- | --- |', ...rows, ''].join('\n')
}
