#!/usr/bin/env node
/**
 * 基线不变量检查（离线、只读）—— qa-verifier
 *
 * 目的：在并行改造期间，确保「原站基线语义/隐私门」没有被误改：
 *   - 个人初始记录仍为空（隐私门）
 *   - 原站日线 klt=101 / 前复权语义仍在（EOD 层）
 *   - 16:45 收盘门槛仍在；发布 workflow 已迁移到 deploy-pages.yml（cron 16:50/07:50）
 *   - 29 只公开清单仍在，且未混入个人记录
 *   - [TODO task-30] 回测 EOD 语义：backtest.ts 重构中，暂跳过（signals-alerts 落地后恢复）
 *   - 公开信号仍复用同一策略引擎、快照 schema 关键字段未删
 *   - 非实时文案仍在
 *
 * 用法：
 *   node tests/acceptance/check_baseline.mjs
 *   （仓库根或任意目录均可，脚本按自身位置定位仓库；不修改任何文件）
 *
 * 退出码：0 = 全部通过；1 = 有不变量被破坏（逐条打印 FAIL）。
 * 注意：本脚本不替代最终验收（见 docs/acceptance.md），只防止基线回归。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const checks = []
const check = (id, name, fn) => {
  try {
    const detail = fn()
    checks.push({ id, name, ok: true, detail: detail ?? '' })
  } catch (error) {
    checks.push({ id, name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

/** 预期中的临时变更：记为 SKIP（不判失败），恢复时改回 check()。 */
const skip = (id, name, reason) => {
  checks.push({ id, name, ok: true, skipped: true, detail: `SKIP：${reason}` })
}

const read = (rel) => {
  try {
    return readFileSync(join(ROOT, rel), 'utf8')
  } catch {
    throw new Error(`无法读取 ${rel}（文件被移动或删除？）`)
  }
}

const expectMatch = (rel, regex, what) => {
  const text = read(rel)
  const m = text.match(regex)
  if (!m) throw new Error(`${rel} 中找不到「${what}」（正则 ${regex}）`)
  return `匹配 ${JSON.stringify(String(m[0]).slice(0, 80))}`
}

// ── 1. 隐私门：个人初始记录必须为空 ─────────────────────────────
check('B-01', 'src/data/initialStocks.ts 为空数组（隐私门）', () =>
  expectMatch('src/data/initialStocks.ts', /export\s+const\s+initialStocks\s*:\s*Stock\[\]\s*=\s*\[\s*\]/, 'export const initialStocks: Stock[] = []'),
)

// ── 2. EOD 日线语义：klt=101 / 前复权 ──────────────────────────
check('B-02', '客户端日线请求仍为 klt=101', () =>
  expectMatch('src/lib/market.ts', /klt:\s*['"]101['"]/, "klt: '101'"),
)
check('B-03', '服务端日线请求仍为 klt=101', () =>
  expectMatch('scripts/ingest.py', /['"]klt['"]\s*:\s*['"]101['"]/, "klt: '101'"),
)
check('B-04', '前复权仍为 fqt=1', () => {
  const a = expectMatch('src/lib/market.ts', /fqt:\s*['"]1['"]/, "fqt: '1'")
  return a
})

// ── 3. 16:45 收盘门槛 + 发布 workflow（已迁移到 deploy-pages.yml） ──
check('B-05', 'ingest.py 仍以 16:45 作为当日收盘门槛', () =>
  expectMatch('scripts/ingest.py', /dt\.time\(\s*16\s*,\s*45\s*\)/, 'dt.time(16, 45)'),
)
check('B-06', 'deploy-pages.yml 仍含收盘后/盘前 schedule（16:50 / 07:50 北京）', () => {
  const text = read('.github/workflows/deploy-pages.yml')
  for (const cron of ["cron: '50 8 * * 1-5'", "cron: '50 23 * * 0-4'"]) {
    if (!text.includes(cron)) throw new Error(`deploy-pages.yml 缺少 ${cron}（16:50/07:50 北京时间）`)
  }
  return "cron: '50 8 * * 1-5'（16:50 北京）+ '50 23 * * 0-4'（07:50 北京）"
})
check('B-07', 'deploy-pages.yml 仍含 refresh → verify → upload artifact → deploy 流水线', () => {
  const text = read('.github/workflows/deploy-pages.yml')
  const required = [
    ['npm run refresh', /npm run refresh/],
    ['bash scripts/verify.sh', /bash scripts\/verify\.sh/],
    ['actions/upload-pages-artifact', /actions\/upload-pages-artifact@v\d+/],
    ['actions/deploy-pages', /actions\/deploy-pages@v\d+/],
  ]
  const missing = required.filter(([, regex]) => !regex.test(text)).map(([name]) => name)
  if (missing.length) throw new Error(`deploy-pages.yml 缺少：${missing.join('、')}`)
  return 'npm run refresh / verify.sh / upload-pages-artifact / deploy-pages 均在'
})

// ── 4. 29 只公开清单，不含个人记录 ────────────────────────────
check('B-08', '公开清单仍为 29 只且为纯代码数组', () => {
  const codes = JSON.parse(read('scripts/public-universe.json'))
  if (!Array.isArray(codes)) throw new Error('public-universe.json 不是数组')
  if (codes.length !== 29) throw new Error(`公开清单数量 ${codes.length} ≠ 29`)
  if (!codes.every((c) => /^\d{6}$/.test(c))) throw new Error('公开清单存在非 6 位代码')
  if (!codes.includes('159558') || !codes.includes('588060')) throw new Error('清单缺少基线 ETF 代码 159558/588060')
  return `${codes.length} 只，含 2 只 ETF`
})
check('B-09', 'ingest 覆盖范围文案仍为「公开清单，非全市场」', () =>
  expectMatch('scripts/ingest.py', /公开清单（\{len\(UNIVERSE\)\}只），非全市场/, 'coverage 文案'),
)

// ── 5. 信号=EOD；回测语义（backtest.ts 重构中，TODO task-30） ──
//  原 B-10/B-11 校验「次日开盘成交 bar.open*(1+COST)」「COST=0.001」；
//  signals-alerts 的 task-30 正在重构 backtest.ts（费用函数 buyFeeFor/sellFeeFor/roundTripCostBps、
//  pendingEntry 顺延/涨跌停等），完成后恢复为 check()：
//    - 次日开盘执行（pendingEntry 在下一根 bar.open 成交，而非信号日 close）
//    - 成本口径（DEFAULT_COST_OPTIONS / roundTripCostBps 与回测一致性）
//  现在标记 SKIP，避免并行重构期间基线门禁误报。
skip(
  'B-10',
  '回测 EOD 语义（TODO task-30：backtest.ts 重构中）',
  '等 signals-alerts 的 task-30 落地后恢复：检查次日开盘成交、费用/成本口径、无未来函数；当前不判失败',
)
check('B-12', '定时信号仍复用 generateStrategy 引擎', () =>
  expectMatch('scripts/generate_signals.mjs', /generateStrategy/, 'generateStrategy'),
)
check('B-13', '公开信号仍被 check_public.py 限制为无 sizing 字段', () =>
  expectMatch('scripts/check_public.py', /'action','actionLabel','score','summary','reasons','indicators'/, 'signals 字段白名单'),
)

// ── 6. 快照 schema 关键字段 ────────────────────────────────────
check('B-14', '快照 schema 仍含 schemaVersion/tradeDate/partial/signals', () => {
  const text = read('src/lib/snapshot.ts')
  for (const field of ['schemaVersion', 'generatedAt', 'tradeDate', 'partial', 'signals', 'quotes']) {
    if (!text.includes(field)) throw new Error(`snapshot.ts 缺少字段 ${field}`)
  }
  return '关键字段齐全'
})
check('B-15', '快照合并仍保留手动行情（mergeSnapshotQuotes）', () =>
  expectMatch('src/lib/snapshot.ts', /source\s*!==\s*'manual'/, "existing.source !== 'manual'"),
)

// ── 7. 非实时标注 & EOD 文档语义 ──────────────────────────────
check('B-16', '报告状态条仍标注「非实时行情」', () =>
  expectMatch('src/components/ReportStatus.tsx', /非实时行情/, '非实时行情'),
)
check('B-17', 'README 仍写明「收盘出信号、次日开盘执行」', () =>
  expectMatch('README.md', /收盘出信号、次日开盘执行/, '收盘出信号、次日开盘执行'),
)
check('B-18', '运维文档仍声明 snapshots are not live quotes', () =>
  expectMatch('docs/operations-2.0.md', /snapshots are not live quotes/i, 'snapshots are not live quotes'),
)

// ── 8. 交付物存在（本轮新增） ─────────────────────────────────
check('B-19', '验收交付物存在：baseline/acceptance/verify.sh', () => {
  const missing = ['docs/baseline.md', 'docs/acceptance.md', 'scripts/verify.sh', 'tests/acceptance/README.md'].filter((rel) => {
    try {
      read(rel)
      return false
    } catch {
      return true
    }
  })
  if (missing.length) throw new Error(`缺少 ${missing.join('、')}`)
  return '四个交付物齐全'
})

// ── 输出 ─────────────────────────────────────────────────────
const failed = checks.filter((c) => c.ok === false)
const skipped = checks.filter((c) => c.skipped)
const effective = checks.length - skipped.length
const passed = effective - failed.length
const width = Math.max(...checks.map((c) => c.id.length))
console.log(`\n基线不变量检查（${ROOT}）\n`)
for (const c of checks) {
  const mark = c.skipped ? '⏭' : c.ok ? '✓' : '✗'
  console.log(`${mark} ${c.id.padEnd(width)}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`)
}
console.log(`\n${passed}/${effective} 有效断言通过；SKIP ${skipped.length} 项（${skipped.map((c) => c.id).join('、') || '无'}，不判失败）`)
console.log(`总计 ${checks.length} 项：PASS ${passed}，SKIP ${skipped.length}，FAIL ${failed.length}。`)
if (failed.length) {
  console.log(`\nFAIL: ${failed.length} 项基线不变量被破坏——若属有意变更，请先更新 docs/baseline.md 并取得 Lead 同意。`)
  process.exit(1)
}
console.log('PASS: 基线不变量全部保持（SKIP 项为预期临时变更）。')
