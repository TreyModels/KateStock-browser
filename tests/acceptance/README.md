# 手工验收步骤（本地 `npm run dev`）

> 本文件是 [`docs/acceptance.md`](../../docs/acceptance.md) 的**操作手册**：告诉我们「怎么点、怎么看、记录什么」。
> 自动门禁见 [`scripts/verify.sh`](../../scripts/verify.sh)；基线不变量见 [`check_baseline.mjs`](./check_baseline.mjs)。
> 约定：所有时间均为**北京时间**；验收只读，不得修改 `src/**` 来「让它通过」；发现问题记录到验收报告并指派责任域（data / signals / ui / build）。

---

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| 仓库 | `kate-dashboard/`（本文件向上两级） |
| 依赖 | 已由 Lead 安装；`node_modules` 是符号链接。**禁止 `npm install`**（会替换符号链接） |
| Node | 本机为 `/opt/homebrew/bin/node`（v26.x）；CI 为 Node 22。命令前加 `PATH=/opt/homebrew/bin:$PATH` |
| 浏览器 | Chrome 或 Edge 桌面版（DevTools 完整）；再准备一台 iPhone/Safari（真机或模拟器）验移动端 |
| 数据 | 本地仓库**没有** `public/data/latest.json`（CI 产物，`.gitignore` 排除），见 §2 |

---

## 1. 启动本地开发服务器

```bash
cd "/path/to/kate-dashboard"
PATH=/opt/homebrew/bin:$PATH npm run dev
```

- Vite 端口由 `vite.config.ts` 固定为 **3000**（不是 5173）：打开 <http://localhost:3000>。
- 首屏若提示「尚无可用的已发布快照」属**预期**（本地没有快照文件）；先做 §2。
- 改代码/切分支后请硬刷新（Cmd+Shift+R）；`npm run dev` 有 HMR，但 localStorage 与 Service Worker 可能保留旧状态。

备选生产预览：

```bash
PATH=/opt/homebrew/bin:$PATH npm run build && PATH=/opt/homebrew/bin:$PATH npm run preview
# 默认 http://localhost:4173
```

---

## 2. 准备 EOD 快照（`public/data/latest.json`）

公开清单、报告状态条、策略卡价位都依赖这个文件。二选一：

**A. 用线上最新快照（需要网络，最接近生产）**

```bash
cd "/path/to/kate-dashboard"
mkdir -p public/data
curl -sSL https://treymodels.github.io/KateStock-browser/data/latest.json -o public/data/latest.json
ls -lh public/data/latest.json   # 基线约 700KB，29 只
```

**B. 本地重新生成（需要网络 + akshare；能验证 ingest 链路）**

```bash
cd "/path/to/kate-dashboard"
SNAPSHOT_OUTPUT=public/data/latest.json python3 scripts/ingest.py
SNAPSHOT_OUTPUT=public/data/latest.json node --experimental-strip-types scripts/generate_signals.mjs
```

> ⚠️ `public/data/` 已被 `.gitignore` 排除：**不要提交**该文件；验收完可以保留（方便继续调试）或删除。
> ⚠️ 如果完全离线且拿不到快照：EOD 相关条目（D4/D5/D6、E2 的公开清单）标记 **N/A（缺数据）**，不要伪装通过；实时/提醒相关条目仍可用 §5 的 DevTools Override 验证。
> ⚠️ **round3 起：提醒层按「消费时刻的墙钟相位」判定是否提醒（`scanAlerts` → `getMarketPhase(now)`）**，非交易时段即使 DevTools Override 报价到触发价也**不会**弹提醒。提醒实弹只能在交易时段（或依赖单测）验证，闭市时只能验面板/空状态/文案。

---

## 3. 自动门禁（先跑，2-5 分钟）

```bash
cd "/path/to/kate-dashboard"
PATH=/opt/homebrew/bin:$PATH bash scripts/verify.sh       # build + lint + node tests，任一失败 exit 1
PATH=/opt/homebrew/bin:$PATH node tests/acceptance/check_baseline.mjs   # 基线不变量
PATH=/opt/homebrew/bin:$PATH python3 -m unittest discover -s tests      # Python 回归（verify.sh 不含）
```

期望：三条命令均 exit 0；`verify.sh` 日志路径会打印在末尾。把 build/lint/tests 的输出摘要贴进验收报告。

---

## 4. 快速回归（10 分钟，不依赖交易时段）

在浏览器里逐项过 `docs/acceptance.md` 的 **E1 / E2 / E3（无价位部分）/ E4 / E8 / E9 / D4 / D6 / F1**：

1. **六视图**：侧栏（桌面）/底部导航（移动）点击今日、股票、策略库、回测、策略、我的；确认核心区块都在（对照 `docs/baseline.md` §1）。
2. **报告状态条**：应显示 交易日 / 生成时间（北京时间）/ 数据年龄 / 来源 / 覆盖范围「公开清单（29只），非全市场」；公开清单应有 29 条。
3. **原交互回归**：添加一只股票（可手填行情）→ 策略卡出现 → 编辑 → 删除；导出 JSON → 再导入；回测页播放/拖动时间轴；策略详情弹窗；风险参数滑块即时重算。
4. **个人数据兼容**：DevTools → Application → Local Storage 检查键 `ashare-daily-strategy-v1` 仍在；升级前后旧数据可读（会显示「历史记录/当前持仓/当前自选」）。
5. **快照失败降级**：先正常加载一次 → `mv public/data/latest.json /tmp/latest.json.bak` → 硬刷新并点「检查报告更新」→ 应显示缓存 +「更新失败，保留上次有效快照」；恢复文件后再刷新。
6. **离线**：DevTools → Network → Offline → 刷新 → 页面壳与缓存快照可读；实时层明确降级；无未捕获异常（Console 不应有红色报错堆栈）。
7. **移动端**：DevTools 设备工具栏选 iPhone 12（390×844）/ iPhone SE（375×667）/ 430×932：
   - Console 执行 `document.documentElement.scrollWidth <= window.innerWidth` 应为 `true`；
   - 底部六个 tab 都可见、可点、触控高度 ≥44px；safe-area 不遮挡内容；
   - 提醒面板可打开/滚动/关闭。

---

## 5. 盘中验收（依赖真实交易时段，北京时间）

> 若验收时不在交易时段：用**单测**（`tests/live.test.mjs`、`tests/alerts.test.mjs`）覆盖全部边界与去重逻辑；用 **DevTools Override** 可验 `B1/B10` 的显示与降级，但**提醒弹窗（C1-C3/C9-C11）会被墙钟时段校验拦住**，必须留给真实交易时段；真实盘中的 `B2/B7/B8/C1-C3` 明确记为「待盘中窗口复测」，**不得**用非交易时段的静态页面冒充通过。

### 5.1 时段窗口表（逐窗口各验 3-5 分钟）

| 窗口（北京时间） | 操作 | 期望（摘要） |
| --- | --- | --- |
| 09:00–09:15 | 打开页面，看状态条与 Network | 徽标「盘前」；轮询 60s；无提醒 |
| 09:15–09:25 | 看报价与状态 | 徽标「集合竞价」；轮询加快到 15s；提醒只在契约允许时出现 |
| 09:30–11:30 | 观察 2-3 分钟 | 徽标「交易中」；15s 轮询；价格/时间戳跳动；命中会提醒 |
| 11:30–13:00 | 观察 | 徽标「午休」；不产生新提醒；轮询降频；**不得**标成交易中 |
| 13:00–15:00 | 观察 | 徽标「交易中」；同 09:30 窗口 |
| 15:00–16:45 | 观察 | 徽标「已收盘」；无新提醒；快照仍是上一交易日（16:45 门槛，见 `docs/baseline.md` §3） |
| 16:45 后（CI 完成后） | 点「检查报告更新」 | 快照 `tradeDate` 前进到当天；公开清单更新 |
| 周末/节假日 | 打开页面 | 徽标「非交易日」；无交易中轮询；无提醒；显示上一交易日 + 数据年龄 |

### 5.2 无法等到行情波动时：用 DevTools 构造命中（不修改应用代码）

1. 打开 DevTools → Network，过滤实时接口（当前实现多半是 `push2.eastmoney.com/api/qt/ulist.np/get`）。
2. 找到批量报价响应 → 右键 → **Override content**（或 Copy response 后用本地覆盖）→ 把目标股票的现价字段改到策略卡的 `触发` 之上（触发提醒）/ 持仓股的 `保护` 之下（止损）/ `目标` 之上（目标）。
3. 等下一轮轮询（交易中约 15s）→ 观察 toast、通知、提醒面板、策略卡高亮。
4. 验证去重：保持覆盖不动，连续观察 2 个以上轮询周期 → 同一 `${code}:${kind}:${tradeDate}` 只应出现一次；刷新页面不应重放旧提醒。
5. 恢复 Override 并硬刷新。

> 不同实现字段不同（`f2` 等），以 Network 实际响应为准；记录你覆盖的字段与值，便于复现。

### 5.3 制造止损提醒的纯 UI 方法（不改代码）

1. 股票页把一只**公开清单内**的股票（如 `600110`）添加为「当前持仓」，股数随意（如 100），成本填 `当前价 ÷ 0.85`（使 `成本 × 0.93 > 当前价`）。
2. 策略引擎会因 `costStop` 给出 `action=stop` 与接近现价的 `stop`；交易时段下一轮实时报价大概率命中「止损」提醒。
3. 若行情上涨没命中：把成本调得更高（例如 `当前价 ÷ 0.5`）再试，或直接使用 §5.2 Override。
4. 验完删除该测试股票（或「清空当前设备数据」）。

### 5.4 数据源失败/降级（随时可验）

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| 主源失败 | Request Blocking 加 `*ulist.np*` | 回退到 `stock/get` 或 `qt.gtimg.cn`；价格仍更新（若实现支持） |
| 全部实时源失败 | 依次 block `*ulist.np*`、`*stock/get*`、`*qt.gtimg.cn*` | 明确显示「行情不可用/降级 + 最后更新时间」；不显示为实时；不提醒 |
| 快照失败 | block `*data/latest.json*` 或移走文件 | 保留 last-good 缓存 + 失败提示；EOD 仍可用 |
| 完全离线 | DevTools Offline | 页面壳/缓存可读；实时层降级；无异常；提醒停用而非误报 |
| 慢网 | Network → Slow 3G | 单请求 8-10s 超时、退避/冷却、不刷请求风暴；恢复后自愈 |

> 观察 Network 面板的请求次数与间隔，作为 B3/B5/B7 的证据（截取时间轴）。

### 5.5 通知与声音

- 桌面 Chrome：点「开启通知」→ 允许；命中时确认同时出现系统通知与页面 toast。
- 再测拒绝/不支持（Safari 私密窗口）：应仍出现 toast，Console 无异常。
- iOS Safari：通知通常要求「添加到主屏幕」并授予权限；若不可用，**toast 兜底即算通过**，把限制写入报告。
- 声音：切换开关后命中；未与页面交互就命中的情况下，浏览器可能拦截播放——应静默失败，不阻塞提醒、不报错。

---

## 6. 证据与报告格式

每个验收项按以下格式记录（可直接贴到 `docs/acceptance.md` 的勾选项旁或单独报告）：

```
ID: B1（P0）
时间/阶段: 2026-11-24 10:12 交易中
操作: 打开今日页，等待 2 轮轮询
实际: 策略卡价格旁显示 "14:32:15"，Network ulist.np 每 15s 一次
期望: 盘中价格可见且带时间戳
结论: PASS / FAIL
证据: 截图 2026-11-24-B1.png；Network 请求时间戳
责任域(FAIL 时): data / signals / ui / build
```

- 截图命名：`YYYY-MM-DD-<ID>-<序号>.png`，存放于验收人临时目录（**不要提交到仓库**）。
- FAIL 项必须给出**最小复现步骤**；跨域问题（如「UI 说 15s 刷新但 data 没给」）由 Lead 仲裁，但仍需指出证据落在哪一层。

---

## 7. 清理

1. 恢复被 Override/Block 的网络请求，硬刷新。
2. 删除测试用的个人股票，或 DevTools → Application → Clear site data（会清 `ashare-daily-strategy-v1` 与提醒去重键）。
3. 可选：`rm -rf public/data`（本地快照，git 本来就不跟踪）；确认 `git status` 没有把数据文件加进来。
4. 关闭 `npm run dev`。
5. 复验完成后由 qa-verifier 汇总 P0/P1 结果发给 Lead；**不在验收中修改应用代码**。

---

## 8. 常见坑清单

- 端口是 **3000**（`vite.config.ts`），不是 Vite 默认 5173。
- 首次访问**没有个人股票**是基线行为（`src/data/initialStocks.ts` 为空）；页面主体来自公开快照，不是数据丢失。
- `data/latest.json` 是 CI 产物，本地不存在属正常；没有它时公开清单/策略卡为空态，先按 §2 准备。
- Service Worker（`public/sw.js`）可能缓存旧壳；Network 面板勾选 **Disable cache** 或 Application → Service Workers → Unregister 后再验。
- 本地 localStorage 可能残留上次验收的个人数据/提醒去重记录；对照基线或验「首次访问」时用隐身窗口。
- 快照 `cache-control` 只有 10 分钟；线上内容更新后本地可能拿到旧文件（`curl` 加 `?v=$(date +%s)` 或清缓存）。
- 通知/声音在 iOS 与无用户手势场景有限制；以 **toast 兜底** 为通过标准，并记录限制。
- 本机 Node v26 与 CI Node 22 的差异要写进报告；`--experimental-strip-types` 两边都应可用。
- 验收期间不要 `npm install`、不要替换 `node_modules`、不要提交 `public/data/` 或密钥文件。
