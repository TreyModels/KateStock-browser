# 发布候选（RC）状态

- 版本：`3fdf1d1` — Add one-command acceptance runner and RC status tooling
- 生成时间：2026-11-24 07:29:19（Asia/Shanghai）；相位：preopen
- 环境：macOS，Node v26.12.0，dev server http://localhost:3000（可达），公开快照：存在（701293 bytes）
- 工作区：0 个未提交文件（验收脚本/文档/日志；**src/ 应用代码零改动**）
- 一键复跑：`bash scripts/acceptance-all.sh`（退出码 0=无 FAIL；1=有 FAIL）
- 本次日志：`docs/acceptance-logs/20261124-072918/`（已 gitignore）
- 本次 market-window: SKIP（非交易时段，当前相位=preopen）

## 本次结果

| 检查 | 结果 | 证据 | 说明 |
| --- | --- | --- | --- |
| verify.sh | PASS | scripts/verify.sh（build/lint/node tests；日志 docs/acceptance-logs/20261124-072918/verify.sh.log） | exit 0 |
| check_baseline | PASS | tests/acceptance/check_baseline.mjs | exit 0 |
| python-unittest | PASS | tests/（python3 -m unittest discover -s tests） | exit 0 |
| personal-stock-e2e | PASS | docs/personal-stock-e2e.md、docs/screenshots/personal-stock-*.png | exit 0 |
| preopen-check | PASS | docs/preopen-check.md、docs/screenshots/preopen-*.png | exit 0 |
| market-window | SKIP | docs/market-window-report.md | 非交易时段（当前相位=preopen；仅在 09:15–11:30 / 13:00–15:00 运行） |

汇总：PASS=5，FAIL=0，SKIP=1，PENDING=0。

## 真实输出（每步 tail；完整日志见 `docs/acceptance-logs/20261124-072918/`）

### verify.sh（PASS）
```
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 713.637
--> PASS: node tests

════════════════════════ 汇总 ════════════════════════
  PASS  build
  PASS  lint
  PASS  node tests
  日志：/var/folders/jb/km5070j9141659tyckdk886r0000gn/T//katestock-verify-20261124-072919.log
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
  · 点击「更新」：触发 fetchQuotes（东财 → JSONP → 腾讯 kline）
  · 拿到日线：{"code":"600000","price":10.75,"tradeDate":"2026-11-23","bars":160,"firstDate":"2026-03-30","lastDate":"2026-11-23","provider":"Tencent kline (qfq)","adjustment":"前复权","source":"auto"}
✅ 股票行出现价格：浦发银行 600000 当前自选 10.75 -1.10% 盘前 2026 收益额 — 策略
✅ 详情价位至少一个非「—」：[{"label":"触发价","value":"10.78"},{"label":"保护位","value":"10.23"},{"label":"目标位","value":"11.20"}]
✅ 详情包含触发/保护/目标三项：触发价 / 保护位 / 目标位
✅ 今日页出现该股票策略卡：浦发银行 600000 10.75 -1.10% 盘前 回踩低吸 强度 74 上升趋势仍在，价格回到短期均线区域，等待止跌后介入。 触发 10.78 距触发 +0.3% 保护 10.23 距保护 +5.1% 目标 11.20 距目标 +4.2% 参考上限 2200 股 完整计划 自动日线 · 2026-11-23
✅ 策略卡有价格且至少一个价位：价格型数值 5 个：10.75 / 1.10 / 10.78 / 10.23 / 11.20；浦发银行 600000 10.75 -1.10% 盘前 回踩低吸 强度 74 上升趋势仍在，价格回到短期均线区域，等待止跌后介入。 触发 10.78 距触发 +0.3% 保护 10.23 距保护 +5.1% 目标 11.20 距目标 +4.2% 参考上限 2200 股 完整计划 自动日线 · 2026-11-23
✅ 东财 push2his 有请求且失败（反爬/JSONP 失败）：attempts=4, failures=4
✅ 腾讯 fqkline 回退成功（HTTP 200 且 qfqday≥21 根）：[{"kind":"response","status":200,"url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","qfqdayRows":320,"firstDate":"2025-07-29","lastDate":"2026-11-23"},{"kind":"response","status":200,"url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,320,qfq","qfqdayRows":320,"firstDate":"2025-07-29","lastDate":"2026-11-23"}]
✅ quote 的 provider 标明腾讯日线回退：Tencent kline (qfq)
✅ quote 的 bars 为 160 根（上限）：160 根（2026-03-30 → 2026-11-23）
✅ 无 pageerror：0 条
```

### preopen-check（PASS）
```
真实时钟盘前检查：2026-11-24 07:29:33（Asia/Shanghai）
✅ 相位徽标 = 盘前：phase="盘前"；状态条="最近报价 16:15:00 数据年龄 15 小时前 成功 29 / 失败 0 / 订阅 29"
✅ provider 时间 = 上一交易日约 16:14（不是今天 09:xx）：000960 20261123161500 → 2026-11-23 16:15:00（来源 tencent field30；expectedDate=2026-11-23；today=2026-11-24）
✅ 状态条「最近报价」= provider 时间（±2 分钟）：statusClock=16:15:00 vs provider=16:15:00
✅ 数据年龄为小时级（数小时）：数据年龄=数据年龄 15 小时前；statusMeta="最近报价 16:15:00 数据年龄 15 小时前 成功 29 / 失败 0 / 订阅 29"
✅ 不把旧价标成「盘中」（价格标签无 盘中/竞价、无 live 标签）：liveTagCount=0；标签样本=["盘前","盘前","盘前","盘前","盘前","盘前"]；liveClaimText=false
✅ 提醒面板为空（无 alert-item / toast）：alerts=0，toasts=0，panel="INTRADAY ALERTS 盘中提醒 通知被浏览器拒绝 提示音已关 浏览器已拒绝通知，可在站点权限设置中重新允许；页面内提醒不受影响。 提醒只针对个人清单：请先在「股票」页添加自选或持仓，生成策略价位后才会提醒。公开清单只有收盘信号、没有触发/保护/目标价位，不会产生提醒。 提醒语义：持仓策略只提醒保护位/目标位，非持仓策略只提醒买入触发，观望策略不提醒"
✅ 提醒面板空状态文案完整（盘前/个人清单说明）：INTRADAY ALERTS 盘中提醒 通知被浏览器拒绝 提示音已关 浏览器已拒绝通知，可在站点权限设置中重新允许；页面内提醒不受影响。 提醒只针对个人清单：请先在「股票」页添加自选或持仓，生成策略价位后才会提醒。公开清单只有收盘信号、没有触发/保护/目标价位，不会产生提醒。 提醒语义：持仓策略只提醒保护位/目标位，非持仓策略只提醒买入触发，观望策略不提醒。提醒基于公开行情与规则价位，可能延迟或误报；同一天同一类提醒只记录一次，不构成投资建议。
✅ 无 UI 报错 / 无 pageerror：statusError=0；pageErrors=0；非网络 console=0
✅ 公开清单价格标签 = 盘前/收盘（无 盘中）：共 29 个标签；异常=[]；样本=["盘前","盘前","盘前","盘前","盘前","盘前"]
✅ 公开清单条数 = 29：publicCount=29；heading="快照交易日/最新报价 2026-11-23 · 29 只有行情"
✅ 无 pageerror（最终）：0 条
```

### market-window（SKIP）
```
非交易时段（当前相位=preopen；仅在 09:15–11:30 / 13:00–15:00 运行）
```


## 证据索引

- 基线与验收清单：`docs/baseline.md`、`docs/acceptance.md`
- 复验报告：`docs/acceptance-report-round2.md`、`docs/acceptance-report-round3.md`
- 可视化/移动端：`docs/visual-check.md`、`docs/screenshots/*.png`（本地，gitignored）
- 核心路径 E2E：`docs/personal-stock-e2e.md`
- 盘前态：`docs/preopen-check.md`
- 交易窗口实弹：`docs/market-window.md`、`docs/market-window-report.md`

## 已知未验证项（人工/盘中/部署）

1. **真实盘中实弹**：盘中价格更新、告警链路、通知/声音，需交易时段跑 `node scripts/market-window-check.mjs`（09:35 计划）；本次 因非交易时段 SKIP。
2. **移动端真机**：iOS Safari 安全区/触控/通知权限；headless 视口截图见 `docs/visual-check.md`（E5 PASS*，遗留 P2 触控/FAB 已由后续提交修复，仍建议真机确认）。
3. **生产 Service Worker / GitHub Pages**：`data/latest.json` 缓存、旧快照回退提示、通知权限；本地 dev server 不注册 SW，需部署后验证（P1-8）。
4. **集合竞价 09:15–09:25**：腾讯时间戳行为未经实测（P1-3）。
5. **生产网络下东财主链路**：本机东财 push2 被反爬，日线已验证腾讯回退；东财可用网络下的主链路未在本机覆盖。
6. **服务端功能**：`server/app.py` 的语音/DeepSeek 研究接口、AI 简报未纳入本机验收。

## 发布候选结论

**自动化通过（发布候选 RC）**：可作为发布候选交用户做收盘后/真机走查。真实盘中实弹、移动端真机、生产 Service Worker 仍待人工，见「已知未验证项」。

> 本文件由 `scripts/acceptance-all.sh` 每次运行自动覆盖；人工结论与遗留项请以对应子报告为准。
