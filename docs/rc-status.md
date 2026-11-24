# 发布候选（RC）状态

- 版本：`2ce402e` — Make backtests execution-realistic (T+1, limit boards, lots, min commission)
- 生成时间：2026-11-24 18:25:38（Asia/Shanghai）；相位：closed
- 环境：macOS，Node v26.12.0，dev server http://localhost:3000（可达），公开快照：存在（631591 bytes）
- 工作区：10 个未提交文件，其中 src/ 有 1 个改动（⚠️ 发布前需确认）
- 一键复跑：`bash scripts/acceptance-all.sh`（退出码 0=无 FAIL；1=有 FAIL）
- 本次日志：`docs/acceptance-logs/20261124-182538/`（已 gitignore）
- 本次 market-window: SKIP（非交易时段，当前相位=closed）

## 本次结果

| 检查 | 结果 | 证据 | 说明 |
| --- | --- | --- | --- |
| verify.sh | PASS | scripts/verify.sh（build/lint/node tests；日志 docs/acceptance-logs/20261124-182538/verify.sh.log） | exit 0 |
| check_baseline | PASS | tests/acceptance/check_baseline.mjs | exit 0 |
| python-unittest | PASS | tests/（python3 -m unittest discover -s tests） | exit 0 |
| personal-stock-e2e | PASS | docs/personal-stock-e2e.md、docs/screenshots/personal-stock-*.png | exit 0 |
| preopen-check | SKIP | docs/preopen-check.md | 非盘前（当前相位=closed；preopen-check 仅在交易日 09:15 前运行） |
| market-window | SKIP | docs/market-window-report.md | 非交易时段（当前相位=closed；仅在 09:15–11:30 / 13:00–15:00 运行） |

汇总：PASS=4，FAIL=0，SKIP=2，PENDING=0。

## 真实输出（每步 tail；完整日志见 `docs/acceptance-logs/20261124-182538/`）

### verify.sh（PASS）
```
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13569.897541
--> PASS: node tests

════════════════════════ 汇总 ════════════════════════
  PASS  build
  PASS  lint
  PASS  node tests
  日志：/var/folders/jb/km5070j9141659tyckdk886r0000gn/T//katestock-verify-20261124-182538.log
══════════════════════════════════════════════════════
结果：PASS（build + lint + node tests 全部通过）
```

### check_baseline（PASS）
```
✓ B-12  定时信号仍复用 generateStrategy 引擎  [匹配 "generateStrategy"]
✓ B-13  公开信号仍被 check_public.py 限制为无 sizing 字段  [匹配 "'action','actionLabel','score','summary','reasons','indicators'"]
✓ B-14  快照 schema 仍含 schemaVersion/tradeDate/partial/signals  [关键字段齐全]
✓ B-15  快照合并仍保留手动行情（mergeSnapshotQuotes）  [匹配 "source !== 'manual'"]
✓ B-16  报告状态条仍标注「非实时行情」  [匹配 "非实时行情"]
✓ B-17  README 仍写明「收盘出信号、次日开盘执行」  [匹配 "收盘出信号、次日开盘执行"]
✓ B-18  运维文档仍声明 snapshots are not live quotes  [匹配 "snapshots are not live quotes"]
✓ B-19  验收交付物存在：baseline/acceptance/verify.sh  [四个交付物齐全]

17/17 有效断言通过；SKIP 1 项（B-10，不判失败）
总计 18 项：PASS 17，SKIP 1，FAIL 0。
PASS: 基线不变量全部保持（SKIP 项为预期临时变更）。
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
  · 拿到日线：{"code":"600000","price":10.69,"tradeDate":"2026-11-24","bars":160,"firstDate":"2026-03-31","lastDate":"2026-11-24","provider":"Tencent kline (qfq)","adjustment":"前复权","source":"auto"}
✅ 股票行出现价格：浦发银行 600000 当前自选 10.69 -0.56% 收盘 2026 收益额 — 策略
✅ 详情价位至少一个非「—」：[{"label":"触发价","value":"10.75"},{"label":"保护位","value":"10.27"},{"label":"目标位","value":"11.19"}]
✅ 详情包含触发/保护/目标三项：触发价 / 保护位 / 目标位
✅ 今日页出现该股票策略卡：浦发银行 600000 10.69 -0.56% 收盘 熊市观望 强度 74 熊市禁止新买入：等 MA60 回升与宽度修复 熊市：不加仓，只管理持仓/等结构修复 触发 10.75 距触发 +0.6% 保护 10.27 距保护 +4.1% 目标 11.19 距目标 +4.7% 完整计划 自动日线 · 2026-11-24
✅ 策略卡有价格且至少一个价位：价格型数值 5 个：10.69 / 0.56 / 10.75 / 10.27 / 11.19；浦发银行 600000 10.69 -0.56% 收盘 熊市观望 强度 74 熊市禁止新买入：等 MA60 回升与宽度修复 熊市：不加仓，只管理持仓/等结构修复 触发 10.75 距触发 +0.6% 保护 10.27 距保护 +4.1% 目标 11.19 距目标 +4.7% 完整计划 自动日线 · 2026-11-24
✅ 东财 push2his 有请求（成功或失败均可，按实际记录）：attempts=4，成功(klines)=0，失败=4
✅ 日线数据获取成功（东财主源 或 腾讯/新浪回退）：东财主源成功=false；腾讯成功=2（501=0，尝试=7）；新浪成功=0
✅ 数据来源可识别：Tencent kline（腾讯回退）
✅ 腾讯 fqkline 回退成功（HTTP 200 且 qfqday≥21 根）：[{"kind":"response","status":200,"host":"bare","url":"https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","bodySnippet":"{\"code\":0,\"msg\":\"\",\"data\":{\"sh600000\":{\"qfqday\":[[\"2025-07-29\",\"12.650\",\"12.370\",\"12.700\",\"12.360\",\"","qfqdayRows":321,"firstDate":"2025-07-29","lastDate":"2026-11-24"},{"kind":"response","status":200,"host":"bare","url":"https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","bodySnippet":"{\"code\":0,\"msg\":\"\",\"data\":{\"sh600000\":{\"qfqday\":[[\"2025-07-29\",\"12.650\",\"12.370\",\"12.700\",\"12.360\",\"","qfqdayRows":321,"firstDate":"2025-07-29","lastDate":"2026-11-24"}]
✅ quote 的 bars 为 160 根（上限）：160 根（2026-03-31 → 2026-11-24）
✅ 无 pageerror：0 条
```

### preopen-check（SKIP）
```
非盘前（当前相位=closed；preopen-check 仅在交易日 09:15 前运行）
```

### market-window（SKIP）
```
非交易时段（当前相位=closed；仅在 09:15–11:30 / 13:00–15:00 运行）
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
2. **数据可用性依赖多级回退**：本机东财 push2 时通/时被反爬、腾讯 fqkline 时通/时返回 501 WAF；个股日线依赖「东财 → 腾讯 → 新浪」多级回退。若全部不可用，该股日线会失败并走手动行情，不会伪造数据。
3. **盘中数据与提醒**：盘中价格更新/告警链路实弹：本次因非交易时段 SKIP；通知/声音未在本脚本断言；跨交易日/不同行情形态仍需持续观察。
4. **移动端真机 / 生产部署**：iOS Safari 安全区/触控/通知、生产 Service Worker/Pages 缓存（data/latest.json）仍未验证。

## 已知未验证项（人工/盘中/部署）

1. **真实盘中实弹**：盘中价格更新、告警链路、通知/声音（通知/声音未在本脚本断言）；本次因非交易时段 SKIP。
2. **移动端真机**：iOS Safari 安全区/触控/通知权限；headless 视口截图见 `docs/visual-check.md`（E5 PASS*，遗留 P2 触控/FAB 已由后续提交修复，仍建议真机确认）。
3. **生产 Service Worker / GitHub Pages**：`data/latest.json` 缓存、旧快照回退提示、通知权限；本地 dev server 不注册 SW，需部署后验证（P1-8）。
4. **集合竞价 09:15–09:25**：腾讯时间戳行为未经实测（P1-3）。
5. **生产网络下东财主链路**：本机东财 push2 被反爬，日线已验证腾讯回退；东财可用网络下的主链路未在本机覆盖。
6. **服务端功能**：`server/app.py` 的语音/DeepSeek 研究接口、AI 简报未纳入本机验收。

## 发布候选结论

**自动化通过（盘中实弹本次 SKIP）**：可作为发布候选；真实盘中实弹需在 09:15–11:30 / 13:00–15:00 重跑，移动端真机/生产 SW 仍待人工。

> 本文件由 `scripts/acceptance-all.sh` 每次运行自动覆盖；人工结论与遗留项请以对应子报告为准。
