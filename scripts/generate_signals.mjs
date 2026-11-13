import { readFileSync, writeFileSync } from 'node:fs'
import { generateStrategy } from '../src/lib/strategy.ts'

const path = process.env.SNAPSHOT_OUTPUT || 'public/data/latest.json'
const report = JSON.parse(readFileSync(path, 'utf8'))
const settings = { capital: 100000, riskPct: 1, maxPositionPct: 10, refreshOnOpen: false }
const signals = {}
for (const [code, quote] of Object.entries(report.quotes)) {
  if (quote.bars.length < 21) throw new Error(`Insufficient bars: ${code}`)
  const stock = { id: `public-${code}`, code, name: code, status: 'watch', createdAt: report.generatedAt }
  const result = generateStrategy(stock, quote, settings)
  signals[code] = { action: result.action, actionLabel: result.actionLabel, score: result.score, summary: result.summary, reasons: result.reasons, indicators: result.indicators }
}
report.strategyVersion = 'katestock-rules-v1'
report.signals = signals
writeFileSync(path, JSON.stringify(report))
console.log(`Computed ${Object.keys(signals).length} public signals with ${report.strategyVersion}`)
