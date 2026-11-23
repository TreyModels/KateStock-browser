# 日内 · A股策略工作台（盘中版）

本地运行的个人 A 股／ETF 短线策略看板。基于 [TreyModels/KateStock-browser](https://github.com/TreyModels/KateStock-browser) 复刻，新增**盘中实时行情**与**买卖触发提醒**，解决原站「要等收盘才有当天数据、不告诉你什么时候买卖」的问题。

## 运行

```bash
# Node 需 20.19+ / 22+（本机用 /opt/homebrew/bin/node v26）
npm ci
npm run dev          # http://localhost:3000
npm run build        # 生产构建 → dist/
bash scripts/verify.sh   # 一键门禁：build + lint + 全部离线测试
```

> 本机 `node_modules` 是指向 `/tmp/kdeps/node_modules` 的符号链接（避免 iCloud 同步几十万文件）。重启后若丢失：`npm ci`（需可写的 npm cache，见 `npm config set cache`）。

## 相对原站改了什么

| 原站 | 本版 |
|---|---|
| 日线 `klt=101`，盘中不更新，`price` = 最后一根日线收盘 | 盘中每 15 秒批量拉报价（东财 push2 → 腾讯 gtimg 回退），带**真实行情时间戳** |
| 收盘后 16:45 门槛 + 一天两次 cron（16:45 / 07:05） | 交易时段实时刷新；非交易时段按下一时段精确唤醒（盘前 09:15 / 开盘 09:30 / 午休 13:00 / 次日 09:15） |
| 只有「收盘信号、次日开盘执行」 | 策略卡显示现价 vs 触发价 / 保护位 / 目标位，以及「距触发 +x%」「已越过触发 x%」 |
| 无提醒 | 命中触发 / 止损 / 目标时：站内提醒 + 浏览器通知 + 可选提示音；同一天同一类只提醒一次 |
| `fetchedAt` 从不渲染 | 状态条显示行情时间、数据年龄；报价超 2 分钟标「可能延迟」，收盘/非交易日标「收盘」 |

回测与信号生成语义**保持不变**：收盘出信号、次日开盘执行（防止未来函数），盘中层只叠加实时价与提醒，不改 EOD 规则。

## 盘中行情怎么走

1. 主源：`push2.eastmoney.com` 的 `ulist.np/get` 批量接口（CORS 允许，`fltt=2` 即小数，无需 /100）。
2. 主源失败（超时 / 反爬 / 部分缺失）→ 逐只 `stock/get`，或腾讯 `qt.gtimg.cn` 的 script 注入回退。
3. 两级都失败 → 该只记 errors，**不伪造报价、不拿旧值冒充实时**；旧报价保留但标「上次报价」。
4. 时间戳只取 provider 真实行情时间（东财 `f124` / 腾讯字段 30）；拿不到就报错降级。
5. 交易时段判定：北京时间，含集合竞价（09:15–09:25）、午休、收盘；**法定节假日未识别**（按工作日处理，失败时显式报错）。
6. 个人清单日线（添加自选/持仓时）：东财 `push2his` → JSONP → 腾讯 `fqkline` 回退；本机实测浏览器端可用，加非公开清单的股票也能生成策略价位。腾讯路径不返回成交额（`amount=0`），不影响价格、涨跌幅与均线指标。

### 已知环境限制

- 本机出网 IP 被东方财富反爬（curl 52 / 回源 502），浏览器里 push2 请求会失败，实际报价走腾讯回退。这是设计内的显式降级。
- 腾讯 `qt.gtimg.cn` 在 **09:15–09:25 集合竞价**时段的时间戳行为未经实测；若该时段不更新，会看到明确的「集合竞价：provider 时间戳可能尚未更新」错误，而不是静默空列表。
- 浏览器通知需要用户手势授权；iOS 需先「添加到主屏幕」（PWA）才支持通知，声音可能被自动播放策略拦截——站内提醒始终兜底。

## 数据与隐私

持仓、自选、设置只存在当前浏览器 localStorage，不同步、不上传；不连接券商、不自动下单、不构成投资建议。公开清单为 `scripts/public-universe.json` 中的 29 只，非全市场扫描。

## 目录

```
src/lib/live.ts            盘中行情层：批量抓取、回退、退避、时段、陈旧判断
src/hooks/useLiveQuotes.ts 轮询 hook（按相位排程、手动刷新、错误与时间戳）
src/lib/live-signals.ts    盘中命中判定（止损 > 目标 > 触发，按持仓语义过滤）
src/lib/alerts.ts          提醒去重/节流/持久化（纯函数，可单测）
src/hooks/useLiveAlerts.ts 提醒 hook（toast + Notification + 声音）
src/components/live/       状态条、实时价格、提醒面板
docs/baseline.md           原站行为基线（含线上实测证据）
docs/acceptance.md         验收清单（51 条）
docs/acceptance-report-round2.md  第二轮复验报告
```

## License / attribution

原始项目由 **Dr. Trey Menefee** 创建，按原 LICENSE 非商业使用并保留署名。
