import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { generateStrategy } from '../src/lib/strategy.ts'

const settings = { capital: 100000, riskPct: 1, maxPositionPct: 10, refreshOnOpen: false }

const makeBars = () =>
  Array.from({ length: 30 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    open: 10 + i * 0.1,
    high: 10.2 + i * 0.1,
    low: 9.8 + i * 0.1,
    close: 10 + i * 0.1,
    volume: 100,
    amount: 1000,
    changePct: 0,
    turnoverPct: 0,
  }))

const makeQuote = (bars = makeBars()) => ({
  code: '600000',
  price: 12.9,
  prevClose: 12.8,
  changePct: 0,
  open: 12.9,
  high: 13.1,
  low: 12.7,
  volume: 100,
  amount: 1000,
  tradeDate: bars.at(-1).date,
  fetchedAt: '2026-10-30T09:00:00Z',
  source: 'auto',
  bars,
})

const makeStock = (overrides = {}) => ({
  id: 'stock-600000',
  code: '600000',
  name: '测试股份',
  status: 'holding',
  createdAt: '2026-10-30T09:00:00Z',
  ...overrides,
})

test('scheduled signals use the same strategy engine and omit personal sizing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'katestock-'))
  try {
    const bars = makeBars()
    const quote = makeQuote(bars)
    const file = join(dir, 'report.json')
    writeFileSync(file, JSON.stringify({ generatedAt: '2026-10-30T09:00:00Z', quotes: { '600000': quote } }))
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/generate_signals.mjs'], {
      env: { ...process.env, SNAPSHOT_OUTPUT: file },
    })
    const out = JSON.parse(readFileSync(file, 'utf8'))
    const expected = generateStrategy(
      { id: 'public-600000', code: '600000', name: '600000', status: 'watch', createdAt: '2026-10-30T09:00:00Z' },
      quote,
      settings,
    )
    assert.equal(out.signals['600000'].score, expected.score)
    assert.equal(out.signals['600000'].action, expected.action)
    assert.equal('suggestedShares' in out.signals['600000'], false)
    assert.equal('capital' in out.signals['600000'], false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('generateStrategy 写入 isHolding：status=holding 且有 shares 才为 true', () => {
  const quote = makeQuote()

  const holding = generateStrategy(makeStock({ status: 'holding', shares: 100, cost: 11 }), quote, settings)
  assert.equal(holding.isHolding, true)
  assert.equal(typeof holding.isHolding, 'boolean')

  // 持仓但没份额：不视为持仓（与 strategy.ts 内 isHolding 变量一致）
  assert.equal(generateStrategy(makeStock({ status: 'holding', shares: 0 }), quote, settings).isHolding, false)
  // 持仓但缺失 shares 字段
  assert.equal(generateStrategy(makeStock({ status: 'holding' }), quote, settings).isHolding, false)
  // 非持仓状态
  assert.equal(generateStrategy(makeStock({ status: 'watch' }), quote, settings).isHolding, false)
  assert.equal(generateStrategy(makeStock({ status: 'history' }), quote, settings).isHolding, false)
})

test('generateStrategy 的 isHolding 不改变 EOD 价位算法（同输入仅差该字段）', () => {
  const quote = makeQuote()
  const holding = generateStrategy(makeStock({ status: 'holding', shares: 100, cost: 11 }), quote, settings)
  const watch = generateStrategy(makeStock({ status: 'watch' }), quote, settings)

  // 对照：把 watch 的 stock 复制成 holding 但 shares=0 时，价位与动作应完全一致
  const zeroShares = generateStrategy(makeStock({ status: 'holding', shares: 0, cost: 11 }), quote, settings)
  assert.equal(zeroShares.action, watch.action)
  assert.equal(zeroShares.trigger, watch.trigger)
  assert.equal(zeroShares.stop, watch.stop)
  assert.equal(zeroShares.target, watch.target)
  assert.equal(zeroShares.score, watch.score)
  assert.equal(zeroShares.isHolding, false)

  // 持仓股有份额时 isHolding 为 true，且字段只新增、不影响 action 的类型
  assert.equal(holding.isHolding, true)
  assert.equal(typeof holding.action, 'string')
})
