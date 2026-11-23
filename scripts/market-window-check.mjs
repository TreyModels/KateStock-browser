#!/usr/bin/env node
/**
 * 实弹验收脚本（09:30 交易时段用）—— qa-verifier
 *
 * 目的：开盘后用**真实时钟 + 真实行情源**做一次 120 秒采样，验证「盘中价格可见且带时间戳 /
 * 报价确实在更新 / 相位正确 / 无页面错误 / 提醒是否自然命中」，并输出报告与截图。
 *
 * 用法：
 *   cd kate-dashboard
 *   PATH=/opt/homebrew/bin:$PATH \
 *   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
 *   PLAYWRIGHT_MODULE=/tmp/pw-tools/node_modules/playwright \
 *   node scripts/market-window-check.mjs
 *
 *   # 仅探测数据源（不启动浏览器，任何时间可跑）：
 *   node scripts/market-window-check.mjs --node-probe
 *
 * 退出码：
 *   0 = PASS（硬断言通过，且窗口内自然出现提醒）
 *   1 = FAIL（硬断言失败 / 脚本环境错误）
 *   2 = 非交易时段（北京时间周一至周五 09:15-11:30 / 13:00-15:00 之外；不开浏览器）
 *   3 = PENDING（硬断言通过，但窗口内没有自然提醒 —— 不判失败）
 *
 * 写作用域：scripts/**、docs/**、tests/acceptance/**；**不修改应用代码**。
 * 输出：docs/market-window-report.md + docs/screenshots/market-window-*.png（截图已 gitignore）。
 *
 * 说明与已知偏离（详见 docs/market-window.md）：
 * - 种子按 Lead 要求：159558 = watch，600519 = holding + shares>0。
 * - 但 600519 不在 public-universe.json 的 29 只里，快照没有它的 bars；为让持仓策略卡有真实价位，
 *   脚本在启动时用腾讯 fqkline（真实日线，非 mock）拉一次 600519 日线并注入 localStorage；
 *   拉取失败则降级（无该卡，报告中标注）。159558 的 bars 来自公开快照。
 */

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'screenshots')
mkdirSync(OUT_DIR, { recursive: true })
const REPORT_PATH = join(ROOT, 'docs', 'market-window-report.md')
const SAMPLES_PATH = join(OUT_DIR, 'market-window-samples.json')
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const SNAPSHOT_PATH = join(ROOT, 'public', 'data', 'latest.json')

const WATCH_CODE = process.env.WATCH_CODE || '159558'
const HOLDING_CODE = process.env.HOLDING_CODE || '600519'
const SESSION_SAMPLES_MS = [0, 45_000, 120_000] // t0 / +45s / +120s

/* ───────────────────────── 北京时间 / 交易窗口 ───────────────────────── */

const beijingPartsFormatter = new Intl.DateTimeFormat('en-GB', {
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
  const parts = beijingPartsFormatter.formatToParts(date)
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
const pad2 = (n) => String(n).padStart(2, '0')
function beijingDate(date = new Date()) {
  const p = beijingParts(date)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}
function beijingClock(date = new Date()) {
  const p = beijingParts(date)
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`
}
function minutesOfDay(date = new Date()) {
  const p = beijingParts(date)
  return p.hour * 60 + p.minute + p.second / 60
}
/** 交易窗口：周一至周五 09:15-11:30 / 13:00-15:00（北京时间）。 */
function inTradingWindow(date = new Date()) {
  const p = beijingParts(date)
  if (p.weekday === 0 || p.weekday === 6) return false
  const m = p.hour * 60 + p.minute + p.second / 60
  return (m >= 9 * 60 + 15 && m < 11 * 60 + 30) || (m >= 13 * 60 && m < 15 * 60)
}
function phaseNow(date = new Date()) {
  const p = beijingParts(date)
  if (p.weekday === 0 || p.weekday === 6) return 'non-trading'
  const m = p.hour * 60 + p.minute + p.second / 60
  if (m < 9 * 60 + 15) return 'preopen'
  if (m < 9 * 60 + 25) return 'auction'
  if (m < 9 * 60 + 30) return 'preopen'
  if (m < 11 * 60 + 30) return 'trading'
  if (m < 13 * 60) return 'lunch'
  if (m < 15 * 60) return 'trading'
  return 'closed'
}
function timeInSession(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike)
  if (Number.isNaN(d.getTime())) return { valid: false }
  const p = beijingParts(d)
  const minutes = p.hour * 60 + p.minute + p.second / 60
  const inSession = (minutes >= 9 * 60 + 15 && minutes < 11 * 60 + 30) || (minutes >= 13 * 60 && minutes < 15 * 60)
  return { valid: true, date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`, clock: `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`, inSession }
}

/* ───────────────────────── 通用工具 ───────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchBuffer(url, { timeout = 12_000, headers = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 KateStock/2.1 qa-market-window', ...headers },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}
function decodeGbk(buffer) {
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return buffer.toString('latin1')
  }
}
function tencentSymbol(code) {
  if (/^[569]/.test(code)) return `sh${code}`
  if (/^[48]/.test(code)) return `bj${code}`
  return `sz${code}`
}
function parseTencentTimestamp(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value || '').trim())
  if (!match) return undefined
  const [, y, mo, d, h, mi, s] = match.map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, s))
}
function parseTencentQuotes(text) {
  const quotes = {}
  const regex = /\bv_([a-z]{2}\d{6})\s*=\s*"([^"]*)"/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const symbol = match[1]
    const fields = match[2].split('~')
    if (fields.length < 38) continue
    const code = symbol.slice(2)
    quotes[code] = {
      code,
      symbol,
      name: fields[1],
      price: Number(fields[3]),
      prevClose: Number(fields[4]),
      timestampRaw: fields[30],
      timestamp: parseTencentTimestamp(fields[30]),
      changePct: Number(fields[32]),
      high: Number(fields[33]),
      low: Number(fields[34]),
    }
  }
  return quotes
}

/* ───────────────────────── 种子行情（真实数据，非 mock） ───────────────────────── */

function quoteFromSnapshot(snapshot, code) {
  const q = snapshot?.quotes?.[code]
  if (!q || !Array.isArray(q.bars) || q.bars.length < 2) return undefined
  return q
}

async function fetchTencentDailyQuote(code) {
  const symbol = tencentSymbol(code)
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,160,qfq`
  const text = await fetchBuffer(url).then(decodeGbk)
  const payload = JSON.parse(text)
  const node = payload?.data?.[symbol]
  const rows = node?.qfqday || node?.day
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('fqkline 无有效日线')
  const bars = []
  let previousClose
  for (const row of rows) {
    const [date, open, close, high, low, volume] = row
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const bar = {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: 0,
      changePct: previousClose ? (Number(close) / previousClose - 1) * 100 : 0,
      turnoverPct: 0,
    }
    if (![bar.open, bar.close, bar.high, bar.low, bar.volume].every(Number.isFinite)) continue
    if (bar.close <= 0 || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) continue
    bars.push(bar)
    previousClose = bar.close
  }
  if (bars.length < 2) throw new Error('fqkline 有效 bar 不足')
  const bars160 = bars.slice(-160)
  const latest = bars160.at(-1)
  const previous = bars160.at(-2)
  return {
    quote: {
      code,
      price: latest.close,
      prevClose: previous.close,
      changePct: latest.changePct,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      volume: latest.volume,
      amount: 0,
      tradeDate: latest.date,
      fetchedAt: new Date().toISOString(),
      source: 'auto',
      provider: 'tencent',
      adjustment: '前复权',
      bars: bars160,
    },
    meta: { source: 'tencent fqkline', bars: bars160.length, tradeDate: latest.date },
  }
}

/* ───────────────────────── --node-probe ───────────────────────── */

async function nodeProbe() {
  const now = new Date()
  const trading = inTradingWindow(now)
  console.log('=== market-window --node-probe ===')
  console.log(`北京时间: ${beijingDate(now)} ${beijingClock(now)}（${phaseNow(now)}）`)
  console.log(`交易窗口: ${trading ? '是（允许跑主脚本）' : '否（主脚本会 exit 2）'}`)
  const codes = ['600519', '159558']
  const results = { gtimg: false, fqkline: false, eastmoneyKline: false }

  console.log('\n--- 腾讯 qt.gtimg.cn 实时报价 ---')
  try {
    const raw = await fetchBuffer(`https://qt.gtimg.cn/q=${codes.map(tencentSymbol).join(',')}`, {
      headers: { Referer: 'https://gu.qq.com/' },
    }).then(decodeGbk)
    results.gtimg = true
    console.log('原始片段:', JSON.stringify(raw.slice(0, 220)))
    const quotes = parseTencentQuotes(raw)
    for (const code of codes) {
      const q = quotes[code]
      if (!q) {
        console.log(`  ${code}: 未解析到`)
        continue
      }
      const t = timeInSession(q.timestamp)
      console.log(
        `  ${code} ${q.name}: price=${q.price} time=${q.timestampRaw} (${t.valid ? `${t.date} ${t.clock}` : '无有效时间'}) → ${t.valid && t.date === beijingDate(now) && t.inSession ? '今天交易时段' : '旧时间戳/非交易时段'}`,
      )
    }
  } catch (error) {
    console.log('  失败:', error.message)
  }

  console.log('\n--- 腾讯 fqkline 日线（前复权） ---')
  for (const code of codes) {
    try {
      const symbol = tencentSymbol(code)
      const raw = await fetchBuffer(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,5,qfq`).then(decodeGbk)
      results.fqkline = true
      const payload = JSON.parse(raw)
      const rows = payload?.data?.[symbol]?.qfqday || payload?.data?.[symbol]?.day || []
      const last = rows.at(-1)
      const t = last ? timeInSession(new Date(`${last[0]}T10:00:00+08:00`)) : { valid: false }
      console.log(
        `  ${code}: ${last ? `last=${last[0]} open=${last[1]} close=${last[2]} high=${last[3]} low=${last[4]} vol=${last[5]}` : '无数据'} → ${last && last[0] === beijingDate(now) ? '含今天 bar' : '最后 bar 为旧日期'}`,
      )
      console.log('  原始片段:', JSON.stringify(raw.slice(0, 200)), t.valid ? '' : '')
    } catch (error) {
      console.log(`  ${code}: 失败 ${error.message}`)
    }
  }

  console.log('\n--- 东财 push2his kline（klt=101 / fqt=1） ---')
  try {
    const code = '600519'
    const beg = '20260901'
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.${code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=${beg}&end=20500101`
    const raw = await fetchBuffer(url).then((b) => b.toString('utf8'))
    results.eastmoneyKline = true
    const payload = JSON.parse(raw)
    const lines = payload?.data?.klines || []
    const last = lines.at(-1)
    console.log(`  ${code}: ${last ? `last=${last.split(',').slice(0, 6).join(',')}` : '无数据'} → ${last && last.startsWith(beijingDate(now)) ? '含今天 bar' : '最后 bar 为旧日期'}`)
    console.log('  原始片段:', JSON.stringify(raw.slice(0, 200)))
  } catch (error) {
    console.log('  失败:', error.message)
  }

  console.log('\n结论:', trading ? '当前在交易窗口内' : '当前为非交易时段：上述三源返回旧时间戳/上一交易日数据属预期')
  const anyOk = results.gtimg || results.fqkline || results.eastmoneyKline
  process.exitCode = anyOk ? 0 : 1
}

/* ───────────────────────── 主流程 ───────────────────────── */

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const modulePath = process.env.PLAYWRIGHT_MODULE || '/tmp/pw-tools/node_modules/playwright'
  try {
    return require(modulePath)
  } catch (error) {
    throw new Error(`无法加载 Playwright（${modulePath}）：${error.message}。请先按 docs/market-window.md 装到 /tmp。`)
  }
}

function seedScript({ storageKey, seedJson }) {
  try {
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, seedJson)
  } catch {
    /* ignore */
  }
}

async function samplePage(page) {
  return page.evaluate(() => {
    const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
    const number = (value) => {
      const parsed = Number(String(value ?? '').replace(/[^0-9.+-]/g, ''))
      return Number.isFinite(parsed) ? parsed : undefined
    }
    const cards = [...document.querySelectorAll('.strategy-card')].map((card) => {
      const levels = {}
      for (const item of card.querySelectorAll('.level-item')) {
        levels[norm(item.querySelector('.level-label')?.textContent)] = norm(item.querySelector('strong')?.textContent)
      }
      return {
        name: norm(card.querySelector('h3')?.textContent),
        code: norm(card.querySelector('.code-label')?.textContent),
        price: norm(card.querySelector('.live-price-number')?.textContent),
        priceNumber: number(card.querySelector('.live-price-number')?.textContent),
        tag: norm(card.querySelector('.price-tag')?.textContent),
        trigger: levels['触发'],
        stop: levels['保护'],
        target: levels['目标'],
        hit: norm(card.querySelector('.strategy-hit-banner')?.textContent) || null,
        quoteLine: norm([...card.querySelectorAll('div')].at(-1)?.textContent).slice(0, 160),
      }
    })
    const publicStocks = [...document.querySelectorAll('.public-stock')].slice(0, 3).map((item) => ({
      name: norm(item.querySelector('strong')?.textContent),
      code: norm(item.querySelector('small')?.textContent) || (/^\d{6}$/.test(norm(item.querySelector('strong')?.textContent)) ? norm(item.querySelector('strong')?.textContent) : ''),
      price: norm(item.querySelector('.live-price-number')?.textContent),
      priceNumber: number(item.querySelector('.live-price-number')?.textContent),
      change: norm(item.querySelector('.live-price-change')?.textContent),
      tag: norm(item.querySelector('.price-tag')?.textContent),
    }))
    const alerts = [...document.querySelectorAll('.alert-item')].map((item) => norm(item.innerText)).slice(0, 10)
    const toasts = [...document.querySelectorAll('[data-sonner-toast]')].map((item) => norm(item.innerText)).slice(0, 10)
    return {
      sampledAt: new Date().toISOString(),
      phase: norm(document.querySelector('.phase-badge')?.textContent),
      statusMeta: norm(document.querySelector('.market-status-meta')?.textContent),
      statusFull: norm(document.querySelector('.market-status')?.innerText).slice(0, 700),
      cards,
      publicStocks,
      alerts,
      toasts,
      alertPanelText: norm(document.querySelector('.live-alerts-panel')?.innerText).slice(0, 500),
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    }
  })
}

function parseStatusClock(statusMeta) {
  const match = /最近报价\s*(\d{2}:\d{2}:\d{2})/.exec(statusMeta || '')
  return match?.[1]
}

function buildReport({ now, seedInfo, samples, providerTimes, consoleErrors, failedRequests, pageErrors, assertions, conclusion, exitCode, screenshots }) {
  const lines = []
  lines.push('# 交易窗口实弹验收报告（market-window-check）', '')
  lines.push(`- 运行时间：${beijingDate(now)} ${beijingClock(now)}（北京时间）；相位：${phaseNow(now)}`)
  lines.push(`- 页面：${BASE_URL}（真实时钟，未 mock 行情）`)
  lines.push(`- 种子：watch=${WATCH_CODE}；holding=${HOLDING_CODE}（shares>0）`)
  lines.push(`- 退出码：**${exitCode}**（${conclusion}）`, '')
  lines.push('## 种子行情（真实数据）', '')
  lines.push(`- ${WATCH_CODE}：${seedInfo.watch}`)
  lines.push(`- ${HOLDING_CODE}：${seedInfo.holding}`)
  if (seedInfo.warnings.length) {
    lines.push('', '⚠️ 说明：')
    for (const warning of seedInfo.warnings) lines.push(`- ${warning}`)
  }
  lines.push('', '## 采样', '')
  lines.push('| # | 相对时刻 | 相位 | 状态条（最近报价/年龄/成功失败订阅） | 策略卡（代码:现价/触发/保护/目标） | 公开前3 | 提醒 | console网络错误 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  samples.forEach((sample, index) => {
    const cards = sample.data.cards.map((card) => `${card.code}:${card.price}/${card.trigger ?? '—'}/${card.stop ?? '—'}/${card.target ?? '—'}${card.hit ? `〔${card.hit}〕` : ''}`).join('；') || '（无卡片）'
    const publics = sample.data.publicStocks.map((item) => `${item.code}:${item.price}(${item.tag})`).join('；')
    const alerts = sample.data.alerts.length ? sample.data.alerts.join(' / ') : '无'
    lines.push(
      `| ${index + 1} | t+${Math.round((sample.at - samples[0].at) / 1000)}s | ${sample.data.phase} | ${sample.data.statusMeta} | ${cards} | ${publics} | ${alerts} | console=${sample.consoleErrorsAtSample} / failedReq=${sample.failedRequestsAtSample} |`,
    )
  })
  const latestProvider = Object.entries(providerTimes)
    .map(([code, value]) => ({ code, ...value }))
    .sort((a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0))[0]
  lines.push('', '## 数据源时间戳（从真实响应解析）', '')
  if (latestProvider) {
    const t = timeInSession(latestProvider.timestamp)
    lines.push(
      `- 最新 provider 时间戳：${latestProvider.code} = ${latestProvider.raw}（${t.valid ? `${t.date} ${t.clock}` : '无法解析'}；来源 ${latestProvider.source}）`,
    )
    for (const [code, value] of Object.entries(providerTimes).slice(0, 6)) {
      const ts = timeInSession(value.timestamp)
      lines.push(`  - ${code}: ${value.raw} → ${ts.valid ? `${ts.date} ${ts.clock}${ts.inSession ? '（交易时段）' : '（非交易时段）'}` : '无效'}`)
    }
    const providerCount = Object.keys(providerTimes).length
    if (providerCount > 6) lines.push(`  - …共 ${providerCount} 只，原始数据见 samples json`)
  } else {
    lines.push('- 未捕获到 provider 时间戳（push2/gtimg 可能被拦截）；回退使用状态条时间与数据年龄。', '')
  }
  lines.push('', '## 硬断言', '')
  for (const assertion of assertions) {
    const mark = assertion.pass === null ? '⏳' : assertion.pass ? '✅' : '❌'
    lines.push(`- ${mark} ${assertion.name}：${assertion.detail}`)
  }
  lines.push('', '## 结论', '')
  lines.push(`**${conclusion}**（退出码 ${exitCode}）`)
  lines.push('', `- 截图：${screenshots.map((item) => `\`${item}\``).join('、')}`)
  lines.push(`- 原始采样：\`${SAMPLES_PATH.replace(`${ROOT}/`, '')}\`（已 gitignore）`)
  if (pageErrors.length) lines.push('', '## pageerror', '', ...pageErrors.map((item) => `- ${item}`))
  if (consoleErrors.length) {
    lines.push('', '## console 错误（前 10 条；仅记录）', '', ...consoleErrors.slice(0, 10).map((item) => `- ${item}`))
  }
  if (failedRequests.length) {
    lines.push('', '## 网络失败请求（前 10 条；仅记录）', '', ...failedRequests.slice(0, 10).map((item) => `- ${item}`))
  }
  lines.push('')
  writeFileSync(REPORT_PATH, lines.join('\n'))
}

function exitWith(code, message) {
  console.log(message)
  process.exit(code)
}

async function main() {
  const now = new Date()
  if (!inTradingWindow(now)) {
    exitWith(2, `非交易时段：北京时间 ${beijingDate(now)} ${beijingClock(now)}（${phaseNow(now)}）。交易窗口为周一至周五 09:15-11:30 / 13:00-15:00；按设计不启动浏览器、exit 2。`)
  }

  const { chromium } = loadPlaywright()
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
  const seedWarnings = []
  const stocks = []
  const quotes = {}

  // watch：优先公开快照（真实 bars）
  const watchSnapshotQuote = quoteFromSnapshot(snapshot, WATCH_CODE)
  if (watchSnapshotQuote) quotes[WATCH_CODE] = watchSnapshotQuote
  else seedWarnings.push(`${WATCH_CODE} 不在公开快照中：无 bars，策略卡可能缺失。`)
  stocks.push({ id: `seed-watch-${WATCH_CODE}`, code: WATCH_CODE, name: `实弹自选-${WATCH_CODE}`, status: 'watch', createdAt: new Date().toISOString() })

  // holding：快照优先；600519 不在 29 只里 → 用腾讯 fqkline 拉真实日线（非 mock）
  let holdingQuote = quoteFromSnapshot(snapshot, HOLDING_CODE)
  let holdingSource = holdingQuote ? '公开快照 bars（真实）' : '（无）'
  if (!holdingQuote) {
    try {
      const fetched = await fetchTencentDailyQuote(HOLDING_CODE)
      holdingQuote = fetched.quote
      holdingSource = `${fetched.meta.source}（真实日线，bars=${fetched.meta.bars}，tradeDate=${fetched.meta.tradeDate}）`
      seedWarnings.push(`${HOLDING_CODE} 不在 public-universe.json 的 29 只里、快照无 bars；已用腾讯 fqkline 真实日线注入（不是 mock），否则持仓卡无价位。`)
      if (fetched.meta.tradeDate !== beijingDate(now)) {
        seedWarnings.push(`${HOLDING_CODE} fqkline 最后 bar = ${fetched.meta.tradeDate}（非今天）：持仓卡价位基于该交易日 EOD；若期望含当日盘中 bar，请确认腾讯 fqkline 在盘中是否返回今日数据。`)
      }
    } catch (error) {
      seedWarnings.push(`${HOLDING_CODE} 无快照 bars 且 fqkline 拉取失败（${error.message}）：持仓策略卡可能缺失。`)
    }
  }
  let holdingCost = 0
  if (holdingQuote) {
    quotes[HOLDING_CODE] = holdingQuote
    holdingCost = Math.round(holdingQuote.price * 0.85 * 100) / 100
  }
  stocks.push({
    id: `seed-holding-${HOLDING_CODE}`,
    code: HOLDING_CODE,
    name: `实弹持仓-${HOLDING_CODE}`,
    status: 'holding',
    shares: 100,
    cost: holdingCost || undefined,
    createdAt: new Date().toISOString(),
  })
  const seed = { stocks, quotes, settings: { capital: 200000, riskPct: 0.8, maxPositionPct: 12, refreshOnOpen: true } }

  const storageKey = 'ashare-daily-strategy-v1'
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
  })
  await context.addInitScript(seedScript, { storageKey, seedJson: JSON.stringify(seed) })
  const page = await context.newPage()

  const consoleErrors = []
  const failedRequests = []
  const pageErrors = []
  const providerTimes = {}

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300))
  })
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 500)))
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url().slice(0, 160)} :: ${request.failure()?.errorText ?? ''}`)
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
          const timestamp = new Date(seconds * 1000)
          providerTimes[code] = { raw: `${seconds}`, timestamp, source: 'eastmoney f124' }
        }
      } else if (url.includes('qt.gtimg.cn')) {
        const text = await response.text()
        for (const [code, quote] of Object.entries(parseTencentQuotes(text))) {
          if (quote.timestamp) providerTimes[code] = { raw: quote.timestampRaw, timestamp: quote.timestamp, source: 'tencent field30' }
        }
      }
    } catch {
      /* 响应解析失败：忽略（不伪造时间戳） */
    }
  })

  const interactive = process.stdout.isTTY
  const log = (msg) => console.log(msg)
  const ready = async () => {
    await page.waitForSelector('.market-status', { timeout: 25_000 })
    await page.waitForFunction(() => document.querySelectorAll('.public-stock').length > 0, { timeout: 25_000 })
    await page.waitForFunction(() => /成功|失败|订阅/.test(document.querySelector('.market-status-meta')?.textContent ?? ''), { timeout: 25_000 }).catch(() => undefined)
    await page.waitForFunction(() => document.querySelectorAll('.strategy-card').length >= 1, { timeout: 15_000 }).catch(() => undefined)
    await sleep(1500)
  }

  log(`交易窗口确认：${beijingDate(now)} ${beijingClock(now)}（${phaseNow(now)}）；打开 ${BASE_URL}`)
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await ready()
  // Lead 要求 reload 一次，让策略卡在快照合并后生成价位
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ready()
  log(`页面就绪；策略卡=${await page.locator('.strategy-card').count()}，公开卡=${await page.locator('.public-stock').count()}`)

  const samples = []
  const screenshots = []
  const startedAt = Date.now()
  for (let index = 0; index < SESSION_SAMPLES_MS.length; index += 1) {
    const target = SESSION_SAMPLES_MS[index]
    const wait = target - (Date.now() - startedAt)
    if (wait > 0) await sleep(wait)
    const data = await samplePage(page)
    const shot = `docs/screenshots/market-window-t${index}.png`
    try {
      await page.screenshot({ path: join(ROOT, shot), fullPage: true })
      screenshots.push(shot)
    } catch (error) {
      log(`截图失败（不影响采样/断言）：${error.message}`)
    }
    samples.push({
      at: Date.now(),
      data,
      consoleErrorsAtSample: consoleErrors.length,
      failedRequestsAtSample: failedRequests.length,
    })
    const relative = Math.round((Date.now() - startedAt) / 1000)
    log(
      `t+${relative}s: 相位=${data.phase} | ${data.statusMeta} | 卡片=${data.cards.length} | 提醒=${data.alerts.length} | consoleErr=${consoleErrors.length} failedReq=${failedRequests.length}`,
    )
  }

  await context.close()
  await browser.close()

  /* ── 硬断言 ── */
  const assertions = []
  const latestProvider = Object.entries(providerTimes)
    .map(([code, value]) => ({ code, ...value }))
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]

  let quoteEvidence
  if (latestProvider) {
    const t = timeInSession(latestProvider.timestamp)
    const today = beijingDate(now)
    const pass = t.valid && t.date === today && t.inSession
    quoteEvidence = `${latestProvider.code} provider=${t.valid ? `${t.date} ${t.clock}` : latestProvider.raw}（${latestProvider.source}）`
    assertions.push({ name: '报价日期=今天且时间在交易时段', pass, detail: quoteEvidence })
  } else {
    // 回退：状态条最近报价 + 数据年龄
    const lastSample = samples.at(-1)
    const clock = parseStatusClock(lastSample?.data.statusMeta)
    const fresh = /数据年龄\s*(刚刚|\d+\s*秒前)/.test(lastSample?.data.statusMeta ?? '')
    const t = clock ? timeInSession(new Date(`${beijingDate(now)}T${clock}+08:00`)) : { valid: false }
    quoteEvidence = `无 provider 时间戳响应（push2/gtimg 被拦）；状态条最近报价=${clock ?? '—'}，fresh=${fresh}`
    assertions.push({ name: '报价日期=今天且时间在交易时段', pass: Boolean(t.valid && t.inSession && fresh), detail: `${quoteEvidence}（降级证据）` })
  }

  const priceSeries = samples.map((sample) => {
    const values = []
    for (const card of sample.data.cards) if (card.priceNumber !== undefined) values.push(card.priceNumber)
    for (const stock of sample.data.publicStocks) if (stock.priceNumber !== undefined) values.push(stock.priceNumber)
    return values
  })
  const clocks = samples.map((sample) => parseStatusClock(sample.data.statusMeta)).filter(Boolean)
  let priceChanged = false
  for (let i = 1; i < priceSeries.length; i += 1) {
    const a = priceSeries[0]
    const b = priceSeries[i]
    for (let j = 0; j < Math.min(a.length, b.length); j += 1) if (a[j] !== b[j]) priceChanged = true
  }
  const clockAdvanced = clocks.length >= 2 && new Set(clocks).size > 1
  assertions.push({
    name: '至少 1 只价格变化或最近报价时间前进',
    pass: priceChanged || clockAdvanced,
    detail: `价格变化=${priceChanged}；最近报价时钟序列=${clocks.join(' → ') || '—'}；前进=${clockAdvanced}`,
  })

  const phases = samples.map((sample) => sample.data.phase)
  const phasePass = phases.every((phase) => phase === '交易中' || phase === '集合竞价')
  assertions.push({ name: '相位=交易中/竞价', pass: phasePass, detail: `采样相位=${phases.join(' / ')}` })

  const alertsSeen = samples.some((sample) => sample.data.alerts.length > 0 || sample.data.toasts.length > 0)
  assertions.push({ name: '无 pageerror', pass: pageErrors.length === 0, detail: pageErrors.length ? pageErrors.join(' | ') : '0 条' })
  assertions.push({
    name: '提醒（出现=PASS；未出现=PENDING）',
    pass: alertsSeen ? true : null,
    detail: alertsSeen
      ? `窗口内自然触发：${samples.flatMap((s) => [...s.data.alerts, ...s.data.toasts]).slice(0, 3).join(' / ')}`
      : '窗口内未自然触发（按约定记为 PENDING，不判失败）',
  })

  const hardPass = assertions.every((assertion) => assertion.pass !== false)
  const exitCode = hardPass ? (alertsSeen ? 0 : 3) : 1
  const conclusion = hardPass
    ? alertsSeen
      ? 'PASS：真实行情在更新、相位/时间戳正确，且窗口内自然触发了提醒'
      : 'PENDING：真实行情在更新、相位/时间戳正确，但窗口内未自然触发提醒（按约定不判失败）'
    : 'FAIL：硬断言未通过'

  const seedInfo = {
    watch: watchSnapshotQuote ? '公开快照 bars（真实，tradeDate=' + watchSnapshotQuote.tradeDate + '）' : '快照无 bars（降级）',
    holding: holdingSource,
    warnings: seedWarnings,
  }
  buildReport({
    now,
    seedInfo,
    samples,
    providerTimes,
    consoleErrors,
    failedRequests,
    pageErrors,
    assertions,
    conclusion,
    exitCode,
    screenshots,
  })
  writeFileSync(
    SAMPLES_PATH,
    JSON.stringify({ now: now.toISOString(), seedInfo, samples, providerTimes, assertions, consoleErrors, failedRequests, pageErrors, exitCode }, null, 2),
  )

  if (interactive) log('')
  log(`报告：${REPORT_PATH.replace(`${ROOT}/`, '')}`)
  log(`截图：${screenshots.join('、')}`)
  log(`结论：${conclusion}（exit ${exitCode}）`)
  process.exit(exitCode)
}

/* ───────────────────────── CLI ───────────────────────── */

const args = new Set(process.argv.slice(2))
if (args.has('--help') || args.has('-h')) {
  console.log('用法：node scripts/market-window-check.mjs [--node-probe]')
  console.log('退出码：0=PASS 1=FAIL 2=非交易时段 3=PENDING（硬断言通过但未自然触发提醒）')
  process.exit(0)
}
if (args.has('--node-probe')) {
  nodeProbe().catch((error) => {
    console.error('probe 失败：', error)
    process.exit(1)
  })
} else {
  main().catch((error) => {
    console.error('market-window-check 失败：', error)
    process.exit(1)
  })
}
