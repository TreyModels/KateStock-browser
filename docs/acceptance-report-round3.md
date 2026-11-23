# 第三轮·修复复核报告（qa-verifier）

- 复核对象：P1-1 / P1-2 / P1-4 / P1-6 / P1-7 / P2-1 / P2-2（+ 顺带修 P1-5、P2-3、P2-4）
- 时间：2026-11-23 23:55–24:05（Asia/Shanghai，**已收盘**）；报告定稿 2026-11-24 00:2x（已跨日，当前为**盘前** preopen，仍无盘中窗口）
- 环境：macOS / Node v26.12.0；dev server <http://localhost:3000> 200；`public/data/latest.json` 200 `application/json`（685K/29 只，已被 gitignore）
- 边界：只读复核、未改应用代码；本报告与 `docs/acceptance.md` / `tests/acceptance/README.md` 的文档同步除外。

## 0. 结论

- **新增 1 个 P0 语义回归（N-1）**：`P2-2` 的「按 action 推断持仓」会把**持仓股的止损/目标提醒误过滤掉**（持仓在 EOD 里常见 `pullback/breakout` 动作），与「持仓才 stop/target」目标相反。**建议修复后再做提醒功能验收**；不阻塞今晚「收盘后/闭市」静态走查。
- 其余 5 项 P1 + P2-1/P2-3/P2-4 均确认修复（多数为代码级通过，无组件测试，最终视觉/实弹仍需人工/盘中确认）。
- 自动门禁全绿：`verify.sh` PASS（build + lint + **58 tests** 0 fail）、基线不变量 **19/19**、Python **4 OK**、`check_public` PASS。
- P1-3（腾讯竞价字段）、P1-8（生产 SW 缓存）按指示维持「待盘中 / 待部署」。

## 1. 自动门禁（本轮实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 一键验证 | `cd /tmp && bash "<repo>/scripts/verify.sh"` | **PASS exit 0**：build PASS / lint PASS / node tests **58 pass 0 fail**（日志 `/var/folders/jb/km5070j9141659tyckdk886r0000gn/T/katestock-verify-20261123-235441.log`） |
| 基线不变量 | `node tests/acceptance/check_baseline.mjs` | **19/19 PASS** |
| Python | `python3 -m unittest discover -s tests` | **4 OK** |
| 发布结构/密钥 | `python3 scripts/check_public.py` | **PASS** |
| dev server | `curl localhost:3000` / `data/latest.json` | 200 / 200 application/json |

测试分布：`alerts.test.mjs` 26 + `live.test.mjs` 24 + `signals` 1 + `snapshot` 3 + `stockImport` 4 = 58。

## 2. 修复确认表

| 项 | 修复内容 | 代码证据 | 测试证据 | 复核 |
| --- | --- | --- | --- | --- |
| **P1-1 失败标注** | 状态条「成功 N / 失败 K · 订阅 M 只」；沿用报价标「上次报价 HH:mm:ss」琥珀色；交易时段无报价时 EOD 价标「收盘」 | `MarketStatusBar.tsx:25-34,61-67,79-86,98-106,110`；`LivePrice.tsx:21,39-42,61-72`；`App.tsx:106-109,295-307,422`；`StrategyCard.tsx:39-40,50,62-68,79`；`PublicStocks.tsx:52,57`；`App.css:468` | 无组件测试（项目无 jsdom/RTL）；纯逻辑已由代码审阅 | **PASS\***（代码级；视觉待人工） |
| **P1-2 跨时段 phase** | 数据层响应后按墙钟重算 phase；提醒层消费时用墙钟相位二次校验 | `live.ts:567-582`（`finalizeResponseQuotes`）、`:749-799`（runFetch 步骤 4）；`alerts.ts:239-268`（`getMarketPhase(now)`） | `live.test.mjs:386-425`（午休/收盘边界/仅 live 相位拒陈旧）；`alerts.test.mjs:243-293`（4 例，含反向墙钟优先） | **PASS** |
| **P1-4 开盘延迟** | `nextWakeAt` 精确唤醒：09:25–09:30→09:30、盘前→09:15、午休→13:00、收盘/周末→下一工作日 09:15；hook 相位看门改用 absolute wake | `live.ts:154-195`；`useLiveQuotes.ts:119-141` | `live.test.mjs:437-466`（09:26/09:25 边界、盘前/午休/收盘/周末、未来时刻断言） | **PASS** |
| **P1-5 快照/收盘日期**（上轮附带项，已顺带修） | 公开清单区分「快照交易日」与「最新收盘/最新报价」，并提示「快照尚未更新」 | `PublicStocks.tsx:24-49`；`App.css:409`（stale-note 样式） | 无组件测试 | **PASS\***（代码级） |
| **P1-6 提醒空状态** | 无个人策略时明确「提醒只针对个人清单…公开清单无价位不会提醒」 | `LiveAlertsPanel.tsx:16-18,38,115-119`；`App.tsx:357`（strategyCount）；`PublicStocks.tsx:48`（公开清单说明） | 无组件测试 | **PASS\***（代码级） |
| **P1-7 updatedAt** | hook `updatedAt` = 本批 provider 行情时间最大值（无报价 undefined）；新增 `lastAttemptAt`；UI 不再用抓取时间兜底 | `useLiveQuotes.ts:18-24,28-34,46-47,77,90-91,96,164`；`App.tsx:101-105`；`MarketStatusBar.tsx:19-22,67,80` | `live.test.mjs:427-436`（`latestQuoteUpdatedAt`）；真实网络 e2e：closed 批次 `latestQuoteUpdatedAt=2026-11-23T08:15:00.000Z`（provider 时间，非抓取时间） | **PASS** |
| **P2-1 当天一次** | 明确 id 去重为「当天一次」，5 分钟节流降级为兜底防抖；测试/注释同步 | `alerts.ts:16-37,223-288`；`alerts.test.mjs:191-241` | 重命名 + 新增兜底节流/跨日测试 | **PASS** |
| **P2-2 持仓语义** | 非持仓只发 trigger；持仓语义（hold/reduce/stop）才发 stop/target；evaluateLive 为唯一命中源 | `live-signals.ts:20-37,44-69`；UI 仅消费 `evaluateLive`（`StrategyCard.tsx:44`、`StrategyDetailDialog.tsx:31`），未绕过 | `alerts.test.mjs:71-159,337-366`（非持仓/持仓/watch 语义） | **FAIL（部分）→ N-1**：按 action 推断持仓，持仓股 action=breakout/pullback 时丢失 stop/target |
| **P2-3 时间戳文案** | 未来时间戳给出「晚于本机时间 N 秒」明确文案 | `live.ts:534-542` | `live.test.mjs:489-494` | **PASS** |
| **P2-4 15s 全页重渲染** | App 相位改为仅在相位真正变化时 setState（15s 轮询仅比较） | `App.tsx:82-90` | 无测试（代码级） | **PASS\***（代码级） |
| P1-3 腾讯竞价字段 | 竞价 stale 全拒时给明确 errors + annotation | `live.ts:584-602,788-792` | `live.test.mjs:467-487` | **维持待盘中实测** |
| P1-8 生产 SW 缓存 | 未改（按指示） | `public/sw.js` 现状 | — | **维持待部署** |

真实网络回归（round3 代码，临时 harness 模拟 script 注入，未改应用代码）：closed 相位 29/29 只经腾讯回退成功、0 errors、3.15s，29/29 价格与快照收盘价一致；伪时钟进入 auction/trading 时陈旧报价全部被拒且竞价错误带「未经实测」annotation。

## 3. 新发现问题

### N-1（P0，阻塞「提醒功能」验收；不阻塞今晚闭市走查）持仓股在 breakout/pullback 动作下丢失止损/目标提醒

- **现象**：`evaluateLive` 用 `Strategy.action` 推断持仓语义：`breakout/pullback` 一律视为非持仓 → 只保留 trigger，过滤 stop/target。但 `generateStrategy` 对**持仓股**同样可能产出 `breakout`/`pullback` 动作（`src/lib/strategy.ts` 未修改；`isHolding` 只影响 costStop/trendStop/overextended 分支），于是持仓股的止损/目标提醒被误过滤。
- **复现（真实策略引擎 + 真实形态日线）**：
  ```
  holding 股，上升趋势回踩 MA5 → action=pullback，stop=11.15，target=11.95，trigger=11.61
  现价 11.00（低于 stop 0.15） → evaluateLive.hits = []（旧逻辑=stop 命中）
  现价 12.05（高于 target 0.10） → evaluateLive.hits = ["trigger"]（旧逻辑=target 命中，现提示为「买入触发」）
  ```
  另一形态：holding 股突破前高 → `action=breakout`，现价低于 stop 时 hits 同样为 `[]`。
- **影响面**：`pullback` 是持仓股在上升趋势中的常见 EOD 状态（价格贴近 MA5）；`breakout` 出现在强势日。二者覆盖时，用户当天**收不到保护位/目标提醒**（可能收到含糊的「触发买点」），与「持仓才 stop/target」的目标相反；`scanAlerts` 与 UI 高亮同源，一起缺失。
- **根因**：`Strategy` 契约无「是否持仓」字段，只能从 action 反推；而 action 不能唯一反推持仓。
- **建议修复**（小改，二选一，保持 evaluateLive 唯一事实源）：
  1. `Strategy` 增加 `isHolding: boolean`（由 `generateStrategy` 依 `stock.status==='holding' && shares>0` 写入；Lead 维护 types），`evaluateLive` 用它：持仓 → stop/target；非持仓 → trigger；或
  2. `evaluateLive(strategy, quote, { holdingCodes })` / `scanAlerts(..., holdingCodes)` 传入 App 的持仓代码集合。
  并补测试：holding+pullback / holding+breakout 的 stop/target 命中；非持仓 entry action 仍然只 trigger。
- **责任域**：signals（evaluateLive）+ Lead（契约字段）；UI 无需改（保持消费 evaluateLive）。

### N-2（P2 文档）README 的时段刷新描述已过时
`README.md:22` 仍写「非交易时段自动降频（60s / 5min / 10min）」，而 round3 实际是 `nextWakeAt` 精确唤醒（09:15/09:30/13:00/下一工作日 09:15）。`docs/acceptance.md` B7 与 `tests/acceptance/README.md` 已由本轮同步，README 不在 qa 写作用域，建议 Lead/UI 顺手更新。责任域：build/文档。

### N-3（P2 文案）策略详情复制文本在闭市相位仍写「盘中现价」
`StrategyDetailDialog.tsx:47`：`liveQuote ? (staleLive ? '上次报价' : '盘中现价')` 未判断 phase；收盘后带 liveQuote 时复制文本会写「盘中现价」。界面内 `DialogDescription`/`LivePrice` 已正确（「含最近报价（收盘）」/「收盘」），仅复制文本口径不一致。建议非 live 相位改为「最近报价/收盘价」。责任域：ui。

### N-4（P2 细节）状态条失败数使用未过滤的 errors
`MarketStatusBar` 的 `failedCount = Object.keys(errors).length`，而 `successCount` 按当前 `liveCodes` 过滤；订阅代码集合切换的瞬间可能短暂显示「失败数」包含已移除代码。影响仅一帧级，建议 failed 也按 covered 过滤。责任域：ui/data。

### N-5（P2 待确认，上轮遗留）个人清单存在时只订阅个人代码
`App.tsx:92-96`：有个人清单时 `liveCodes` 只含个人代码，公开清单其余代码无实时价（显示 EOD）。这是 task-3 原始要求，但「公开清单是否也要盘中价」是产品口径问题，建议 Lead 确认。责任域：ui/Lead。

> 另注（非缺陷）：round3 起提醒层按墙钟相位放行，**闭市时即使 DevTools Override 报价也不会弹提醒**；本轮已把该限制写进 `docs/acceptance.md` 与 `tests/acceptance/README.md`，提醒实弹必须留到交易时段。

## 4. 剩余待人工 / 盘中 / 部署项

1. **N-1 修复后的回归验证**（holding+pullback/breakout 的 stop/target）——优先。
2. **提醒实弹**：C1-C3/C9-C11（真实交易时段；含浏览器通知权限 granted/denied/unsupported、iOS 主屏、提示音被自动播放策略拦截的静默兜底）。
3. **盘中窗口**：09:15–09:25 竞价（P1-3 腾讯字段）、09:25→09:30 精确开盘（P1-4 真实 Network）、11:30/13:00/15:00 边界、B1/B2/B7/B8 真实浏览器观察。
4. **视觉/真机**：B1/E1-E4 的渲染、E5 移动端（375/390/430、无横向滚动、六 tab、safe-area）、E6/E7（桌面/a11y）。
5. **浏览器交互回归**：E8（添加/编辑/删除、手动行情、导入导出、回测播放、弹窗、风险滑块、旧 localStorage 可读）。
6. **部署相关**：F1 离线、F4 CI Node 22、P1-8 生产 SW 缓存（`data/latest.json` 失败提示是否出现）。
7. **文档**：N-2 README 刷新描述；随后把 round1 acceptance 的 `PASS*`/`PENDING` 更新为最终结论。

## 5. 是否可以交用户做「收盘后人工走查」？

**可以（限闭市/盘前/EOD/UI 部分）**。当前环境已就绪：dev server 200、`/data/latest.json` 200 JSON（29 只、tradeDate 2026-11-23）；当前 00:2x 属 preopen，次日 09:15 自动唤醒。

今晚（闭市/盘前，无盘中窗口）可验：状态条（**23:xx 打开=「已收盘」；00:00 后打开=「盘前」**，两者均无提醒；最近报价 16:14–16:15:00（provider 盘后时间）/ 数据年龄约 7–8 小时 / 成功 29 / 失败 0 / 订阅 29）、PublicStocks（23:xx=「快照交易日/最新收盘 2026-11-23」＋卡片「收盘」；00:00 后=「快照交易日/最新报价 2026-11-23」＋卡片「盘前」）、报告状态条、公开清单信号、提醒面板空状态（无个人策略时应显示「提醒只针对个人清单…」）、股票页/回测/规则/设置、导入导出、移动端与桌面布局。

**预期现象，不是 bug**：① 夜间/凌晨「数据年龄」很大（约 7–8 小时）；② 00:00 后徽标自动变「盘前」，此时仍显示上一交易日收盘价且不轮询；③ 无个人清单时策略卡为空、无提醒；④ 不会出现任何盘中提醒/通知（墙钟非 auction/trading，属设计行为）。

今晚**不能**验：提醒弹窗/通知/声音、实时轮询、竞价/开盘、失败降级（需断网/Override 时注意提醒不会触发）、真实 `盘中报价 HH:mm:ss`（camera 显示为「收盘」属正确）。

## 6. 建议下一步

1. 修 **N-1**（Lead 契约加 `isHolding` 或传 heldCodes）+ 补两条测试 → qa 复验后再宣布「提醒功能」完成。
2. 用户按上述闭市清单走查 UI/EOD；交易时段再做提醒实弹与竞价/开盘复测。
3. 修 N-2/N-3（小）后可进入最终验收；N-4/N-5 可记录为后续。

---

## Round 4 复核（2026-11-24 07:05，N-1 修复确认）

- **N-1 关闭（PASS）**：`Strategy.isHolding?` 契约（types/index.ts:75），`generateStrategy` 透传（strategy.ts:51,140，diff 仅新增该字段、不改价位算法）；`isHoldingStrategy` 优先 isHolding、旧数据回退 action（live-signals.ts:41-46、53-57）。上一轮复现用例现返回：holding+pullback 现价 11.00<stop → `hits=["stop"]`；12.05>target → `hits=["target"]`（不再误发 trigger）；非持仓/watch 语义保持。测试：signals 1→3（isHolding 写入、EOD 算法不变）、alerts 26→33（holding+pullback/breakout、旧数据回退、watch）；targeted 36/36 pass。
- **N-3 关闭**：详情复制文本按相位区分「盘中现价 / 最新价格（收盘） / 上次报价」（StrategyDetailDialog.tsx:37-38,50）；微余项：preopen/lunch 也显示「最新价格（收盘）」，属 P2 文案小瑕疵。
- **N-4 关闭**：状态条失败数改用 App 按订阅过滤的 `failedCodes`（App.tsx:115,308,399；MarketStatusBar.tsx:24-30,62），与成功数同口径。
- **N-5 关闭（无新问题）**：订阅改为「个人 ∪ 公开」去重、上限 80、个人优先（App.tsx:49,96-101）。请求次数实测：80 只 → push2 批量 **1** 次 + 腾讯回退 script **1** 次（无逐只放大），最长 URL 839 字符；live 报价不写 localStorage、第三方仍只有东财/腾讯，新增的只是已公开的 29 只清单代码，无新增私密数据。微余项：个人代码 >51 时公开清单实时价会被截断（P2）。
- **门禁**：`verify.sh` PASS（build + lint + **67 tests** 0 fail）、`check_baseline` 19/19、dev server 200、`/data/latest.json` 200 JSON。
- **结论**：无新阻塞；N-1 已关闭。提醒功能可宣布为「已就绪，**待盘中实弹验证**」（通知/声音/竞价/开盘/边界与移动端视觉仍待人工；P1-3、P1-8 维持待盘中/待部署）。
