# 日内 · A股今日策略

面向 iPhone 与桌面浏览器的本地 A 股／ETF 短线策略工作台。

## 运行

```bash
npm install
npm run dev
```

生产构建：`npm run build`，输出目录为 `dist/`。

## 功能

- 自动获取公开日线行情，失败时支持 JSONP 回退与手动指标录入。
- 突破跟随、回踩低吸、趋势持有、过热减仓与止损规则。
- 四策略独立历史回测：收盘出信号、次日开盘执行，计入成本并防止未来函数。
- 当前适配评分、权益曲线、交易日志与可播放／拖动的动态复盘时间轴。
- 按账户本金、单笔风险和单票仓位上限计算整手参考股数。
- 股票清单、当前持仓、自选与历史记录管理。
- 本地持久化、JSON 备份导入导出、PWA 主屏幕安装。

## 数据与边界

持仓和设置只保存在当前浏览器 localStorage，不同步到其他设备。行情来自东方财富公开日线接口，可能延迟或中断。策略为固定规则研究结果，不连接券商、不自动下单，也不构成收益承诺。

预置的 29 条证券记录来自用户提供的 2026 年收益贡献截图，全部标记为“历史记录”，不代表当前持仓。

## Attribution and reuse

Credit and cite **Dr. Trey Menefee** when using, reproducing, sharing, or adapting his material. Noncommercial use is permitted under the conditions in [LICENSE](LICENSE); commercial use requires prior permission. Third-party materials retain their own terms.
