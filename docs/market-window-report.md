# 交易窗口实弹验收报告（预运行状态）

> 本文件由 `scripts/market-window-check.mjs` 在交易窗口内运行时**覆盖生成**。当前是 2026-11-24 07:2x（盘前），尚未执行实弹采样；以下为预运行状态与自测结论。

- 脚本：[`scripts/market-window-check.mjs`](../scripts/market-window-check.mjs)
- 用法：[`docs/market-window.md`](./market-window.md)
- 计划运行：**2026-11-24 09:35（Lead）**，窗口 09:15–11:30
- 退出码：0=PASS / 1=FAIL / 2=非交易时段 / 3=PENDING（硬断言+告警链路通过，但未自然触发提醒）

## 两级提醒检查（实跑时分开写）

| 检查 | 口径 | 判定 |
| --- | --- | --- |
| **告警链路实弹** | 用真实 gtimg 实时价 × 公开快照真实 bars，选 `ma20 > 当前价` 的候选注入为 holding（cost=EOD×1.2 → costStop → action=stop，stop 在现价上方），reload 后等 ≤30s 看该 code 的 stop 提醒是否出现 | **必须 PASS**；FAIL → exit 1，附状态条/面板/候选卡证据 |
| **自然触发** | 窗口内价格真的穿越策略价位（排除脚本注入候选的 stop 告警） | 出现 → PASS（exit 0）；未出现 → PENDING（exit 3，不判失败） |

## 预运行自测（07:15–07:21，非交易时段，属预期）

| 项 | 结果 |
| --- | --- |
| 主脚本（非窗口） | 「非交易时段…exit 2」，**未启动浏览器**，`MAIN_EXIT=2` |
| `--node-probe` gtimg | 600519 time=20261123161441、159558 time=20261123161436 → **上一交易日旧时间戳**（预期） |
| `--node-probe` fqkline | 600519/159558 最后 bar = 2026-11-23 → 旧日期（预期） |
| `--node-probe` 东财 kline | Node 直连 fetch failed（本机反爬；curl 可通），不影响 probe（以腾讯两源为准） |
| `--pick-candidate` | 29/29 拿到 gtimg 报价；选中 002827（EOD=44.85，实时=44.85，ma20=54.03，stop≈45.86，cost=53.82，余量 2.25%） |
| 冒烟（临时副本，固定 10:00 + mock 新鲜报价） | 页面/策略卡=3/采样/告警链路 PASS/报告/断言链路均正常；已清理，未计入正式结论 |

## 待 09:35 运行后填充

脚本将生成：告警链路实弹（候选表 + 选中 + 等待证据）、自然触发、采样表（t0/+45s/+120s）、provider 时间戳、硬断言、结论与截图路径。
