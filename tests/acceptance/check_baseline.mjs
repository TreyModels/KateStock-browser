#!/usr/bin/env node
/**
 * 基线不变量检查（离线、只读）—— qa-verifier
 *
 * 目的：在并行改造期间，确保「原站基线语义/隐私门」没有被误改：
 *   - 个人初始记录仍为空（隐私门）
 *   - 原站日线 klt=101 / 前复权语义仍在（EOD 层）
 *   - 16:45 收盘门槛与 cron 16:45/07:05 仍在
 *   - 29 只公开清单仍在，且未混入个人记录
 *   - 回测仍是「次日开盘成交 + 单边成本」
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

// ── 3. 16:45 收盘门槛 + cron ───────────────────────────────────
check('B-05', 'ingest.py 仍以 16:45 作为当日收盘门槛', () =>
  expectMatch('scripts/ingest.py', /dt\.time\(\s*16\s*,\s*45\s*\)/, 'dt.time(16, 45)'),
)
check('B-06', 'cron 仍为 16:45 北京时间（45 8 * * 1-5）', () =>
  expectMatch('.github/workflows/market-update.yml', /cron:\s*['"]45 8 \* \* 1-5['"]/, "cron: '45 8 * * 1-5'"),
)
check('B-07', 'cron 仍为 07:05 北京时间（5 23 * * 0-4）', () =>
  expectMatch('.github/workflows/market-update.yml', /cron:\s*['"]5 23 \* \* 0-4['"]/, "cron: '5 23 * * 0-4'"),
)

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

// ── 5. 信号=EOD、回测=次日开盘、成本 0.1% ─────────────────────
check('B-10', '回测仍为次日开盘成交（bar.open * (1 + COST)）', () =>
  expectMatch('src/lib/backtest.ts', /bar\.open\s*\*\s*\(1\s*\+\s*COST\)/, 'bar.open * (1 + COST)'),
)
check('B-11', '单边成本仍为 0.001（0.1%）', () =>
  expectMatch('src/lib/backtest.ts', /const\s+COST\s*=\s*0\.001\b/, 'const COST = 0.001'),
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
const failed = checks.filter((c) => !c.ok)
const width = Math.max(...checks.map((c) => c.id.length))
console.log(`\n基线不变量检查（${ROOT}）\n`)
for (const c of checks) {
  const mark = c.ok ? '✓' : '✗'
  console.log(`${mark} ${c.id.padEnd(width)}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`)
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) {
  console.log(`\nFAIL: ${failed.length} 项基线不变量被破坏——若属有意变更，请先更新 docs/baseline.md 并取得 Lead 同意。`)
  process.exit(1)
}
console.log('PASS: 基线不变量全部保持。')
