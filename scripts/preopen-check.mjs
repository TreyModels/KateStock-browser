#!/usr/bin/env node
/**
 * 真实时钟「盘前态」检查（不 mock / 不固定时钟）：验证盘前不冒充实时、不误报。
 *
 * 断言：
 *  1) 相位徽标 = 盘前；
 *  2) 状态条「最近报价」provider 时间 = 上一交易日（约 16:14，不是今天 09:xx）；数据年龄为小时级；
 *     页面不把旧价标成「盘中」（无 .price-tag-live、价格标签不含 盘中/竞价）；
 *  3) 提醒面板为空、无 UI 报错/无 pageerror；
 *  4) 公开清单价格标签 = 盘前/收盘；
 *  5) 无 pageerror。
 *
 * 用法（真实时钟，独立 browser context，不污染 localStorage）：
 *   cd kate-dashboard
 *   PATH=/opt/homebrew/bin:$PATH \
 *   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
 *   PLAYWRIGHT_MODULE=/tmp/pw-tools/node_modules/playwright \
 *   node scripts/preopen-check.mjs
 *
 * 退出码：0=PASS，1=FAIL（报告/控制台给出责任域 ui/signals/data）。
 * 输出：docs/preopen-check.md + docs/screenshots/preopen-*.png（截图已 gitignore）。
 */

import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'screenshots')
mkdirSync(OUT_DIR, { recursive: true })
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const modulePath = process.env.PLAYWRIGHT_MODULE || '/tmp/pw-tools/node_modules/playwright'
const DOC_PATH = join(ROOT, 'docs', 'preopen-check.md')

const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const pad2 = (n) => String(n).padStart(2, '0')

const beijingFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hour12: false,
})
const by = (parts, type) => parts.find((p) => p.type === type)?.value ?? ''
function beijingParts(date = new Date()) {
  const parts = beijingFormatter.formatToParts(date)
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: Number(by(parts, 'year')),
    month: Number(by(parts, 'month')),
    day: Number(by(parts, 'day')),
    hour: Number(by(parts, 'hour')) % 24,
    minute: Number(by(parts, 'minute')),
    second: Number(by(parts, 'second')),
    weekday: weekdayMap[by(parts, 'weekday')] ?? 0,
  }
}
function beijingDate(date = new Date()) {
  const p = beijingParts(date)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}
function beijingClock(date = new Date()) {
  const p = beijingParts(date)
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`
}
function previousTradingDay(date = new Date()) {
  const p = beijingParts(date)
  let candidate = new Date(Date.UTC(p.year, p.month - 1, p.day))
  for (let guard = 0; guard < 8; guard += 1) {
    candidate = new Date(candidate.getTime() - 86_400_000)
    const day = candidate.getUTCDay()
    if (day !== 0 && day !== 6) break
  }
  return candidate.toISOString().slice(0, 10)
}
function clockOfIso(iso) {
  const date = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(date.getTime())) return undefined
  const p = beijingParts(date)
  return { date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`, clock: `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}` }
}
function parseTencentTimestamp(raw) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(raw || '').trim())
  if (!match) return undefined
  const [, y, mo, d, h, mi, s] = match.map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, s))
}
function parseTencentQuotes(text) {
  const quotes = {}
  const regex = /\bv_([a-z]{2}\d{6})\s*=\s*"([^"]*)"/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const fields = match[2].split('~')
    if (fields.length < 38) continue
    quotes[match[1].slice(2)] = { price: Number(fields[3]), timestampRaw: fields[30], timestamp: parseTencentTimestamp(fields[30]) }
  }
  return quotes
}

const report = {
  startedAt: new Date().toISOString(),
  base: BASE_URL,
  assertions: [],
  providerTimes: {},
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  evidence: {},
  conclusion: 'FAIL',
  responsibility: null,
}

function assertion(name, pass, detail) {
  report.assertions.push({ name, pass, detail: String(detail ?? '') })
  console.log(`${pass ? '✅' : '❌'} ${name}：${detail}`)
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
  // 独立 browser context：默认空 localStorage，不注入任何 mock/清单/固定时钟
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
  })
  const page = await context.newPage()
  const startedAt = new Date()

  page.on('pageerror', (error) => report.pageErrors.push(String(error).slice(0, 500)))
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push(message.text().slice(0, 300))
  })
  page.on('response', async (response) => {
    const url = response.url()
    try {
      if (url.includes('push2.eastmoney.com/api/qt/ulist.np')) {
        const payload = await response.json()
        for (const item of payload?.data?.diff ?? []) {
          const code = String(item?.f12 ?? '')
          const seconds = Number(item?.f124)
          if (!/^\d{6}$/.test(code) || !Number.isFinite(seconds) || seconds <= 0) continue
          report.providerTimes[code] = { raw: String(seconds), timestamp: new Date(seconds * 1000), source: 'eastmoney f124' }
        }
      } else if (url.includes('qt.gtimg.cn')) {
        const text = await response.text()
        for (const [code, quote] of Object.entries(parseTencentQuotes(text))) {
          if (quote.timestamp) report.providerTimes[code] = { raw: quote.timestampRaw, timestamp: quote.timestamp, source: 'tencent field30' }
        }
      }
    } catch {
      /* 解析失败忽略（不伪造时间戳） */
    }
  })

  let failureStage = 'ui'
  try {
    console.log(`真实时钟盘前检查：${beijingDate(startedAt)} ${beijingClock(startedAt)}（Asia/Shanghai）`)
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.market-status', { timeout: 25_000 })
    await page.waitForFunction(() => document.querySelectorAll('.public-stock').length > 0, { timeout: 25_000 })
    // 等首轮真实报价落定：状态条出现「最近报价 HH:mm:ss」且成功/失败计数非初始 0/0
    await page.waitForFunction(
      () => {
        const text = document.querySelector('.market-status-meta')?.textContent ?? ''
        const hasQuoteClock = /最近报价\s*\d{2}:\d{2}:\d{2}/.test(text)
        const hasCount = /成功\s*[1-9]/.test(text) || /失败\s*[1-9]/.test(text)
        return hasQuoteClock && hasCount
      },
      { timeout: 35_000 },
    ).catch(() => undefined)
    // 再等一小段时间让 provider 时间戳响应事件与渲染稳定
    for (let attempt = 0; attempt < 20 && Object.keys(report.providerTimes).length === 0; attempt += 1) await sleep(250)
    await sleep(800)

    const evidence = await page.evaluate(() => {
      const text = (selector) => document.querySelector(selector)?.innerText ?? ''
      const phase = document.querySelector('.phase-badge')?.textContent ?? ''
      const statusMeta = document.querySelector('.market-status-meta')?.innerText ?? ''
      const statusFull = document.querySelector('.market-status')?.innerText ?? ''
      const priceTags = [...document.querySelectorAll('.price-tag')].map((el) => el.textContent?.trim() ?? '')
      const alerts = [...document.querySelectorAll('.alert-item')].map((el) => el.innerText ?? '')
      const toasts = [...document.querySelectorAll('[data-sonner-toast]')].map((el) => el.innerText ?? '')
      return {
        checkedAt: new Date().toISOString(),
        phase: phase.trim(),
        statusMeta: statusMeta.replace(/\s+/g, ' ').trim(),
        statusFull: statusFull.replace(/\s+/g, ' ').trim(),
        priceTags,
        liveTagCount: document.querySelectorAll('.price-tag-live').length,
        staleTagCount: document.querySelectorAll('.price-tag-stale').length,
        alerts,
        toasts,
        alertPanelText: text('.live-alerts-panel').replace(/\s+/g, ' ').trim(),
        statusErrorCount: document.querySelectorAll('.market-status-error').length,
        publicCount: document.querySelectorAll('.public-stock').length,
        publicHeading: text('.public-stocks-heading p').replace(/\s+/g, ' ').trim(),
        bodyHasLiveClaim: /盘中报价\s+\d{2}:\d{2}/.test(document.body.innerText),
      }
    })
    report.evidence = evidence
    const checkedAt = new Date(evidence.checkedAt)
    const today = beijingDate(checkedAt)
    const expectedDate = previousTradingDay(checkedAt)

    /* 截图：首屏 + 状态条 + 公开清单 + 提醒面板 */
    await screenshot(page, 'preopen-01-today-top.png')
    await page.locator('.market-status').first().screenshot({ path: join(ROOT, 'docs/screenshots/preopen-02-statusbar.png') })
    report.screenshots.push('docs/screenshots/preopen-02-statusbar.png')
    await page.locator('.public-stocks').first().screenshot({ path: join(ROOT, 'docs/screenshots/preopen-03-public-stocks.png') })
    report.screenshots.push('docs/screenshots/preopen-03-public-stocks.png')
    const panel = page.locator('.live-alerts-panel').first()
    if (await panel.count()) {
      await panel.screenshot({ path: join(ROOT, 'docs/screenshots/preopen-04-alerts-panel.png') })
      report.screenshots.push('docs/screenshots/preopen-04-alerts-panel.png')
    }

    /* ── 断言 1：相位 = 盘前 ── */
    failureStage = 'data'
    assertion('相位徽标 = 盘前', evidence.phase === '盘前', `phase="${evidence.phase}"；状态条="${evidence.statusMeta}"`)

    /* ── 断言 2：provider 时间 = 上一交易日 16:14 左右；数据年龄小时级；不冒充盘中 ── */
    const latestProvider = Object.entries(report.providerTimes)
      .map(([code, value]) => ({ code, ...value }))
      .sort((a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0))[0]
    if (!latestProvider) {
      assertion('provider 时间 = 上一交易日约 16:14', false, '未捕获到 push2/gtimg 响应时间戳（网络受限）')
      assertion('状态条最近报价 = provider 时间', false, '无 provider 时间戳可比对')
    } else {
      const providerClock = clockOfIso(latestProvider.timestamp)
      const statusClockMatch = /最近报价\s*(\d{2}:\d{2}:\d{2})/.exec(evidence.statusMeta)
      const statusClock = statusClockMatch?.[1]
      const isPreviousTradingDay = providerClock?.date === expectedDate
      const inExpectedWindow = providerClock ? providerClock.clock >= '15:00:00' && providerClock.clock <= '17:00:00' : false
      const notTodayMorning = providerClock ? !(providerClock.date === today && providerClock.clock >= '09:00:00' && providerClock.clock < '12:00:00') : false
      assertion(
        'provider 时间 = 上一交易日约 16:14（不是今天 09:xx）',
        Boolean(providerClock && isPreviousTradingDay && inExpectedWindow && notTodayMorning),
        `${latestProvider.code} ${latestProvider.raw} → ${providerClock ? `${providerClock.date} ${providerClock.clock}` : '无效'}（来源 ${latestProvider.source}；expectedDate=${expectedDate}；today=${today}）`,
      )
      let statusMatch = false
      if (providerClock && statusClock) {
        const toSeconds = (clock) => clock.split(':').reduce((acc, part, index) => acc + Number(part) * [3600, 60, 1][index], 0)
        statusMatch = Math.abs(toSeconds(statusClock) - toSeconds(providerClock.clock)) <= 120
      }
      assertion('状态条「最近报价」= provider 时间（±2 分钟）', statusMatch, `statusClock=${statusClock ?? '—'} vs provider=${providerClock?.clock ?? '—'}`)
    }
    const ageMatch = /数据年龄\s*(\d+)\s*小时前/.exec(evidence.statusMeta)
    const ageHours = ageMatch ? Number(ageMatch[1]) : null
    assertion('数据年龄为小时级（数小时）', Boolean(ageHours !== null && ageHours >= 1), `数据年龄=${ageMatch?.[0] ?? '未匹配'}；statusMeta="${evidence.statusMeta}"`)
    const liveTags = evidence.priceTags.filter((tag) => /盘中|竞价/.test(tag))
    assertion(
      '不把旧价标成「盘中」（价格标签无 盘中/竞价、无 live 标签）',
      evidence.liveTagCount === 0 && liveTags.length === 0 && evidence.bodyHasLiveClaim === false,
      `liveTagCount=${evidence.liveTagCount}；标签样本=${JSON.stringify(evidence.priceTags.slice(0, 6))}；liveClaimText=${evidence.bodyHasLiveClaim}`,
    )

    /* ── 断言 3：提醒面板为空且不报错 ── */
    failureStage = 'signals'
    assertion(
      '提醒面板为空（无 alert-item / toast）',
      evidence.alerts.length === 0 && evidence.toasts.length === 0,
      `alerts=${evidence.alerts.length}，toasts=${evidence.toasts.length}，panel="${evidence.alertPanelText.slice(0, 180)}"`,
    )
    // 无个人策略时面板显示「提醒只针对个人清单…」；有策略但非交易时段才显示「当前为盘前…」。两者都算完整的空状态说明。
    const emptyStateExplained = /(暂无盘中提醒|提醒暂停|提醒只针对个人清单)/.test(evidence.alertPanelText)
    assertion('提醒面板空状态文案完整（盘前/个人清单说明）', emptyStateExplained, evidence.alertPanelText.slice(0, 240))
    const nonNetworkConsoleErrors = report.consoleErrors.filter((text) => !/Failed to load resource|net::ERR_/.test(text))
    assertion(
      '无 UI 报错 / 无 pageerror',
      evidence.statusErrorCount === 0 && report.pageErrors.length === 0 && nonNetworkConsoleErrors.length === 0,
      `statusError=${evidence.statusErrorCount}；pageErrors=${report.pageErrors.length}；非网络 console=${nonNetworkConsoleErrors.length}`,
    )

    /* ── 断言 4：公开清单价格标签 = 盘前/收盘 ── */
    failureStage = 'ui'
    const badTags = evidence.priceTags.filter((tag) => tag !== '盘前' && tag !== '收盘')
    assertion(
      '公开清单价格标签 = 盘前/收盘（无 盘中）',
      evidence.priceTags.length > 0 && badTags.length === 0,
      `共 ${evidence.priceTags.length} 个标签；异常=${JSON.stringify(badTags)}；样本=${JSON.stringify(evidence.priceTags.slice(0, 6))}`,
    )
    assertion('公开清单条数 = 29', evidence.publicCount === 29, `publicCount=${evidence.publicCount}；heading="${evidence.publicHeading}"`)

    /* ── 断言 5：无 pageerror ── */
    assertion('无 pageerror（最终）', report.pageErrors.length === 0, report.pageErrors.join(' | ') || '0 条')

    const hardPass = report.assertions.every((item) => item.pass)
    report.conclusion = hardPass ? 'PASS' : 'FAIL'
    report.responsibility = hardPass
      ? null
      : evidence.phase !== '盘前'
        ? 'data（getMarketPhase 相位）/ ui（徽标）'
        : evidence.liveTagCount > 0 || badTags.length > 0
          ? 'ui（价格标签/文案）或 data（provider 时间戳）'
          : evidence.alerts.length > 0 || evidence.toasts.length > 0
            ? 'signals（盘前误报）'
            : 'ui/data（状态条/时间戳/页面错误）'
    process.exitCode = hardPass ? 0 : 1
  } catch (error) {
    report.conclusion = 'FAIL'
    report.responsibility = failureStage === 'signals' ? 'signals（提醒面板）' : failureStage === 'data' ? 'data（行情/时间戳）或 ui（状态条）' : 'ui（页面/交互）'
    report.error = String(error).slice(0, 800)
    assertion('盘前检查流程完成', false, report.error)
    console.error('preopen-check 失败：', error)
    process.exitCode = 1
  } finally {
    await context.close()
    await browser.close()
    report.finishedAt = new Date().toISOString()
    writeFileSync(join(OUT_DIR, 'preopen-evidence.json'), JSON.stringify(report, null, 2))
    writeMarkdown(checkedAtFallback(startedAt))
  }
}

function checkedAtFallback(startedAt) {
  return startedAt
}

function writeMarkdown(startedAt) {
  const lines = []
  const latestProvider = Object.entries(report.providerTimes)
    .map(([code, value]) => ({ code, ...value }))
    .sort((a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0))[0]
  lines.push('# 盘前态真实时钟检查（不冒充实时、不误报）', '')
  lines.push(`- 运行时间：${beijingDate(startedAt)} ${beijingClock(startedAt)}（Asia/Shanghai，真实时钟，无固定时钟/mock）`)
  lines.push(`- 页面：${report.base}（独立 browser context，未注入清单/mock）`)
  lines.push(`- 结论：**${report.conclusion}**${report.responsibility ? `；责任域：${report.responsibility}` : ''}`)
  lines.push('', '## 断言', '', '| 断言 | 结果 | 证据 |', '| --- | --- | --- |')
  for (const item of report.assertions) {
    lines.push(`| ${item.name} | ${item.pass ? '✅ PASS' : '❌ FAIL'} | ${String(item.detail).replace(/\|/g, '\\|').slice(0, 500)} |`)
  }
  lines.push('', '## 证据（页面读数）', '')
  const e = report.evidence ?? {}
  lines.push(`- 相位：${e.phase ?? '—'}`)
  lines.push(`- 状态条：${e.statusMeta ?? '—'}`)
  lines.push(`- 价格标签（前 6）：${JSON.stringify((e.priceTags ?? []).slice(0, 6))}（共 ${e.priceTags?.length ?? 0} 个；live=${e.liveTagCount ?? '—'}，stale=${e.staleTagCount ?? '—'}）`)
  lines.push(`- 公开清单：${e.publicCount ?? '—'} 只；标题「${e.publicHeading ?? '—'}」`)
  lines.push(`- 提醒面板：alerts=${e.alerts?.length ?? '—'}，toasts=${e.toasts?.length ?? '—'}；"${(e.alertPanelText ?? '').slice(0, 220)}"`)
  lines.push('', '## provider 时间戳（从真实网络响应解析）', '')
  if (latestProvider) {
    const clock = clockOfIso(latestProvider.timestamp)
    lines.push(`- 最新：${latestProvider.code} = ${latestProvider.raw} → ${clock ? `${clock.date} ${clock.clock}` : '无效'}（${latestProvider.source}）`)
    for (const [code, value] of Object.entries(report.providerTimes).slice(0, 5)) {
      const c = clockOfIso(value.timestamp)
      lines.push(`  - ${code}: ${value.raw} → ${c ? `${c.date} ${c.clock}` : '无效'}`)
    }
    lines.push(`- 共 ${Object.keys(report.providerTimes).length} 只；provider 日期应为上一交易日（非今天 09:xx）。`)
  } else {
    lines.push('- 未捕获到 provider 时间戳（网络受限），已回退状态条时间/数据年龄。')
  }
  lines.push('', '## 截图', '')
  for (const shot of report.screenshots) lines.push(`- \`${shot}\``)
  lines.push('', '## 复现命令', '', '```bash', 'cd kate-dashboard', 'PATH=/opt/homebrew/bin:$PATH \\', 'PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \\', 'PLAYWRIGHT_MODULE=/tmp/pw-tools/node_modules/playwright \\', 'node scripts/preopen-check.mjs', '```', '')
  if (report.consoleErrors.length) {
    lines.push('## console 错误（前 10 条；网络类如 ERR_EMPTY_RESPONSE 属反爬预期，仅记录）', '')
    for (const error of report.consoleErrors.slice(0, 10)) lines.push(`- ${error}`)
    lines.push('')
  }
  if (report.error) lines.push('## 失败堆栈', '', '```', report.error, '```', '')
  lines.push('', '## 环境说明（非缺陷）', '')
  lines.push('- headless Chromium 的 Notification 权限默认为 denied，面板显示「通知被浏览器拒绝」属环境状态，不是报错；真实浏览器默认通常为「开启浏览器通知」。')
  lines.push('- console 的 `ERR_EMPTY_RESPONSE` 来自东财 push2 反爬（本机已知），报价由腾讯 gtimg 回退成功；脚本只对 pageerror / UI 错误判失败，网络类 console 仅记录。')
  lines.push('', '## 责任域判定口径', '')
  lines.push('- 相位错误 → **data**（getMarketPhase）/ **ui**（徽标渲染）。')
  lines.push('- provider 时间/数据年龄/状态条时间错误 → **data**（live.ts 时间戳）或 **ui**（状态条展示）。')
  lines.push('- 旧价被标「盘中」→ **ui**（价格标签）或 **data**（phase/时间戳传递）。')
  lines.push('- 盘前出现提醒/通知 → **signals**（alerts 时段过滤）。')
  lines.push('- pageerror/UI 报错 → **ui**（组件）或 **data**（行情异常）。')
  writeFileSync(DOC_PATH, lines.join('\n'))
}

main().catch((error) => {
  console.error('preopen-check 启动失败：', error)
  process.exit(1)
})
