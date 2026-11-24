import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRegimeFilter,
  profileFor,
  regimeVerdict,
} from '../src/lib/regime-filter.ts'

const makeStrategy = (overrides = {}) => ({
  stockId: 'stock-600000',
  code: '600000',
  name: '测试股份',
  action: 'breakout',
  actionLabel: '突破跟随',
  score: 80,
  summary: '价格接近或突破前高，成交量同步放大，可按计划小仓跟随。',
  reasons: ['20 日高点 10.50', '量比 1.30，涨跌幅 2.00%'],
  isHolding: false,
  trigger: 10.2,
  stop: 9.5,
  target: 11.5,
  suggestedShares: 500,
  suggestedPositionPct: 5,
  price: 10.5,
  changePct: 2,
  tradeDate: '2026-11-24',
  source: 'auto',
  indicators: { ma5: 10, ma10: 10, ma20: 10, high20: 10.5, atr14: 0.3, rsi14: 60, volumeRatio: 1.2 },
  bars: [],
  ...overrides,
})

/* ── profileFor：三档数值 ───────────────────────────────────── */

test('profileFor 三档数值与决策表一致', () => {
  const expected = {
    bear: {
      regime: 'bear',
      maxEquityPct: 30,
      baselineEquityPct: 20,
      cashPct: 70,
      maxPerNamePct: 6,
      maxPositions: 2,
      allowBreakout: false,
      allowPullback: false,
      sizeMultiplier: 0,
    },
    range: {
      regime: 'range',
      maxEquityPct: 60,
      baselineEquityPct: 45,
      cashPct: 40,
      maxPerNamePct: 8,
      maxPositions: 4,
      allowBreakout: true,
      allowPullback: true,
      sizeMultiplier: 0.5,
    },
    bull: {
      regime: 'bull',
      maxEquityPct: 100,
      baselineEquityPct: 80,
      cashPct: 20,
      maxPerNamePct: 10,
      maxPositions: 6,
      allowBreakout: true,
      allowPullback: true,
      sizeMultiplier: 1,
    },
  }

  for (const [regime, values] of Object.entries(expected)) {
    const profile = profileFor(regime)
    for (const [key, value] of Object.entries(values)) {
      assert.deepEqual(profile[key], value, `${regime}.${key}`)
    }
    assert.ok(Array.isArray(profile.notes) && profile.notes.length > 0, `${regime} notes 非空`)
    assert.ok(profile.notes.every((note) => typeof note === 'string' && note.length > 0))
  }
})

test('profileFor 返回完整字段且是副本（改 notes 不污染模块常量）', () => {
  const fields = [
    'regime',
    'maxEquityPct',
    'baselineEquityPct',
    'cashPct',
    'maxPerNamePct',
    'maxPositions',
    'allowBreakout',
    'allowPullback',
    'sizeMultiplier',
    'notes',
  ]
  for (const regime of ['bull', 'range', 'bear']) {
    assert.deepEqual(Object.keys(profileFor(regime)).sort(), [...fields].sort())
  }

  const first = profileFor('bear')
  first.notes.push('人为污染')
  first.maxEquityPct = 999
  const second = profileFor('bear')
  assert.equal(second.maxEquityPct, 30)
  assert.equal(second.notes.includes('人为污染'), false)
})

/* ── regimeVerdict：行动卡文案 ─────────────────────────────── */

test('regimeVerdict 三档都有标题与做/不做清单', () => {
  const expectedHeadlines = {
    bear: '熊市：禁止新买入，只做止损/减仓',
    range: '震荡市：半仓参与，等待确认',
    bull: '牛市：按计划执行突破/回踩',
  }
  for (const [regime, headline] of Object.entries(expectedHeadlines)) {
    const verdict = regimeVerdict(regime)
    assert.equal(verdict.headline, headline)
    assert.ok(verdict.doToday.length > 0)
    assert.ok(verdict.dontToday.length > 0)
    for (const item of [...verdict.doToday, ...verdict.dontToday]) {
      assert.equal(typeof item, 'string')
      assert.ok(item.length > 0)
    }
  }
  assert.match(regimeVerdict('bear').headline, /禁止/)
  assert.match(regimeVerdict('range').headline, /半仓/)
})

test('regimeVerdict 返回副本（改数组不影响下次调用）', () => {
  const first = regimeVerdict('bull')
  first.doToday.push('污染')
  first.headline = '污染'
  const second = regimeVerdict('bull')
  assert.equal(second.headline, '牛市：按计划执行突破/回踩')
  assert.equal(second.doToday.includes('污染'), false)
})

/* ── bear：禁买（breakout/pullback → watch） ───────────────── */

test('bear：breakout/pullback 变 watch，文案/仓位/reason 符合契约', () => {
  const input = [
    makeStrategy({ code: '600206', action: 'pullback', actionLabel: '回踩低吸', score: 74 }),
    makeStrategy({ code: '159558', action: 'breakout', actionLabel: '突破跟随', score: 80 }),
  ]
  const result = applyRegimeFilter(input, 'bear')
  const profile = profileFor('bear')

  assert.equal(result.length, 2)
  for (const [index, strategy] of result.entries()) {
    assert.equal(strategy.action, 'watch', `第 ${index} 个应降级 watch`)
    assert.equal(strategy.actionLabel, '熊市观望')
    assert.equal(strategy.summary, '熊市禁止新买入：等 MA60 回升与宽度修复')
    assert.equal(strategy.suggestedShares, undefined)
    assert.equal(strategy.suggestedPositionPct, undefined)
    assert.ok(strategy.reasons.includes(profile.notes[0]), '应追加一条来自 profile 的理由')
    // score 与价位保留（只改建议语义，不改原信号计算）
    assert.equal(strategy.score, input[index].score)
    assert.equal(strategy.trigger, input[index].trigger)
    assert.equal(strategy.stop, input[index].stop)
    assert.equal(strategy.target, input[index].target)
  }
})

test('bear：hold/reduce/stop/watch 原样；持仓 stop 不受影响', () => {
  const input = [
    makeStrategy({ code: '600000', action: 'stop', actionLabel: '优先止损', isHolding: true, stop: 9.8 }),
    makeStrategy({ code: '600519', action: 'hold', actionLabel: '持有待涨', isHolding: true }),
    makeStrategy({ code: '000001', action: 'reduce', actionLabel: '逢高减仓', isHolding: true }),
    makeStrategy({ code: '300750', action: 'watch', actionLabel: '等待信号', isHolding: false, suggestedShares: undefined, suggestedPositionPct: undefined }),
  ]
  const result = applyRegimeFilter(input, 'bear')
  assert.deepEqual(result, input)
})

test('bear：非买入动作即便带 suggestedShares 也保持原样', () => {
  const input = [makeStrategy({ action: 'hold', actionLabel: '持有待涨', suggestedShares: 300, suggestedPositionPct: 3 })]
  assert.deepEqual(applyRegimeFilter(input, 'bear'), input)
})

/* ── range：半仓 + 100 股取整 ──────────────────────────────── */

test('range：breakout/pullback 建议仓位 ×0.5 并向下取整到 100 股', () => {
  const input = [
    makeStrategy({ code: '600000', action: 'breakout', suggestedShares: 500, suggestedPositionPct: 5 }),
    makeStrategy({ code: '600519', action: 'pullback', suggestedShares: 530, suggestedPositionPct: 3.33 }),
  ]
  const result = applyRegimeFilter(input, 'range')

  assert.equal(result[0].action, 'breakout', 'range 保留买入动作')
  assert.equal(result[0].suggestedShares, 200) // 500 × 0.5 = 250 → floor 到 100 的倍数 = 200
  assert.equal(result[0].suggestedPositionPct, 2.5)
  assert.ok(result[0].reasons.includes('震荡市半仓'))

  assert.equal(result[1].action, 'pullback')
  assert.equal(result[1].suggestedShares, 200) // 530 × 0.5 = 265 → 200
  assert.equal(result[1].suggestedPositionPct, 1.67)
  assert.ok(result[1].reasons.includes('震荡市半仓'))
})

test('range：不足 1 手时半仓取整为 0；无建议仓位时保持 undefined', () => {
  const input = [
    makeStrategy({ code: '600000', suggestedShares: 100, suggestedPositionPct: 1 }),
    makeStrategy({ code: '600519', suggestedShares: undefined, suggestedPositionPct: undefined }),
    makeStrategy({ code: '000001', action: 'watch', suggestedShares: undefined, suggestedPositionPct: undefined }),
  ]
  const result = applyRegimeFilter(input, 'range')
  assert.equal(result[0].suggestedShares, 0)
  assert.equal(result[0].suggestedPositionPct, 0.5)
  assert.equal(result[1].suggestedShares, undefined)
  assert.equal(result[1].suggestedPositionPct, undefined)
  // 非买入动作不参与半仓
  assert.equal(result[2].suggestedShares, undefined)
  assert.equal(result[2].reasons.includes('震荡市半仓'), false)
})

test('range：hold/reduce/stop/watch 原样（仓位不改）', () => {
  const input = [
    makeStrategy({ action: 'hold', actionLabel: '持有待涨', suggestedShares: 400, suggestedPositionPct: 4 }),
    makeStrategy({ action: 'stop', actionLabel: '优先止损', suggestedShares: undefined, suggestedPositionPct: undefined }),
  ]
  assert.deepEqual(applyRegimeFilter(input, 'range'), input)
})

/* ── bull：原样 ────────────────────────────────────────────── */

test('bull：内容原样（含 sizing/reason），但返回新数组与新对象', () => {
  const input = [
    makeStrategy({ code: '600000', action: 'breakout' }),
    makeStrategy({ code: '000001', action: 'hold', actionLabel: '持有待涨' }),
  ]
  const result = applyRegimeFilter(input, 'bull')

  assert.deepEqual(result, input)
  assert.notEqual(result, input)
  assert.notEqual(result[0], input[0])
  assert.notEqual(result[0].reasons, input[0].reasons)
  assert.deepEqual(result[0].reasons, input[0].reasons)
  assert.equal(result[0].suggestedShares, 500)
})

/* ── 不可变性 / 缺省 regime ────────────────────────────────── */

test('applyRegimeFilter 不修改输入（三层 regime 均不可变）', () => {
  const snapshot = () =>
    JSON.stringify([
      makeStrategy({ action: 'breakout' }),
      makeStrategy({ action: 'pullback' }),
      makeStrategy({ action: 'hold', actionLabel: '持有待涨' }),
    ])
  const input = JSON.parse(snapshot())
  const before = JSON.stringify(input)

  for (const regime of ['bear', 'range', 'bull']) {
    const result = applyRegimeFilter(input, regime)
    assert.equal(JSON.stringify(input), before, `${regime} 不得修改输入对象`)
    assert.notEqual(result, input)
  }
  assert.equal(JSON.stringify(input), snapshot())
})

test('无 regime（undefined）时原样返回入参数组本身', () => {
  const input = [makeStrategy({ action: 'breakout' })]
  assert.equal(applyRegimeFilter(input, undefined), input)
  assert.deepEqual(applyRegimeFilter(input, undefined), input)
})

test('bear 过滤可重复应用（幂等，不重复改文案）', () => {
  const input = [makeStrategy({ action: 'pullback', actionLabel: '回踩低吸' })]
  const once = applyRegimeFilter(input, 'bear')
  const twice = applyRegimeFilter(once, 'bear')
  assert.deepEqual(twice, once)
})
