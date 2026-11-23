#!/usr/bin/env node
/**
 * 可视化验收截图（qa-verifier）：桌面/移动端布局 + 盘中标签最坏情况。
 *
 * 依赖（刻意放在 /tmp，避免污染仓库）：
 *   mkdir -p /tmp/pw-tools && cd /tmp/pw-tools
 *   PATH=/opt/homebrew/bin:$PATH npm init -y
 *   PATH=/opt/homebrew/bin:$PATH npm_config_cache=/tmp/npm-cache npm install playwright
 *   PATH=/opt/homebrew/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium
 *
 * 运行（需 dev server 在 http://localhost:3000，且存在 public/data/latest.json）：
 *   cd kate-dashboard
 *   PATH=/opt/homebrew/bin:$PATH \
 *   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
 *   PLAYWRIGHT_MODULE=/tmp/pw-tools/node_modules/playwright \
 *   node scripts/screenshots.mjs
 *
 * 说明：
 * - 不修改应用代码；localStorage 只注入「测试持仓/自选」种子，让策略卡渲染出来。
 * - 用 addInitScript 固定 Date（不动 setTimeout），分别模拟「闭市 15:50」与「交易中 10:00」。
 * - 交易场景用 Playwright route 提供「新鲜 push2 报价」；随后让主源失败，得到「上次报价」标签。
 * - 输出：docs/screenshots/*.png + docs/screenshots/measurements.json（截图可 gitignore）。
 */

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'screenshots')
mkdirSync(OUT_DIR, { recursive: true })

const require = createRequire(import.meta.url)
const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE || '/tmp/pw-tools/node_modules/playwright'
const { chromium } = require(PLAYWRIGHT_MODULE)

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const SNAPSHOT_PATH = join(ROOT, 'public', 'data', 'latest.json')

const CLOSED_ISO = '2026-11-24T15:50:00+08:00' // 已收盘（周二 15:50）
const TRADING_ISO = '2026-11-24T10:00:00+08:00' // 交易中（周二 10:00）

const STORAGE_KEY = 'ashare-daily-strategy-v1'
const SEED_DATA = {
  // 159558 在公开快照里是 pullback（有触发/保护/目标），用来展示策略卡与「持仓」徽标
  stocks: [
    { id: 'seed-159558', code: '159558', name: '测试持仓', status: 'holding', shares: 100, cost: 0.7, createdAt: '2026-11-20T00:00:00Z' },
    { id: 'seed-600110', code: '600110', name: '测试自选', status: 'watch', createdAt: '2026-11-20T00:00:00Z' },
  ],
  quotes: {},
  settings: { capital: 200000, riskPct: 0.8, maxPositionPct: 12, refreshOnOpen: true },
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
const results = []
const consoleProblems = []

function addInitScripts(context, { fixedIso }) {
  return context.addInitScript(
    ({ fixedIso, storageKey, seedJson }) => {
      try {
        const key = storageKey
        if (!localStorage.getItem(key)) localStorage.setItem(key, seedJson)
      } catch {
        /* 隐私模式等：忽略 */
      }
      const RealDate = Date
      const fixed = new RealDate(fixedIso).getTime()
      class FixedDate extends RealDate {
        constructor(...args) {
          if (args.length === 0) super(fixed)
          else super(...args)
        }
        static now() {
          return fixed
        }
      }
      globalThis.Date = FixedDate
    },
    { fixedIso, storageKey: STORAGE_KEY, seedJson: JSON.stringify(SEED_DATA) },
  )
}

async function newPage(browser, { width, height, fixedIso, deviceScaleFactor = 2 }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
    userAgent:
      width <= 500
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        : undefined,
  })
  await addInitScripts(context, { fixedIso })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleProblems.push({ viewport: `${width}x${height}`, kind: 'console', text: message.text().slice(0, 300) })
  })
  page.on('pageerror', (error) => {
    consoleProblems.push({ viewport: `${width}x${height}`, kind: 'pageerror', text: String(error).slice(0, 300) })
  })
  return { context, page }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForApp(page, { expectStrategies = 2 } = {}) {
  await page.waitForSelector('.market-status', { timeout: 20_000 })
  await page.waitForFunction(() => document.querySelectorAll('.public-stock').length > 0, { timeout: 20_000 })
  if (expectStrategies > 0) {
    await page.waitForFunction(
      (n) => document.querySelectorAll('.strategy-card').length >= n,
      expectStrategies,
      { timeout: 20_000 },
    )
  }
  // 等首轮盘中报价（成功或失败）落定
  await page
    .waitForFunction(
      () => {
        const text = document.querySelector('.market-status-meta')?.textContent ?? ''
        return /成功|失败|订阅/.test(text)
      },
      { timeout: 20_000 },
    )
    .catch(() => undefined)
  await sleep(1200)
}

/** 用公开快照合成「新鲜」push2 批量报价（f124 = 模拟交易时刻）。 */
async function installMockPush2(page, fixedIso) {
  const fixedSeconds = Math.floor(new Date(fixedIso).getTime() / 1000)
  await page.route('**/push2.eastmoney.com/api/qt/ulist.np/get**', async (route) => {
    try {
      const url = new URL(route.request().url())
      const secids = (url.searchParams.get('secids') || '').split(',').filter(Boolean)
      const diff = []
      for (const secid of secids) {
        const code = secid.split('.')[1]
        const quote = snapshot.quotes[code]
        if (!quote) continue
        diff.push({
          f2: quote.price,
          f3: quote.changePct,
          f4: 0,
          f5: quote.volume,
          f6: quote.amount,
          f12: code,
          f14: code,
          f15: quote.high,
          f16: quote.low,
          f17: quote.open,
          f18: quote.prevClose,
          f124: fixedSeconds,
        })
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ rc: 0, data: { total: diff.length, diff } }),
      })
    } catch {
      await route.abort()
    }
  })
}

/** 主源失败：abort push2（gtimg 真实回退会因「行情时间戳早于模拟时间」被 stale 拒绝 → 沿用上次报价）。 */
async function breakLiveSources(page) {
  await page.unroute('**/push2.eastmoney.com/api/qt/ulist.np/get**')
  await page.route('**/push2.eastmoney.com/**', (route) => route.abort())
  await page.route('**/qt.gtimg.cn/**', (route) => route.abort())
}

async function measure(page, label) {
  return page.evaluate((label) => {
    const vw = window.innerWidth
    const doc = document.documentElement
    const selectors = [
      '.market-status',
      '.market-status-main',
      '.market-status-meta',
      '.market-status-actions',
      '.price-tag',
      '.live-price',
      '.status-tag',
      '.strategy-card',
      '.live-alerts-panel',
      '.public-stock',
      '.bottom-nav',
      '.filter-tabs',
    ]
    const overflowing = []
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const outside = rect.right > vw + 1 || rect.left < -1
        const clipped = (style.overflowX === 'hidden' || style.overflow === 'hidden') && el.scrollWidth > el.clientWidth + 1
        if (outside || clipped) {
          overflowing.push({
            sel,
            cls: String(el.className || '').slice(0, 80),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            scrollW: el.scrollWidth,
            clientW: el.clientWidth,
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
          })
        }
      }
    }
    const touch = [...document.querySelectorAll('button, [role="switch"], a[class*="button"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
      })
      .map((el) => {
        const r = el.getBoundingClientRect()
        const labelText = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
        return { label: labelText, w: Math.round(r.width), h: Math.round(r.height) }
      })
    const smallTouch = touch.filter((t) => Math.min(t.w, t.h) < 44)
    return {
      label,
      viewport: { w: vw, h: window.innerHeight },
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      horizontalScroll: doc.scrollWidth > vw + 1,
      overflowing: overflowing.slice(0, 25),
      overflowingCount: overflowing.length,
      phase: (document.querySelector('.phase-badge')?.textContent || '').trim(),
      statusMeta: (document.querySelector('.market-status-meta')?.textContent || '').trim().replace(/\s+/g, ' '),
      priceTags: [...document.querySelectorAll('.price-tag')].map((el) => el.textContent.trim()),
      liveTagCount: document.querySelectorAll('.price-tag-live').length,
      staleTagCount: document.querySelectorAll('.price-tag-stale').length,
      holdingBadges: document.querySelectorAll('.strategy-card .status-tag.status-holding').length,
      strategyCount: document.querySelectorAll('.strategy-card').length,
      publicCount: document.querySelectorAll('.public-stock').length,
      alertsPanelText: (document.querySelector('.live-alerts-panel')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 320),
      alertsEmptyText: (document.querySelector('.live-alerts-empty')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 320),
      touchTargetCount: touch.length,
      smallTouchCount: smallTouch.length,
      smallTouch: smallTouch.slice(0, 20),
      bodyTextHasRealtime: /实时行情/.test(document.body.innerText),
      footerDisclaimer: /不构成投资建议/.test(document.body.innerText),
    }
  }, label)
}

async function shoot(page, name, { fullPage = true, locator } = {}) {
  const path = join(OUT_DIR, name)
  if (locator) await locator.screenshot({ path })
  else await page.screenshot({ path, fullPage })
  return path
}

function record(name, path, metrics, note) {
  results.push({ name, path: `docs/screenshots/${name}`, note, metrics })
  console.log(`✓ ${name}`)
}

const browser = await chromium.launch()
const errors = []

try {
  /* ── 场景 1：闭市态（固定 2026-11-24 15:50），桌面 + 移动 + 320 ── */
  for (const spec of [
    { width: 1440, height: 900, file: 'desktop-1440x900-today-closed.png', label: 'desktop 1440x900 今日页 闭市态' },
    { width: 375, height: 812, file: 'mobile-375x812-today-closed.png', label: 'iPhone12 375x812 今日页 闭市态' },
    { width: 320, height: 568, file: 'mobile-320x568-today-closed.png', label: '320x568 今日页 闭市态' },
  ]) {
    const { context, page } = await newPage(browser, { width: spec.width, height: spec.height, fixedIso: CLOSED_ISO })
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      await waitForApp(page)
      const path = await shoot(page, spec.file)
      const metrics = await measure(page, spec.label)
      record(spec.file, path, metrics)
      if (spec.width === 375) {
        await page.locator('.bottom-nav button', { hasText: '股票' }).first().click()
        await page.waitForSelector('.stock-toolbar')
        await sleep(600)
        const stocksPath = await shoot(page, 'mobile-375x812-stocks-closed.png')
        record('mobile-375x812-stocks-closed.png', stocksPath, await measure(page, 'iPhone12 375x812 股票页 闭市态'))
      }
    } catch (error) {
      errors.push({ scenario: spec.file, error: String(error) })
    } finally {
      await context.close()
    }
  }

  /* ── 场景 2：交易中（mock 新鲜报价），375 特写 ── */
  {
    const { context, page } = await newPage(browser, { width: 375, height: 812, fixedIso: TRADING_ISO })
    try {
      await installMockPush2(page, TRADING_ISO)
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      await waitForApp(page)
      await page.waitForFunction(() => document.querySelectorAll('.price-tag-live').length > 0, { timeout: 15_000 })
      await sleep(500)
      const card = page.locator('.strategy-card').first()
      const cardPath = await shoot(page, 'strategy-card-375-trading.png', { locator: card })
      record('strategy-card-375-trading.png', cardPath, await measure(page, '策略卡特写 375 交易中（mock 新鲜报价）'))
      const panel = page.locator('.live-alerts-panel')
      const panelPath = await shoot(page, 'alerts-panel-375-trading.png', { locator: panel })
      record('alerts-panel-375-trading.png', panelPath, await measure(page, '提醒面板特写 375 交易中（空状态）'))
      const fullPath = await shoot(page, 'mobile-375x812-today-trading.png')
      record('mobile-375x812-today-trading.png', fullPath, await measure(page, 'iPhone12 375x812 今日页 交易中（mock）'))
    } catch (error) {
      errors.push({ scenario: '375 trading', error: String(error) })
    } finally {
      await context.close()
    }
  }

  /* ── 场景 3：交易中 + 主源失败 → 窄屏「上次报价」最坏情况（320） ── */
  {
    const { context, page } = await newPage(browser, { width: 320, height: 568, fixedIso: TRADING_ISO })
    try {
      await installMockPush2(page, TRADING_ISO)
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      await waitForApp(page)
      await page.waitForFunction(() => document.querySelectorAll('.price-tag-live').length > 0, { timeout: 15_000 })
      await breakLiveSources(page)
      await page.locator('.live-refresh').click()
      await page.waitForFunction(
        () => document.querySelector('.market-status-error') && document.querySelectorAll('.price-tag-stale').length > 0,
        { timeout: 30_000 },
      )
      await sleep(600)
      const fullPath = await shoot(page, 'mobile-320x568-today-stale-labels.png')
      record('mobile-320x568-today-stale-labels.png', fullPath, await measure(page, '320x568 今日页 交易中刷新失败（上次报价）'))
      const cardPath = await shoot(page, 'strategy-card-320-stale.png', { locator: page.locator('.strategy-card').first() })
      record('strategy-card-320-stale.png', cardPath, await measure(page, '策略卡特写 320（上次报价）'))
      const panelPath = await shoot(page, 'alerts-panel-320-stale.png', { locator: page.locator('.live-alerts-panel') })
      record('alerts-panel-320-stale.png', panelPath, await measure(page, '提醒面板特写 320（空状态）'))
    } catch (error) {
      errors.push({ scenario: '320 stale', error: String(error) })
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  playwright: PLAYWRIGHT_MODULE,
  scenarios: results,
  consoleProblems,
  errors,
}
writeFileSync(join(OUT_DIR, 'measurements.json'), JSON.stringify(report, null, 2))

console.log('\n=== 汇总 ===')
for (const item of results) {
  const m = item.metrics
  console.log(
    `${item.name}\n  phase=${m.phase} 横向滚动=${m.horizontalScroll} 溢出元素=${m.overflowingCount} 小触控=${m.smallTouchCount}/${m.touchTargetCount} liveTag=${m.liveTagCount} staleTag=${m.staleTagCount}`,
  )
}
if (consoleProblems.length) console.log(`\nconsole/pageerror: ${consoleProblems.length} 条（见 measurements.json）`)
if (errors.length) {
  console.log(`\n场景失败: ${errors.length} 条`)
  for (const e of errors) console.log(`  - ${e.scenario}: ${e.error}`)
  process.exitCode = 1
}
console.log(`\n截图输出：${OUT_DIR}`)
