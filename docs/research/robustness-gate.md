# 推荐前稳健性门槛（Robustness Gate）——本应用动作的 PASS / FAIL / UNKNOWN

> 版本：v1.0 · 2026-11-24 · 作者：strategy-research（研究稿）
> 用途：在把任何策略「推荐给她」之前，必须逐项过下面的硬门槛。**门不过，不推荐**；门不过但作为风控纪律有独立价值的，单独标注。
> 本文件**不构成投资建议**，也不承诺任何收益。
> 配套：`docs/research/strategy-equations.md`（公式与数据可行性）、`docs/research/strategies.md`（regime playbook）、`src/lib/strategy.ts`、`src/lib/backtest.ts`。
> 判定口径：**PASS** = 有证据通过全部适用硬门槛；**FAIL** = 有证据表明在本应用条件下不成立/不可执行；**UNKNOWN** = 证据不足，门未过 → 暂不推荐（默认状态）。**本应用当前的 6 个动作 + 熊市超跌反弹，没有一个是 PASS（作为 alpha 策略）。**

## Executive summary

1. **A strategy may only be recommended after passing seven hard gates:** reproducible definition, ≥5 years with regime coverage and n≥30 per cell, out-of-sample, multiple-testing control (Bonferroni/BH/Reality Check), cross-type robustness (size/industry/liquidity, excluding ST, new listings, suspended and limit-locked names), execution feasibility under T+1/price limits/costs/slippage, and parameter-neighbourhood stability; capacity and reporting standards are also required.
2. **Statistical power alone kills most short-sample results:** to distinguish an annualized Sharpe of 0.5 from zero at 95% confidence requires roughly 15–17 years of data (Lo 2002 SE approximation), and with 20 backtest trials Bonferroni raises this to roughly 40 years — a 160-day demo cannot validate anything.
3. **This app's current backtest is a signal simulator, not a validation harness:** it is single-name, all-in, 0.10% one-way cost, no T+1 constraint enforcement, no limit-up/down or halt filtering, no portfolio layer; any conclusion drawn from it fails gates G2 (sample), G6 (cross-type) and G7 (execution) by construction.
4. **Gate verdicts for the app:** `breakout` UNKNOWN (weak A-share prior, untested net of costs), `pullback` UNKNOWN (short-reversal prior is favorable but the app's version is a 5–20 day trend pullback, not the tested 1–5 day reversal), `hold`/`reduce` UNKNOWN (exit policies that inherit the entry strategy), `stop` PASS only as a risk-control discipline (not as alpha), `watch` PASS trivially (no position = no risk), bear-market `reversion` UNKNOWN and not even implementable in `generateStrategy` today.
5. **Net recommendation:** recommend only the risk-control rules (`stop` discipline, cash/position caps) plus the "do nothing / watch" default; do **not** recommend `breakout`, `pullback`, `hold`, `reduce` or bear-reversion as profitable strategies until the missing evidence listed in §2/§6 is produced.

---

## 0. 判定规则与适用范围

### 0.1 三态定义

| 判定 | 含义 | 能否推荐 |
|---|---|---|
| **PASS** | 有证据通过全部适用硬门槛 | 可以推荐，但必须附「适用边界 + 失效条件」 |
| **FAIL** | 有证据表明在本应用条件下不成立（负期望/不可执行/概念错误） | **不能推荐** |
| **UNKNOWN** | 证据不足或关键门槛未测 | **不能推荐**（默认状态，不是「也许能」） |

补充：`stop`、`watch` 这类**非 alpha 规则**不按 alpha 门槛打分，但需标注「只作为风控/无操作纪律，不作为收益来源」。

### 0.2 本应用能提供什么

- 日线 OHLCV（`Bar`：date/open/close/high/low/volume/amount/changePct），`amount` 在腾讯源常为 0；
- `generateStrategy`（EOD 动作：breakout/pullback/hold/reduce/stop/watch）；
- `runBacktest`（单标的、4 套策略、满仓、0.1% 单边成本、收盘信号→次日开盘）；
- `regime.ts`（沪深300 MA20/60/120 + 回撤 + 宽度，provisional）。

**不能提供**：全市场股票池、股本/市值、财报、行业、ST/次新/停牌标记、真实换手率、历史指数成分（point-in-time）、多资产与无风险收益、分钟级执行数据。

---

## 1. 门槛 G1–G10（判定标准 / 所需证据 / 本应用现状）

### G1 定义可复现（Reproducibility）

- **硬标准**：公式、参数、回看窗口、调仓时点、成交价假设、成本模型、数据版本全部写死；他人在同一数据上能复现同一笔交易序列。
- **所需证据**：代码 + 数据快照 + 参数文件 + 交易日志（每笔的 signalDate/entryDate/entryPrice/exitPrice/exitReason）。
- **本应用现状**：公式已在 `strategy-equations.md` 写清；但 backtest 只有 0.1% 成本、无滑点/涨跌停/T+1 强制，且样本来自会变的 `public/data/latest.json` → **部分满足**，需冻结快照与成本模型。

### G2 样本量与覆盖（Sample size & coverage）

- **硬标准**：≥5 年日线；至少覆盖 2 个完整牛熊周期（如 2018 熊、2019–2021 牛、2022 熊、2023–2024 震荡）；每个 `策略 × regime` 单元 **n ≥ 30**；交易次数足够做统计（建议 ≥100 笔）。
- **所需证据**：分年交易数、分 regime 交易数、有效样本起止日期。
- **本应用现状**：演示数据 29 只 × 每只 160 根日线（约 8 个月），regime 单元最小 n=5 → **不满足**（差一个数量级）。

### G3 样本外（Out-of-sample / holdout）

- **硬标准**：最近 ≥2 年或 ≥30% 样本完全不参与参数选择与规则设计；样本外表现与样本内**同号**且效应量不崩塌（如样本外收益 ≥ 样本内的 50%，或至少不为负）。
- **所需证据**：样本内/外分段报告；参数冻结时间戳；样本外交易日志。
- **本应用现状**：没有任何样本外划分 → **不满足**。

### G4 多重检验（Multiple testing）

- **硬标准**：记录试过的策略/参数组合数 `k`；用 Bonferroni（`α/k`）、Benjamini–Hochberg（FDR 10%）或 White Reality Check / Hansen SPA（p<0.05）校正；报告校正后的 p 值与 Deflated Sharpe Ratio（Bailey & López de Prado 2014）。
- **所需证据**：全部试验的收益序列（不是只报最好的一个）；`k` 与校正过程。
- **本应用现状**：无可用于多重检验的试验记录；只有 4 套策略的展示 → **不满足**。
- **统计功效警示**（用 Lo 2002 的 Sharpe 标准误近似，`SE(SR) ≈ sqrt((1+SR²/2)/T)`，T 为年数）：
  - 要区分年化 `SR=0.5` 与 0（95% 双侧），忽略高阶项约需 `T ≈ (1.96/0.5)² ≈ 15.4` 年；用上式修正约 **17 年**；
  - 若有 `k=20` 次试验，Bonferroni 阈值 `α/k=0.0025`（z≈3.02），`SR=0.5` 约需 **41 年**；
  - 也就是说：**160 个交易日的回测即使看起来很好，也几乎不可能提供统计证据**（除非效应量极大，而这通常意味着过拟合或数据错误）。

### G5 分年 / 分 regime 稳定性

- **硬标准**：分年收益 ≥60% 年份同号；单一年份贡献不超过总收益的 50%；每个 regime（Bull/Range/Bear）都有独立、方向一致的样本；报告最差年份与最差 regime。
- **所需证据**：分年、分 regime 表；最差 5 个交易月/季度。
- **本应用现状**：未做（样本不足一年）→ **不满足**。

### G6 标的类型稳健（Cross-sectional robustness）

- **硬标准**：结果在**大盘/小盘**、至少 2 个**行业**、**流动性高/中/低**分层中方向一致（允许强度差异，不允许符号翻转）；剔除 **ST、次新（上市 < 60/120 日）、停牌、涨跌停不可成交、退市整理** 样本后结论不变。
- **所需证据**：各分层收益表；剔除清单与剔除前后对比。
- **本应用现状**：无股本/行业/ST/上市日期字段；29 只公开清单不是全市场、非 point-in-time → **不满足，且数据上不可实现**（需外部数据源）。

### G7 执行可行性（Execution feasibility）

- **硬标准**：
  - T+1：买入当日不得卖出；止损/目标当天触发只能下一交易日执行；
  - 次日开盘执行，不用收盘价成交；
  - 一字涨停不买、一字跌停不卖、停牌不交易；
  - 成本：双边佣金 + 印花税（卖出 0.05%）+ 过户费 + 滑点（0.1%–0.3%/边），**单边总成本 ≥0.1%，建议按 0.2% 做压力测试**；
  - 开盘跳空越过触发价 >2% 视为追高，放弃。
- **所需证据**：成交假设文档；含/不含涨跌停过滤两版结果；成本敏感性（0.1%/0.2%/0.3%）。
- **本应用现状**：`backtest.ts` 只有 0.1% 单边成本、按触发价成交、无涨跌停/停牌/T+1 约束；止损在「当天 bar.low ≤ stop」就假设能卖，**违反 T+1**（当天买入当天不能卖）→ **不满足**。

### G8 参数敏感性（Parameter neighbourhood）

- **硬标准**：核心参数 ±20% 邻域（如 Donchian 16/20/25、ATR 止损 1.2/1.4/1.6、RSI 12/14/16、回踩缓冲 0.2/0.25/0.3）**符号不变**，效应量保留 ≥50%；不存在「只有某一个参数值赚钱」的悬崖。
- **所需证据**：参数网格表（不是只报最优）。
- **本应用现状**：未做 → **不满足**。

### G9 容量（Capacity）

- **硬标准**：单笔订单 ≤ 20 日平均成交额的 1%；最小可交易标的在个人资金（如 ¥10 万–100 万）下能成交；给出「资金上限」估计。
- **所需证据**：按 ADV 分层；滑点随规模变化。
- **本应用现状**：`amount` 常为 0，无法算 ADV；29 只样本中部分小盘/ETF → **不满足**（可用 `C×V` 粗估，但需标口径）。

### G10 报告规范（Reporting）

- **硬标准**：必须同时报告：年化收益、**Sharpe 的 95% 置信区间**、最大回撤、胜率、盈亏比、交易数、分年/分 regime、**最差年份/最差月**、失败案例、全部交易日志；禁止只报「总收益」或「胜率」。
- **所需证据**：标准报告模板（§12）+ 原始交易记录。
- **本应用现状**：`BacktestLab` 展示收益/胜率/最大回撤/评分，但无置信区间、无成本敏感性、无失败案例、无交易日志导出 → **部分满足**。

---

## 2. 本应用动作的 Gate 打分

> 打分对象是「作为可推荐给用户的策略/规则」，不是「代码是否存在」。

| 动作 | 类型 | Gate 判定 | 已有什么 | 缺什么（必须补） | 推荐结论 |
|---|---|---|---|---|---|
| `breakout` 突破跟随 | 入场（动量/突破） | **UNKNOWN** | 有精确规则（Donchian 20 变体 + 量比确认）；有单标的回测实现 | 中国 ≥5 年扣费后样本、样本外、多重检验、涨跌停/T+1 过滤、参数邻域、容量；且 A 股动量先验偏弱 | **暂不推荐**；先验不占优，除非通过 G2–G8 全套 |
| `pullback` 回踩低吸 | 入场（趋势 + 短期回归） | **UNKNOWN** | 有精确规则；短期反转文献给了一点正先验 | 同上；且本应用是 5–20 日均线回调，不是文献检验的 1–5 日反转，**不能直接引用反转文献背书** | **暂不推荐**；可列「观察名单」研究对象 |
| `hold` 持有待涨 | 退出/持有规则 | **UNKNOWN** | 有移动保护位规则（MA10 / price−1.3ATR） | 不能单独检验；必须与入场策略联合测；需证明「持有到反向信号」优于固定止盈 | **不作为独立策略推荐**；只作为入场策略的附属规则 |
| `reduce` 逢高减仓 | 退出规则 | **UNKNOWN** | 有 RSI≥76 / 乖离 >2.2ATR 规则 | 无 AlertKind（不能自动提醒）、无独立检验；「减多少/何时减」无证据 | **不作为独立策略推荐**；需与 `hold` 一起测 |
| `stop` 优先止损 | 风控规则（非 alpha） | **PASS（仅作风控纪律）** | 止损优先语义明确（`backtest.ts`、`live-signals.ts`）；文献支持止损可降低崩盘风险（Han/Zhou/Zhu 工作论文，**未获取到全文**） | 需在 T+1 下重估（当天不能卖）、止损宽度需 ATR 归一、需报告「止损对收益的拖累」 | **可推荐，但只作为风险控制纪律，不作为收益来源**；必须说明「止损会降低均值收益、换来尾部保护」 |
| `watch` 等待 | 无操作/持币 | **PASS（平凡通过）** | 语义明确（不产生提醒、不建仓） | 机会成本需如实说明；无 alpha 属性 | **可推荐**（这是默认状态）；「不交易」不是失败 |
| 熊市超跌反弹（草案，§8 of strategies.md） | 入场（均值回归） | **UNKNOWN（且当前不可实现）** | 有草案条件（RSI≤25 + 确认 + 紧止损 + 3 日时间止损） | `generateStrategy` 无 reversion action；无确认字段/无 ST 过滤/无 T+1 与跌停卖出建模；无中国样本扣费后检验；A 股短期反转证据虽偏正，但「扣费后可交易性」未验证 | **暂不推荐实现**；先做「事件研究 + 可交易性」再决定 |

**总结**：**0 个作为 alpha 策略 PASS；2 个作为非 alpha 规则 PASS（`stop` 风控、`watch` 不交易）；5 个 UNKNOWN。** 这是符合预期的——应用现在的回测基础设施不足以通过任何 alpha 门槛。

---

## 3. 现有 backtest 能证明什么、不能证明什么

| 能做 | 不能做 |
|---|---|
| 验证规则机制（指标计算、信号顺序、止损/目标优先级） | 验证策略有效性（样本太短、单标的、无全市场） |
| 在给定标的上生成逐笔交易与净值曲线 | 样本外/多重检验/分年分 regime 稳健性 |
| 检查「收盘信号→次日开盘」是否被遵守 | T+1 约束、涨跌停/停牌、印花税、滑点、容量 |
| 作为教学/可视化工具 | 横截面异象（规模/价值/换手/Amihud），因为缺股本与财报 |
| 单标的压力测试（手动改参数） | 组合层风险（相关性、行业集中、现金）|

**推论**：**任何只依赖本应用 `runBacktest` 的结论，都不能单独通过 G2–G9**。可以把 `runBacktest` 当作「信号正确性检查器」，但不能当作「策略验证器」。

---

## 4. 中国 A 股特有的执行与稳健性坑（G6/G7 细节）

1. **T+1**：当天买入当天不能卖 → 回测若允许「entry bar 当天止损」是前视/不可执行；必须禁止 `exitIndex === entryIndex`。
2. **涨跌停**：主板 ±10%、创业板/科创板 ±20%、ST ±5%；一字板无法成交；涨停买入的「信号」在实盘可能根本买不到，回测会高估收益。需要「涨停不买、跌停不卖」过滤，并单独报告「剔除涨跌停不可成交样本后」的结果。
3. **停牌**：长期停牌会让信号/止损失效；`market.ts` 只校验日期递增，bars 可能缺日 → 必须显式处理缺日。
4. **ST/次新/退市整理**：ST 股波动与规则不同（±5%），次新股上市初期无涨跌停或规则不同；不剔除会污染「小盘/反转」结果。
5. **成本与印花税**：印花税历史多次调整（回测需按当年规则）；现行卖出 0.05%；佣金有最低 5 元，小资金实际成本率更高。
6. **流动性与容量**：小盘股/ETF 的 ADV 低；个人资金虽小，但「涨停买不到、跌停卖不掉」比容量更致命。
7. **复权口径**：腾讯日线为前复权（qfq），新浪口径需核实；混用会导致均线/动量失真（`strategy-equations.md` §0.3 已列）。

---

## 5. 为什么多数散户策略过不了（结构性原因）

1. **统计功效不足**：如 §G4，年化 SR=0.5 需要约 15–17 年；20 次试验后约 41 年。绝大多数「3 年回测很好」的策略在统计上无法与 0 区分。
2. **多重检验**：研究员/散户会试很多参数与规则；「最好的那个」几乎必然被高估（选择偏差）。不记录 `k` 就无法校正。
3. **成本吃掉短周期策略**：5 日反转类策略年换手可达 5000%+，A 股成本粗算每年 10%–16%（§4 of equations），文献里的扣费前收益很难留下。
4. **执行摩擦**：T+1 + 涨跌停 + 停牌让「回测成交价」在实盘不可得，尤其是突破/反转这类需要精确入场价的策略。
5. **regime 不稳定**：同一规则在牛/熊/震荡的期望不同；不分 regime 的「总平均」会掩盖最差单元（本应用演示里 Bear×breakout 只有 n=5，任何分组统计量都没有意义）。
6. **过拟合的隐蔽性**：参数越多、规则越复杂，越容易在样本内完美、样本外崩溃；「回踩 MA5 附近 + 量比 + 涨幅」这种多条件规则尤其需要参数邻域检验。

**结论**：不是「这些策略一定不赚钱」，而是「**在当前证据下无法证明它们赚钱，因此不满足推荐标准**」。这是证据标准问题，不是市场判断。

---

## 6. 从 UNKNOWN 到 PASS 所需的最小验证计划（成本估计）

| 步骤 | 需要什么 | 大致工作量 |
|---|---|---|
| 1. 数据 | 全 A 股 ≥5 年日线（含股本、ST/上市日期、行业），point-in-time 指数成分 | 外部数据源；1–2 天接入 |
| 2. 规则冻结 | 公式 + 参数 + 成本模型 + 成交规则写死并打时间戳 | 0.5 天 |
| 3. 事件研究 | 按 signal 日分组统计未来 1/5/10/20 日收益（扣费、剔除不可成交） | 2–3 天脚本 |
| 4. 组合回测 | 组合层（资金、持仓数、相关性）+ 交易日志 | 3–5 天 |
| 5. 稳健性 | 分年/分 regime/分层/参数邻域/成本敏感性/多重检验 | 3–5 天 |
| 6. 样本外 | 留出最近 ≥2 年，参数冻结后只跑一次 | 0.5 天 |
| 7. 报告 | 效应量 + 95% CI + 失败案例 + 交易日志 | 1 天 |

**在完成 1–7 之前，任何「推荐」都只能是「研究假设」，不是「策略建议」。**

---

## 7. Gate 打分卡（可直接复制使用）

```
策略名称：
公式/参数版本（git commit / 时间戳）：
数据：起止 ______  股票池 ______  point-in-time？是/否
样本量：总交易 ______  每年 ______  每 regime：Bull __ Range __ Bear __
样本外：起止 ______  样本内收益 ______  样本外收益 ______  同号？是/否
多重检验：试验数 k=____  校正方法 ____  校正后 p=____  Deflated SR=____
分年：≥60% 年份同号？是/否   单年最大贡献 ____%
regime：Bull/Regime/Bear 方向一致？是/否   最差 regime ______
标的稳健：大盘____ 小盘____ 行业≥2____ 流动性三层____ 剔除ST/次新/停牌/涨跌停后____
执行：T+1 是/否  次日开盘 是/否  涨停不可买过滤 是/否  跌停不可卖过滤 是/否
成本：单边 ____%（含印花税/滑点）  成本 0.1/0.2/0.3% 敏感性 ____
参数邻域：±20% 符号不变？是/否  效应保留 ____%
容量：单笔/ADV=____%  资金上限 ______
报告：95% CI ____  最大回撤 ____  最差年份 ____  失败案例 ____
结论：PASS / FAIL / UNKNOWN
```

---

## 8. 推荐给她之前的 10 条检查清单

1. **公式写死**：策略的每一行都能落到公式/伪代码（见 `strategy-equations.md`），没有「感觉」「盘感」这类不可复现项。
2. **数据字段核过**：确认所需字段本应用真的有（股本/财报/行业/ST/上市日期缺一不可的时候就别推）。
3. **≥5 年 + 2 个牛熊周期**：样本不够长就不看结论；每单元 n<30 的格子直接标「样本不足」。
4. **样本外先冻结**：最近 ≥2 年不参与设计，只用来「考」一次；样本外崩了就不推。
5. **记录试错次数**：把试过的参数/规则全登记，做 Bonferroni/BH/Reality Check；只报最好一个 = 自欺。
6. **成本和摩擦算足**：T+1、涨跌停、停牌、双边 ≥0.2%（0.3% 压力测试）、印花税；不做「理想成交」假设。
7. **剔除脏样本**：ST、次新、停牌、涨跌停不可成交；剔除后结论翻转 = 不推。
8. **分层检验**：大盘/小盘、行业、流动性至少各两层；符号翻转就不推。
9. **参数邻域不崩**：±20% 参数效应保留 ≥50%；只有单点最优 = 过拟合。
10. **写清失效条件**：一句话说明「什么情况下这个策略会失效」（如「震荡市/高波动/流动性枯竭」），以及监控指标；没有失效条件的策略不可信。

---

## 9. 结论与免责声明

**结论**：
- 本应用的 `breakout`、`pullback`、`hold`、`reduce`、熊市超跌反弹：**UNKNOWN，暂不推荐作为策略**；`stop`（风控纪律）与 `watch`（不交易）可以推荐，但必须说明它们不是收益来源。
- 中国 A 股证据方向上是「短期反转相对强、中期动量相对弱」，但**扣费后可交易性、样本外稳定性、多重检验**都还没有在本应用的数据上被验证；证据不足时，正确做法是**不推荐**，而不是「先做做看」。
- 若要把某个策略从 UNKNOWN 推到 PASS，按 §6 的最小验证计划执行；在此之前，只把它当「研究假设」，不当作「策略建议」。

**免责声明**：本文是研究方法与工程门槛说明，**不构成投资建议**，不承诺任何收益。所有文献仅确认「题目/作者/年份/期刊」层面，全文与具体数字多处「未获取到全文/待核实」；本文不引用无法核实的数字。历史与样本内表现不代表未来；据此操作的任何损失由操作者自行承担。

---

## 附录：门槛相关方法来源

- White, H. (2000). *A Reality Check for Data Snooping*. Econometrica 68(5):1097–1126.
- Hansen, P. R. (2005). *A Test for Superior Predictive Ability*. Journal of Business & Economic Statistics 23(4):365–380.
- Benjamini, Y., & Hochberg, Y. (1995). *Controlling the False Discovery Rate*. JRSS-B 57(1):289–300.
- Bailey, D. H., & López de Prado, M. (2014). *The Deflated Sharpe Ratio*. Journal of Portfolio Management 40(5):94–107.
- Lo, A. W. (2002). *The Statistics of Sharpe Ratios*. Financial Analysts Journal 58(4):36–52.（Sharpe 标准误近似，用于 §G4 的功效估算）
- Han, Y., Zhou, G., & Zhu, Y. *Taming Momentum Crashes: A Simple Stop-Loss Strategy*（工作论文，约 2016；未获取到正式发表信息）
- 中国执行规则（T+1、涨跌停、印花税）为现行制度事实；费率与规则会变，回测需按当年规则。
