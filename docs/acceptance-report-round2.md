# 第二轮复验报告（集成后，qa-verifier）

- 验收依据：[`docs/acceptance.md`](./acceptance.md)（P0 35 / P1 15 / P2 1）、[`docs/baseline.md`](./baseline.md)
- 复验时间：2026-11-23 23:44–23:52（Asia/Shanghai，**收盘后**，无盘中窗口）
- 环境：macOS / `/opt/homebrew/bin/node v26.12.0`、npm 11.20.0；`node_modules` 为符号链接（未执行 `npm install`）；本地 dev server `http://localhost:3000`
- 权限边界：本轮**只读复验、不改应用代码**；仅新增被 `.gitignore` 排除的本地快照 `public/data/latest.json`（供人工浏览器验收）与本报告。
- 结果口径：`PASS` = 本轮有离线/网络/代码级充分证据；`PASS*` = 代码级通过、但显示效果/交互/盘中行为需人工或盘中窗口最终确认（**不视为已完成人工验收**）；`PENDING` = 本环境无法判定，必须人工/盘中复测；`FAIL` = 不通过。

## 0. 结论摘要

- **无 P0 阻塞问题**；不需要回退或返工才能继续人工验收。
- P0 35 项：**PASS 20 / PASS* 13 / PENDING 2 / FAIL 0**。
- P1 建议 8 项（见 §3），其中 P1-3（集合竞价时间戳）与 P1-1（失败保旧报价的标签）最值得优先处理/实测。
- P2 观察 5 项（见 §4）。
- 自动门禁全绿：`verify.sh` PASS（build + lint + **44** 离线测试）、基线不变量 19/19、Python 4 tests OK、`check_public.py` PASS。

## 1. 自动门禁结果

| 门禁 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 一键验证 | `cd /tmp && bash "<repo>/scripts/verify.sh"` | **PASS exit 0** | build PASS / lint PASS / node tests 44 pass 0 fail；日志 `/var/folders/jb/km5070j9141659tyckdk886r0000gn/T/katestock-verify-20261123-234419.log` |
| 基线不变量 | `node tests/acceptance/check_baseline.mjs` | **PASS 19/19** | 空 `initialStocks`、klt=101、16:45、cron、29 只、次日开盘+0.1% 成本、快照 schema、非实时文案均未变 |
| Python 回归 | `python3 -m unittest discover -s tests` | **PASS 4 tests OK** | `test_ingest.py`（16:45 边界）、`test_ai.py` |
| 发布结构/密钥扫描 | `python3 scripts/check_public.py` | **PASS** | 需 `public/data/latest.json`（本轮已准备）；报告结构 + dist 无 `sk-` 等 |
| 依赖/范围卫生 | `git status`、`ls -ld node_modules` | **PASS** | `node_modules -> /tmp/kdeps/node_modules`；`package.json/lock` 未改；`public/data/` 被 `.gitignore:29` 忽略 |

## 2. P0 验收表（35 项）

> 证据格式：`文件:行号` / 命令输出。`PASS*` 含义见开头。

| ID | 结果 | 证据 | 责任域 |
| --- | --- | --- | --- |
| A1 `npm run build` | PASS | verify.sh build PASS（tsc -b + vite build，dist 115K CSS / 548K JS） | build |
| A2 `npm run lint` | PASS | verify.sh lint PASS（0 error） | build/各域 |
| A3 既有+新增 node 测试 | PASS | 44 tests / 44 pass；`tests/signals|snapshot|stockImport` 基线 3 个仍在 | build/signals |
| A4 新增测试离线覆盖 | PASS | `tests/live.test.mjs`、`tests/alerts.test.mjs` 仅 import 纯模块（grep 无 fetch/http）；总耗时 253ms；覆盖解析/缩放/回退/时段/陈旧/去重/跨日/权限缺失 | data+signals |
| A6 verify.sh 可执行+失败语义 | PASS | `/tmp` 用绝对路径 exit 0；故障注入（lint=false→1、无测试文件→1、缺 node_modules→2） | build |
| A7 基线不变量 | PASS | `check_baseline.mjs` 19/19（隐私门/EOD 语义/cron/schema） | build |
| A8 范围与依赖卫生 | PASS | git status 仅声明文件；package.json 未动；符号链接完好；数据文件被忽略 | build/Lead |
| B1 盘中价格可见且带时间戳 | PASS* | `MarketStatusBar.tsx:71-74`（最近报价/数据年龄）、`StrategyCard.tsx:58-60`（盘中报价 HH:mm:ss）、`quote-utils.ts:34-47`；真实渲染待人工 | ui+data |
| B2 实时报价来源与回退 | PASS | 本机 `curl push2` = exit 52（反爬）；`qt.gtimg.cn` 200 + `ACAO:*` + GBK；**真实 `fetchLiveQuotes` 端到端**（模拟 script 注入）：29 只请求 → 29 只 tencent 回退成功、0 errors、3.29s；29/29 价格与 EOD 快照收盘价一致 | data |
| B6 时段判定 | PASS | `tests/live.test.mjs:198-237`：09:14 preopen / 09:15 auction / 09:25-09:30 preopen / 09:30 trading / 11:30 lunch / 13:00 trading / 15:00 closed / 周末 non-trading；标签与轮询间隔断言 | data+ui |
| B7 只在竞价/交易自动轮询 | PASS* | `useLiveQuotes.ts:108-138`（非 live 只 watchPhase 不请求）；`nextPollDelay` 测试 `live.test.mjs:229-234`；浏览器 Network 实测待人工 | data |
| B8 报价新鲜度可见 | PASS* | `MarketStatusBar.tsx:57-59,69`（>2min“盘中报价可能延迟”+数据年龄）；`live.test.mjs:335-351`；视觉待人工 | ui+data |
| B10 失败降级不冒充实时 | PASS* | 错误横幅 `MarketStatusBar.tsx:87-92`；数据层交易时段拒绝陈旧 `live.ts:633-640`（伪时钟实测：29 只旧报价全部被拒、errors 明示）；提醒层 stale guard `alerts.ts:246`。**附 P1-1 注意项** | data+ui |
| C1 触发命中提醒 | PASS* | `alerts.test.mjs:66-75`；`useLiveAlerts.ts:45-58`（toast）+ `LiveAlertsPanel` 列表；真实 toast 待人工 | signals+ui |
| C2 止损命中提醒 | PASS* | `alerts.test.mjs:76-83`（stop 优先、命中止损不提示买点）；toast.error；待人工 | signals+ui |
| C3 目标命中提醒 | PASS* | `alerts.test.mjs:107-115`；toast.success；待人工 | signals+ui |
| C4 命中优先级/顺序 | PASS | `alerts.test.mjs:76-83,252-260`：止损 > 目标 > 触发；多命中按序产出 | signals |
| C5 去重 id | PASS | `alerts.test.mjs:147-163`；`alerts.ts:124-141` id=`code:kind:tradeDate`；重复扫描 0 事件 | signals |
| C6 5 分钟节流+跨日重置+持久化 | PASS | `alerts.test.mjs:164-201,261-289`；坏数据/版本不符/配额异常静默降级 | signals |
| C7 无价位不提醒 | PASS | `alerts.test.mjs:97-106`；`live-signals.ts:17-38`（非有限/非正价位忽略） | signals |
| C8 >2min 陈旧不提醒 | PASS | `alerts.test.mjs:214-231`（120s 边界）；`alerts.ts:95-104,246`；数据层双重过滤 | signals |
| C12 文案合规 | PASS | `LiveAlertsPanel.tsx:118`、`MarketStatusBar.tsx:95`、`App.tsx:364`、`StrategyDetailDialog.tsx:102`：无“实时行情/保证收益”承诺，保留“不构成投资建议”；提醒用“触发/保护/目标” | ui |
| D1 午休不误报 | PASS | `alerts.test.mjs:202-213`；`alerts.ts:24` 仅 auction/trading；面板空状态按时段解释 `LiveAlertsPanel.tsx:108-115` | signals+ui |
| D2 收盘不误报 | PASS | 同上；`quote-utils.ts:20-26` 收盘/非交易日=“收盘”标签；`MarketStatusBar.tsx:13` “已收盘，显示收盘价” | signals+ui |
| D3 非交易日不误报 | PASS | `live.test.mjs:220-228` 周末=non-trading；`nextPollDelay` 10min；提醒被 phase 过滤 | data+signals |
| D4 收盘后仍可用 | PASS* | `useLiveQuotes.ts:108-140` 收盘仍允许一次拉取；EOD 快照路径未改；本地已备快照（701,293B/29 只）且 dev server 正确返回 JSON；浏览器视觉待人工 | ui |
| D6 快照失败保留 last-good | PASS* | `App.tsx:136-150` 逻辑与基线一致（失败 setReportError、缓存不清）；生产 SW 缓存导致提示可能不出现的风险见 P1-8 | ui |
| E1 六视图完整 | PASS* | `App.tsx:36-43`（六视图）、`:485-487`（底部导航）未改；点击走查待人工 | ui |
| E2 今日页信息层级 | PASS* | `App.tsx:288-368`：状态条/报告条/公开清单/研究/hero/筛选/盘前纪律/风险预算齐全；视觉对比待人工 | ui |
| E3 策略卡盘中增强 | PASS* | `StrategyCard.tsx:40-105`：现价+时间、触发/保护/目标、距触发/保护/目标、命中横幅+高亮、无价位 `—`；视觉待人工 | ui+signals |
| E4 盘中状态条 | PASS* | `MarketStatusBar.tsx:61-98`：phase 徽标、最近报价、数据年龄、覆盖数、自动刷新开关、手动刷新；视觉待人工 | ui+data |
| E5 移动端布局 | **PENDING** | 静态证据：`App.css:168-171,367-375`（六 tab/safe-area）、`:526-534`（新组件小屏适配）；**无 headless 浏览器，需真机/DevTools 走查** | ui |
| E8 原交互浏览器回归 | **PENDING** | 自动部分：stockImport/snapshot/signals 测试通过、localStorage 键未变（`useLocalData.ts:5`）、相关代码未改；**添加/编辑/导入导出/回测播放等点击流程需人工** | ui+build |
| E9 回测/EOD 语义不变 | PASS | `src/lib/strategy.ts`、`src/lib/backtest.ts` 未被修改（git status）；`tests/signals.test.mjs` 通过；`check_baseline` B-10/11/12/13 通过 | signals+build |
| F5 范围/依赖卫生 | PASS | 6 改 + 12 新文件均落在 task 声明作用域；`types/index.ts` 仅追加盘中契约；未改依赖 | Lead |

## 3. 集成点专项检查（Lead 指定 5 点）

| # | 检查点 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | `codes` 选择：`data.stocks` 空时用 `report.quotes` | **通过（代码级）** | `App.tsx:88-92`：`stockCodes.length ? stockCodes : Object.keys(report?.quotes ?? {})`，去重 + 6 位过滤；快照就绪后 key 变化会自动触发首次拉取。**产品口径待确认**：有个人清单时只订阅个人代码，公开清单其余代码不显示实时价（显示 EOD），见 P1-7 |
| 2 | 自动刷新关闭时手动刷新 pulse | **通过（代码级）** | `App.tsx:80-81,104-117,94`：关自动→`manualLiveRefresh=true` 短暂启用订阅，`liveLoading` 结束后 0ms 复位；`useLiveQuotes.ts:47-89,91-146` enabled 变化触发一次 `poll()`、禁用即清理定时器；无残留轮询风险（代码审阅），浏览器 Network 待人工确认 |
| 3 | phase 盘前→开盘切换 | **通过（代码级，有延迟说明）** | `App.tsx:82-86` 15s `phaseTick` + `:99` `getMarketPhase()` 重算显示相位；数据层 `useLiveQuotes.ts:127-138` 非交易时段只做相位看门（preopen 60s），进入 auction/trading 才拉行情。显示 ≤15s 切换；开盘后首次行情可能再等最多 ~60s（P1-4） |
| 4 | 收盘「收盘」标记不冒充实时 | **通过（代码级）** | `quote-utils.ts:20-26`（closed/non-trading→“收盘”）、`LivePrice.tsx:54-63`（`displayLive = live && tag.live`）、`PublicStocks.tsx:22-24`（非 live 相位显示“收盘日线，非实时”）、`StrategyCard.tsx:58-60`（非 live 相位回落到“自动日线 · tradeDate”）、`MarketStatusBar.tsx:13` |
| 5 | 陈旧价（>2min）展示“可能延迟” | **通过（代码级）** | `MarketStatusBar.tsx:57-59`：`isLivePricePhase(phase) && updatedAt` 且年龄 >2min → “盘中报价可能延迟，请注意数据年龄”；`updatedAt` 取 provider 的 `latestLiveQuoteAt`（`App.tsx:101-102,290`）；数据层 `live.ts:428-460` 在 live 相位直接拒绝陈旧报价 |

## 4. 问题分级

### P0 阻塞：**无**

### P1 建议（发布前修或书面豁免）

| 编号 | 问题 | 影响/场景 | 责任域 | 建议 |
| --- | --- | --- | --- | --- |
| P1-1 | **数据源失败时保留的旧报价仍标「盘中」**：`useLiveQuotes.ts:72-79` 用 `result.quotes[code] ?? current[code]` 保留旧价；`MarketStatusBar.tsx:74` 的“覆盖 N/N”把旧价算作覆盖；同组件 `:87-90` 却写“仅显示可用数据，不用旧报价冒充实时” | 交易中数据源全挂后 0–2 分钟内，旧价仍带「盘中」标签；状态条文案与事实不一致 | ui（显示）+ data（状态） | 对 `errors[code]` 的报价不显示「盘中」标签（改「最后报价/缓存」），覆盖数只统计本次成功 |
| P1-2 | **时段边界竞态**：`live.ts:601` 在请求开始时快照 phase；跨 11:30/15:00 返回的行情仍带旧 phase，`alerts.ts:245` 可能据此在边界后数秒产生一次提醒 | 午休/收盘边界极窄窗口可能误报一次 | data+signals | 响应后重算 `getMarketPhase()` 覆盖 quote.phase，或 alerts 用墙钟相位二次校验 |
| P1-3 | **集合竞价（09:15–09:25）provider 时间戳待实测**：腾讯字段 30 在竞价时段是否更新未知；若停留在昨收/上一时点，`live.ts:633-640` 会在 auction 拒掉全部报价（UI 显示“集合竞价 + 0 只报价 + N 只失败”） | 竞价提醒可能完全失效 | data | 盘中 09:15-09:25 实测；必要时对 auction 放宽 stale 窗口或用东财 f124 |
| P1-4 | **09:25–09:30 判 preopen，开盘后首次行情最多延迟 ~60s**：`live.ts:74-75`（测试锁定）+ `useLiveQuotes.ts:120-137` preopen 看门 60s | 09:30 开盘后提醒/价格最多晚 ~1 分钟 | data | 09:25-09:30 或 09:29 起缩短相位看门间隔（如 15s） |
| P1-5 | **快照日期与实时收盘价日期可能不一致**：15:00–16:45 快照未更新时，`PublicStocks.tsx:22-27` 标题“交易日 {昨日} · 收盘日线，非实时”，而价格为今日收盘（实时层「收盘」标签） | 用户对“交易日”理解歧义 | ui | 价格旁或标题区分“快照交易日 / 最新收盘日” |
| P1-6 | **无个人清单时提醒功能恒为空**：`App.tsx:68-71,88-92` 无策略；公开 signals 无价位；但 `LiveAlertsPanel.tsx:108-115` 空状态写“价格触及触发价…会记录”，未说明需个人清单 | 首次用户以为提醒坏了 | ui+signals | 空状态补充“添加个人清单并生成策略后启用提醒” |
| P1-7 | **`liveUpdatedAt` 是抓取时间而非行情时间**（`useLiveQuotes.ts:81`），无报价时 `App.tsx:290` 用它兜底显示「最近报价」 | 失败/无报价时可能显示“最近报价 = 刚才”，误导 | data+ui | 无 provider 报价时显示 `—`，仅用 `latestLiveQuoteAt` |
| P1-8 | **生产 SW 缓存使 D6“更新失败”提示可能不出现**（pre-existing）：`public/sw.js` 成功响应即 `cache.put`，网络失败回退缓存 → `App.tsx:136-150` 以为 fetch 成功 | Pages 上快照失败可能无“更新失败”提示（但交易日/年龄仍可见） | build+ui | Pages 验收专项确认；必要时对 `data/latest.json` 禁用 SW 缓存 |

### P2 观察（可后续）

| 编号 | 观察 | 责任域 |
| --- | --- | --- |
| P2-1 | id 含 tradeDate → 同一天同一 (code,kind) 只提醒一次，5 分钟节流在实际流程中几乎不会再放行（`alerts.ts:238-255` 先查 seen）。与 UI“同一天同一类只记录一次”一致，但与“5 分钟后可再次提醒”测试语义有落差，建议确认预期 | signals |
| P2-2 | 非持仓的 breakout/pullback 计划也有 stop/target，价格穿越会发“保护位失守/分批止盈”类提醒（`live-signals.ts:28-38`），对未持仓用户略误导；建议按 `status==='holding'` 分级文案 | signals+ui |
| P2-3 | `isStale` 用 `Math.abs`，未来时间戳也判陈旧；时钟异常时 errors 文案“已 0 秒未更新”有歧义（伪时钟 e2e 中出现） | data |
| P2-4 | `phaseTick` 每 15s 触发整棵 App 重渲染，无 memo；当前规模可接受 | ui |
| P2-5 | 腾讯 `amount` 用“万元”字段换算（e2e：8,223,840,000 vs 新浪 8,223,838,967，约 0.00004% 舍入差）；不参与策略计算，仅展示层面 | data |

## 5. 待人工 / 盘中复测清单

1. **E5 移动端**：375×667 / 390×844 / 430×932，`document.documentElement.scrollWidth <= innerWidth`；底部六 tab、safe-area、提醒面板。
2. **E8 浏览器交互**：添加/编辑/删除、手动行情、JSON/Markdown/ZIP 导入导出、清空数据、回测播放与拖动、策略详情弹窗、风险参数滑块；旧 localStorage（`ashare-daily-strategy-v1`）可读。
3. **视觉确认**：B1/E1-E4/E6/E7（与线上原站并排对比；桌面 1440/1920；键盘 Tab/aria）。
4. **提醒实弹**：C1-C3/C9-C11（DevTools Override 行情或按 `tests/acceptance/README.md` §5.2/5.3 构造命中；Notification 权限 granted/denied/unsupported；iOS 主屏幕；提示音）。
5. **盘中窗口**：09:15-09:25 竞价（P1-3）、09:25→09:30→09:30+ 开盘（P1-4）、11:30/13:00 边界、15:00 收盘后；B1/B2/B7/B8 的真实 Network 观察。
6. **D2/D4 收盘后浏览器**：当前 23:52 可直接验（已备快照：应显示“已收盘/收盘价/数据年龄/覆盖 29/29”，无提醒）。
7. **F1 离线、F3 Pages 生产 SW（P1-8）、F4 CI Node 22**。

## 6. 本轮环境实测附录

**网络（2026-11-23 23:45，本机）**

- `curl https://push2.eastmoney.com/api/qt/ulist.np/get?...` → `curl (52) Empty reply from server`（反爬，与 Lead 说明一致）。
- `curl https://qt.gtimg.cn/q=sh600519,sz000001` → `200`、`content-type: text/html; charset=GBK`、`access-control-allow-origin: *`；GBK 解码正常。
- 新浪交叉校验：`hq.sinajs.cn` 600519=1439.000 / 000001=12.340，与腾讯一致（时间戳各源不同：腾讯 16:14–16:15，新浪 15:34–15:36，均为盘后快照）。

**真实 `fetchLiveQuotes` 端到端（模拟浏览器 script 注入，未改应用代码）**

```
requested 29 / got 29 / errors {} / providers {tencent: 29} / elapsed 3.29s
29/29 价格 == public/data/latest.json 收盘价
updatedAt 2026-11-23T08:14:15Z ~ 08:15:00Z（北京 16:14–16:15）
伪“交易中”时钟下：got 0，29 只全部 “拒绝作为实时报价”（stale 守卫生效）
```

**本地验收快照**

- 已准备 `public/data/latest.json`（701,293 B，`tradeDate=2026-11-23`、29 quotes、29 signals），来自线上最新发布；`git check-ignore` 确认被忽略，不会入库。
- dev server `http://localhost:3000` 返回 `200`；`/data/latest.json` 现为 `application/json`（准备前因 Vite SPA fallback 返回 HTML，应用会显示“暂无报告”，人工验收前必须备好该文件）。
- 注意：本轮**未**记录浏览器渲染结果；`PASS*` 项不得当作人工验收已完成。

## 7. 建议下一步

1. Lead 复核本报告 P1 清单，决定「发布前修 / 豁免」；建议至少处理 P1-1、P1-2、P1-6（均为小改动）。
2. 用户按 [`tests/acceptance/README.md`](../tests/acceptance/README.md) 做浏览器/移动端人工验收；开盘窗口补测 P1-3/P1-4 与 B2 真实浏览器 Network。
3. 人工验收通过后，把 §2 表中 `PASS*`、`PENDING` 项更新为最终结论；当前**不存在需要回滚的 P0 问题**。
