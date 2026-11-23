# 交易窗口实弹验收（market-window-check）

> 目的：开盘后用**真实时钟 + 真实行情源**验证「盘中价格在更新 / 报价时间戳是今天且在交易时段 / 相位正确 / 无 pageerror / 是否自然触发提醒」。
> 脚本：[`scripts/market-window-check.mjs`](../scripts/market-window-check.mjs)；报告输出：[`docs/market-window-report.md`](./market-window-report.md)（每次运行覆盖）。
> 约束：**不修改应用代码**；非交易时段直接 exit 2，不开浏览器、不用 mock 凑数。

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| dev server | `http://localhost:3000` 已启动（默认），且 `public/data/latest.json` 存在（公开快照 29 只） |
| Playwright | 装在 `/tmp`（仓库零污染）：`/tmp/pw-tools/node_modules/playwright` + `/tmp/pw-browsers` |
| 时间 | 北京时间**周一至周五 09:15–11:30 / 13:00–15:00**；之外运行主脚本会 exit 2 |
| 环境变量 | `BASE_URL`（默认 http://localhost:3000）、`WATCH_CODE`（默认 159558）、`HOLDING_CODE`（默认 600519）、`PLAYWRIGHT_BROWSERS_PATH`、`PLAYWRIGHT_MODULE` |

一次性安装（已装好，可跳过）：

```bash
mkdir -p /tmp/pw-tools /tmp/npm-cache /tmp/pw-browsers
cd /tmp/pw-tools && PATH=/opt/homebrew/bin:$PATH npm init -y
PATH=/opt/homebrew/bin:$PATH npm_config_cache=/tmp/npm-cache npm install playwright
PATH=/opt/homebrew/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium
```

## 1. 用法

```bash
cd kate-dashboard

# 实弹（只在交易窗口可跑，约 2 分钟 + 页面加载）
PATH=/opt/homebrew/bin:$PATH \
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
PLAYWRIGHT_MODULE=/tmp/pw-tools/node_modules/playwright \
node scripts/market-window-check.mjs

# 仅数据源探测（任何时间可跑，不启浏览器）
PATH=/opt/homebrew/bin:$PATH node scripts/market-window-check.mjs --node-probe

# 帮助
node scripts/market-window-check.mjs --help
```

### 退出码

| 码 | 含义 |
| --- | --- |
| **0** | PASS：硬断言通过，且窗口内自然触发了提醒 |
| **1** | FAIL：硬断言失败 / 脚本环境错误（报告里会列出失败断言） |
| **2** | 非交易时段：北京时间 09:15–11:30 / 13:00–15:00 之外，**不开浏览器** |
| **3** | PENDING：硬断言通过，但 120s 窗口内没有自然触发提醒（按约定不判失败） |

## 2. 脚本做了什么

1. 先按北京时间判断窗口：不在窗口内立即退出 2（不启动浏览器）。
2. 种子（真实数据，非 mock）：
   - `WATCH_CODE=159558`（watch）：bars 来自 `public/data/latest.json` 公开快照；
   - `HOLDING_CODE=600519`（holding，shares=100）：**600519 不在公开 29 只里，快照没有 bars**；脚本在启动时用腾讯 `fqkline` 拉真实日线（前复权）注入 localStorage，使持仓策略卡有真实价位；若拉取失败则降级（无该卡，报告写明）。
   - 通过 `addInitScript` 写 localStorage 后打开页面，并 **reload 一次**让快照合并后生成策略卡。
3. t0 / +45s / +120s 三次采样：状态条全文（相位/最近报价/年龄/成功失败订阅）、策略卡（代码、现价、触发/保护/目标、命中横幅）、公开清单前 3 只价格与标签、提醒面板文本、console 网络错误 / 失败请求 / pageerror。
4. 从真实网络响应解析 provider 时间戳（东财 `f124` / 腾讯字段 30），校验「今天 + 交易时段」；若被反爬拦截则回退状态条「最近报价 + 数据年龄」作降级证据。
5. 硬断言：
   - 至少 1 只价格变化 **或** 最近报价时间前进；
   - 报价日期 = 今天且时间在交易时段（provider 时间戳优先，回退状态条+新鲜度）；
   - 相位 = 交易中 / 集合竞价；
   - 无 pageerror。
6. 输出：`docs/market-window-report.md`（采样表 + 数据源时间戳 + 断言 + 结论 + 截图路径）、`docs/screenshots/market-window-t{0,1,2}.png`、`docs/screenshots/market-window-samples.json`（截图与 json 已被 `docs/screenshots/.gitignore` 忽略）。

提醒判定：出现提醒 → PASS（exit 0）；未出现 → PENDING（exit 3，不判失败，避免把「行情没波动」当成脚本缺陷）。

## 3. 已知限制

- 本机出网 IP 常被东财 push2 反爬（`ERR_EMPTY_RESPONSE`）；数据层会回退腾讯 `qt.gtimg.cn`，属设计内路径；console 网络错误只记录、不参与硬断言（硬断言只要求无 **pageerror**）。
- `--node-probe` 里东财 kline 用 Node 直连可能 `UND_ERR_SOCKET`（curl 可通）；probe 以腾讯两源为准，东财仅作附加信息。
- 集合竞价（09:15–09:25）期间 provider 时间戳是否更新未实测；若在此窗口跑，可能因「报价时间不在连续竞价时段」被判 FAIL——**建议 09:30 后运行**。
- 页面为 dev server（Vite）；生产构建/PWA 行为另需人工。
- 截图/采样 json 只作本地证据，不入库（只提交报告 md 与脚本/文档）。

## 4. `--node-probe` 自测（2026-11-24 07:15，非交易时段）

预期：07:xx 为非交易时段，各源应返回**上一交易日（2026-11-23）的旧时间戳**；这是正确行为，不是脚本失败。实测输出（节选）：

```
=== market-window --node-probe ===
北京时间: 2026-11-24 07:15:56（preopen）
交易窗口: 否（主脚本会 exit 2）

--- 腾讯 qt.gtimg.cn 实时报价 ---
原始片段: "v_sh600519=\"1~贵州茅台~600519~1439.00~...~20261123161441~..."
  600519 贵州茅台: price=1439 time=20261123161441 (2026-11-23 16:14:41) → 旧时间戳/非交易时段
  159558 半导体设备ETF易方达: price=0.799 time=20261123161436 (2026-11-23 16:14:36) → 旧时间戳/非交易时段

--- 腾讯 fqkline 日线（前复权） ---
  600519: last=2026-11-23 open=1475.350 close=1439.000 high=1478.000 low=1428.000 → 最后 bar 为旧日期
  159558: last=2026-11-23 open=0.795 close=0.799 high=0.814 low=0.755 → 最后 bar 为旧日期

--- 东财 push2his kline（klt=101 / fqt=1） ---
  失败: fetch failed（Node 直连被反爬；curl 可通，仅作附加探测）

结论: 当前为非交易时段：上述三源返回旧时间戳/上一交易日数据属预期
```

同时主脚本在 07:15 实测：

```
非交易时段：北京时间 2026-11-24 07:15:56（preopen）。交易窗口为周一至周五 09:15-11:30 / 13:00-15:00；按设计不启动浏览器、exit 2。
MAIN_EXIT=2
```

## 5. 09:30 实弹运行清单（Lead）

1. 确认 dev server 与 `public/data/latest.json` 在（浏览器打开一次今日页确认公开清单 29 只）。
2. 跑 §1 的实弹命令；等待约 2–3 分钟。
3. 把 `docs/market-window-report.md` 的「硬断言 + 结论」发回；exit 3（PENDING）属正常（未自然触发提醒）。
4. 若 FAIL：报告里会标注是「时间戳/相位/价格变化/pageerror」哪一项；截图在 `docs/screenshots/market-window-t*.png`。
