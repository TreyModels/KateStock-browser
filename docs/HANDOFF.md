# 交接说明（HANDOFF）

截至 2026-11-24 07:36（收盘/盘前），版本 `v0.1.0-rc2`。

## 一句话状态

看板复刻 + 盘中实时行情 + 买卖触发提醒已做完并通过自动化验收（5 PASS / 0 FAIL / 1 SKIP）。
**唯一没打的一枪是真实盘中实弹**——定时任务会在 09:16（集合竞价）和 09:35（开盘后）自动跑，结果写回 `docs/market-window-report.md` 与 `docs/rc-status.md`。

## 怎么用

```bash
cd kate-dashboard
PATH=/opt/homebrew/bin:$PATH npm run dev        # http://localhost:3000
PATH=/opt/homebrew/bin:$PATH npm run refresh    # 收盘后（16:45+）刷新公开清单快照
bash scripts/acceptance-all.sh                  # 一键验收（生成 docs/rc-status.md）
```

- 加自己的股票：「股票」页 → 添加 → 更新（日线走腾讯回退，不需要东财）。
- 提醒：提醒面板 → 开启浏览器通知；iOS 需先「添加到主屏幕」。
- 使用细节见 `docs/USAGE.md`。

## 验收现状

| 项 | 证据 |
|---|---|
| build / lint / 98 离线测试 | `scripts/verify.sh` |
| 基线不变量 19 项 | `tests/acceptance/check_baseline.mjs` |
| 浏览器 E2E：加非公开股票 → 腾讯日线 → 三价位 | `docs/personal-stock-e2e.md` |
| 盘前真实时钟：不冒充实时 | `docs/preopen-check.md` |
| 移动端 320/375 无溢出、无小触控目标 | `docs/visual-check.md` |
| 一键验收汇总 | `docs/rc-status.md` |

## 未验证（不要当成已通过）

1. **真实盘中提醒**：脚本 `scripts/market-window-check.mjs` 在交易时段跑；`exit 0` 才算 PASS，`exit 3` 是「窗口内未自然触发」，只能记 PENDING。
2. **iOS 真机**：安全区、触控、通知权限需要真机看一眼。
3. **生产部署**：Service Worker 缓存策略（P1-8）、Pages/CDN 的 latest.json 缓存。
4. **集合竞价时段**腾讯时间戳行为（P1-3），09:16 任务会验。
5. 本机东财主链路被反爬（已验证腾讯回退，不是功能缺失）。

## 关键提交

```
ea8db3a Record RC acceptance run after snapshot refresher   (tag v0.1.0-rc2)
353185c Add Node snapshot refresher
3fdf1d1 Add one-command acceptance runner and RC status tooling
e76d14c Add real-clock preopen check
0db6673 Add personal-stock browser E2E
a22c357 Add alert-wiring live check
82cde04 Add real-market acceptance script
7ea30f5 Add Tencent kline fallback for daily bars
f0db199 Fix mobile touch targets / FAB
e5b6e81 Intraday quotes + alerts + dashboard integration
```

## 已知取舍

- 腾讯回退不返回成交额（`amount=0`），不影响价格/涨跌幅/均线/ATR。
- 法定节假日未识别（按工作日；失败时显式报错）。
- 公开清单 29 只，非全市场；规则分数不是收益概率。
- 盘中跑 `npm run refresh` 会用到未收盘 K 线，指标失真——请 16:45 后再跑。

## 下一步建议

1. 09:16 / 09:35 看两个定时任务的结论；若 FAIL，`docs/market-window-report.md` 会指出责任域（data / signals / ui）。
2. 真机走查一遍移动端（截图在 `docs/screenshots/`）。
3. 若要上线：先决定部署形态（静态 Pages 或常开服务端），再专项验 SW 缓存与通知权限。
