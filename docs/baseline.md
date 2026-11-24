# 原站行为基线：KateStock-browser /「日内 · A股今日策略」

> 用途：本文件是复刻与「盘中提醒」改造的**对照物**。验收时用它判断「哪些行为必须原样保留、哪些行为是本轮新增」。
> 基线身份：本地克隆 HEAD = `fa5e291`（`Calculate scheduled watchlist strategy signals`），对应线上 <https://treymodels.github.io/KateStock-browser/>。
> 检查方式：静态源码逐行核对 + 线上 HTTP 快照实测 + 构建产物哈希比对。所有行号以本仓库当前 HEAD 为准；线上证据抓取于 2026-11-23 23:35（Asia/Shanghai）。
> 标注约定：**【代码】** = 仓库文件:行号；**【线上】** = URL / HTTP 头 / 响应字段；**【不确定】** = 本轮未能证实、不得当作结论的项。

---

## 0. 基线身份与可复现性

| 事实 | 证据 |
| --- | --- |
| 克隆仓库只有一个提交 `fa5e291`，工作区来源即该提交 | `git log --oneline` |
| 线上页面标题「日内 · A股今日策略」，中文，PWA | 【代码】`index.html:14`、`public/manifest.webmanifest:1-22` |
| 本地构建产物与线上运行的 JS 逐字节一致（**克隆后、改造前** snapshotted） | `dist/assets/index-hT0svD50.js` 的 SHA-256 = `b0041e04…859c1084`；`curl` 线上同名资源后 `cmp` 结果 IDENTICAL。⚠️ 2026-11-23 23:40 并行改造期间重新构建后 `dist/` 已变为 `index-sg6n0Emn.js`（预期内）；基线对照请用线上版本或 `git show HEAD:<file>` 源码，**不要用当前 dist**。 |
| 线上部署目录含 `assets/`、`data/latest.json`、`manifest.webmanifest`、`sw.js` | 【线上】`https://treymodels.github.io/KateStock-browser/` 及子路径均 200 |
| 本地克隆**不含** `public/data/latest.json`（数据是 CI 产物，不入库） | `.gitignore` 末尾 `public/data/`；`public/` 下只有 icons/manifest/quants/sw.js |

**可复现命令（基线哈希为历史记录；当前 dist 已被改造覆盖）**

```bash
# 线上基线构建产物哈希（随时可复现，需要网络）
curl -sS https://treymodels.github.io/KateStock-browser/assets/index-hT0svD50.js -o /tmp/live.js
shasum -a 256 /tmp/live.js
# 期望：b0041e040666c3d51df002542d2bbca127225ea64849c39a0844e919859c1084
# 2026-11-23 23:35 在“克隆 HEAD + 未改造”的 dist 上比对结果为 IDENTICAL。

# 若要在本地重新核对：用干净克隆（或 git worktree + HEAD）执行
# npm ci && npm run build
# cmp dist/assets/index-hT0svD50.js /tmp/live.js   # 无输出 = 基线一致
```

结论：**本仓库 HEAD 就是线上现状**（改造前构建产物与线上逐字节一致），因此下文源码行号同时也是线上行为证据。改造期间 `dist/` 会被重建成新版本，基线比对以线上部署或 HEAD 源码为准。

---

## 1. 页面结构（6 视图 + PWA + 今日页信息层级）

视图定义（桌面侧栏 / 移动端底部导航共用同一份 `views` 数组）：

| 视图 | 导航文案 | 证据 | 基线内容 |
| --- | --- | --- | --- |
| `today` | 今日 | 【代码】`src/App.tsx:29-37`、`239-343` | 黄金手动值、报告状态条、公开清单行情、每日研究/语音、策略统计、今日信号筛选 tab、盘前纪律、风险预算 |
| `stocks` | 股票 | `src/App.tsx:346-353` | 个人清单（历史记录/当前持仓/当前自选）、搜索/筛选/更新、手动录入、删除 |
| `library` | 策略库 | `src/App.tsx:354` | `<QuantsLibrary/>` |
| `backtest` | 回测 | `src/App.tsx:355` | `<BacktestLab/>`：四策略回测、权益曲线、动态复盘时间轴、交易日志 |
| `rules` | 策略 | `src/App.tsx:357-367` | 四张规则卡：突破跟随 / 回踩低吸 / 减仓与止损 / 风险定仓（`362-365`） |
| `settings` | 我的 | `src/App.tsx:369-407` | 风险参数、iPhone 安装步骤、备份导入导出、黄金值、清空数据 |

- 桌面侧栏：`src/App.css:192-194`（≥960px 显示 sidebar，隐藏 mobile-header/bottom-nav/mobile-fab）。
- 移动端底部导航：`src/App.tsx:409-413`；样式 `src/App.css:168-171`；紧凑 iPhone 六等分 + `env(safe-area-inset-*)`：`src/App.css:367-375`；`index.html:5` 带 `viewport-fit=cover`。
- 今日页文案里只有「月日+星期」当日日期，**没有行情时间戳**：`src/App.tsx:70`（`dateText`）。
- 页脚声明「不构成收益承诺」：`src/App.tsx:305`（`source-note`）；侧栏「不上传持仓，不连接券商」`src/App.tsx:229` 附近。
- PWA：`public/manifest.webmanifest`（standalone / zh-CN / 192+512 图标）；`public/sw.js:1` 壳缓存 `ashare-strategy-shell-v3`，fetch 事件为**网络优先、失败回退缓存**，成功响应会 `cache.put` 写入同源 GET（含 `data/latest.json`）。

---

## 2. 数据语义：原站全部是「日线收盘」数据，没有实时行情层

### 2.1 客户端自动行情（`src/lib/market.ts`）

| 事实 | 证据 |
| --- | --- |
| 请求东方财富**历史日线** `push2his.eastmoney.com/api/qt/stock/kline/get`，`klt: '101'` = 日线 | 【代码】`src/lib/market.ts:27`（`klt: '101'`）、`:19-33` |
| `fqt: '1'` = 前复权 | `src/lib/market.ts:28` |
| 取近 240 天、解析后只保留最近 160 根 bar | `src/lib/market.ts:20-22`、`:53` |
| 「现价」= 最后一根日线的 `close` | `src/lib/market.ts:55-62` |
| `tradeDate` = 最后一根 bar 的日期（只有日期，无时刻） | `src/lib/market.ts:69` |
| `fetchedAt` = **浏览器抓取时刻**（不是交易所行情时间） | `src/lib/market.ts:70` |
| 全仓检索：`fetchedAt` 没有任何渲染/展示 | `grep -rn fetchedAt src/` 仅命中 `App.tsx:192`（导入）、`snapshot.ts:5`（校验）、`market.ts:70`、`strategy.ts:181` |
| 12 秒超时；fetch 失败回退 JSONP；失败文案「行情服务…手动录入」 | `src/lib/market.ts:78`、`:88-128`、`:81`、`:114` |
| 4 并发批量抓取，进度回调 | `src/lib/market.ts:130-153` |
| 手动行情 fallback：手填价格+MA/ATR/量比，`source:'manual'`、`bars:[]` | `src/lib/strategy.ts:150-192`（`buildManualQuote`） |
| 策略计算优先用手填指标，无则用收盘 bar 计算 | `src/lib/strategy.ts:45-57` |

### 2.2 服务端每日发布（`scripts/ingest.py`）

| 事实 | 证据 |
| --- | --- |
| 股票池 = `scripts/public-universe.json`（29 个代码，含 2 只 ETF：159558、588060） | `scripts/ingest.py:14`；`public-universe.json` 共 29 项（第 2-30 行） |
| 同一 kline 接口、`klt=101`、`fqt=1`、窗口 260 天 | `scripts/ingest.py:64` |
| 每只保留 160 根 bar；价格/昨收/tradeDate 取法同客户端 | `scripts/ingest.py:51`、`:88-89` |
| 主源 Eastmoney；非 ETF 个股可回退 Sina（AKShare，qfq）；**ETF 不做回退**（避免混用复权语义） | `scripts/ingest.py:65-73` |
| 数据校验：OHLCV 合法、日期严格递增、≥21 根、末根=期望交易日 | `scripts/ingest.py:36-51` |
| fail closed：无任何有效报价时直接抛错，保留 last-good 快照 | `scripts/ingest.py:98` |
| 日历陈旧拒绝发布 | `scripts/ingest.py:58` |
| 发布字段：`schemaVersion/generatedAt/tradeDate/source/sourceUrl/partial/failures/coverage/quotes`，另有 `signals`、`strategyVersion`、`ai` | `scripts/ingest.py:102`；`scripts/generate_signals.mjs:1-27`；`scripts/ai_brief.py:1-20` |
| `coverage` 文案「公开清单（29只），非全市场」 | `scripts/ingest.py:102` |
| 输出路径默认 `public/data/latest.json`，先写 `.tmp` 再原子替换 | `scripts/ingest.py:103-107` |

### 2.3 快照校验与本地缓存（`src/lib/snapshot.ts`）

- zod schema 强制字段/顺序/一致性：价格=末根 close、tradeDate=末根日期、bar 日期递增、signals 覆盖必须与 quotes 一一对应、【代码】`src/lib/snapshot.ts:5-11`。
- localStorage 键：`katestock-last-good-public-snapshot-v1`（`snapshot.ts:13`）。
- 合并规则：**手动行情和新日期行情不被快照覆盖**（`snapshot.ts:18-25`）。
- App 打开时读缓存 + 拉一次 `data/latest.json`（`cache:'no-store'`），并拒绝比缓存更旧的报告：【代码】`src/App.tsx:89-110`。之后**不轮询**，只能点「检查报告更新」（`src/components/ReportStatus.tsx:13`）。

### 2.4 数据流结论

原站唯一的「价格」来源是：**上一交易日（或最新已完成交易日）的日线收盘价**。页面上不存在「行情时间 HH:MM:SS」的概念，只有 `tradeDate`（日期）和快照 `generatedAt`（生成时刻）。这是用户痛点「收盘才有数据」的结构性原因，不是 bug。

---

## 3. 收盘门槛：16:45（Asia/Shanghai）

- 纯函数 `completed_date(now, dates)`：当日只有 `now.time() >= 16:45` 才把今天算作已完成交易日；否则取之前最近的交易日；无可用日期则抛错：【代码】`scripts/ingest.py:18-23`。
- 调用点：`expected = completed_date(now, dates)`，`now` 为 `Asia/Shanghai`：【代码】`scripts/ingest.py:55`、`:59`。
- 单测锁死边界：07:05 → 前一交易日；**16:45 整** → 当日：【代码】`tests/test_ingest.py:6-10`。
- 含义：15:00 收盘后到 16:45 之间，即使当天已收盘，快照**仍不会**包含当天；16:45 是留给数据源结算的保守缓冲（非交易所口径）。
- **客户端没有这个门槛**：`market.ts` 没有任何交易时段/时间判断（`src/lib/market.ts` 全文仅用时间构造 `beg`）。用户盘中手动刷新时，直接取日线接口最后一根 bar；该接口在盘中是否返回「当日未完成 bar」/「上一日」【不确定】。若返回当日未完成 bar，页面会把盘中价显示成最后一根「日线收盘价」且 `tradeDate=今天`，与非实时标注产生语义混淆——这是新实时层必须避免的坑（不能复用该路径）。

---

## 4. 定时任务：16:50 / 07:50（北京时间；发布 workflow 已迁移）

【代码】`.github/workflows/deploy-pages.yml`（原 `.github/workflows/market-update.yml` 已移除）：

| 项 | 值 | 证据 |
| --- | --- | --- |
| 收盘后调度 | `cron: '50 8 * * 1-5'` = **16:50 北京**，周一至周五 | `deploy-pages.yml:9` |
| 盘前调度 | `cron: '50 23 * * 0-4'` = 次日 **07:50 北京**，周一至周五 | `deploy-pages.yml:11` |
| 其他触发 | `workflow_dispatch` + push 到 `main` | `:4-6` |
| 并发与超时 | `concurrency: pages`；`timeout-minutes: 20` | `:18-25` |
| 流水线 | checkout → setup-node **24** → `npm ci` → **`npm run refresh`**（失败 sleep 20 重试一次；仍失败则 warning 并部署 committed last-good 快照）→ **`bash scripts/verify.sh`** → configure-pages → `npm run build` → **upload-pages-artifact** | `:26-43` |
| 发布 | **deploy-pages@v4**（`needs: build`） | `:44-54` |
| 失败行为 | refresh 失败不阻塞（回退 last-good）；verify/build/部署失败则保留线上上一版 | `:34-43` + `docs/operations-2.0.md:5` |
| 数据完成判定 | 仍由 `scripts/ingest.py` 的 `completed_date` **16:45** 决定；16:50 的 workflow 触发只是给数据源结算与排队留缓冲 | `scripts/ingest.py:18-23`、`tests/test_ingest.py:6-10` |

- 07:50 那班在 16:50 之前运行，`completed_date` 只会取 **昨天**的已完成交易日，所以它的作用是「盘前再发布一次上一交易日快照」，不会产生当日数据。
- 时区：中国无夏令时，UTC+8 固定偏移，故 cron 的 UTC 小时 +8 即为北京时间（16:50 = 08:50Z；07:50 = 23:50Z 前一 UTC 日）。
- 线上最近一次发布：`generatedAt 2026-11-23T09:58:35.718691Z` = **北京时间 17:58:35**，远晚于 16:50；工作流有 push/dispatch 两种入口，**无法从静态站点判断本次是 cron 还是 push 触发**【不确定】。
- **节假日行为【不确定】**：workflow 在周一至周五（含中国法定节假日）仍会触发。`ingest.py:58` 用「日历最大日期 < 今天」判定日历陈旧；Sina 交易日历是否包含未来日期未验证，因此节假日可能(a)成功重发上一交易日快照，或(b)抛「Trading calendar is out of date」保留 last-good。两种都可接受，但都需要在验收时观察，不能假设。

---

## 5. 信号语义：收盘出信号、次日开盘执行

| 事实 | 证据 |
| --- | --- |
| README 明示「四策略独立历史回测：收盘出信号、次日开盘执行，计入成本并防止未来函数」 | 【代码】`README.md:18` |
| 回测假设面板明示「收盘生成信号，下一交易日开盘执行；单边成本 0.10%」 | `src/components/BacktestLab.tsx:241` |
| quants 策略同口径「次日开盘成交，单边成本 0.1%」 | `src/components/BacktestLab.tsx:198` |
| 回测实现（**重构中，task-30**）：原口径为 pending entry 在**下一根 bar 的 open** × (1+COST) 成交、`COST=0.001`；新实现改为显式费用函数 `buyFeeFor`/`sellFeeFor`/`roundTripCostBps`（`DEFAULT_COST_OPTIONS`）并含涨跌停/顺延等执行限制，EOD 语义（收盘出信号/次日开盘执行）仍为目标；**待 signals-alerts task-30 落地后复核** | `src/lib/backtest.ts`（费用函数 `:140-198`、pendingEntry `:384-442`） |
| 复盘叙事文案「下一交易日开盘才进入回测」「不在当天收盘前偷用数据」 | `src/lib/backtest.ts:291-292` |
| 定时信号复用**同一策略引擎** `generateStrategy`，且不发布个人仓位/股数 | `scripts/generate_signals.mjs:1-27`；单测 `tests/signals.test.mjs:8-22` |
| 发布信号字段被强约束（无 sizing）：`action/actionLabel/score/summary/reasons/indicators` | `scripts/check_public.py:12-18` |
| 公开信号是「自选清单级规则」，非个人持仓/下单 | 【代码】`docs/operations-2.0.md:27` |
| 策略引擎价位：breakout/pullback 给 trigger/stop/target；watch/trendDown 等可无价位 | `src/lib/strategy.ts:59-140` |
| 策略卡展示触发/保护/目标，但**不比较实时价、不提醒** | `src/components/StrategyCard.tsx:44-56` |
| 交易成本/止损优先等限制声明 | `src/components/BacktestLab.tsx:241` |

结论：原站的信号是**日频、收盘确认、次日执行**的研究信号；它没有「盘中命中触发/止损/目标」的概念，也没有任何通知去重/节流逻辑。本轮新增的提醒层必须**叠加**在这套 EOD 语义之上，不得改变 `generateStrategy`/回测口径（`tests/signals.test.mjs` 是回归护栏）。

> **2026-11-24 状态**：`src/lib/backtest.ts` 正在重构（signals-alerts task-30）。`tests/acceptance/check_baseline.mjs` 的 B-10（回测 EOD 语义）暂标记 **SKIP**，task-30 落地后恢复为「次日开盘成交 + 费用/成本口径 + 无未来函数」断言。

---

## 6. 非实时标注（必须保留的文案与状态机）

| 位置 | 基线文案/行为 | 证据 |
| --- | --- | --- |
| 报告状态条 | 「收盘研究快照」、「**非实时行情** · 本地缓存/已加载/加载中/暂无报告」 | `src/components/ReportStatus.tsx:11` |
| 报告状态条 | 展示 行情交易日 `tradeDate`、生成时间（北京时间）、**数据年龄 N 小时**、来源链接、覆盖范围；`age >= 48` 时警告「快照可能过期」；`partial` 时列出失败；`error` 时「更新失败，保留上次有效快照」 | `ReportStatus.tsx:7-9`、`:12` |
| 公开清单 | 「交易日 {tradeDate} · **收盘日线，非实时** · {n} 只有行情」 | `src/components/PublicStocks.tsx:9` |
| 公开清单 | `partial` 时提示「部分证券本次未更新…未展示失败证券的价格」 | `PublicStocks.tsx:16` |
| 策略卡 | 底部「自动日线/手动行情 · {tradeDate}」 | `src/components/StrategyCard.tsx:75` |
| 今日页 | 黄金产品「手动参考价值 · 非实时；未确认产品代码」 | `src/App.tsx:241` |
| README | 「行情来自东方财富公开日线接口，可能延迟或中断…不连接券商、不自动下单，也不构成收益承诺」 | `README.md:26` |
| 运维文档 | 「snapshots are not live quotes」；快照会缓存 last-good；静态 Pages 不提供 `/api/chat` | `docs/operations-2.0.md:3`、`:5`、`:25` |
| AI 简报 | 可选；线上当前 `ai.status = "unavailable"`，UI 显示「AI 研究简述暂不可用；行情与策略仍可使用」 | `ReportStatus.tsx:12`；线上快照实测 |

**重要基线缺口**：原站**没有**「逐报价时间戳」展示（`fetchedAt` 从未渲染，见 §2.1），也没有「数据年龄/新鲜度」用于阻挡基于旧价的决策。本轮「盘中价格可见且带时间戳」属于新增能力，不能拿「tradeDate 是今天」冒充时间戳。

---

## 7. 29 只公开清单 vs 空 initialStocks（隐私门）

| 事实 | 证据 |
| --- | --- |
| 个人预置记录被清空：`export const initialStocks: Stock[] = []` | `src/data/initialStocks.ts:1-4`（注释「Personal records are restored from device storage or a private backup, never bundled.」） |
| 个人数据只存本浏览器 localStorage（键 `ashare-daily-strategy-v1`），不同步 | `src/hooks/useLocalData.ts:5`、`:40-45`；`README.md:26` |
| 29 只是**公开自选清单**（定时任务计算对象），不是预装个人记录 | `scripts/public-universe.json`（29 项）；`scripts/ingest.py:14`、`:102` |
| 公开快照禁止携带仓位/成本/股数等私字段；发布前扫描 | `scripts/check_public.py:12-18`、`:22-33` |
| 「不要声称 Pages 站点是私密的」；历史预装记录已移除 | `docs/operations-2.0.md:9`、`:11-13` |

⚠️ **文档不一致**：`README.md:28` 仍写着「预置的 29 条证券记录来自用户提供的 2026 年收益贡献截图，全部标记为'历史记录'」，与 `initialStocks` 已清空（空数组）矛盾。29 这个数字实际指公开清单；README 该句是**陈旧描述**，不应作为「预装个人记录」的验收依据。

---

## 8. 线上快照实测（2026-11-23 23:35 抓取）

**请求**

```bash
curl -sS -D - https://treymodels.github.io/KateStock-browser/data/latest.json
```

**响应头（摘要）**

```
HTTP/2 200
content-type: application/json; charset=utf-8
last-modified: Mon, 23 Nov 2026 09:59:11 GMT     # = 北京时间 2026-11-23 17:59:11
cache-control: max-age=600
access-control-allow-origin: *
content-length: 701293
```

**响应字段（实测）**

```json
{"schemaVersion":1,
 "generatedAt":"2026-11-23T09:58:35.718691Z",   // 北京时间 17:58:35
 "tradeDate":"2026-11-23",
 "source":"Eastmoney (前复权)",
 "sourceUrl":"https://www.eastmoney.com/",
 "partial":false,
 "failures":[],
 "coverage":"公开清单（29只），非全市场",
 "quotes": { ... 29 只 ... },
 "strategyVersion":"katestock-rules-v1",
 "signals": { ... 29 只，与 quotes 一一对应 ... },
 "ai": {"status":"unavailable","text":"","model":"deepseek-flash"}}
```

- quotes 代码清单（29）：`000876,000960,001216,001270,002008,002222,002384,002396,002407,002409,002428,002432,002536,002654,002827,002886,002938,159558,588060,600110,600206,600547,600549,600825,600869,601216,603186,603290,605488`。
- 每只 quote 含 `provider:"Eastmoney"`、`adjustment:"前复权"`、`bars` 160 根（示例 600110：2026-03-30 → 2026-11-23），**没有逐报价时间戳字段**（只有快照级 `fetchedAt`/`generatedAt`）。
- `signals` 每条只有 `action/actionLabel/score/summary/reasons/indicators`（无 trigger/stop/target、无股数）→ 公开清单的「价位/提醒」不能直接来自快照信号，必须由前端策略引擎结合个人持仓重新计算。
- `partial:false`、`ai.status:unavailable`：本次全部 29 只成功，AI 简报未生成。

**部署时序**：收盘 15:00 → ingest.py 的 16:45 完成门槛 + 16:50 定时触发 + Actions 排队/refresh/build/verify → 快照 17:58 生成、17:59 上传（北京时间）。即用户在 15:00-16:45 之间即使已收盘也只能看到**上一交易日**；16:45 之后还要等 16:50 workflow 与 CI 完成。这是「收盘后才看到」体验的直接来源之一。

---

## 9. 对本轮改造的含义 / 原站额外坑（给 Lead 与实现方）

1. **原站没有任何实时行情调用**：客户端和定时任务都走 `push2his` 日线（`klt=101`），页面上没有报价时间。实时层必须是**新增数据通道**（push2 ulist.np / stock.get / gtimg），不能靠改 klt 或缩短时间窗口假装实时。
2. **客户端没有 16:45 门槛，也没有「bar 是否完成」的判定**：盘中手动刷新可能把东财「当日未完成日线」当成收盘价（该接口盘中返回行为【不确定】）。新实时层不得复用 `market.ts` 的日线路径；EOD 层保留 `market.ts` 原语义即可。
3. **快照发布天然滞后**：16:45 完成门槛 + 16:50 cron + Actions 排队/refresh/build，线上实测 17:58 才生成；07:50 那班只更新上一交易日。UI 不能把「快照已加载」表述成「今日实时」。
4. **29 只 ≠ 全市场**；ETF 无 Sina 回退；`partial` 时个别代码不展示价格。实时层要覆盖「个人自选里不在公开清单的代码」：前端直连实时接口，但没有 EOD bars 时策略引擎无法给出 trigger/stop/target（`generateStrategy` 需要 ≥2 根 bar；`bars:[]` 的手动行情依赖手填指标）。**没有价位就不能编造提醒**。
5. **静态 Pages + CDN + Service Worker**：`data/latest.json` 头 `cache-control: max-age=600`（最多 10 分钟旧）；App 虽用 `cache:'no-store'`，中间缓存仍可能给旧数据；`sw.js` 对同源 GET 成功即 `cache.put`，网络失败时回退缓存。结果是「数据源失败」可能表现为**悄悄使用旧缓存而不报错**（ReportStatus 只在 `generatedAt` 年龄 ≥48h 时警告）。验收「失败降级不冒充实时」必须专门覆盖这一路径。
6. **首次访问没有个人股票**：`initialStocks` 为空，今日页主体是公开快照。UI 的实时 `codes` 必须在无个人清单时回退到 `report.quotes` 的代码（否则实时层无标的、提醒永远不触发），这已是 task-3 的要求。
7. **通知能力基线为零**：原站只有 sonner toast（`src/App.tsx` 末尾 `<Toaster/>`），没有 Notification API、没有 WebAudio。iOS Safari 的通知需要「添加到主屏幕」+ 用户手势授权；声音在无手势时会被浏览器拦截。验收必须保证 **toast 兜底、声音失败静默**。
8. **节假日/时段判定**：定时任务在法定节假日仍触发；实时层目前节假日暂按工作日处理（task-1 已知限制）。必须靠「报价超过 2 分钟未更新就不提醒」的 stale guard 兜底，避免用上一交易日收盘价误触发。
9. **公开信号字段被 `check_public.py` 锁死**（无 trigger/stop/target/股数）：盘中提醒只能由前端策略引擎（`generateStrategy` + 个人持仓）计算价位；不要期望快照里带价位。
10. **个人持仓才有成本止损**：`costStop`/`trendStop` 只在 `stock.status==='holding'` 且满足条件时出现（`src/lib/strategy.ts:59-86`）；自选/历史记录的「止损提醒」只在策略给出 stop 时成立（breakout/pullback 才有）。
11. **README 陈旧**：§7 的「预置 29 条」与空 `initialStocks` 矛盾，验收以代码为准。
12. **Node 版本差异**：CI 用 Node 22（`.github/workflows/ci.yml:14`），发布 workflow 用 Node 24（`.github/workflows/deploy-pages.yml:30`），本机 `/opt/homebrew/bin/node` 为 v26.12.0；`--experimental-strip-types` 本机实测可用（snapshot 测试 3 pass）。最终验收要记录实际 Node 版本，避免「本机过、CI 不过」。
13. **重复的 `data/latest.json` 体积**：约 701 KB（29×160 bars）。实时层若仍在挂载时整包加载，移动端首屏成本不变；提醒层要用实时接口而非轮询快照。

---

## 10. 本轮未验证 / 不得当结论的项

- 东财 `push2his` 日线接口在**交易时段内**是否返回当日未完成 bar（需在盘中实测，或查官方文档）。
- 中国法定节假日下 `ingest.py` 的行为是「重发上一交易日」还是「日历陈旧失败」（见 §4）。
- 线上 `data/latest.json` 的 CDN 实际缓存命中/失效行为（`max-age=600` 只是声明）。
- CORS：`push2.eastmoney.com` 批量报价接口是否允许浏览器直连（原站日线接口 `fetch` 失败时会回退 JSONP，说明历史接口在同源策略上并不可靠）；实时层如果走 `fetch` 必须实测 CORS，否则要准备 script/JSONP 回退。
- GitHub Actions 定时任务是否真实按 cron 触发（`docs/operations-2.0.md:5` 明确「It has not yet been run in GitHub Actions」，但线上已有快照，说明至少 push/dispatch 路径跑通；cron 是否生效未证实）。
