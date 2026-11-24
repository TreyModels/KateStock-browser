import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_FULL_MATCHED,
  EVIDENCE_CAPS,
  EVIDENCE_LABELS,
  EVIDENCE_LABELS_EN,
  EVIDENCE_TABLE,
  EVIDENCE_WEIGHTS,
  FIT_TABLE,
  RANKING_WEIGHTS,
  STRATEGY_LABELS,
  STRATEGY_ROWS,
  rankStrategies,
} from '../src/lib/strategy-ranking.ts'
import { applyRegimeFilter, profileFor, regimeVerdict } from '../src/lib/regime-filter.ts'

const HAS_CJK = /[\u4e00-\u9fa5]/
const hasCjk = (value) => HAS_CJK.test(String(value))

const makeStrategy = (overrides = {}) => ({
  stockId: 'stock-600000',
  code: '600000',
  name: '测试股份',
  action: 'watch',
  actionLabel: '等待信号',
  score: 50,
  summary: '测试策略',
  reasons: [],
  isHolding: false,
  price: 10.5,
  changePct: 1,
  tradeDate: '2026-11-24',
  source: 'auto',
  indicators: { ma5: 10, ma10: 10, ma20: 10, high20: 10.5, atr14: 0.3, rsi14: 60, volumeRatio: 1.2 },
  bars: [],
  ...overrides,
})

const strategiesOf = (actions) => actions.map((action, index) => makeStrategy({ stockId: `s-${index}`, code: String(600000 + index), action }))

const idsOf = (scores) => scores.map((score) => score.id)
const byId = (scores) => Object.fromEntries(scores.map((score) => [score.id, score]))

/** 按公开常量复算期望 confidence（含证据封顶），用于交叉验证实现。 */
const expectedConfidence = (regime, id, matched) => {
  const fit = FIT_TABLE[regime][id]
  const evidence = EVIDENCE_TABLE[id]
  const activity = Math.min(1, matched / Math.max(1, ACTIVITY_FULL_MATCHED))
  const raw = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        100 *
          (RANKING_WEIGHTS.fit * fit +
            RANKING_WEIGHTS.evidence * EVIDENCE_WEIGHTS[evidence] +
            RANKING_WEIGHTS.activity * activity),
      ),
    ),
  )
  const cap = EVIDENCE_CAPS[evidence]
  return cap === null ? raw : Math.min(cap, raw)
}

/* ── 契约形状 ──────────────────────────────────────────────── */

test('返回 7 行常量策略表，字段与中文标签符合契约', () => {
  const scores = rankStrategies({ strategies: [], regime: 'bear' })
  assert.equal(scores.length, 7)
  assert.deepEqual(idsOf(scores).sort(), ['breakout', 'hold', 'pullback', 'reduce', 'reversion', 'stop', 'watch'])

  const expectedLabels = {
    stop: '止损管理',
    reduce: '逢高减仓',
    hold: '持有待涨',
    pullback: '回踩低吸',
    breakout: '突破跟随',
    reversion: '超跌反弹',
    watch: '观望等待',
  }
  const expectedActions = {
    stop: 'stop',
    reduce: 'reduce',
    hold: 'hold',
    pullback: 'pullback',
    breakout: 'breakout',
    reversion: 'watch', // 实盘无 reversion action，用 watch 占位
    watch: 'watch',
  }
  const fields = ['action', 'confidence', 'evidence', 'id', 'label', 'matched', 'reasons', 'status']

  for (const score of scores) {
    assert.deepEqual(Object.keys(score).sort(), fields)
    assert.equal(score.label, expectedLabels[score.id])
    assert.equal(score.action, expectedActions[score.id])
    assert.equal(typeof score.confidence, 'number')
    assert.equal(Number.isInteger(score.confidence), true)
    assert.ok(score.confidence >= 0 && score.confidence <= 100)
    assert.equal(typeof score.matched, 'number')
    assert.ok(Array.isArray(score.reasons))
    assert.ok(['active', 'degraded', 'blocked'].includes(score.status))
  }
})

test('权重/证据表/封顶/标签常量与 task-26、task-27 结论一致', () => {
  assert.deepEqual(RANKING_WEIGHTS, { fit: 0.55, evidence: 0.25, activity: 0.2 })
  assert.deepEqual(EVIDENCE_WEIGHTS, { PASS: 1, PARTIAL: 0.7, UNKNOWN: 0.45, FAIL: 0.1 })
  assert.deepEqual(EVIDENCE_TABLE, {
    stop: 'PASS',
    watch: 'PASS',
    reduce: 'UNKNOWN',
    hold: 'UNKNOWN',
    pullback: 'UNKNOWN',
    breakout: 'UNKNOWN',
    reversion: 'UNKNOWN',
  })
  assert.deepEqual(EVIDENCE_CAPS, { PASS: null, PARTIAL: 80, UNKNOWN: 55, FAIL: 55 })
  assert.deepEqual(EVIDENCE_LABELS, { PASS: '通过', PARTIAL: '部分通过', UNKNOWN: '未验证', FAIL: '未通过' })
  assert.equal(ACTIVITY_FULL_MATCHED, 3)

  // 适配表三档关键值抽查
  assert.equal(FIT_TABLE.bear.stop, 0.95)
  assert.equal(FIT_TABLE.bear.breakout, 0.05)
  assert.equal(FIT_TABLE.range.pullback, 0.75)
  assert.equal(FIT_TABLE.bull.breakout, 0.9)
  assert.equal(STRATEGY_ROWS.length, 7)
})

/* ── 公式 / 证据封顶 ───────────────────────────────────────── */

test('confidence 公式逐行等于 0.55fit + 0.25evidence + 0.20activity 再封顶', () => {
  const strategies = strategiesOf(['stop', 'hold', 'hold', 'pullback', 'pullback', 'pullback', 'breakout', 'watch'])
  const matched = {
    stop: 1,
    reduce: 0,
    hold: 2,
    watch: 1,
    reversion: 0,
    pullback: 3,
    breakout: 1,
  }

  for (const regime of ['bear', 'range', 'bull']) {
    const scores = rankStrategies({ strategies, regime })
    for (const score of scores) {
      assert.equal(score.matched, matched[score.id], `${regime}.${score.id} matched`)
      assert.equal(score.evidence, EVIDENCE_TABLE[score.id], `${regime}.${score.id} evidence`)
      assert.equal(
        score.confidence,
        expectedConfidence(regime, score.id, matched[score.id]),
        `${regime}.${score.id} confidence`,
      )
    }
  }
})

test('证据封顶：UNKNOWN ≤55、PASS 不封顶（已触及公式 >55 仍不被削）', () => {
  // 所有 UNKNOWN 行在三档 regime 下都 ≤55
  for (const regime of ['bear', 'range', 'bull']) {
    for (const score of rankStrategies({ strategies: [], regime })) {
      if (score.evidence === 'UNKNOWN') {
        assert.ok(score.confidence <= 55, `${regime}.${score.id} UNKNOWN 应 ≤55`)
      }
    }
  }

  // bull breakout 公式原值 81（fit .9 / UNKNOWN），封顶后必须为 55
  const bull = byId(rankStrategies({ strategies: strategiesOf(['breakout', 'breakout', 'breakout']), regime: 'bull' }))
  assert.equal(EVIDENCE_TABLE.breakout, 'UNKNOWN')
  assert.equal(bull.breakout.confidence, 55)
  assert.equal(expectedConfidence('bull', 'breakout', 3), 55)
  // 未封顶的原值确实更高（证明封顶生效而非公式碰巧）
  const uncapped = Math.round(100 * (RANKING_WEIGHTS.fit * FIT_TABLE.bull.breakout + RANKING_WEIGHTS.evidence * EVIDENCE_WEIGHTS.UNKNOWN + RANKING_WEIGHTS.activity * 1))
  assert.equal(uncapped, 81)

  // stop 是 PASS、不封顶：命中 6 只（activity=1）→ 97 > 55
  const bear = byId(rankStrategies({ strategies: strategiesOf(Array(6).fill('stop')), regime: 'bear' }))
  assert.equal(bear.stop.evidence, 'PASS')
  assert.equal(bear.stop.confidence, 97)
  assert.ok(bear.stop.confidence > 55)
})

test('activity = min(1, matched/3)：0 只 / 1 只 / ≥3 只的边界', () => {
  const conf = (count) => byId(rankStrategies({ strategies: strategiesOf(Array(count).fill('stop')), regime: 'bear' })).stop.confidence
  assert.equal(conf(0), 77) // 77.25
  assert.equal(conf(1), 84) // 83.92
  assert.equal(conf(3), 97) // 97.25
  assert.equal(conf(100), 97) // activity 封顶 1
})

test('confidence 全部为 0-100 整数（任意命中数）', () => {
  for (const count of [0, 1, 2, 3, 10, 1000]) {
    const scores = rankStrategies({ strategies: strategiesOf(Array(count).fill('pullback')), regime: 'range' })
    for (const score of scores) {
      assert.equal(Number.isInteger(score.confidence), true)
      assert.ok(score.confidence >= 0 && score.confidence <= 100)
    }
  }
})

/* ── 三档 regime 排序样例 ──────────────────────────────────── */

test('bear 样例：止损管理 > 观望等待 ≈ 逢高减仓 > 持有待涨 > 超跌反弹 > 回踩低吸 > 突破跟随', () => {
  const strategies = strategiesOf(['stop', 'pullback', 'pullback', 'watch', 'hold'])
  const scores = rankStrategies({ strategies, regime: 'bear' })

  assert.deepEqual(idsOf(scores), ['stop', 'watch', 'reduce', 'hold', 'reversion', 'pullback', 'breakout'])
  assert.deepEqual(scores.map((score) => score.confidence), [84, 59, 55, 48, 31, 30, 14])

  const map = byId(scores)
  assert.equal(map.stop.status, 'active')
  assert.equal(map.watch.status, 'active')
  assert.equal(map.reduce.status, 'active')
  assert.equal(map.hold.status, 'active')
  for (const id of ['pullback', 'breakout', 'reversion']) {
    assert.equal(map[id].status, 'blocked', `${id} 熊市应 blocked`)
    assert.ok(map[id].confidence <= 55, `${id} 熊市买入类 confidence 应 ≤55`)
  }
  assert.equal(map.pullback.matched, 2)
  assert.equal(map.stop.matched, 1)
  assert.equal(map.reversion.matched, 0)
})

test('range 样例：半仓 → 买入类 degraded 且 ≤55，止损最高', () => {
  const strategies = strategiesOf(['stop', 'pullback', 'pullback', 'breakout', 'hold'])
  const scores = rankStrategies({ strategies, regime: 'range' })

  assert.deepEqual(idsOf(scores), ['stop', 'pullback', 'watch', 'hold', 'breakout', 'reduce', 'reversion'])
  assert.deepEqual(scores.map((score) => score.confidence), [81, 55, 55, 51, 51, 47, 42])

  const map = byId(scores)
  for (const id of ['pullback', 'breakout', 'reversion']) {
    assert.equal(map[id].status, 'degraded', `${id} 震荡市应 degraded`)
    assert.ok(map[id].confidence <= 55)
  }
  assert.equal(map.stop.status, 'active')
  assert.equal(map.hold.status, 'active')
})

test('bull 样例：全部 active；UNKNOWN 买入类仍被证据封顶到 55（按 fit 同分排序）', () => {
  const strategies = strategiesOf(['stop', 'breakout', 'breakout', 'breakout', 'breakout', 'breakout', 'pullback', 'hold'])
  const scores = rankStrategies({ strategies, regime: 'bull' })

  assert.deepEqual(idsOf(scores), ['stop', 'breakout', 'pullback', 'hold', 'reduce', 'watch', 'reversion'])
  assert.deepEqual(scores.map((score) => score.confidence), [78, 55, 55, 55, 50, 47, 28])
  assert.ok(scores.every((score) => score.status === 'active'))
  // 同为 55 的买入行按 fit 降序：breakout .9 > pullback .8 > hold .75
  const buys = scores.filter((score) => ['breakout', 'pullback', 'hold'].includes(score.id))
  assert.deepEqual(idsOf(buys), ['breakout', 'pullback', 'hold'])
})

/* ── matched 统计 ──────────────────────────────────────────── */

test('matched 按未过滤策略的 action 计数；reversion 恒为 0', () => {
  const strategies = strategiesOf(['stop', 'reduce', 'reduce', 'hold', 'hold', 'hold', 'watch', 'breakout', 'pullback'])
  const map = byId(rankStrategies({ strategies, regime: 'range' }))
  assert.equal(map.stop.matched, 1)
  assert.equal(map.reduce.matched, 2)
  assert.equal(map.hold.matched, 3)
  assert.equal(map.watch.matched, 1)
  assert.equal(map.breakout.matched, 1)
  assert.equal(map.pullback.matched, 1)
  assert.equal(map.reversion.matched, 0) // 无实盘 reversion action
})

test('bear 下买入类 matched 仍然如实统计（不因 blocked 归零）', () => {
  const scores = rankStrategies({ strategies: strategiesOf(['pullback', 'pullback', 'breakout']), regime: 'bear' })
  const map = byId(scores)
  assert.equal(map.pullback.matched, 2)
  assert.equal(map.breakout.matched, 1)
  assert.equal(map.pullback.status, 'blocked')
  assert.match(map.pullback.reasons.join(' '), /当前 2 只回踩低吸形态，熊市不采信/)
})

/* ── reasons / evidence 文案 ───────────────────────────────── */

test('reasons：首条为证据标签；UNKNOWN 显示「未验证（缺 ≥5 年扣费样本）」', () => {
  for (const regime of ['bear', 'range', 'bull']) {
    for (const score of rankStrategies({ strategies: [], regime })) {
      assert.ok(score.reasons.length >= 2 && score.reasons.length <= 3, `${regime}.${score.id} reasons 2-3 条`)
      assert.match(score.reasons[0], /^证据：/, `${regime}.${score.id} 首条应为证据标签`)
      assert.ok(score.reasons.every((reason) => typeof reason === 'string' && reason.length > 0))

      if (score.evidence === 'UNKNOWN') {
        assert.match(score.reasons[0], /未验证/)
        assert.match(score.reasons[0], /缺 ≥5 年扣费样本/)
      }
      if (score.id === 'stop') {
        assert.match(score.reasons[0], /证据：通过/)
        assert.match(score.reasons[0], /alpha/)
      }
      if (score.id === 'watch') {
        assert.match(score.reasons[0], /证据：通过/)
      }
    }
  }
})

test('reasons：宽度证据与熊市/震荡市/牛市状态解释', () => {
  const bearPullback = byId(
    rankStrategies({ strategies: strategiesOf(['pullback', 'pullback']), regime: 'bear', breadthPct: 20.7 }),
  ).pullback
  const joined = bearPullback.reasons.join(' ')
  assert.match(joined, /宽度 20\.7% 低于 60%/)
  assert.match(joined, /熊市：买入类策略禁用/)
  assert.match(joined, /当前 2 只回踩低吸形态，熊市不采信/)

  const range = byId(rankStrategies({ strategies: [], regime: 'range', breadthPct: 70 }))
  assert.match(range.pullback.reasons.join(' '), /宽度 70\.0% 高于 60%/)
  assert.match(range.pullback.reasons.join(' '), /半仓降级/)

  const bull = byId(rankStrategies({ strategies: [], regime: 'bull' }))
  assert.match(bull.breakout.reasons.join(' '), /牛市：买入类策略可执行/)
  assert.match(bull.stop.reasons.join(' '), /止损管理适用当前环境/)
})

/* ── profile 覆盖 / 缺省 regime ────────────────────────────── */

test('profile 可覆盖（status 按 profile 判定），且不修改传入 profile', () => {
  const bearProfile = profileFor('bear')
  const snapshot = JSON.stringify(bearProfile)
  const scores = rankStrategies({ strategies: [], regime: 'bull', profile: bearProfile })
  assert.equal(JSON.stringify(bearProfile), snapshot, '不得修改传入 profile')

  const map = byId(scores)
  // fit 仍用 bull 表，但 status 由传入 profile 决定：bear profile 禁止买入
  assert.equal(map.breakout.status, 'blocked')
  assert.equal(map.pullback.status, 'blocked')
  assert.equal(map.reversion.status, 'blocked')
  assert.equal(map.stop.status, 'active')
})

test('无 regime / 非法 regime 默认按 range 处理', () => {
  const base = rankStrategies({ strategies: strategiesOf(['pullback']), regime: 'range' })
  assert.deepEqual(rankStrategies({ strategies: strategiesOf(['pullback']), regime: undefined }), base)
  assert.deepEqual(rankStrategies({ strategies: strategiesOf(['pullback']), regime: 'bogus' }), base)
})

/* ── 不可变 / 纯函数 / 排序稳定性 ──────────────────────────── */

test('不修改输入策略与数组；重复调用结果稳定且返回新数组', () => {
  const input = [makeStrategy({ action: 'pullback' }), makeStrategy({ action: 'stop', isHolding: true })]
  const before = JSON.stringify(input)

  const first = rankStrategies({ strategies: input, regime: 'bear' })
  const second = rankStrategies({ strategies: input, regime: 'bear' })
  assert.equal(JSON.stringify(input), before, '不得修改输入策略')
  assert.notEqual(first, second, '每次返回新数组')
  assert.deepEqual(first, second, '纯函数结果稳定')

  // 修改返回值不影响后续调用
  first[0].reasons.push('污染')
  first[0].confidence = 999
  const third = rankStrategies({ strategies: input, regime: 'bear' })
  assert.deepEqual(third, second)
})

test('排序：confidence 非升序；同分按 fit 降序', () => {
  for (const regime of ['bear', 'range', 'bull']) {
    const scores = rankStrategies({ strategies: strategiesOf(['stop', 'pullback', 'breakout', 'hold', 'watch']), regime })
    for (let index = 1; index < scores.length; index += 1) {
      const previous = scores[index - 1]
      const current = scores[index]
      const confidenceOrder = previous.confidence - current.confidence
      assert.ok(confidenceOrder >= 0, `${regime} 排序应 confidence 降序`)
      if (confidenceOrder === 0) {
        assert.ok(
          FIT_TABLE[regime][previous.id] >= FIT_TABLE[regime][current.id],
          `${regime} 同分应按 fit 降序：${previous.id} vs ${current.id}`,
        )
      }
    }
  }
})

/* ── i18n：默认 zh 兼容 + en 文案 ───────────────────────────── */

test('i18n：默认 lang 与显式 lang=zh 完全一致（向后兼容）', () => {
  const strategies = strategiesOf(['stop', 'pullback', 'pullback', 'hold'])
  for (const regime of ['bear', 'range', 'bull']) {
    assert.deepEqual(
      rankStrategies({ strategies, regime, breadthPct: 20.7 }),
      rankStrategies({ strategies, regime, breadthPct: 20.7, lang: 'zh' }),
    )
    assert.deepEqual(profileFor(regime), profileFor(regime, 'zh'))
    assert.deepEqual(regimeVerdict(regime), regimeVerdict(regime, 'zh'))
  }
  const buy = [makeStrategy({ action: 'pullback', suggestedShares: 500, suggestedPositionPct: 5 })]
  assert.deepEqual(applyRegimeFilter(buy, 'bear'), applyRegimeFilter(buy, 'bear', 'zh'))
  assert.deepEqual(applyRegimeFilter(buy, 'range'), applyRegimeFilter(buy, 'range', 'zh'))
})

test('i18n en：7 个策略标签全英文，数值/排序与 zh 一致', () => {
  const strategies = strategiesOf(['stop', 'pullback', 'breakout', 'hold', 'watch'])
  for (const regime of ['bear', 'range', 'bull']) {
    const zh = rankStrategies({ strategies, regime })
    const en = rankStrategies({ strategies, regime, lang: 'en' })
    assert.deepEqual(idsOf(en), idsOf(zh), '排序不受语言影响')
    for (const [index, row] of en.entries()) {
      const zhRow = zh[index]
      assert.equal(row.label, STRATEGY_LABELS.en[row.id])
      assert.equal(hasCjk(row.label), false, `label 应为英文：${row.label}`)
      // 数值/状态/证据不随语言变化
      assert.equal(row.confidence, zhRow.confidence)
      assert.equal(row.matched, zhRow.matched)
      assert.equal(row.status, zhRow.status)
      assert.equal(row.evidence, zhRow.evidence)
      assert.equal(row.action, zhRow.action)
    }
  }
  assert.deepEqual(STRATEGY_LABELS.en, {
    stop: 'Stop-loss management',
    reduce: 'Trim into strength',
    hold: 'Hold position',
    pullback: 'Buy the dip',
    breakout: 'Breakout follow',
    reversion: 'Oversold rebound',
    watch: 'Wait and see',
  })
  assert.deepEqual(EVIDENCE_LABELS_EN, { PASS: 'Passed', PARTIAL: 'Partial', UNKNOWN: 'Unvalidated', FAIL: 'Failed' })
})

test('i18n en：reasons 全英文、2-3 条、首条 Evidence 且插值正确', () => {
  const strategies = strategiesOf(['stop', 'pullback', 'pullback', 'watch'])
  const scores = rankStrategies({ strategies, regime: 'bear', breadthPct: 20.7, lang: 'en' })
  const map = byId(scores)

  for (const score of scores) {
    assert.ok(score.reasons.length >= 2 && score.reasons.length <= 3)
    assert.match(score.reasons[0], /^Evidence: /)
    assert.equal(score.reasons.some((reason) => hasCjk(reason)), false, `reasons 应全英文：${score.reasons.join(' | ')}`)
  }

  const pullback = map.pullback
  assert.equal(pullback.label, 'Buy the dip')
  assert.equal(pullback.status, 'blocked')
  assert.match(pullback.reasons[0], /Evidence: Unvalidated \(no fee-adjusted sample of 5\+ years\)/)
  assert.match(pullback.reasons[1], /Bear market: new buys disabled \(cash floor 70%\)/)
  assert.match(pullback.reasons[2], /Current 2 Buy the dip setup\(s\), not trusted in the bear market/)
  assert.match(pullback.reasons[2], /Breadth 20\.7% below 60%/)

  const stop = map.stop
  assert.match(stop.reasons[0], /Evidence: Passed \(risk-control discipline only, not alpha\)/)
  assert.match(stop.reasons[2], /1 Stop-loss management setup\(s\) in the current list/)

  const watch = map.watch
  assert.match(watch.reasons[0], /Evidence: Passed \(not trading is the default, trivially passed\)/)
})

test('i18n en：regime profile / verdict / 降级文案为英文', () => {
  const bearProfile = profileFor('bear', 'en')
  assert.equal(bearProfile.regime, 'bear')
  assert.equal(bearProfile.notes.length, 3)
  assert.match(bearProfile.notes[0], /Bear market: stop-loss \/ trim only, no new positions/)
  assert.match(bearProfile.notes[1], /Cash ≥70%/)
  assert.equal(bearProfile.notes.some((note) => hasCjk(note)), false)

  const rangeVerdict = regimeVerdict('range', 'en')
  assert.match(rangeVerdict.headline, /Range market: half size/)
  assert.ok(rangeVerdict.doToday.some((item) => /size multiplier 0\.5/.test(item)))
  assert.ok(rangeVerdict.dontToday.length > 0)
  assert.equal(rangeVerdict.doToday.some((item) => hasCjk(item)), false)

  const bearFiltered = applyRegimeFilter([makeStrategy({ action: 'pullback' })], 'bear', 'en')
  assert.equal(bearFiltered[0].action, 'watch')
  assert.equal(bearFiltered[0].actionLabel, 'Bear watch')
  assert.match(bearFiltered[0].summary, /^Bear market: no new buys/)
  assert.equal(bearFiltered[0].suggestedShares, undefined)
  assert.equal(bearFiltered[0].reasons.includes(bearProfile.notes[0]), true)

  const rangeFiltered = applyRegimeFilter(
    [makeStrategy({ action: 'pullback', suggestedShares: 500, suggestedPositionPct: 5 })],
    'range',
    'en',
  )
  assert.equal(rangeFiltered[0].action, 'pullback')
  assert.equal(rangeFiltered[0].suggestedShares, 200)
  assert.equal(rangeFiltered[0].reasons.includes('Range market: half size'), true)

  // 非买入动作在 en 下同样不追加英文 reason、值原样
  const hold = [makeStrategy({ action: 'hold', actionLabel: 'Hold position' })]
  assert.deepEqual(applyRegimeFilter(hold, 'bear', 'en'), hold)
})
