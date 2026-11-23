# 交易窗口实弹验收报告（预运行状态）

> 本文件由 `scripts/market-window-check.mjs` 在交易窗口内运行时**覆盖生成**。当前是 2026-11-24 07:1x（盘前），尚未执行实弹采样；以下为预运行状态与 `--node-probe` 自测结论。

- 脚本：[`scripts/market-window-check.mjs`](../scripts/market-window-check.mjs)
- 用法：[`docs/market-window.md`](./market-window.md)
- 计划运行：**2026-11-24 09:35（Lead）**，窗口 09:15–11:30
- 退出码约定：0=PASS / 1=FAIL / 2=非交易时段 / 3=PENDING（硬断言通过但未自然触发提醒）

## 预运行自测（07:15，非交易时段，属预期）

| 项 | 结果 |
| --- | --- |
| 主脚本（非窗口） | 输出「非交易时段…exit 2」，**未启动浏览器**，`MAIN_EXIT=2` |
| `--node-probe` 腾讯 qt.gtimg.cn | 600519 time=20261123161441、159558 time=20261123161436 → **上一交易日旧时间戳**（预期） |
| `--node-probe` 腾讯 fqkline | 600519/159558 最后 bar = 2026-11-23 → **旧日期**（预期） |
| `--node-probe` 东财 kline | Node 直连 `fetch failed`（本机反爬；curl 可通），仅作附加探测，不影响 probe 结论 |
| 冒烟测试（临时副本，固定 10:00 时钟） | 页面加载、策略卡=2、公开卡=29、采样/截图/报告/断言链路均正常；因真实 provider 仍是旧时间戳，按预期 FAIL（未计入正式结论） |

## 待 09:35 运行后填充

脚本将生成：采样表（t0/+45s/+120s 的状态条、策略卡价位、公开前 3、提醒、console 网络错误）、provider 时间戳、硬断言结果、结论与截图路径。
