# 可视化验收报告（Playwright 截图自动化）

- 执行：qa-verifier，2026-11-24 07:0x–07:2x（Asia/Shanghai）
- 目标：把 E5（移动端布局）与 E1-E4 中「只能人工看」的项变成可复现存证；**不改应用代码**。
- 环境：dev server `http://localhost:3000`（Vite，`public/data/latest.json` 已就绪，29 只）；Node `/opt/homebrew/bin/node v26.12.0`；Playwright 1.65.1 + Chromium 159.0.8154.6，均装在 `/tmp`（仓库零污染）。
- 产物：截图 `docs/screenshots/*.png`（已 gitignore）、原始测量 `docs/screenshots/measurements.json`（已 gitignore）；脚本 [`scripts/screenshots.mjs`](../scripts/screenshots.mjs)。

## 0. 复现方式

```bash
# 一次性依赖（装在 /tmp，不写仓库）
mkdir -p /tmp/pw-tools /tmp/npm-cache /tmp/pw-browsers
cd /tmp/pw-tools && PATH=/opt/homebrew/bin:$PATH npm init -y
PATH=/opt/homebrew/bin:$PATH npm_config_cache=/tmp/npm-cache npm install playwright
PATH=/opt/homebrew/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium

# 跑截图（需 dev server 与 public/data/latest.json）
cd kate-dashboard
PATH=/opt/homebrew/bin:$PATH \
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
PLAYWRIGHT_MODULE=/tmp/pw-tools/node_modules/playwright \
node scripts/screenshots.mjs
```

脚本行为（不修改应用代码）：
- 用 `addInitScript` 注入 localStorage 种子（1 只持仓 159558 + 1 只自选 600110，均来自公开清单），并**固定 `Date`**（不改定时器）模拟时钟：
  - 闭市态 = `2026-11-24 15:50`（Beijing）；交易中 = `2026-11-24 10:00`（Beijing）。
- 交易场景用 Playwright `route` 提供「新鲜 push2 批量报价」（f124=模拟时刻，价格取自公开快照），用于展示 `盘中` 标签；随后 abort push2/gtimg 并点「刷新报价」，得到 `上次报价 HH:mm:ss` 的最坏标签状态。
- 每张图同时测量：横向滚动、元素溢出/裁切、触控目标尺寸、phase、价格标签、成功/失败/订阅、提醒面板文案、console/pageerror。

## 1. 截图与检查结论

| # | 截图（`docs/screenshots/`） | 视口/状态 | 检查项 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `desktop-1440x900-today-closed.png` | 1440×900，闭市（模拟 15:50） | 桌面三栏、状态条、公开清单、策略卡、提醒面板；无横向滚动/溢出 | **PASS**（横向滚动=false，溢出=0；徽标「已收盘」、最近报价/数据年龄/成功/失败/订阅可见） |
| 2 | `mobile-375x812-today-closed.png` | 375×812（iPhone 12 档），闭市 | 单列布局、底部六 tab、卡片堆叠、长文案换行 | **PASS**（无横向滚动/溢出） |
| 3 | `mobile-375x812-stocks-closed.png` | 375×812，股票页，闭市 | 搜索/筛选/更新、状态条 compact、股票行操作 | **PASS\***：布局正常；见 P2-2（FAB 遮挡当前视口行操作图标） |
| 4 | `mobile-320x568-today-closed.png` | 320×568 窄屏，闭市 | 最窄档标签/文案、六 tab、状态条 | **PASS**（无横向滚动/溢出） |
| 5 | `strategy-card-375-trading.png` | 策略卡特写，375，交易中（mock 新鲜报价） | 现价+盘中标签、触发/保护/目标、距触发%、「持仓」徽标、涨跌色 | **PASS**（「持仓」「盘中」清晰；无裁切） |
| 6 | `alerts-panel-375-trading.png` | 提醒面板特写，375，交易中 | 权限按钮、声音开关、空状态文案、免责声明 | **PASS**（空状态完整：「暂无盘中提醒。价格触及触发价、保护位或目标位时会自动记录在这里。」） |
| 7 | `mobile-375x812-today-trading.png` | 375×812，交易中（mock） | 盘中全局观感、公开清单 29 只「盘中」标签、状态条 | **PASS**（liveTag=31 = 29 公开 + 2 策略卡；无溢出） |
| 8 | `mobile-320x568-today-stale-labels.png` | 320×568，交易中刷新失败（最坏标签） | 「上次报价 HH:mm:ss」、成功/失败/订阅、错误横幅、换行 | **PASS**（31 个「上次报价 10:00:00」琥珀标签；`成功 0 / 失败 29 / 订阅 29`；无溢出） |
| 9 | `strategy-card-320-stale.png` | 策略卡特写，320，失败沿用 | 上次报价标签、距触发%、底部长文案换行 | **PASS**（标签换行不裁切；footer 两行完整） |
| 10 | `alerts-panel-320-stale.png` | 提醒面板特写，320，失败沿用 | 320 下权限/声音/空状态/免责声明 | **PASS**（无裁切；文案完整） |

补充：闭市态所有价格标签均为「收盘」（`liveTag=0`、`staleTag=0`），未出现「盘中」；正文中的「实时行情」仅出现在「非实时行情/不是实时行情/不冒充实时」等否定语境。

## 2. 自动化测量汇总

| 检查项 | 结果 |
| --- | --- |
| 横向滚动（`scrollWidth > innerWidth`） | **全部 false**（10 个场景/视口：320/375/1440 均无） |
| 元素溢出/裁切（关键选择器，含 `overflow:hidden` 且 `scrollWidth>clientWidth`） | **全部 0**（状态条、价格标签、策略卡、提醒面板、公开卡、底部导航、筛选 tab） |
| 徽标与时间可见 | 有（闭市「已收盘」；交易「交易中」；「最近报价 hh:mm:ss / 数据年龄 / 成功 失败 订阅」均在状态条内可见） |
| 闭市不冒充实时 | **PASS**：闭市截图价格标签 100% 为「收盘」，无「盘中/竞价」；面板空状态按「已收盘时段」解释 |
| 提醒面板空状态文案完整 | **PASS**：交易中/闭市两种空状态文案均完整显示（见 #6/#10） |
| console/pageerror | 仅 4 条 `ERR_FAILED`：来自 #8 场景**故意** abort 的 push2/gtimg 请求；无 `pageerror` |
| 触控目标（`button/[role=switch]/a.button`，测 CSS px） | 见 §3 P2-1：多数 ≥44；`.filter-tabs button` 40、`.stock-identity` 36、`.icon-button.subtle` 40×44；`.live-switch` 包装层 44（switch 本体 44×26，点击 label 即可） |

## 3. 发现的问题（仅记录，未改应用代码）

### P2-1（ui-dashboard）部分触控目标 <44px
- 证据：`App.css:54` `.filter-tabs button { min-height: 40px }`（全部/机会/风险/等待，320 下实测 68×40）；`App.css:103` `.stock-identity { min-height: 36px }`（320/375 实测 36 高）；`App.css:24` `.icon-button.subtle { width:40px; height:44px }`；`App.css:521` `.alert-dismiss { width:40px; height:44px }`。
- 影响：仍高于 WCAG 2.5.8 的 24px 底线，但与 Apple 44px 建议有差距；实际可点（左右留白），不影响本次布局结论。
- 建议：筛选 tab 提到 44 高、图标按钮统一 44×44、股票行身份按钮提到 44 高（或明确接受 40/36 为设计例外）。

### P2-2（ui-dashboard）移动端「添加股票」FAB 与股票行操作图标重叠
- 证据：`mobile-375x812-stocks-closed.png` 中，首屏股票行的设置/删除图标被右下角固定 FAB（`.mobile-fab`，`App.css:116`，`bottom: calc(78px + safe-area)`）部分遮挡；页面底部 padding 112px（`App.css:5`）略小于 FAB 顶部位置（约 126px），滚到底时最后一行操作也可能贴边。
- 影响：当前视口内点齿轮/删除需先滚动，属可恢复的遮挡；不阻塞。
- 建议：给 `.stock-list` / `.page-content` 增加约 24–32px 底部留白，或让 FAB 在股票页下移/隐藏。

### P2-3（说明，非缺陷）headless 通知权限状态
- 截图里提醒面板显示「通知被浏览器拒绝」：这是 **headless Chromium 默认 Notification 权限为 denied**；真实 Chrome 默认应为「开启浏览器通知」，iOS Safari 需主屏幕安装。真实权限交互仍需人工/真机确认（E7/C10 待人工）。

### 说明（非缺陷）模拟数据与时钟
- 闭市截图 #1-#4 的时间固定为 2026-11-24 15:50，故「数据年龄 23 小时」是模拟时钟与 provider 盘后时间的差值，不是 bug。
- 交易/失败态 #5-#10 的行情由被测前端 + Playwright route（push2 mock）驱动，用于**标签/布局**验收；真实盘中数据仍需盘中窗口复测。

## 4. 对验收清单的更新建议

- **E5（移动端布局）：PENDING → PASS\***。理由：320/375 均无横向滚动/溢出，徽标与时间可见，底部六 tab 正常，长标签（`上次报价 HH:mm:ss`、`成功/失败/订阅`、`持仓`）不挤压不裁切；遗留 P2-1/P2-2 为触控尺寸与 FAB 遮挡的非阻塞问题。
- **E1-E4（看板/状态条/策略卡/提醒面板）**：视觉层面 **PASS\***（桌面 + 移动 + 特写截图佐证）；功能交互仍以单测/人工为准。
- 真实设备（iOS Safari 字体/安全区）、生产构建（`npm run build` 后 `preview`）、真实通知权限仍需人工复测；P1-3/P1-8 维持待盘中/待部署。
