# 盘前态真实时钟检查（不冒充实时、不误报）

- 运行时间：2026-11-24 07:41:57（Asia/Shanghai，真实时钟，无固定时钟/mock）
- 页面：http://localhost:3000（独立 browser context，未注入清单/mock）
- 结论：**PASS**

## 断言

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 相位徽标 = 盘前 | ✅ PASS | phase="盘前"；状态条="最近报价 16:15:00 数据年龄 15 小时前 成功 29 / 失败 0 / 订阅 29" |
| provider 时间 = 上一交易日约 16:14（不是今天 09:xx） | ✅ PASS | 000960 20261123161500 → 2026-11-23 16:15:00（来源 tencent field30；expectedDate=2026-11-23；today=2026-11-24） |
| 状态条「最近报价」= provider 时间（±2 分钟） | ✅ PASS | statusClock=16:15:00 vs provider=16:15:00 |
| 数据年龄为小时级（数小时） | ✅ PASS | 数据年龄=数据年龄 15 小时前；statusMeta="最近报价 16:15:00 数据年龄 15 小时前 成功 29 / 失败 0 / 订阅 29" |
| 不把旧价标成「盘中」（价格标签无 盘中/竞价、无 live 标签） | ✅ PASS | liveTagCount=0；标签样本=["盘前","盘前","盘前","盘前","盘前","盘前"]；liveClaimText=false |
| 提醒面板为空（无 alert-item / toast） | ✅ PASS | alerts=0，toasts=0，panel="INTRADAY ALERTS 盘中提醒 通知被浏览器拒绝 提示音已关 浏览器已拒绝通知，可在站点权限设置中重新允许；页面内提醒不受影响。 提醒只针对个人清单：请先在「股票」页添加自选或持仓，生成策略价位后才会提醒。公开清单只有收盘信号、没有触发/保护/目标价位，不会产生提醒。 提醒语义：持仓策略只提醒保护位/目标位，非持仓策略只提醒买入触发，观望策略不提醒" |
| 提醒面板空状态文案完整（盘前/个人清单说明） | ✅ PASS | INTRADAY ALERTS 盘中提醒 通知被浏览器拒绝 提示音已关 浏览器已拒绝通知，可在站点权限设置中重新允许；页面内提醒不受影响。 提醒只针对个人清单：请先在「股票」页添加自选或持仓，生成策略价位后才会提醒。公开清单只有收盘信号、没有触发/保护/目标价位，不会产生提醒。 提醒语义：持仓策略只提醒保护位/目标位，非持仓策略只提醒买入触发，观望策略不提醒。提醒基于公开行情与规则价位，可能延迟或误报；同一天同一类提醒只记录一次，不构成投资建议。 |
| 无 UI 报错 / 无 pageerror | ✅ PASS | statusError=0；pageErrors=0；非网络 console=0 |
| 公开清单价格标签 = 盘前/收盘（无 盘中） | ✅ PASS | 共 29 个标签；异常=[]；样本=["盘前","盘前","盘前","盘前","盘前","盘前"] |
| 公开清单条数 = 29 | ✅ PASS | publicCount=29；heading="快照交易日/最新报价 2026-11-23 · 29 只有行情" |
| 无 pageerror（最终） | ✅ PASS | 0 条 |

## 证据（页面读数）

- 相位：盘前
- 状态条：最近报价 16:15:00 数据年龄 15 小时前 成功 29 / 失败 0 / 订阅 29
- 价格标签（前 6）：["盘前","盘前","盘前","盘前","盘前","盘前"]（共 29 个；live=0，stale=0）
- 公开清单：29 只；标题「快照交易日/最新报价 2026-11-23 · 29 只有行情」
- 提醒面板：alerts=0，toasts=0；"INTRADAY ALERTS 盘中提醒 通知被浏览器拒绝 提示音已关 浏览器已拒绝通知，可在站点权限设置中重新允许；页面内提醒不受影响。 提醒只针对个人清单：请先在「股票」页添加自选或持仓，生成策略价位后才会提醒。公开清单只有收盘信号、没有触发/保护/目标价位，不会产生提醒。 提醒语义：持仓策略只提醒保护位/目标位，非持仓策略只提醒买入触发，观望策略不提醒。提醒基于公开行情与规则价位，可能延迟或误报；同一天同一类提醒只记录一次，不构成"

## provider 时间戳（从真实网络响应解析）

- 最新：000960 = 20261123161500 → 2026-11-23 16:15:00（tencent field30）
  - 159558: 20261123161436 → 2026-11-23 16:14:36
  - 588060: 20261123161459 → 2026-11-23 16:14:59
  - 600110: 20261123161453 → 2026-11-23 16:14:53
  - 600206: 20261123161457 → 2026-11-23 16:14:57
  - 600547: 20261123161452 → 2026-11-23 16:14:52
- 共 29 只；provider 日期应为上一交易日（非今天 09:xx）。

## 截图

- `docs/screenshots/preopen-01-today-top.png`
- `docs/screenshots/preopen-02-statusbar.png`
- `docs/screenshots/preopen-03-public-stocks.png`
- `docs/screenshots/preopen-04-alerts-panel.png`

## 复现命令

```bash
cd kate-dashboard
PATH=/opt/homebrew/bin:$PATH \
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
PLAYWRIGHT_MODULE=/tmp/pw-tools/node_modules/playwright \
node scripts/preopen-check.mjs
```

## console 错误（前 10 条；网络类如 ERR_EMPTY_RESPONSE 属反爬预期，仅记录）

- Failed to load resource: net::ERR_EMPTY_RESPONSE
- Failed to load resource: net::ERR_EMPTY_RESPONSE
- Failed to load resource: net::ERR_EMPTY_RESPONSE


## 环境说明（非缺陷）

- headless Chromium 的 Notification 权限默认为 denied，面板显示「通知被浏览器拒绝」属环境状态，不是报错；真实浏览器默认通常为「开启浏览器通知」。
- console 的 `ERR_EMPTY_RESPONSE` 来自东财 push2 反爬（本机已知），报价由腾讯 gtimg 回退成功；脚本只对 pageerror / UI 错误判失败，网络类 console 仅记录。

## 责任域判定口径

- 相位错误 → **data**（getMarketPhase）/ **ui**（徽标渲染）。
- provider 时间/数据年龄/状态条时间错误 → **data**（live.ts 时间戳）或 **ui**（状态条展示）。
- 旧价被标「盘中」→ **ui**（价格标签）或 **data**（phase/时间戳传递）。
- 盘前出现提醒/通知 → **signals**（alerts 时段过滤）。
- pageerror/UI 报错 → **ui**（组件）或 **data**（行情异常）。