# 浏览器 E2E：添加非公开股票 → 日线获取（东财主源/腾讯/新浪回退）→ 策略价位

- 运行时间：2026-11-24T01:41:11.536Z → 2026-11-24T01:41:14.242Z（Asia/Shanghai）
- 页面：http://localhost:3000；股票：600000
- 结论：**PASS**

## 前置条件

- dev server `http://localhost:3000` 运行中（本脚本不依赖交易时段，日线数据任何时段可拉）。
- Playwright 装在 `/tmp`：`/tmp/pw-tools/node_modules/playwright` + `/tmp/pw-browsers`。
- 浏览器上下文注入空个人清单；**除代码/名称外全部走页面交互**（打开添加对话框 → 填写 → 保存 → 点更新）。
- 本机东财 push2his 时通/时被反爬、腾讯 fqkline 2026-11-24 07:44 起对本机 501 WAF：脚本按**实际来源**判定（东财主源成功 或 腾讯/新浪回退成功 均可 PASS），并记录本次走了哪条链路。

## 步骤

- 打开应用：http://localhost:3000
- 进入股票页：成功
- 页面交互添加股票：600000 浦发银行（status=当前自选）
- 点击「更新」：触发 fetchQuotes（东财 → JSONP → 腾讯 kline）
- 拿到日线：{"code":"600000","price":10.67,"tradeDate":"2026-11-24","bars":160,"firstDate":"2026-03-31","lastDate":"2026-11-24","provider":"Tencent kline (qfq)","adjustment":"前复权","source":"auto"}

## 断言

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 股票行出现价格 | ✅ PASS | 浦发银行 600000 当前自选 10.67 -0.74% 收盘 2026 收益额 — 策略 |
| 详情价位至少一个非「—」 | ✅ PASS | [{"label":"触发价","value":"10.74"},{"label":"保护位","value":"10.27"},{"label":"目标位","value":"11.18"}] |
| 详情包含触发/保护/目标三项 | ✅ PASS | 触发价 / 保护位 / 目标位 |
| 今日页出现该股票策略卡 | ✅ PASS | 浦发银行 600000 10.67 -0.74% 收盘 回踩低吸 强度 74 上升趋势仍在，价格回到短期均线区域，等待止跌后介入。 触发 10.74 距触发 +0.7% 保护 10.27 距保护 +3.9% 目标 11.18 距目标 +4.8% 参考上限 2200 股 完整计划 自动日线 · 2026-11-24 |
| 策略卡有价格且至少一个价位 | ✅ PASS | 价格型数值 5 个：10.67 / 0.74 / 10.74 / 10.27 / 11.18；浦发银行 600000 10.67 -0.74% 收盘 回踩低吸 强度 74 上升趋势仍在，价格回到短期均线区域，等待止跌后介入。 触发 10.74 距触发 +0.7% 保护 10.27 距保护 +3.9% 目标 11.18 距目标 +4.8% 参考上限 2200 股 完整计划 自动日线 · 2026-11-24 |
| 东财 push2his 有请求（成功或失败均可，按实际记录） | ✅ PASS | attempts=4，成功(klines)=0，失败=4 |
| 日线数据获取成功（东财主源 或 腾讯/新浪回退） | ✅ PASS | 东财主源成功=false；腾讯成功=2（501=0，尝试=2）；新浪成功=0 |
| 数据来源可识别 | ✅ PASS | Tencent kline（腾讯回退） |
| 腾讯 fqkline 回退成功（HTTP 200 且 qfqday≥21 根） | ✅ PASS | [{"kind":"response","status":200,"url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","qfqdayRows":321,"firstDate":"2025-07-29","lastDate":"2026-11-24"},{"kind":"response","status":200,"url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","qfqdayRows":321,"firstDate":"2025-07-29","lastDate":"2026-11-24"}] |
| quote 的 bars 为 160 根（上限） | ✅ PASS | 160 根（2026-03-31 → 2026-11-24） |
| 无 pageerror | ✅ PASS | 0 条 |

## 网络证据

- push2his（东财）记录 4 条：
  - {"kind":"requestfailed","url":"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61&klt=101&fqt=1&beg=20260329&end=20500101","error":"net::ERR_EMPTY_RESPONSE"}
  - {"kind":"requestfailed","url":"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61&klt=101&fqt=1&beg=20260329&end=20500101&cb=__quote_1795484472896_t18wwq8pmr","error":"net::ERR_EMPTY_RESPONSE"}
  - {"kind":"requestfailed","url":"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61&klt=101&fqt=1&beg=20260329&end=20500101","error":"net::ERR_EMPTY_RESPONSE"}
  - {"kind":"requestfailed","url":"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61&klt=101&fqt=1&beg=20260329&end=20500101&cb=__quote_1795484473188_am8ye9w8txv","error":"net::ERR_EMPTY_RESPONSE"}
- 腾讯 fqkline 记录 2 条（501 为 WAF 挑战页，属数据源侧限制）：
  - {"kind":"response","status":200,"url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","qfqdayRows":321,"firstDate":"2025-07-29","lastDate":"2026-11-24"}
  - {"kind":"response","status":200,"url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","qfqdayRows":321,"firstDate":"2025-07-29","lastDate":"2026-11-24"}
- 新浪 JSONP 记录 0 条：

## 数据口径说明（重要）

- 东财（push2his）与腾讯（fqkline）是**前复权**；新浪日线回退是**不复权**（Quote.adjustment 已标注 `不复权（tushare 未验证）`）。
- 混源差异：同一页面里不同股票的均线/ATR/RSI（基于各自 bars）口径可能不一致；策略价位不能跨数据源直接比较。个人清单若混源，建议以同一数据源为准，或重要决策前核对 `adjustment`。
- 本轮实际：provider=Tencent kline (qfq)；adjustment=前复权。生产网络优先东财/腾讯前复权，新浪仅作腾讯 501 时的兜底。

## 截图

- `docs/screenshots/personal-stock-01-dialog.png`
- `docs/screenshots/personal-stock-02-stock-page.png`
- `docs/screenshots/personal-stock-03-detail.png`
- `docs/screenshots/personal-stock-04-today-card.png`

## 复现命令

```bash
cd kate-dashboard
PATH=/opt/homebrew/bin:$PATH \
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
PLAYWRIGHT_MODULE=/tmp/pw-tools/node_modules/playwright \
node scripts/personal-stock-e2e.mjs
```

## console 错误（前 10 条；仅记录）

- Failed to load resource: net::ERR_EMPTY_RESPONSE
- Failed to load resource: net::ERR_EMPTY_RESPONSE
- Failed to load resource: net::ERR_EMPTY_RESPONSE
- Failed to load resource: net::ERR_EMPTY_RESPONSE
- Failed to load resource: net::ERR_EMPTY_RESPONSE
- Failed to load resource: net::ERR_EMPTY_RESPONSE
- Failed to load resource: net::ERR_EMPTY_RESPONSE
- Failed to load resource: net::ERR_EMPTY_RESPONSE

## 责任域判定口径

- 添加/保存/点更新/详情打不开 → **ui**（StockDialog / 按钮状态 / 详情弹窗）。
- 页面交互成功但 bars 未落地、来源无法识别（东财未成功且腾讯/新浪也无成功响应） → **data**（market.ts 数据链路/解析）。
- 网络里腾讯成功、localStorage 有 bars，但页面不显示策略卡/价位 → **ui 或状态管理**（本脚本会单独标注）。