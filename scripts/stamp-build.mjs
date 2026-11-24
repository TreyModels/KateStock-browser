#!/usr/bin/env node
/**
 * 构建前版本戳（task-40）：
 * 1) 读取 git 短 SHA + 本地构建时间，生成 build id；
 * 2) 把 build id 写入 index.html 的 meta/`window.__BUILD__`（幂等，重复构建会刷新）；
 * 3) 把 public/sw.js 的 CACHE 名换成带 build id 的名称（幂等），让每次部署产生新缓存并清旧缓存。
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const pad = (n) => String(n).padStart(2, '0')

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'dev'
  }
}

const sha = gitSha()
const now = new Date()
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
const id = `${sha}-${date.replaceAll('-', '')}-${pad(now.getHours())}${pad(now.getMinutes())}`
const build = { id, sha, time: `${date} ${time}` }

const html = readFileSync('index.html', 'utf8')
const nextHtml = html
  .replace(/<meta name="build-id" content="[^"]*" \/>/, `<meta name="build-id" content="${id}" />`)
  .replace(/<script>window\.__BUILD__ = \{[^}]*\};<\/script>/, `<script>window.__BUILD__ = ${JSON.stringify(build)};</script>`)
writeFileSync('index.html', nextHtml)

const sw = readFileSync('public/sw.js', 'utf8')
const nextSw = sw.replace(/const CACHE = 'ashare-strategy-shell-[^']*'/, `const CACHE = 'ashare-strategy-shell-${id}'`)
writeFileSync('public/sw.js', nextSw)

console.log(`[stamp-build] v${sha} · ${build.time} · cache=ashare-strategy-shell-${id}`)
