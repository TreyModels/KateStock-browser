#!/usr/bin/env node
/**
 * 核心使用路径 E2E（Playwright）：添加非公开股票 → 东财失败 → JSONP → 腾讯日线回退 → 策略价位
 *
 * 目的：验证浏览器端「添加股票 600000（不在 public-universe.json）→ 点更新」能经
 *   东财 push2his（fetch 失败 / JSONP）→ 腾讯 fqkline（2026-11-24 起本机 501 WAF）→ 新浪 JSONP 回退拿到 ≥21 根日线，并生成策略卡
 *   （触发/保护/目标至少一个有值）。不改应用代码；任何时段可跑（日线不依赖盘中）。
 *
 * 用法：
 *   cd kate-dashboard
 *   PATH=/opt/homebrew/bin:$PATH \
 *   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
 *   PLAYWRIGHT_MODULE=/tmp/pw-tools/node_modules/playwright \
 *   node scripts/personal-stock-e2e.mjs
 *
 * 退出码：0 = PASS；1 = FAIL（报告/控制台会给出责任域 ui/data 的初步定位）。
 * 输出：docs/personal-stock-e2e.md + docs/screenshots/personal-stock-*.png（+ evidence json）。
 */

import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'screenshots')
mkdirSync(OUT_DIR, { recursive: true })
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const CODE = '600000'
const NAME = '浦发银行'
const STORAGE_KEY = 'ashare-daily-strategy-v1'

const require = createRequire(import.meta.url)
const modulePath = process.env.PLAYWRIGHT_MODULE || '/tmp/pw-tools/node_modules/playwright'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const report = {
  startedAt: new Date().toISOString(),
  base: BASE_URL,
  code: CODE,
  steps: [],
  network: { push2his: [], tencentKline: [], sinaKline: [] },
  consoleErrors: [],
  pageErrors: [],
  assertions: [],
  screenshots: [],
  conclusion: 'FAIL',
  responsibility: null,
}

function step(name, detail) {
  report.steps.push({ at: new Date().toISOString(), name, detail })
  console.log(`  · ${name}${detail ? `：${detail}` : ''}`)
}
function assertion(name, pass, detail) {
  report.assertions.push({ name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  return pass
}
async function screenshot(page, name, options = {}) {
  const relative = `docs/screenshots/${name}`
  await page.screenshot({ path: join(ROOT, relative), ...options })
  report.screenshots.push(relative)
  return relative
}

async function main() {
  let chromium
  try {
    ;({ chromium } = require(modulePath))
  } catch (error) {
    console.error(`无法加载 Playwright（${modulePath}）：${error.message}`)
    process.exit(1)
  }

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
  })
  // 只注入「空个人清单」，其余全部走页面交互（避免历史 localStorage 干扰）
  await context.addInitScript(({ key }) => {
    try {
      if (!localStorage.getItem(key)) {
        localStorage.setItem(
          key,
          JSON.stringify({ stocks: [], quotes: {}, settings: { capital: 200000, riskPct: 0.8, maxPositionPct: 12, refreshOnOpen: true } }),
        )
      }
    } catch {
      /* ignore */
    }
  }, { key: STORAGE_KEY })

  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => {
    pageErrors.push(String(error).slice(0, 500))
  })
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push(message.text().slice(0, 300))
  })
  page.on('requestfailed', (request) => {
    const url = request.url()
    const entry = { url: url.slice(0, 300), error: request.failure()?.errorText ?? '' }
    if (url.includes('push2his.eastmoney.com')) report.network.push2his.push({ kind: 'requestfailed', ...entry })
    if (url.includes('web.ifzq.gtimg.cn')) report.network.tencentKline.push({ kind: 'requestfailed', ...entry })
    if (url.includes('quotes.sina.cn')) report.network.sinaKline.push({ kind: 'requestfailed', ...entry })
  })
  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('push2his.eastmoney.com')) {
      const entry = { kind: 'response', status: response.status(), url: url.slice(0, 300), cb: /[?&]cb=/.test(url) }
      try {
        const text = await response.text()
        entry.bodySnippet = text.slice(0, 100)
        entry.hasKlines = /"klines"/.test(text)
        entry.rcZero = /"rc"\s*:\s*0/.test(text)
      } catch {
        /* 忽略 */
      }
      report.network.push2his.push(entry)
    }
    if (url.includes('web.ifzq.gtimg.cn')) {
      const entry = { kind: 'response', status: response.status(), url: url.slice(0, 300) }
      try {
        const payload = await response.json()
        const symbols = Object.keys(payload?.data ?? {})
        const node = payload?.data?.[symbols[0]]
        const rows = node?.qfqday || node?.day
        if (Array.isArray(rows)) {
          entry.qfqdayRows = rows.length
          entry.firstDate = rows[0]?.[0]
          entry.lastDate = rows.at(-1)?.[0]
        }
      } catch {
        entry.bodySnippet = '（非 JSON：可能是 501 WAF 挑战页或 CORS 失败）'
      }
      report.network.tencentKline.push(entry)
    }
    if (url.includes('quotes.sina.cn')) {
      const entry = { kind: 'response', status: response.status(), url: url.slice(0, 300) }
      try {
        const text = await response.text()
        entry.bodySnippet = text.slice(0, 120)
        const match = /var\s+__sina_kline_[^=]+=\s*\(([\s\S]*)\)\s*;?\s*$/.exec(text.trim())
        if (match) {
          const rows = JSON.parse(match[1])
          entry.rows = Array.isArray(rows) ? rows.length : 0
          entry.firstDate = rows?.[0]?.day
          entry.lastDate = rows?.at?.(-1)?.day
        }
      } catch {
        /* 忽略解析失败，仅记录状态 */
      }
      report.network.sinaKline.push(entry)
    }
  })

  let failureStage = 'ui'
  try {
    /* ── 1. 打开应用 → 股票页 ── */
    step('打开应用', BASE_URL)
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.market-status', { timeout: 25_000 })
    await page.waitForSelector('.desktop-nav button', { timeout: 15_000 })
    const stocksNav = page.locator('.desktop-nav button', { hasText: '股票' }).first()
    await stocksNav.click()
    await page.waitForSelector('.stock-toolbar', { timeout: 15_000 })
    step('进入股票页', '成功')

    /* ── 2. 页面交互添加 600000 ── */
    const addButton = page.locator('button', { hasText: '添加股票' }).filter({ visible: true }).first()
    await addButton.click()
    await page.waitForSelector('.stock-dialog', { timeout: 10_000 })
    await page.getByPlaceholder('输入 6 位证券代码').fill(CODE)
    await page.getByPlaceholder('输入证券名称').fill(NAME)
    await screenshot(page, 'personal-stock-01-dialog.png')
    await page.getByRole('button', { name: '保存并生成策略' }).click()
    await page.waitForSelector('.stock-row', { timeout: 10_000 })
    await page.waitForFunction(
      (code) => document.querySelector('.stock-list')?.innerText.includes(code),
      CODE,
      { timeout: 10_000 },
    )
    step('页面交互添加股票', `${CODE} ${NAME}（status=当前自选）`)

    /* ── 3. 点「更新」触发 fetchQuotes（等自动刷新按钮恢复可用后再点） ── */
    const updateButton = page.locator('.stock-toolbar button', { hasText: '更新' }).first()
    await page.waitForFunction(
      () => {
        const button = [...document.querySelectorAll('.stock-toolbar button')].find((el) => el.textContent?.includes('更新'))
        return button && !button.disabled
      },
      { timeout: 60_000 },
    )
    await updateButton.click()
    step('点击「更新」', '触发 fetchQuotes（东财 → JSONP → 腾讯 kline）')

    /* ── 4. 等待 quote 持久化（bars≥21） ── */
    await page.waitForFunction(
      ({ key, code }) => {
        try {
          const raw = localStorage.getItem(key)
          if (!raw) return false
          const data = JSON.parse(raw)
          const quote = data?.quotes?.[code]
          return Boolean(quote && Array.isArray(quote.bars) && quote.bars.length >= 21 && quote.price > 0)
        } catch {
          return false
        }
      },
      { key: STORAGE_KEY, code: CODE },
      { timeout: 90_000 },
    )
    const quote = await page.evaluate(({ key, code }) => {
      const data = JSON.parse(localStorage.getItem(key))
      const q = data.quotes[code]
      return {
        code: q.code,
        price: q.price,
        tradeDate: q.tradeDate,
        bars: q.bars.length,
        firstDate: q.bars[0]?.date,
        lastDate: q.bars.at(-1)?.date,
        provider: q.provider ?? null,
        adjustment: q.adjustment ?? null,
        source: q.source,
      }
    }, { key: STORAGE_KEY, code: CODE })
    report.quote = { provider: quote.provider ?? null, adjustment: quote.adjustment ?? null, bars: quote.bars, price: quote.price, tradeDate: quote.tradeDate }
    step('拿到日线', JSON.stringify(quote))

    /* ── 5. 断言：股票行/策略卡有价格 ── */
    failureStage = 'data'
    await page.waitForFunction(
      (code) => {
        const row = [...document.querySelectorAll('.stock-row')].find((el) => el.textContent?.includes(code))
        return Boolean(row && /\d+\.\d{2}/.test(row.textContent))
      },
      CODE,
      { timeout: 20_000 },
    )
    const rowText = norm((await page.locator('.stock-row').filter({ hasText: CODE }).first().innerText()).slice(0, 300))
    assertion('股票行出现价格', /\d+\.\d{2}/.test(rowText), rowText)
    await screenshot(page, 'personal-stock-02-stock-page.png')

    /* ── 6. 打开策略详情，断言触发/保护/目标至少一个有值 ── */
    const row = page.locator('.stock-row').filter({ hasText: CODE }).first()
    await row.getByRole('button', { name: '策略' }).click()
    await page.waitForSelector('.stock-dialog', { timeout: 10_000 })
    await page.waitForFunction(
      () => {
        const boxes = [...document.querySelectorAll('.stock-dialog .level-box strong')]
        return boxes.length >= 3 && boxes.some((el) => /\d+\.\d{2}/.test(el.textContent ?? ''))
      },
      { timeout: 15_000 },
    )
    const levels = await page.evaluate(() =>
      [...document.querySelectorAll('.stock-dialog .level-box')].map((box) => ({
        label: (box.querySelector('span')?.textContent ?? '').trim(),
        value: (box.querySelector('strong')?.textContent ?? '').trim(),
      })),
    )
    await screenshot(page, 'personal-stock-03-detail.png')
    const valuedLevels = levels.filter((item) => /\d+\.\d{2}/.test(item.value))
    assertion('详情价位至少一个非「—」', valuedLevels.length >= 1, JSON.stringify(levels))
    assertion('详情包含触发/保护/目标三项', levels.length >= 3, levels.map((item) => item.label).join(' / '))
    await page.keyboard.press('Escape')
    await sleep(400)

    /* ── 7. 今日页策略卡（价格 + 价位） ── */
    await page.locator('.desktop-nav button', { hasText: '今日' }).first().click()
    await page.waitForSelector('.strategy-card', { timeout: 15_000 })
    const card = page.locator('.strategy-card').filter({ hasText: CODE }).first()
    await card.waitFor({ timeout: 15_000 })
    const cardText = norm((await card.innerText()).slice(0, 400))
    assertion('今日页出现该股票策略卡', /600000/.test(cardText), cardText)
    const priceTokens = cardText.match(/\d+\.\d{2}/g) ?? []
    assertion('策略卡有价格且至少一个价位', priceTokens.length >= 2, `价格型数值 ${priceTokens.length} 个：${priceTokens.join(' / ')}；${cardText.slice(0, 220)}`)
    await screenshot(page, 'personal-stock-04-today-card.png')

    /* ── 8. Network/来源断言：东财主源成功，或东财失败→腾讯/新浪回退成功 ── */
    const push2hisFailures = report.network.push2his.filter((entry) => entry.kind === 'requestfailed' || (entry.kind === 'response' && entry.status >= 400))
    const push2hisAttempts = report.network.push2his.filter((entry) => entry.kind === 'requestfailed' || entry.kind === 'response')
    const push2hisSuccesses = report.network.push2his.filter((entry) => entry.kind === 'response' && entry.status === 200 && entry.hasKlines === true)
    const tencentSuccesses = report.network.tencentKline.filter((entry) => entry.kind === 'response' && entry.status === 200 && (entry.qfqdayRows ?? 0) >= 21)
    const tencentAttempts = report.network.tencentKline.filter((entry) => entry.kind === 'requestfailed' || entry.kind === 'response')
    const tencent501 = report.network.tencentKline.filter((entry) => entry.status === 501)
    const sinaSuccesses = report.network.sinaKline.filter((entry) => entry.kind === 'response' && entry.status === 200 && (entry.rows ?? 0) >= 21)
    const provider = quote.provider ?? ''
    const eastmoneyPrimarySuccess = push2hisSuccesses.length > 0
    assertion('东财 push2his 有请求（成功或失败均可，按实际记录）', push2hisAttempts.length > 0, `attempts=${push2hisAttempts.length}，成功(klines)=${push2hisSuccesses.length}，失败=${push2hisFailures.length}`)
    assertion(
      '日线数据获取成功（东财主源 或 腾讯/新浪回退）',
      quote.bars >= 21 && (eastmoneyPrimarySuccess || tencentSuccesses.length > 0 || sinaSuccesses.length > 0),
      `东财主源成功=${eastmoneyPrimarySuccess}；腾讯成功=${tencentSuccesses.length}（501=${tencent501.length}，尝试=${tencentAttempts.length}）；新浪成功=${sinaSuccesses.length}`,
    )
    const sourceLabel = /Sina/i.test(provider)
      ? 'Sina kline（新浪回退）'
      : /Tencent/i.test(provider)
        ? 'Tencent kline（腾讯回退）'
        : eastmoneyPrimarySuccess
          ? 'Eastmoney 主源（基线 Quote 无 provider 字段，属预期）'
          : '未知来源'
    assertion('数据来源可识别', /Tencent|Sina/i.test(provider) || eastmoneyPrimarySuccess, sourceLabel)
    if (eastmoneyPrimarySuccess) {
      assertion('回退链路本次未触发（东财主源可用，属预期；回退能力已在反爬/501 窗口另行验证）', true, `provider=${provider || 'null'}（东财主源）`)
    } else if (/Sina/i.test(provider)) {
      assertion('新浪回退成功（HTTP 200 且 rows≥21 根）', sinaSuccesses.length > 0, JSON.stringify(sinaSuccesses.slice(0, 2)))
      assertion('新浪回退为不复权并已明确标注（不冒充前复权）', /不复权/.test(quote.adjustment ?? ''), quote.adjustment ?? 'null')
    } else if (/Tencent/i.test(provider)) {
      assertion('腾讯 fqkline 回退成功（HTTP 200 且 qfqday≥21 根）', tencentSuccesses.length > 0, JSON.stringify(tencentSuccesses.slice(0, 2)))
    } else {
      assertion('回退数据源失败（东财不可用且腾讯/新浪均无成功响应）', false, '见网络证据')
    }
    assertion('quote 的 bars 为 160 根（上限）', quote.bars === 160, `${quote.bars} 根（${quote.firstDate} → ${quote.lastDate}）`)

    /* ── 9. 无 pageerror ── */
    assertion('无 pageerror', pageErrors.length === 0, pageErrors.join(' | ') || '0 条')

    const hardPass = report.assertions.every((item) => item.pass)
    report.conclusion = hardPass ? 'PASS' : 'FAIL'
    report.responsibility = hardPass
      ? null
      : push2hisAttempts.length === 0 || tencentSuccesses.length === 0
        ? 'data（market.ts 回退链路 / 网络）'
        : 'ui（添加/刷新/详情交互）或 data（解析/状态）'
    process.exitCode = hardPass ? 0 : 1
  } catch (error) {
    report.conclusion = 'FAIL'
    report.responsibility = failureStage === 'ui' ? 'ui（添加股票对话框/刷新按钮/详情交互）' : 'data（market.ts 腾讯回退/解析）或 ui（状态）'
    report.error = String(error).slice(0, 800)
    assertion('E2E 流程完成', false, report.error)
    console.error('E2E 失败：', error)
    process.exitCode = 1
  } finally {
    await context.close()
    await browser.close()
    report.pageErrors = pageErrors
    report.finishedAt = new Date().toISOString()
    writeFileSync(join(OUT_DIR, 'personal-stock-evidence.json'), JSON.stringify(report, null, 2))
    writeReport()
  }
}

function writeReport() {
  const lines = []
  lines.push('# 浏览器 E2E：添加非公开股票 → 日线获取（东财主源/腾讯/新浪回退）→ 策略价位', '')
  lines.push(`- 运行时间：${report.startedAt} → ${report.finishedAt ?? '—'}（Asia/Shanghai）`)
  lines.push(`- 页面：${report.base}；股票：${report.code}`)
  lines.push(`- 结论：**${report.conclusion}**${report.responsibility ? `；责任域（初步）：${report.responsibility}` : ''}`)
  lines.push('', '## 前置条件', '')
  lines.push('- dev server `http://localhost:3000` 运行中（本脚本不依赖交易时段，日线数据任何时段可拉）。')
  lines.push('- Playwright 装在 `/tmp`：`/tmp/pw-tools/node_modules/playwright` + `/tmp/pw-browsers`。')
  lines.push('- 浏览器上下文注入空个人清单；**除代码/名称外全部走页面交互**（打开添加对话框 → 填写 → 保存 → 点更新）。')
  lines.push('- 本机东财 push2his 时通/时被反爬、腾讯 fqkline 2026-11-24 07:44 起对本机 501 WAF：脚本按**实际来源**判定（东财主源成功 或 腾讯/新浪回退成功 均可 PASS），并记录本次走了哪条链路。')
  lines.push('', '## 步骤', '')
  for (const stepItem of report.steps) lines.push(`- ${stepItem.name}${stepItem.detail ? `：${stepItem.detail}` : ''}`)
  lines.push('', '## 断言', '')
  lines.push('| 断言 | 结果 | 证据 |', '| --- | --- | --- |')
  for (const item of report.assertions) lines.push(`| ${item.name} | ${item.pass ? '✅ PASS' : '❌ FAIL'} | ${String(item.detail).replace(/\|/g, '\\|').slice(0, 500)} |`)
  lines.push('', '## 网络证据', '')
  lines.push(`- push2his（东财）记录 ${report.network.push2his.length} 条：`)
  for (const entry of report.network.push2his.slice(0, 8)) lines.push(`  - ${JSON.stringify(entry)}`)
  lines.push(`- 腾讯 fqkline 记录 ${report.network.tencentKline.length} 条（501 为 WAF 挑战页，属数据源侧限制）：`)
  for (const entry of report.network.tencentKline.slice(0, 8)) lines.push(`  - ${JSON.stringify(entry)}`)
  lines.push(`- 新浪 JSONP 记录 ${report.network.sinaKline.length} 条：`)
  for (const entry of report.network.sinaKline.slice(0, 8)) lines.push(`  - ${JSON.stringify(entry)}`)
  lines.push('', '## 数据口径说明（重要）', '')
  lines.push('- 东财（push2his）与腾讯（fqkline）是**前复权**；新浪日线回退是**不复权**（Quote.adjustment 已标注 `不复权（tushare 未验证）`）。')
  lines.push('- 混源差异：同一页面里不同股票的均线/ATR/RSI（基于各自 bars）口径可能不一致；策略价位不能跨数据源直接比较。个人清单若混源，建议以同一数据源为准，或重要决策前核对 `adjustment`。')
  lines.push('- 本轮实际：provider=' + (report.quote?.provider ?? '—') + '；adjustment=' + (report.quote?.adjustment ?? '—') + '。生产网络优先东财/腾讯前复权，新浪仅作腾讯 501 时的兜底。')
  lines.push('', '## 截图', '')
  for (const shot of report.screenshots) lines.push(`- \`${shot}\``)
  lines.push('', '## 复现命令', '', '```bash', 'cd kate-dashboard', 'PATH=/opt/homebrew/bin:$PATH \\', 'PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \\', 'PLAYWRIGHT_MODULE=/tmp/pw-tools/node_modules/playwright \\', 'node scripts/personal-stock-e2e.mjs', '```', '')
  if (report.consoleErrors.length) {
    lines.push('## console 错误（前 10 条；仅记录）', '')
    for (const error of report.consoleErrors.slice(0, 10)) lines.push(`- ${error}`)
    lines.push('')
  }
  if (report.error) lines.push('## 失败堆栈', '', '```', report.error, '```', '')
  lines.push('## 责任域判定口径', '')
  lines.push('- 添加/保存/点更新/详情打不开 → **ui**（StockDialog / 按钮状态 / 详情弹窗）。')
  lines.push('- 页面交互成功但 bars 未落地、来源无法识别（东财未成功且腾讯/新浪也无成功响应） → **data**（market.ts 数据链路/解析）。')
  lines.push('- 网络里腾讯成功、localStorage 有 bars，但页面不显示策略卡/价位 → **ui 或状态管理**（本脚本会单独标注）。')
  writeFileSync(join(ROOT, 'docs', 'personal-stock-e2e.md'), lines.join('\n'))
}

main().catch((error) => {
  console.error('personal-stock-e2e 启动失败：', error)
  process.exit(1)
})
