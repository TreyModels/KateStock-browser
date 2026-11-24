# 发布候选（RC）状态

- 版本：`651310e` — Refresh acceptance docs for Sina fallback (E2E PASS, 5 PASS / 0 FAIL / 1 SKIP)
- 生成时间：2026-11-24 09:38:05（Asia/Shanghai）；相位：trading
- 环境：macOS，Node v26.12.0，dev server http://localhost:3000（可达），公开快照：存在（628159 bytes）
- 工作区：5 个未提交文件（验收脚本/文档/日志；**src/ 应用代码零改动**）
- 一键复跑：`bash scripts/acceptance-all.sh`（退出码 0=无 FAIL；1=有 FAIL）
- 本次日志：`docs/acceptance-logs/20261124-093805/`（已 gitignore）
- 本次 market-window: 已运行

## 本次结果

| 检查 | 结果 | 证据 | 说明 |
| --- | --- | --- | --- |
| verify.sh | PASS | scripts/verify.sh（build/lint/node tests；日志 docs/acceptance-logs/20261124-093805/verify.sh.log） | exit 0 |
| check_baseline | PASS | tests/acceptance/check_baseline.mjs | exit 0 |
| python-unittest | PASS | tests/（python3 -m unittest discover -s tests） | exit 0 |
| personal-stock-e2e | PASS | docs/personal-stock-e2e.md、docs/screenshots/personal-stock-*.png | exit 0 |
| preopen-check | SKIP | docs/preopen-check.md | 非盘前（当前相位=trading；preopen-check 仅在交易日 09:15 前运行） |
| market-window | PASS | docs/market-window-report.md | exit 0 |

汇总：PASS=5，FAIL=0，SKIP=1，PENDING=0。

## 真实输出（每步 tail；完整日志见 `docs/acceptance-logs/20261124-093805/`）

### verify.sh（PASS）
```
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7288.742333
--> PASS: node tests

════════════════════════ 汇总 ════════════════════════
  PASS  build
  PASS  lint
  PASS  node tests
  日志：/var/folders/jb/km5070j9141659tyckdk886r0000gn/T//katestock-verify-20261124-093805.log
══════════════════════════════════════════════════════
结果：PASS（build + lint + node tests 全部通过）
```

### check_baseline（PASS）
```
✓ B-11  单边成本仍为 0.001（0.1%）  [匹配 "const COST = 0.001"]
✓ B-12  定时信号仍复用 generateStrategy 引擎  [匹配 "generateStrategy"]
✓ B-13  公开信号仍被 check_public.py 限制为无 sizing 字段  [匹配 "'action','actionLabel','score','summary','reasons','indicators'"]
✓ B-14  快照 schema 仍含 schemaVersion/tradeDate/partial/signals  [关键字段齐全]
✓ B-15  快照合并仍保留手动行情（mergeSnapshotQuotes）  [匹配 "source !== 'manual'"]
✓ B-16  报告状态条仍标注「非实时行情」  [匹配 "非实时行情"]
✓ B-17  README 仍写明「收盘出信号、次日开盘执行」  [匹配 "收盘出信号、次日开盘执行"]
✓ B-18  运维文档仍声明 snapshots are not live quotes  [匹配 "snapshots are not live quotes"]
✓ B-19  验收交付物存在：baseline/acceptance/verify.sh  [四个交付物齐全]

19/19 通过
PASS: 基线不变量全部保持。
```

### python-unittest（PASS）
```
....
----------------------------------------------------------------------
Ran 4 tests in 0.001s

OK
```

### personal-stock-e2e（PASS）
```
  · 拿到日线：{"code":"600000","price":10.62,"tradeDate":"2026-11-24","bars":160,"firstDate":"2026-03-31","lastDate":"2026-11-24","provider":null,"adjustment":null,"source":"auto"}
✅ 股票行出现价格：浦发银行 600000 当前自选 10.62 -1.21% 盘中 2026 收益额 — 策略
✅ 详情价位至少一个非「—」：[{"label":"触发价","value":"10.73"},{"label":"保护位","value":"10.27"},{"label":"目标位","value":"11.17"}]
✅ 详情包含触发/保护/目标三项：触发价 / 保护位 / 目标位
✅ 今日页出现该股票策略卡：浦发银行 600000 10.62 -1.21% 盘中 回踩低吸 强度 74 上升趋势仍在，价格回到短期均线区域，等待止跌后介入。 触发 10.73 距触发 +1.0% 保护 10.27 距保护 +3.4% 目标 11.17 距目标 +5.2% 参考上限 2200 股 完整计划 盘中报价 09:38:18 · 收盘日线 2026-11-24
✅ 策略卡有价格且至少一个价位：价格型数值 5 个：10.62 / 1.21 / 10.73 / 10.27 / 11.17；浦发银行 600000 10.62 -1.21% 盘中 回踩低吸 强度 74 上升趋势仍在，价格回到短期均线区域，等待止跌后介入。 触发 10.73 距触发 +1.0% 保护 10.27 距保护 +3.4% 目标 11.17 距目标 +5.2% 参考上限 2200 股 完整计划 盘中报价 09:38:18 · 收盘日线 2026-11-24
✅ 东财 push2his 有请求（成功或失败均可，按实际记录）：attempts=2，成功(klines)=2，失败=0
✅ 日线数据获取成功（东财主源 或 腾讯/新浪回退）：东财主源成功=true；腾讯成功=0（501=0，尝试=0）；新浪成功=0
✅ 数据来源可识别：Eastmoney 主源（基线 Quote 无 provider 字段，属预期）
✅ 回退链路本次未触发（东财主源可用，属预期；回退能力已在反爬/501 窗口另行验证）：provider=null（东财主源）
✅ quote 的 bars 为 160 根（上限）：160 根（2026-03-31 → 2026-11-24）
✅ 无 pageerror：0 条
```

### preopen-check（SKIP）
```
非盘前（当前相位=trading；preopen-check 仅在交易日 09:15 前运行）
```

### market-window（PASS）
```
告警链路候选来源：公开快照 29 只（不依赖 600519/fqkline）；实时报价 29 只
交易窗口确认：2026-11-24 09:38:24（trading）；打开 http://localhost:3000
页面就绪；策略卡=3，公开卡=29
等待告警链路实弹：候选=600825 EOD=11.8 实时=11.84 ma20=12.89 stop=12 cost=14.16（ma20 > 当前价（实时）且 stop > 当前价（余量最大））
告警链路实弹：PASS（2ms）证据：保护 持仓 实弹告警-600825 600825 09:38:27 实弹告警-600825 跌破止损 12.00（现价 11.84） 价位 12.00 现价 11.84
t+1s: 相位=交易中 | 最近报价 09:38:25数据年龄 刚刚成功 30 / 失败 0 / 订阅 30 | 卡片=3 | 提醒=2 | consoleErr=0 failedReq=0
t+46s: 相位=交易中 | 最近报价 09:38:56数据年龄 17 秒前成功 30 / 失败 0 / 订阅 30 | 卡片=3 | 提醒=2 | consoleErr=3 failedReq=3
t+121s: 相位=交易中 | 最近报价 09:40:15数据年龄 13 秒前成功 30 / 失败 0 / 订阅 30 | 卡片=3 | 提醒=2 | consoleErr=4 failedReq=4
报告：docs/market-window-report.md
截图：docs/screenshots/market-window-alert-pipeline.png、docs/screenshots/market-window-t0.png、docs/screenshots/market-window-t1.png、docs/screenshots/market-window-t2.png
结论：PASS：真实行情在更新、相位/时间戳正确；告警链路实弹 PASS，且窗口内自然触发了提醒（exit 0）
```


## 证据索引

- 基线与验收清单：`docs/baseline.md`、`docs/acceptance.md`
- 复验报告：`docs/acceptance-report-round2.md`、`docs/acceptance-report-round3.md`
- 可视化/移动端：`docs/visual-check.md`、`docs/screenshots/*.png`（本地，gitignored）
- 核心路径 E2E：`docs/personal-stock-e2e.md`
- 盘前态：`docs/preopen-check.md`
- 交易窗口实弹：`docs/market-window.md`、`docs/market-window-report.md`

## 已知风险

1. **数据源复权口径混用**：东财/腾讯日线为**前复权**；新浪日线回退（2026-11-24 因腾讯 fqkline 501 WAF 新增的第四级）为**不复权**（`Quote.adjustment` 已标注 `不复权（tushare 未验证）`）。个人清单若混源，同一页面不同股票的均线/ATR/RSI 口径可能不一致，策略价位不可跨数据源直接比较；重要决策前请核对数据来源，生产优先东财/腾讯前复权。
2. **数据可用性依赖多级回退**：本机东财 push2 反爬、腾讯 fqkline 返回 501 WAF，个股日线目前依赖新浪 JSONP；若新浪也不可用，该股日线会失败并走手动行情，不会伪造数据。
3. **盘中数据与提醒**：本次非交易时段跑，market-window SKIP；盘中价格更新/告警链路/通知声音尚未在交易时段实弹验证。
4. **移动端真机 / 生产部署**：iOS Safari 安全区/触控/通知、生产 Service Worker/Pages 缓存（data/latest.json）仍未验证。

## 已知未验证项（人工/盘中/部署）

1. **真实盘中实弹**：盘中价格更新、告警链路、通知/声音，需交易时段跑 `node scripts/market-window-check.mjs`（09:35 计划）；本次 已尝试。
2. **移动端真机**：iOS Safari 安全区/触控/通知权限；headless 视口截图见 `docs/visual-check.md`（E5 PASS*，遗留 P2 触控/FAB 已由后续提交修复，仍建议真机确认）。
3. **生产 Service Worker / GitHub Pages**：`data/latest.json` 缓存、旧快照回退提示、通知权限；本地 dev server 不注册 SW，需部署后验证（P1-8）。
4. **集合竞价 09:15–09:25**：腾讯时间戳行为未经实测（P1-3）。
5. **生产网络下东财主链路**：本机东财 push2 被反爬，日线已验证腾讯回退；东财可用网络下的主链路未在本机覆盖。
6. **服务端功能**：`server/app.py` 的语音/DeepSeek 研究接口、AI 简报未纳入本机验收。

## 发布候选结论

**自动化通过（发布候选 RC）**：可作为发布候选交用户做收盘后/真机走查。真实盘中实弹、移动端真机、生产 Service Worker 仍待人工，见「已知未验证项」。

> 本文件由 `scripts/acceptance-all.sh` 每次运行自动覆盖；人工结论与遗留项请以对应子报告为准。
