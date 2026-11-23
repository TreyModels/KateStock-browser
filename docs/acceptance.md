# 验收清单：看板复刻 + 盘中提醒（KateStock / 日内）

> 配套文件：[`docs/baseline.md`](./baseline.md)（原站行为基线）、[`scripts/verify.sh`](../scripts/verify.sh)（自动化门禁）、[`tests/acceptance/README.md`](../tests/acceptance/README.md)（手工验收步骤）。
> 版本：第 1 轮（基线+清单），最终复验在 Lead 集成完成后由 qa-verifier 执行。
> 判定口径：**P0 = 阻塞发布**（任一失败不得宣布完成）；**P1 = 发布前应修复或由 Lead 书面豁免**；**P2 = 可记录为后续项**。

## 0. 使用说明

- **环境**：仓库根目录（`kate-dashboard/`）；`PATH=/opt/homebrew/bin:$PATH`；不得 `npm install`（`node_modules` 是符号链接）；所有时间均为**北京时间（Asia/Shanghai）**。
- **自动项**：`bash scripts/verify.sh` 或清单中给出的单测命令；单测必须**离线可跑**，不得依赖网络。
- **手工项**：`npm run dev`（Vite 固定端口 **3000**，见 `vite.config.ts` 的 `server.port`），并按 [`tests/acceptance/README.md`](../tests/acceptance/README.md) 准备 `public/data/latest.json`。
- **证据**：每条失败项记录 `ID + 时间 + 页面阶段 + 截图/Network 请求 + 实际结果`；自动项记录命令与输出摘要。
- **责任域**：`data` = data-live（task-1：`src/lib/live.ts`、`src/hooks/useLiveQuotes.ts`）、`signals` = signals-alerts（task-2：`src/lib/live-signals.ts`、`src/lib/alerts.ts`、`src/hooks/useLiveAlerts.ts`）、`ui` = ui-dashboard（task-3：`src/App.tsx`、`src/components/**`、`src/App.css`）、`build` = Lead 集成（门禁/合并/全量回归）。跨域问题由 Lead 仲裁，但必须定位到具体域。

### 时段与预期（手工验收基准）

| 北京时间 | 阶段 | 自动轮询 | 允许提醒 | 页面应标注 |
| --- | --- | --- | --- | --- |
| 09:00–09:15（工作日） | preopen | 边界唤醒至 09:15 | 否 | 盘前 |
| 09:15–09:25 | auction | 15s | 是 | 集合竞价 |
| 09:25–09:30 | auction（归并方式以 `tests/live.test.mjs` 断言为准） | 15s | 是 | 集合竞价 |
| 09:30–11:30 | trading | 15s | 是 | 交易中 |
| 11:30–13:00 | lunch | 边界唤醒至 13:00 | 否 | 午休 |
| 13:00–15:00 | trading | 15s | 是 | 交易中 |
| 15:00–次日 09:00（工作日） | closed | 边界唤醒至下一工作日 09:15 | 否 | 已收盘 |
| 周六/周日（及可识别的节假日） | non-trading | 边界唤醒至下一工作日 09:15 | 否 | 非交易日 |

边界必须至少断言：`09:14 ≠ trading`、`09:15 = auction`、`09:30 = trading`、`11:30 = lunch`、`13:00 = trading`、`15:00 = closed`、周末 = `non-trading`。

---

## A. 构建、回归与不可破坏约束（build / Lead）

- [ ] **A1 `npm run build` 通过**（P0，责任：build）
  - 怎么验：`cd kate-dashboard && PATH=/opt/homebrew/bin:$PATH npm run build`
  - 期望：exit 0；`tsc -b` 无类型错误；生成 `dist/`；无未解析 import。
- [ ] **A2 `npm run lint` 通过**（P0，责任：build + 各域）
  - 怎么验：`npm run lint`
  - 期望：exit 0；0 error（warning 需在报告中列出并说明）。
- [ ] **A3 既有 node 测试全部通过且基线 3 个测试仍在**（P0，责任：build + signals）
  - 怎么验：`node --experimental-strip-types --test tests/*.test.mjs`
  - 期望：`tests/signals.test.mjs`、`tests/snapshot.test.mjs`、`tests/stockImport.test.mjs` 存在且 pass；新增 `tests/live.test.mjs`、`tests/alerts.test.mjs` 也 pass。禁止删除/弱化既有断言。
- [ ] **A4 新增测试离线且覆盖关键分支**（P0，责任：data + signals）
  - 怎么验：断网（或 `https_proxy=http://127.0.0.1:9` 等无效代理）跑 A3；再阅读测试断言。
  - 期望：`live.test.mjs` 覆盖批量解析/缩放/回退/时段边界/陈旧拒绝；`alerts.test.mjs` 覆盖重复命中、跨日重置、陈旧报价、权限缺失；全部离线通过。
- [ ] **A5 Python 回归未破坏**（P1，责任：build）
  - 怎么验：`cd kate-dashboard && python3 -m unittest discover -s tests`
  - 期望：4 tests OK（`tests/test_ingest.py` 的 16:45 边界、`tests/test_ai.py` 的边界校验）。`scripts/verify.sh` 不含此步，需单独跑。
- [ ] **A6 `scripts/verify.sh` 一键门禁可执行**（P0，责任：build）
  - 怎么验：仓库根执行 `bash scripts/verify.sh`；再从任意目录执行 `cd /tmp && bash "/绝对路径/kate-dashboard/scripts/verify.sh"`。
  - 期望：两种方式都能切到仓库根并跑 build → lint → node tests；全绿 exit 0；任一失败 exit ≠0 且明确指出失败步骤。脚本不修改工作区（除 `dist/` 构建产物外）。
- [ ] **A7 基线不变量检查**（P0，责任：build；隐私/EOD 语义护栏）
  - 怎么验：`node tests/acceptance/check_baseline.mjs`
  - 期望：exit 0。检查项：`src/data/initialStocks.ts` 仍为空数组；`market.ts` 仍 `klt: '101'`；`ingest.py` 仍 16:45 门槛；cron 仍 16:45/07:05；`public-universe.json` 仍 29 项；`backtest.ts` 仍次日开盘成交（`bar.open * (1 + COST)`）；快照 schema 字段未删。
- [ ] **A8 改动范围与依赖卫生**（P0，责任：build/Lead）
  - 怎么验：`git status --short`、`git diff`。
  - 期望：只改各任务声明文件；没有 `package.json` 依赖变更；`node_modules` 仍是符号链接、未 `npm install`；无 `.env`/密钥/数据文件入库；`public/data/` 未提交。

---

## B. 盘中行情层（data + ui）

- [ ] **B1 盘中价格可见且带时间戳**（P0，责任：ui 显示 + data 供数）
  - 怎么验：交易时段打开今日页与股票页，对照 DevTools Network 中报价响应时间。
  - 期望：策略卡/清单的盘中价格旁**可见行情时间**（如 `14:32:15` 或「12 秒前」类年龄标注）；时间随轮询更新；不再只有 `tradeDate` 日期。**只有日期或只有快照 generatedAt = 不通过**。
- [ ] **B2 报价确实来自实时接口**（P0，责任：data）
  - 怎么验：交易时段 Network 过滤 `push2.eastmoney.com`；与东财/腾讯 App 或 `qt.gtimg.cn/q=` 手工对照 1-2 只。
  - 期望：存在 `api/qt/ulist.np/get` 批量请求（间隔约 15s，交易中）；价格与外部行情在轮询延迟内一致。若整页只请求 `data/latest.json`、价格等于 EOD 收盘价 → 不通过。
- [ ] **B3 批量请求与失败回退次数受控**（P1，责任：data）
  - 怎么验：选 5 只以上标的观察 Network。
  - 期望：主源单次调用最多 1 个批量请求；仅失败标的才走 stock.get/gtimg 回退；无「每只一个请求」的请求风暴。
- [ ] **B4 回退链与「不返回旧数据冒充实时」**（P1，责任：data + ui）
  - 怎么验：DevTools Request Blocking 分别 block `*ulist.np*` → 再 block `*stock/get*` → 再 block `*qt.gtimg.cn*`。
  - 期望：逐级回退生效；单只失败进入 errors 且 UI 不把旧价标为实时；全部失败时显示「行情不可用/降级 + 最后更新时间」。禁止：接口失败后价格仍显示为最新并继续跳动。
- [ ] **B5 超时、退避与冷却**（P1，责任：data）
  - 怎么验：DevTools 设为 Slow/Offline 或 block 主源，观察 30-60 秒。
  - 期望：单请求 8-10s 内超时；连续失败后请求间隔增大/暂停（冷却）；网络恢复后自动恢复轮询；页面不卡死、控制台无未捕获异常。
- [ ] **B6 时段判定正确**（P0，责任：data + ui）
  - 怎么验：`node --experimental-strip-types --test tests/live.test.mjs`（边界）+ 真实窗口人工核对徽标。
  - 期望：见 §0 时段表的边界断言；UI 徽标与 data 层 phase 一致；不得把午休标成交易中。
- [ ] **B7 自动轮询只在 auction/trading**（P0，责任：data）
  - 怎么验：交易中观察 15s 间隔；11:30/13:00/15:00 边界观察是否在边界时刻唤醒；关闭「自动刷新」开关后 Network 不再新增轮询。
  - 期望：仅 auction/trading 自动轮询（15s）；非交易时段不轮询行情，只用 `nextWakeAt` 精确唤醒到 09:15/13:00/下一工作日 09:15（**round3 起不再使用 60s/5min/10min 固定间隔**，`nextPollDelay` 保留为契约兜底）；关闭开关后手动刷新仍可用（pulse 语义）；离开页面/卸载后无残留定时器。
- [ ] **B8 报价新鲜度可见**（P0，责任：ui + data）
  - 怎么验：页面状态条与卡片时间戳；人为 block 行情接口后观察。
  - 期望：显示「最近报价时间/数据年龄」；数据年龄增长清晰可见；超过 2 分钟未更新的报价在 UI 或提醒层被明确标记/拒绝（见 C8）。
- [ ] **B9 代码覆盖：公开清单 + 个人自选**（P1，责任：ui + data）
  - 怎么验：清空个人数据（或新隐身窗口）→ 无个人股票时观察实时请求的 codes；再从股票页添加一只不在 29 只清单的代码（如 600519，需手动/自动行情）。
  - 期望：无个人清单时回退到 `report.quotes` 的代码，实时价可见；加入清单后该代码也参与实时；无 EOD bars 时页面不崩、不显示编造的 trigger/stop/target、不产生提醒。
- [ ] **B10 数据源失败时明确降级、不冒充实时**（P0，责任：data + ui）
  - 怎么验：DevTools 全断网 / block 所有行情 API 与 `data/latest.json`，刷新与等待轮询。
  - 期望：页面明确显示「行情不可用/数据降级 + 最后更新时间」；实时徽标不得仍显示「交易中」；价格不再伪装为最新（隐藏或标记陈旧）；不产生提醒；EOD 快照仍可读。禁止：接口全挂但界面看起来一切正常、价格仍像实时。

---

## C. 信号与提醒层（signals + ui）

- [ ] **C1 触发命中提醒**（P0，责任：signals + ui）
  - 怎么验：单测覆盖 `evaluateLive` 的 trigger 命中；手工用 DevTools 覆盖报价响应，把某只 `breakout/pullback` 的价格改到 `trigger` 上方，等下一轮轮询。
  - 期望：toast + 提醒面板出现「触发」事件；含代码/名称、类型、价位、触发时价格、时间、消息；策略卡对应项高亮并显示命中类型。
- [ ] **C2 止损命中提醒**（P0，责任：signals + ui）
  - 怎么验：单测覆盖；手工把持仓股（`status='holding'`，有 cost/shares）现价压到 `stop` 下方（可临时把成本填高，使 `costStop` 成立）。
  - 期望：出现「止损」提醒；优先级高于目标/触发。
- [ ] **C3 目标命中提醒**（P0，责任：signals + ui）
  - 怎么验：单测覆盖；手工把持仓股现价抬到 `target` 上方（DevTools Override）。
  - 期望：出现「目标」提醒；含价位与时间。
- [ ] **C4 命中优先级与顺序**（P0，责任：signals）
  - 怎么验：单测构造同一报价同时满足 stop/target/trigger。
  - 期望：顺序固定 `止损 > 目标 > 触发`；不会对同一报价并发弹出矛盾提醒；`hits` 数组顺序符合契约。
- [ ] **C5 提醒去重（同 id 只一次）**（P0，责任：signals）
  - 怎么验：单测 + 手工让同一命中持续 2 个以上轮询周期。
  - 期望：事件 id 为 `${code}:${kind}:${tradeDate}`；同一 id 只产生一次 toast/Notification/面板条目；不因轮询重复爆炸。
- [ ] **C6 5 分钟节流与跨日重置**（P0，责任：signals）
  - 怎么验：单测固定时间；手工刷新页面后重复命中。
  - 期望：同 `(code, kind)` 5 分钟内不重复；跨 `tradeDate` 可再次提醒；已见集合持久化（localStorage 带版本号），刷新页面不重放旧提醒。
- [ ] **C7 无价位/无策略不提醒**（P0，责任：signals + ui）
  - 怎么验：单测覆盖 watch/无 trigger/stop/target 的策略；页面上观察这类卡片。
  - 期望：不产生任何提醒；卡片价位显示 `—`，不显示命中高亮。
- [ ] **C8 陈旧报价不提醒**（P0，责任：signals + ui）
  - 怎么验：单测构造 `updatedAt` 距今 >2 分钟；手工 block 行情接口后等待。
  - 期望：旧报价不产生提醒；UI 标注数据年龄/陈旧；不得用昨日收盘价触发今日提醒。
- [ ] **C9 提醒面板可用**（P1，责任：ui）
  - 怎么验：命中后打开「盘中提醒」面板。
  - 期望：列表含时间/代码/类型/价位/消息；单条 dismiss；全部清空；空状态文案合理；刷新页面后按持久化策略表现一致（不重复旧提醒）。
- [ ] **C10 浏览器通知（含权限失败兜底）**（P1，责任：ui + signals）
  - 怎么验：桌面 Chrome 点「开启通知」，分别测试 granted / denied / 不支持（Safari 私密窗口）三种情况；iOS 记录是否需「添加到主屏幕」。
  - 期望：granted 时命中同时发 Notification；denied/不支持时 toast 仍出现、无异常；权限请求只在用户点击后发生。iOS 限制写入验收记录，不阻塞（toast 兜底）。
- [ ] **C11 声音开关**（P1，责任：signals + ui）
  - 怎么验：切换声音开关后命中；未交互直接命中（浏览器自动播放策略）。
  - 期望：开启时短提示音；被策略拦截/失败时静默，不崩溃、不阻塞提醒；默认状态在 UI 明确。
- [ ] **C12 文案合规、不误导**（P0，责任：ui）
  - 怎么验：阅读提醒面板/状态条/卡片文案。
  - 期望：使用「触发提醒/止损提醒/目标提醒」等，不写成「买入信号/保证收益/实时行情」；保留「不构成投资建议」类声明；价位与数据来源/时间可追溯。

---

## D. 非交易时段、收盘后与快照降级（signals + ui + data）

- [ ] **D1 午休不误报**（P0，责任：signals + ui）
  - 怎么验：11:30-13:00 观察（或用单测固定 phase=lunch）。
  - 期望：徽标「午休」；不产生新提醒；自动轮询降频；价格时间戳/年龄继续可见。
- [ ] **D2 收盘不误报、且 15:00-16:45 仍显示上一交易日语义**（P0，责任：signals + ui）
  - 怎么验：15:00 后观察徽标与提醒；对照 `docs/baseline.md` §3 的 16:45 门槛。
  - 期望：徽标「已收盘」；不产生新提醒；价格不得标为实时（可标「收盘」）；16:45 后 CI 尚未完成时页面不把上一交易日说成今天实时；快照更新后 `tradeDate` 正确前进。
- [ ] **D3 非交易日不误报**（P0，责任：signals + data + ui）
  - 怎么验：周末/节假日打开页面；单测断言 `phase=non-trading`。
  - 期望：徽标「非交易日」；无自动交易中轮询；无提醒；快照显示上一交易日 + 数据年龄；不得用上一交易日收盘价假装当日行情。
- [ ] **D4 收盘后仍可用**（P0，责任：ui）
  - 怎么验：15:00 后（及 16:45 后）刷新页面/重新加载。
  - 期望：EOD 快照、公开清单 29 只、策略卡、回测、规则、设置、导出全部可用；页面不空白；缓存 last-good 生效。
- [ ] **D5 快照更新成功路径**（P1，责任：ui + data）
  - 怎么验：替换 `public/data/latest.json` 为新版本（如用线上最新文件）后点「检查报告更新」。
  - 期望：`tradeDate/generatedAt/数据年龄/公开清单` 更新；个人手动行情不被快照覆盖（回归 `snapshot.test.mjs` 的合并规则）。
- [ ] **D6 快照拉取失败保留 last-good**（P0，责任：ui）
  - 怎么验：先成功加载快照，再移走/重命名 `public/data/latest.json`（或 block 请求），刷新并点「检查报告更新」。
  - 期望：显示缓存快照 + 「更新失败，保留上次有效快照」；不崩溃；EOD 仍可用；不得把旧缓存伪装成新数据。

---

## E. 看板复刻与可用性（ui）

- [ ] **E1 六视图完整可达**（P0，责任：ui）
  - 怎么验：桌面侧栏与移动底部导航逐一点击。
  - 期望：今日/股票/策略库/回测/策略/我的均可到达；核心模块（报告状态条、公开清单、回测、规则卡、设置）不丢失；无白屏/报错。
- [ ] **E2 今日页信息层级与基线一致**（P0，责任：ui）
  - 怎么验：对照 `docs/baseline.md` §1 与线上截图（<https://treymodels.github.io/KateStock-browser/>）。
  - 期望：快照状态条、公开清单行情、每日研究区、策略统计、信号筛选 tab、盘前纪律、风险预算仍按原有信息层级呈现；视觉风格（侧栏品牌「日内」、卡片、配色）未被破坏。
- [ ] **E3 策略卡盘中增强正确**（P0，责任：ui + signals）
  - 怎么验：交易时段看策略卡；对照触发/保护/目标与 `generateStrategy` 输出。
  - 期望：现价（带时间戳）与 EOD 语义可区分；展示触发/保护/目标 + 距触发 `%`；命中时高亮并显示类型；无价位显示 `—`；不挤压原布局。
- [ ] **E4 盘中状态条完整**（P0，责任：ui + data）
  - 怎么验：观察页面顶部。
  - 期望：MarketPhase 徽标、最近报价时间/数据年龄、自动刷新开关、手动刷新按钮齐全；状态与 B6 一致；开关真实控制轮询。
- [ ] **E5 移动端布局**（P0，责任：ui）
  - 怎么验：DevTools 375×667、390×844、430×932 竖屏；检查 `document.documentElement.scrollWidth <= window.innerWidth`；点击底部导航；观察提醒面板/卡片。
  - 期望：无横向滚动；底部六 tab 可见可点、触控区 ≥44px；safe-area 不遮挡；提醒面板可滚动可关闭；文字不溢出/不重叠。320 宽记录为 P2 遗留。
- [ ] **E6 桌面布局**（P1，责任：ui）
  - 怎么验：1440×900 与 1920×1080。
  - 期望：sidebar + 三栏网格不重叠；回测宽表格可横向滚动；长文本/长数字不破版。
- [ ] **E7 可访问性与文案**（P1，责任：ui）
  - 怎么验：键盘 Tab 走查、屏幕阅读器/aria 检查、文案审读。
  - 期望：状态条 `aria-live`；按钮有可读 label；涨跌不只靠颜色（有 +/- 与文字）；不承诺「实时行情」；错误/降级文案明确。
- [ ] **E8 原交互回归**（P0，责任：ui + build）
  - 怎么验：添加/编辑/删除股票、手动行情、导入导出 JSON/Markdown/ZIP、清空数据、回测播放与拖动、策略详情弹窗、风险参数即时重算；检查 localStorage 键 `ashare-daily-strategy-v1` 旧数据可读。
  - 期望：全部可用；升级后旧个人数据不丢失；无控制台异常。
- [ ] **E9 回测/EOD 语义不变**（P0，责任：signals + ui + build）
  - 怎么验：`tests/signals.test.mjs` 通过；用固定 bars fixture 对比回测四条策略结果与修改前一致（可保存基线的 scores/trades 哈希）；检查 `src/lib/strategy.ts`、`src/lib/backtest.ts` 未被改写语义。
  - 期望：收盘出信号/次日开盘执行/0.1% 单边成本/止损优先等口径不变；公开信号仍不含 sizing。
- [ ] **E10 PWA/版本刷新**（P2，责任：ui）
  - 怎么验：`npm run preview` + 安装 manifest；构建新版本后刷新。
  - 期望：可安装；`sw.js` 不会长期锁定旧 JS；刷新后拿到新代码。

---

## F. 部署、离线与安全（build / Lead）

- [ ] **F1 离线基本可用**（P1，责任：build + ui + data）
  - 怎么验：先在线加载一次 → DevTools Offline → 刷新/操作。
  - 期望：页面壳与 last-good 快照可读；实时层明确降级；无未捕获异常；提醒停用而不是误报。
- [ ] **F2 GitHub Pages 路径与 CORS 兼容**（P1，责任：build + data）
  - 怎么验：`vite.config.ts` `base: './'`；`npm run build && npm run preview` 从子路径打开；浏览器控制台检查实时接口 CORS。
  - 期望：资源与 `./data/latest.json` 相对路径正确；实时接口若被 CORS 拒绝则回退链生效（JSONP/script），不得静默失败。
- [ ] **F3 构建产物无私数据/密钥**（P1，责任：build）
  - 怎么验：准备 `public/data/latest.json` 后跑 `python scripts/check_public.py`；`grep` dist 无 `sk-` 等。
  - 期望：通过；`initialStocks` 仍为空；公开快照字段与 `check_public.py` 白名单一致。
- [ ] **F4 CI 等价（Node 22）**（P1，责任：build/Lead）
  - 怎么验：Lead 确认 CI（Node 22）上 build/lint/node tests 通过；本地 Node 26 的差异记录在验收报告。
  - 期望：无「本机过、CI 不过」；`--experimental-strip-types` 在两个版本都可用。
- [ ] **F5 任务范围与依赖卫生**（P0，责任：Lead）
  - 怎么验：`git diff --stat`、`git status`；核对共享任务 write_scopes。
  - 期望：所有改动落在声明作用域；无越权修改 `src/types/index.ts`（契约由 Lead 维护）；`node_modules` 符号链接未替换；未执行 `npm install`。

---

## 复验流程（Lead 集成完成后）

1. **门禁**：`bash scripts/verify.sh` 全绿；`node tests/acceptance/check_baseline.mjs` 通过；`python3 -m unittest discover -s tests` 通过。
2. **准备**：`npm run dev`（端口 3000）；按 `tests/acceptance/README.md` 放置 `public/data/latest.json`（来自线上或本地 ingest，`public/data/` 已被 gitignore，不得提交）。
3. **离线/静态项**：A、E1-E3、E8-E9、F1-F5 可随时验。
4. **盘中项**：B、C、D 依赖真实时段。若复验时不在交易时段：以单测（`tests/live.test.mjs`、`tests/alerts.test.mjs`，覆盖全部边界与去重）+ DevTools Override 报价覆盖 B1/B2/B10 的显示与降级；**提醒弹窗（C1-C3/C9-C11）从 round3 起按墙钟相位放行，闭市时 Override 也不会触发，必须留给真实交易时段**；真实盘中的 B2/B7/B8/C1-C3 记为「待盘中窗口复测」，不得用非交易时段的静态页面冒充通过。
5. **审查**：对每个 P0 项给出 PASS/FAIL/豁免（豁免须 Lead 书面同意并注明风险）；FAIL 必须落到责任域。
6. **不修改应用代码**：复验只读，发现问题写回报告/任务板，不直接改 `src/**`。

## 统计

- 总条目：51（P0: 35 / P1: 15 / P2: 1）
- 必覆盖项映射：盘中价格+时间戳 → B1；触发/止损/目标提醒 → C1/C2/C3；提醒去重 → C5/C6；午休/收盘/非交易日不误报 → D1/D2/D3；数据源失败明确降级 → B10；收盘后仍可用 → D4；移动端布局 → E5；build/lint/既有测试 → A1/A2/A3/A6。
