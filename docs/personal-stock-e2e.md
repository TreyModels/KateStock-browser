# 浏览器 E2E：添加非公开股票 → 日线回退（腾讯/新浪）→ 策略价位

- 运行时间：2026-11-23T23:40:53.727Z → 2026-11-23T23:40:57.737Z（Asia/Shanghai）
- 页面：http://localhost:3000；股票：600000
- 结论：**PASS**

## 前置条件

- dev server `http://localhost:3000` 运行中（本脚本不依赖交易时段，日线数据任何时段可拉）。
- Playwright 装在 `/tmp`：`/tmp/pw-tools/node_modules/playwright` + `/tmp/pw-browsers`。
- 浏览器上下文注入空个人清单；**除代码/名称外全部走页面交互**（打开添加对话框 → 填写 → 保存 → 点更新）。
- 本机出网 IP 被东财 push2his 反爬，这正是要验证「东财失败 → JSONP → 腾讯 kline → 新浪 JSONP」多级回退的场景；2026-11-24 07:44 起腾讯 fqkline 也对本机返回 501 WAF。

## 步骤

- 打开应用：http://localhost:3000
- 进入股票页：成功
- 页面交互添加股票：600000 浦发银行（status=当前自选）
- 点击「更新」：触发 fetchQuotes（东财 → JSONP → 腾讯 kline）
- 拿到日线：{"code":"600000","price":10.75,"tradeDate":"2026-11-23","bars":160,"firstDate":"2026-03-30","lastDate":"2026-11-23","provider":"Sina kline (不复权)","adjustment":"不复权（tushare 未验证）","source":"auto"}

## 断言

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 股票行出现价格 | ✅ PASS | 浦发银行 600000 当前自选 10.75 -1.10% 盘前 2026 收益额 — 策略 |
| 详情价位至少一个非「—」 | ✅ PASS | [{"label":"触发价","value":"10.78"},{"label":"保护位","value":"10.23"},{"label":"目标位","value":"11.20"}] |
| 详情包含触发/保护/目标三项 | ✅ PASS | 触发价 / 保护位 / 目标位 |
| 今日页出现该股票策略卡 | ✅ PASS | 浦发银行 600000 10.75 -1.10% 盘前 回踩低吸 强度 74 上升趋势仍在，价格回到短期均线区域，等待止跌后介入。 触发 10.78 距触发 +0.3% 保护 10.23 距保护 +5.1% 目标 11.20 距目标 +4.2% 参考上限 2200 股 完整计划 自动日线 · 2026-11-23 |
| 策略卡有价格且至少一个价位 | ✅ PASS | 价格型数值 5 个：10.75 / 1.10 / 10.78 / 10.23 / 11.20；浦发银行 600000 10.75 -1.10% 盘前 回踩低吸 强度 74 上升趋势仍在，价格回到短期均线区域，等待止跌后介入。 触发 10.78 距触发 +0.3% 保护 10.23 距保护 +5.1% 目标 11.20 距目标 +4.2% 参考上限 2200 股 完整计划 自动日线 · 2026-11-23 |
| 东财 push2his 有请求且失败（反爬/JSONP 失败） | ✅ PASS | attempts=4, failures=4 |
| 日线回退成功（腾讯 fqkline 或新浪 JSONP，任一成功） | ✅ PASS | 腾讯成功=0（501=0，尝试=4）；新浪成功=2；{"kind":"response","status":200,"url":"https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20__sina_kline_1795477256344_ndsd86k1ncc=/CN_MarketDataService.getKLineData?symbol=sh600000&scale=240&ma=no&datalen=320","bodySnippet":"/*<script>location.href='//sina.com';</script>*/\nvar __sina_kline_1795477256344_ndsd86k1ncc=([{\"day\":\"2025-07-29\",\"open\"","rows":320,"firstDate":"2025-07-29","lastDate":"2026-11-23"} |
| quote 的 provider 标明回退数据源（腾讯/新浪） | ✅ PASS | Sina kline (不复权) |
| 新浪回退成功（HTTP 200 且 rows≥21 根） | ✅ PASS | [{"kind":"response","status":200,"url":"https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20__sina_kline_1795477256344_ndsd86k1ncc=/CN_MarketDataService.getKLineData?symbol=sh600000&scale=240&ma=no&datalen=320","bodySnippet":"/*<script>location.href='//sina.com';</script>*/\nvar __sina_kline_1795477256344_ndsd86k1ncc=([{\"day\":\"2025-07-29\",\"open\"","rows":320,"firstDate":"2025-07-29","lastDate":"2026-11-23"},{"kind":"response","status":200,"url":"https://quotes.sina.cn/cn/api/jsonp_v2.php/var%2 |
| 新浪回退为不复权并已明确标注（不冒充前复权） | ✅ PASS | 不复权（tushare 未验证） |
| quote 的 bars 为 160 根（上限） | ✅ PASS | 160 根（2026-03-30 → 2026-11-23） |
| 无 pageerror | ✅ PASS | 0 条 |

## 网络证据

- push2his（东财）记录 4 条：
  - {"kind":"requestfailed","url":"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61&klt=101&fqt=1&beg=20260328&end=20500101","error":"net::ERR_EMPTY_RESPONSE"}
  - {"kind":"requestfailed","url":"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61&klt=101&fqt=1&beg=20260328&end=20500101&cb=__quote_1795477255660_zqrea1r75vr","error":"net::ERR_EMPTY_RESPONSE"}
  - {"kind":"requestfailed","url":"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61&klt=101&fqt=1&beg=20260328&end=20500101","error":"net::ERR_EMPTY_RESPONSE"}
  - {"kind":"requestfailed","url":"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61&klt=101&fqt=1&beg=20260328&end=20500101&cb=__quote_1795477256754_lvv3ria58p","error":"net::ERR_EMPTY_RESPONSE"}
- 腾讯 fqkline 记录 4 条（501 为 WAF 挑战页，属数据源侧限制）：
  - {"kind":"requestfailed","url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","error":"net::ERR_FAILED"}
  - {"kind":"requestfailed","url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","error":"net::ERR_FAILED"}
  - {"kind":"requestfailed","url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","error":"net::ERR_FAILED"}
  - {"kind":"requestfailed","url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","error":"net::ERR_FAILED"}
- 新浪 JSONP 记录 2 条：
  - {"kind":"response","status":200,"url":"https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20__sina_kline_1795477256344_ndsd86k1ncc=/CN_MarketDataService.getKLineData?symbol=sh600000&scale=240&ma=no&datalen=320","bodySnippet":"/*<script>location.href='//sina.com';</script>*/\nvar __sina_kline_1795477256344_ndsd86k1ncc=([{\"day\":\"2025-07-29\",\"open\"","rows":320,"firstDate":"2025-07-29","lastDate":"2026-11-23"}
  - {"kind":"response","status":200,"url":"https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20__sina_kline_1795477257399_v8kbxlp1lve=/CN_MarketDataService.getKLineData?symbol=sh600000&scale=240&ma=no&datalen=320","bodySnippet":"/*<script>location.href='//sina.com';</script>*/\nvar __sina_kline_1795477257399_v8kbxlp1lve=([{\"day\":\"2025-07-29\",\"open\"","rows":320,"firstDate":"2025-07-29","lastDate":"2026-11-23"}

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
- Access to fetch at 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq' from origin 'http://localhost:3000' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
- Failed to load resource: net::ERR_FAILED
- Access to fetch at 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq' from origin 'http://localhost:3000' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
- Failed to load resource: net::ERR_FAILED
- Failed to load resource: net::ERR_EMPTY_RESPONSE

## 责任域判定口径

- 添加/保存/点更新/详情打不开 → **ui**（StockDialog / 按钮状态 / 详情弹窗）。
- 页面交互成功但 bars 未落地、provider 不是腾讯/新浪、或对应回退请求未发生 → **data**（market.ts 多级回退/解析）。
- 网络里腾讯成功、localStorage 有 bars，但页面不显示策略卡/价位 → **ui 或状态管理**（本脚本会单独标注）。