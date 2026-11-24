# 不同市场状态（Bull / Range / Bear）下的短线策略适配 playbook

> 版本：v1.0 · 2026-11-24 · 作者：strategy-research（研究稿）
> 性质：研究 + 可执行 playbook 草案。**不构成投资建议**；不接券商、不自动下单。
> 配套文档/代码：`docs/research/regime.md`（市场状态判定，task-18）、`src/lib/regime.ts` + `src/hooks/useRegime.ts`（状态计算，task-20）、`src/lib/strategy.ts`、`src/lib/backtest.ts`、`src/lib/live-signals.ts`。
> 写作用域：本文件是本次任务唯一新增文件；**未修改 `src/` 下任何代码**。文中所有「配置草案」都是文字建议，不代表已实现。
> 数据时点：`public/data/latest.json`（2026-11-24 收盘，29 只标的）+ 沪深300 日线（2026-11-24 收盘，320 根）。所有真实数据都注明了来源与时点；未跑过的验证一律写「未验证」。

## Executive summary

1. **Regime gates the toolkit, not the reverse:** trend-following/breakout is a bull-market tool. After DOWN market states momentum profits reverse (Cooper, Gutierrez & Hameed 2004) and momentum crashes cluster in high-volatility panic states (Daniel & Moskowitz 2016), so `breakout` must be disabled in Bear and downgraded in Range.
2. **Pullback buying is structurally wrong in a Bear:** the app's `pullback` needs `MA5 > MA10 > MA20`, which is a lagging condition that often still holds during the first leg of a decline; buying a dip in a confirmed downtrend is buying a falling knife, so `pullback` is disabled in Bear rather than "made tighter".
3. **Control Bear risk with size and cash, not with tighter ATR multipliers:** stop distance should scale with ATR (Turtle 2N; Chandelier 3×ATR), so when ATR rises the right response is fewer shares and more cash (riskPct 1.0%→0.5%, maxPositionPct 10%→6%, cash floor ≥70%), not compressing the stop into the noise.
4. **Use an EOD-only regime filter computed from data through the signal-day close:** HS300 MA20/MA60/MA120 + 250-day drawdown + breadth, exactly as provisionally implemented in `src/lib/regime.ts`; label backtest trades by **signal date** (not entry date) to avoid lookahead.
5. **No performance claim is made here:** the current snapshot computes Bear with 95.7 confidence and the app still emits 2 `pullback` cards — this playbook suppresses both; a small grouped backtest demo (29 stocks × 160 days) is included only to show the validation pipeline and is explicitly **未验证**, not evidence of returns.

## 0. 结论速查（TL;DR）

- **今天（2026-11-24 收盘，按本应用 provisional 规则）：Bear，confidence 95.7，source=index。** 详见 §4.3、§6.4。
- **熊市禁什么**：禁 `breakout`、禁 `pullback`；非持仓一律 `watch`（现金也是仓位）。
- **熊市留什么**：`stop`（最高优先级）、`reduce`（提前、分批）、`hold`（只限已有持仓且结构未破）；若要参与反弹，只允许「超跌反弹 + 三重确认」的人工小仓（§8），现有代码没有对应 action，**需新增**。
- **熊市资金**：现金 ≥ 70%，单票 ≤ 6%，组合总风险 ≤ 1%，同时持仓 ≤ 2 只。
- **震荡市**：只做「半仓 + 确认」的 `pullback`，突破降级；现金 30–50%。
- **牛市**：`breakout` / `pullback` 正常，现金 ≥ 10–20%（保留机动）。
- **必须知道**：本文的分组回测只是**样本内演示**（29 只 × 每只 160 根日线），没有经过稳健性检验，**不能**用来证明任何规则赚钱；未验证项在 §9 列明。

---

## 1. 代码语义基线（准确理解要建议的对象）

### 1.1 `src/lib/strategy.ts`——EOD 策略生成

决策是**优先级 if/else 链**（`strategy.ts:67-117`），先命中先返回：

| 优先级 | action | 触发条件（代码原文语义） | 关键价位/字段 | 是否要求持仓 |
|---|---|---|---|---|
| 1 | `stop` | `price <= cost*0.93`（成本 −7%）或 `price < MA20 − 0.5×ATR14` | `stop`、`reasons`、`score=94` | **是**（`isHolding`，`strategy.ts:51-53`） |
| 2 | `reduce` | 持仓且 `RSI14 ≥ 76` 或 `price > MA5 + 2.2×ATR14` | `trigger = price + 0.35×ATR`、`stop = max(MA5, price−ATR)`、`score=82` | **是**（`strategy.ts:74-81`） |
| 3 | `breakout` | `price ≥ high20×0.998` 且 `changePct ≥ 1` 且 `volumeRatio ≥ 1.15` | `trigger=max(price, high20×1.001)`、`stop=min(MA10, trigger−1.4×ATR)`、`target=trigger+max(2.2ATR, 1.8×风险)` | 否（持仓股也可能命中） |
| 4 | `pullback` | `MA5>MA10>MA20` 且 `price ≤ MA5+0.25×ATR` 且 `price ≥ MA10−0.4×ATR` 且 `changePct < 1.5` | `trigger=max(price, MA5)`、`stop=min(MA10−0.6ATR, MA20−0.2ATR)`、`target=max(high20, trigger+1.8ATR)` | 否 |
| 5 | `hold` | 持仓且 `MA5>MA10>MA20` 且 `price ≥ MA5` | `stop=max(MA10, price−1.3ATR)`、`target=max(high20, price+1.5ATR)` | **是** |
| 6 | `watch`（兜底） | 其余情况；若 `MA5<MA10<MA20` 则文案为「均线空头排列，不逆势抄底」，若 RSI 过热则「不追高」 | 无入场价位 | 否 |

指标口径：`MA5/10/20` 为最近 5/10/20 根收盘均值；`high20` 为**前** 20 根日线最高价（不含当日，`strategy.ts:38-42`）；`ATR14` 为最近 14 根 TR 均值（`strategy.ts:21-29`）；`RSI14` 为简单平均涨跌幅（`strategy.ts:7-19`）；`volumeRatio` 为当日量 / 前 5 日均量（`strategy.ts:45-46`）。

仓位建议（`strategy.ts:119-127`）：
- `riskShares = floor( capital×riskPct/100 ÷ (trigger−stop) ÷ 100 ) × 100`
- `capShares = floor( capital×maxPositionPct/100 ÷ trigger ÷ 100 ) × 100`
- `suggestedShares = min(riskShares, capShares)`，`suggestedPositionPct = shares×trigger/capital×100`

界面可配参数只有 3 个：`capital`（账户参考本金）、`riskPct`（单笔风险 %，0.2–2）、`maxPositionPct`（单票仓位上限 %，1–50），见 `src/App.tsx:416-418, 514-516`。

### 1.2 `src/lib/backtest.ts`——验证语义

- **收盘出信号、次日开盘执行**：`hasSignal` 在 `index` 收盘判定；`pending` 在下一根 `bar.open` 成交（`backtest.ts:177-192, 229-231`）。回测注释明确「不在当天收盘前偷用数据」。
- **成本**：`COST = 0.001`，买入与卖出各扣一次（`backtest.ts:74, 182, 198, 204-207`）。
- **止损优先**：同一根 bar 内先判 `bar.low <= stop`，再判 `bar.high >= target`（`backtest.ts:194-203`）。止损/目标按触发价成交（`stop×(1−cost)` / `target×(1−cost)`），没有额外滑点模型。
- **4 套策略**：`breakout`、`pullback`、`trend`、`reversion`（`backtest.ts:79-84`），入场/出场规则见 `backtest.ts:115-139`：
  - `breakout`：止损 `min(MA10, 入场−1.4ATR)`，目标 `入场+max(2.2ATR,1.8×风险)`，收盘跌破 MA10 或持有 ≥12 日出。
  - `pullback`：止损 `min(MA10−0.6ATR, MA20−0.2ATR)`，目标 `max(high20, 入场+1.8ATR)`，收盘跌破 MA20 或 ≥12 日出。
  - `trend`：止损 `入场−2ATR`，目标无穷；`MA5<MA10` 或 `close<MA20−0.5ATR` 出。
  - `reversion`（**仅回测有，`generateStrategy` 没有这个 action**）：`RSI14≤32 且 close<MA20 且当日跌`，止损 `入场−1.5ATR`，目标 `入场+1.8ATR`，`RSI14≥55` 或 ≥8 日出。
- **结构限制（很重要）**：单标的、单笔、满仓（`units = cash/entryPrice`），无组合层资金管理、无相关性/行业约束、无 regime 过滤。**因此不能直接回答「熊市该不该做」**，只能做逐笔交易的 regime 归因（§6.4）。

### 1.3 `src/lib/live-signals.ts`——盘中提醒语义

- 命中顺序固定 `stop > target > trigger`（`live-signals.ts:76-81`）。
- **持仓**（`strategy.isHolding === true`，缺字段时按 action 回退）：只提醒 `stop` 与 `target`；`trigger` 对持仓没有「买入」含义。
- **非持仓**：只提醒 `trigger`，且仅当 action ∈ {`breakout`, `pullback`}（`live-signals.ts:27-31, 53-57`）。
- `watch` 不产生任何提醒（`live-signals.ts:54`）。
- `AlertKind` 只有 `trigger | stop | target`（`src/types/index.ts`）——**没有 `reduce` 提醒类型**；「逢高减仓」目前不会单独提醒，这是后文「需新增」项之一。

### 1.4 `src/lib/regime.ts`——已实现的 provisional regime 判定

（task-20 实现，阈值集中在 `regime.ts:68-84`；`docs/research/regime.md` 的最终结论出来后可校准，但本文按当前实现写。）

- 数据：沪深300 日线（腾讯 fqkline → 新浪，`fetchIndexBars`，`regime.ts:419`），≥120 根才用指数判定，否则退回「宽度」。
- 7 个条件各 +1：`close>MA20`、`close>MA60`、`close>MA120`、`MA20>MA60`、MA60 近 20 日斜率>0、距 250 日高点回撤<15%、宽度（收盘>MA20 占比）≥60%。
- 判定：`bull = score≥5 且 close>MA60`；`bear = score≤2 或 (close<MA60 且回撤≥20%)`；其余 `range`。
- 输出 `RegimeInfo { regime, confidence, asOf, source, evidence[], breadthPct? }`；`useRegime()` 返回 `{ regime: RegimeInfo|null, loading, error, refresh }`，当天缓存、失败退回宽度。
- **缺口**：只有 EOD 单点快照，没有「连续确认/最短持续」机制 → 均线附近会抖动（§6.4 演示样本 160 天出现 14 段 regime）；宽度只覆盖公开清单 29 只；`source='breadth'` 时置信度语义与指数模式不可比。

---

## 2. 研究证据（每条给来源与年份；查不到的写「未获取到」）

> 检索说明：本次环境 `web_search` 可用，但 `web_fetch` 对多数域名返回「非公网地址」，因此部分论文只能确认「存在与作者/标题/年份」，**未获取到全文页码**。凡未核对原文的数字类细节，本文不引用；只引用方向性结论。A 股直接证据明显少于美股/期货，这一点在每节末尾标注。

### 2.1 趋势跟随在牛市 vs 熊市的差异

| 结论 | 来源 | 日期 | 与本应用的关系 | 证据强度 |
|---|---|---|---|---|
| 时序动量（过去 12 个月收益的符号）在 1965–2009 的 58 个期货/远期品种上可预测未来 1–12 个月收益，且在极端行情中表现更好 | Moskowitz, Ooi & Pedersen, *Time Series Momentum*, JFE | 2012 | `breakout`/`trend` 属同一族（价格动量）；说明「顺大势」在趋势市有效 | 强（期货，非 A 股） |
| 趋势跟随 1880–2016 的百年证据：长期正收益、与股债低相关，在极端市场提供「危机 alpha」 | Hurst, Ooi & Pedersen, *A Century of Evidence on Trend-Following Investing*, JPM | 2017 | 熊市里趋势策略的价值来自「能做空/能空仓」，本应用只做多 → 对应动作是**退出/持币** | 强（美股/多资产） |
| 横截面动量只在「市场状态为 UP」之后显著；在 DOWN 状态之后动量收益转负（反转） | Cooper, Gutierrez & Hameed, *Market States and Momentum*, JF | 2004 | **最直接依据**：熊市里追突破/追强势股，期望收益为负 | 强（美股） |
| 动量在市场大跌后 + 高波动的「恐慌态」出现剧烈回撤（momentum crash），随后输家反弹 | Daniel & Moskowitz, *Momentum Crashes*, JFE / NBER w20439 | 2016 | 熊市末段的暴力反弹会让「追突破」两头挨打；也解释为何熊市反弹不可持续追高 | 强（美股） |
| 动量按自身波动率缩放可显著降低崩盘风险、提高夏普 | Barroso & Santa-Clara, *Momentum has its moments*, JFE | 2015 | 熊市应降低动量类策略的仓位，而不是原样执行 | 强（美股） |

**A 股直接证据**：未获取到「A 股突破策略在熊市失效」的可引用实证全文。作为旁证，检索到中文实证《我国沪深300动量效应和反转效应角度的实证研究》（CNKI，2016），但**未获取到全文与结论**，不据此下判断。

**应用含义**：`breakout` 不是「任何时候都能用」的规则，它是**牛市/上行状态的工具**；熊市里它的正确形态是「不做」。

### 2.2 熊市里「回踩低吸」为什么容易变成接飞刀（下跌中继）

| 结论 | 来源 | 日期 | 与本应用的关系 | 证据强度 |
|---|---|---|---|---|
| 中期（3–12 个月）动量与短期（1 周–1 月）反转并存；更长尺度（3–5 年）存在过度反应后的反转 | Jegadeesh & Titman, *Returns to Buying Winners and Selling Losers*, JF；De Bondt & Thaler, *Does the Stock Market Overreact?*, JF；Jegadeesh, *Evidence of Predictable Behavior of Security Returns*, JF | 1993 / 1985 / 1990 | 「回踩买」赚的是短周期均值回归，但它的前提是**趋势仍在**；趋势坏了，均值回归会变成趋势延续 | 强（美股） |
| A 股横截面：短期反转与规模效应较明显，动量相对弱 | Cakici, Chan & Topyan, *Cross-sectional stock return predictability in China*, European Journal of Finance（DOI 10.1080/1351847X.2014.997369） | 2014 在线 / 2017 卷期 | 支持 A 股「追涨不如低吸」的直觉，但**不**支持「熊市低吸」——低吸也要有趋势前提 | 中（A 股；未获取到全文细节） |
| 市场 DOWN 状态之后，前一期输家组合继续跑输/动量反转 | Cooper, Gutierrez & Hameed | 2004 | 下跌中继的学术侧写：熊市初期「便宜」会变得更便宜 | 强（美股） |

**机制解释（本应用的代码层面，比文献更直接）**：`pullback` 的条件是 `MA5 > MA10 > MA20`（`strategy.ts:56`）。均线是滞后量：一轮下跌刚启动时，MA5 仍可能高于 MA10、MA10 仍高于 MA20，此时价格回踩 MA5 反而正好是**下跌的第一波**。也就是说，`pullback` 的「趋势向上」判定在拐点处会系统性偏晚，这正是「接飞刀」的代码级原因。**熊市确认后该条件会自然失效，但在「熊市初期」它仍会发出信号**——所以不能只靠个股条件，必须叠加 regime 过滤器。

**直接检验「熊市买跌」的论文**：未获取到可引用全文。检索到 IESE 的 Estrada（2026）工作论文 *Buy the Dip? Not So Fast*，但本环境无法获取全文，**不作为论据**。

### 2.3 波动率与止损宽度

| 结论 | 来源 | 日期 | 与本应用的关系 | 证据强度 |
|---|---|---|---|---|
| 海龟法则：`N = ATR(20)`，止损 `2N`，每个 Unit 使账户风险约 1% | Curtis Faith, *Way of the Turtle* | 2007 | 本应用 `ATR14×1.4` 的突破止损同属「ATR 归一化」；止损宽度应与波动同比例 | 强（交易者经典，非学术） |
| Chandelier Exit：`最高价(22) − 3×ATR(22)` 作为移动止损 | Chuck LeBeau（交易者文献） | **未获取到原始发表年份** | `hold` 的移动止损可用同思路（本应用当前用 `MA10`/`MA20−0.5ATR`） | 中（行业惯例） |
| 给动量策略加简单止损（个股从买入价回撤约 10% 离场）可显著降低崩盘风险、提高风险调整收益；止损过紧会伤害策略 | Han, Zhou & Zhu, *Taming Momentum Crashes: A Simple Stop-Loss Strategy*（工作论文） | 约 2016；**未获取到正式发表信息** | 支持「熊市保留硬止损」；同时警告「别把止损压进噪声」 | 中（工作论文） |
| 波动率目标化（按已实现波动倒数缩放暴露）对风险资产可降低回撤、改善风险调整收益，但在低波动牛市中会牺牲部分收益 | Harvey, Hoyle, Korgaonkar, Rattray, Sargaison & van Hemert, *The Impact of Volatility Targeting*, JPM；Moreira & Muir, *Volatility-Managed Portfolios*, JF | 2018 / 2017 | 熊市 ATR 抬升时应**减仓**（目标波动不变），而不是压缩 ATR 倍数 | 强（美股/多资产） |

**风险预算公式（本应用已经在用）**：`股数 × (入场价 − 止损价) ≤ 本金 × riskPct%`。

**应用含义（回答任务里的「止损从 1.4 缩到多少」）**：不建议在熊市把突破止损从 `1.4×ATR` 机械压缩到 1.0；熊市 ATR 本身变大，压缩倍数会同时放大「被噪声打掉」的概率。正确做法是：**熊市根本不做突破**；若做超跌反弹，用 **1.0–1.2×ATR 的紧止损 + 1/3 仓位 + 2–3 日时间止损**（因为反弹逻辑本来就是短周期的，见 §8）。既有持仓的保护位则从 `MA20−0.5ATR` 收紧到 `MA10−0.5ATR`（换参照均线，而不是改 ATR 系数）。

### 2.4 现金 / 仓位管理

| 结论 | 来源 | 日期 | 与本应用的关系 | 证据强度 |
|---|---|---|---|---|
| 10 个月（≈200 日）SMA 择时：长期收益与买入持有接近，最大回撤显著下降 | Faber, *A Quantitative Approach to Tactical Asset Allocation*, Journal of Wealth Management | 2007 | 熊市「持币/降仓」有实证支持，不是胆小 | 强（美股，单市场） |
| 波动率管理组合：按逆方差缩放市场暴露，可提高夏普与 alpha | Moreira & Muir, JF | 2017 | 熊市总仓位系数直接下调 | 强（美股） |
| regime 切换下最优资产配置显著变化，但状态参数估计不稳定 | Ang & Bekaert, *International Asset Allocation With Regime Shifts*, RFS | 2002 | 别把 regime 当成精确预测，只当「风险开关」 | 强（理论/实证） |
| 「熊市应持有 X% 现金」的普适最优值 | — | — | **未获取到**；本文用风险预算 + 单票上限推导，不给「最优现金比例」的伪精确数字 | 无 |

**应用含义**：现金比例不是拍脑袋，而是由「单笔风险预算 × 可同时承受的持仓数」倒推：`总风险 ≤ 3%（牛）/ 2%（震荡）/ 1%（熊）`，`现金 ≥ 1 − 总仓位`。本应用目前**没有现金字段**（`AppData` 只有 `goldValueCny`、`stocks`、`quotes`、`settings`），所以「留多少现金」只能由 `settings.capital − Σ(持仓市值)` 估算，口径不严谨（§4.2 标为「需新增」）。

### 2.5 动量 vs 均值回归在不同 regime 的效果

| 结论 | 来源 | 日期 | 与本应用的关系 |
|---|---|---|---|
| 中期动量（3–12 个月）在美股显著（Jegadeesh & Titman）；在 UP 状态后更强、DOWN 状态后反转（Cooper et al.）；恐慌态崩盘（Daniel & Moskowitz） | 同上 | 1993 / 2004 / 2016 | `breakout`、`trend` = 动量族 → **Bull 主用** |
| 短期反转（1 周–1 月）与长期反转（3–5 年）都存在，但方向相反、驱动不同 | Jegadeesh 1990；De Bondt & Thaler 1985 | 1990 / 1985 | `pullback` 混合了「趋势 + 短期回归」→ **Bull/Range 可用**；`reversion` 纯均值回归 → **只适合熊市小仓短线** |
| A 股反转强于动量 | Cakici et al. | 2014/2017 | 熊市里「超跌反弹」比「追突破」更符合 A 股特性，但必须加确认与时间止损 |

**regime 映射小结**：Bull → 动量（breakout/trend）为主、回调为辅；Range → 回调（pullback）为主、突破降级；Bear → 只保留退出（stop/reduce）与「超跌反弹 + 确认」的小仓试验，不做趋势跟随。

---

## 3. regime × 动作决策表

图例：**✅ 允许**（按正常规则执行）/ **⚠️ 降级**（允许但缩小仓位或提高确认门槛）/ **⛔ 禁止**（不生成买入计划，非持仓转 `watch`）/ **🛡️ 保护**（只对已有持仓，优先级最高）。

| 动作 | Bull | Range | Bear | 理由（对应文献/代码） |
|---|---|---|---|---|
| `breakout` 突破跟随 | ✅ 正常 | ⚠️ 降级：需指数 `close > MA60` 或宽度 ≥50%，量比门槛 1.15→1.3，仓位减半 | ⛔ 禁止 | 动量在 DOWN 状态后反转（Cooper 2004）；熊市反弹是 crash 的一部分（Daniel & Moskowitz 2016）；A 股熊市假突破多 |
| `pullback` 回踩低吸 | ✅ 正常 | ✅ 允许但 **半仓**；优先「回踩 MA10/MA20 且缩量」而不是「追 MA5」 | ⛔ 禁止（转 `watch`） | `MA5>MA10>MA20` 在下跌初期仍可能成立（代码级滞后）；下跌中继/接飞刀（§2.2） |
| `hold` 持有待涨 | ✅ 正常（移动止损跟 MA10） | ⚠️ 收紧：止损跟 `MA10−0.5ATR`；不加仓 | 🛡️ 仅限「已有持仓且未破 MA20」；反弹到 `MA10/MA20` 附近优先减 | 熊市趋势向下，hold 只能靠保护位被动退出；Ang & Bekaert 2002：状态切换要降暴露 |
| `reduce` 逢高减仓 | ✅ 正常（RSI≥76 或 乖离 >2.2ATR） | ⚠️ 提前：RSI≥70 或 乖离 ≥1.8ATR | 🛡️ **提高优先级**：RSI≥65 / 乖离 ≥1.5ATR / 反弹到 MA20 附近即减；分批 | 熊市反弹窗口短且快；`reduce` 目前在提醒层没有独立 AlertKind（§4.2） |
| `stop` 优先止损 | 🛡️ 最高 | 🛡️ 最高 | 🛡️ 最高；趋势保护位从 `MA20−0.5ATR` 收紧为 `MA10−0.5ATR`，保留成本 −7% 硬止损 | 止损优先是代码既有语义（`backtest.ts:194-203`、`live-signals.ts:76-81`）；熊市波动大，先退出再讨论 |
| `watch` 等待 | ⚠️ 可接受（等更好信号） | ✅ 默认 | ✅ **唯一允许的非持仓动作**：现金也是仓位 | `watch` 不产生提醒（`live-signals.ts:54`）；熊市「安静」是特性也是风险（§9） |

补充规则：
1. **Bear 下非持仓不再产生 `breakout`/`pullback`**，因此盘中提醒层自动只剩「持仓的 stop/target」——这与 `live-signals.ts` 的语义天然一致，**不需要改提醒代码**，只需要 regime 过滤器决定「要不要把 EOD 建议降级为 watch」。
2. **`stop` 永不降级**：任何 regime 下「先止损、再讨论」都是硬约束（代码已经是 stop 优先）。
3. **Bear 的 `hold` 不能作为「不止损」的借口**：`hold` 只表示「结构未破、继续用移动保护位」，一旦 `price < MA20−0.5ATR` 或成本 −7%，必须转 `stop`。
4. **Range 的「降级」不是禁止**：只是仓位减半（`maxPositionPct` 10%→6%）、确认门槛提高（量比、指数位置），并接受更高假信号率。

---

## 4. 今日行动卡（可执行建议的最小载体）

> 目的：把「策略结论」变成每天可以直接照着做的一张卡。**今天是 Bear（§4.3 用真实数据填充）**；模板本身与 regime 无关。

### 4.1 行动卡模板

| 区块 | 字段 | 填写规则 |
|---|---|---|
| A. 市场状态 | `regime` / `confidence` / `asOf` / `source` / 一句理由 | 取 `RegimeInfo`；`confidence<60` 或 `source='breadth'` 时标注「低置信，按 Range 处理」 |
| B. 今日买入候选（0–3 个） | 代码、名称、命中规则（`action`）、触发价 `trigger`、保护位 `stop`、目标位 `target`、参考股数 `suggestedShares`、参考仓位 `suggestedPositionPct`、评分 `score`、理由 `reasons` | 只列 `action ∈ {breakout, pullback}` 且 `isHolding=false`；再按 regime 决策表过滤；按 `score` 降序最多 3 个 |
| C. 减仓/退出 | 代码、触发条件（`stop`/`reduce` 价位或 RSI/乖离阈值）、优先级、分批比例 | 只列持仓；顺序固定 **stop 优先于 reduce**；无持仓则写「无持仓，本区块空」 |
| D. 现金与「今天不做什么」 | 目标现金比例、今日禁止清单 | 由 regime 参数（§5）给出；熊市必须写「不追突破、不接下跌中的回踩、不补仓摊薄」 |
| E. 钱挪到哪里 | 现金去向、是否再平衡 | 熊市：不新增股票买入，现金留在现金等价物（货币基金/国债逆回购等；**本应用不跟踪具体产品**，只记录比例）；如个人配置含黄金（`AppData.goldValueCny`，手动参考值），只按既定权重持有，不追涨 |
| F. 如果只能做一件事 | 一句话 | 熊市默认「检查持仓是否触发 stop；没有持仓就什么都不做」；Bull 默认「只做评分最高的 1 个 breakout，按 suggestedShares 执行」 |

**执行时点**：行动卡基于 T 日收盘生成 → 在 **T+1 开盘**执行（与 `backtest.ts` 的「收盘信号、次日开盘」一致）；盘中价格只用于判断是否已越过触发价/保护位（`live-signals.ts`），**不改变 EOD 计划**。开盘跳空越过触发价超过 +2% 时视为「追高」，放弃当日执行。

### 4.2 字段 → 代码映射（哪些已有、哪些「需新增」）

| 行动卡字段 | 现有来源 | 状态 |
|---|---|---|
| `regime` / `confidence` / `asOf` / `source` / `evidence` | `RegimeInfo`（`src/lib/regime.ts:48-55`，经 `useRegime()`） | ✅ 已有（task-20） |
| 代码 / 名称 | `stock.code` / `stock.name`；公开清单的 `Quote` **没有 name 字段**，只能用 code | ⚠️ 公开清单缺名称，需从 `Stock` 或行情接口补 |
| 命中规则（action） | `strategy.action` / `actionLabel` | ✅ 已有 |
| 触发价 / 保护位 / 目标位 | `strategy.trigger` / `stop` / `target` | ✅ 已有 |
| 参考股数 / 参考仓位 | `strategy.suggestedShares` / `suggestedPositionPct`（公式见 §1.1） | ✅ 已有（但只按单票约束，不含组合现金） |
| 评分 / 理由 | `strategy.score` / `strategy.reasons` | ✅ 已有 |
| 持仓标识 | `strategy.isHolding`（task-8 新增） | ✅ 已有 |
| 指标明细 | `strategy.indicators`（ma5/ma10/ma20/high20/atr14/rsi14/volumeRatio） | ✅ 已有 |
| 目标现金比例 / 今日禁止清单 | 无 | ❌ **需新增**：`portfolio.cashPct`、`regimeProfile`（配置文件或 UI 设定） |
| 组合总风险 / 同时持仓数 | 无（`AppData` 没有现金、也没有持仓数量上限） | ❌ **需新增**：`portfolio.openRiskPct`、`maxConcurrentPositions` |
| 「钱挪到哪里」 | 无（`goldValueCny` 只是手工参考值） | ❌ **需新增**（或保持人工记录） |
| `reduce` 类提醒 | `AlertKind` 只有 `trigger/stop/target`；`reduce` 没有提醒类型 | ❌ **需新增** `AlertKind='reduce'`（或复用 target 并标注） |
| 「超跌反弹」买入候选 | `generateStrategy` 没有 reversion action（只有 `backtest.ts` 里有） | ❌ **需新增** action（否则只能人工/看板外执行，见 §8） |
| 行动卡「一行一个标的」的 UI 区块 | 目前只有策略卡、盘前纪律（静态 3 条）、风险预算面板（`src/App.tsx:407-420`） | ❌ **需新增** UI 区块（不在本任务范围） |

### 4.3 今日示例（真实数据填充，2026-11-24 收盘）

数据口径：`public/data/latest.json`（29 只，全部按 `status='watch'` 计算）+ `strategy.ts` 现规则 + `regime.ts` 现规则；`capital=100,000 / riskPct=1 / maxPositionPct=10`（与 `scripts/generate_signals.mjs` 一致）。

**A. 市场状态（`computeRegime` 输出，source=index，asOf=2026-11-24）**

```
regime = bear, confidence = 95.7
沪深300 收盘 3963.82，MA20 4022.94（-1.47%）
收盘 vs MA60 4273.87（-7.25%）；MA20 vs MA60（-5.87%）
收盘 vs MA120 4516.29（-12.23%）
MA60 近 20 日斜率 -4.55%（下行）
距 250 日高点 5059.66 回撤 -21.66%
宽度 20.69%（6/29 只收盘 > MA20，阈值 ≥60%）
评分 0/7 → 弱势（熊）
```

**B. 今日买入候选：0 个。** 应用当前仍会给出 2 个 `pullback` 卡（这是「没有 regime 过滤」时的输出）；按本文决策表，Bear 下**全部禁止**，降级为 watch：

| 代码 | 应用当前 action | 触发价 | 保护位 | 目标位 | 参考股数 / 仓位 | 评分 | 熊市处理 |
|---|---|---|---|---|---|---|---|
| 159558 | `pullback`（回踩低吸） | 0.82 | 0.78 | 0.91 | 12,100 股 / 9.92% | 74 | ⛔ 禁止入场；列入观察，等指数站回 MA20 且该标的放量重回 MA5 之上再评估 |
| 600206 | `pullback`（回踩低吸） | 39.61 | 36.67 | 44.99 | 200 股 / 7.92% | 74 | ⛔ 同上 |

> 注：这两行的 `trigger/stop/target/suggestedShares` 都是**代码真实输出**，不是人工编的；展示它们是为了说明「熊市里应用会给你看似可执行的计划，这正是需要 regime 过滤器的地方」。

**C. 减仓/退出：今日公共清单无持仓（全部 watch），本区块为空。** 若持有仓位，按以下规则逐行填：
- 优先级 1（`stop`）：`price < MA20 − 0.5×ATR` 或 `price ≤ cost×0.93` → 退出，不补仓。
- 优先级 2（`reduce`）：`RSI14 ≥ 65` 或 `price > MA5 + 1.5×ATR` 或反弹至 MA20 附近 → 分批减（熊市阈值比默认 RSI 76 / 2.2ATR 提前）。
- 优先级 3（`hold`）：仅当未破 MA20 且多头结构未坏，用 `MA10−0.5ATR` 作移动保护。

**D. 现金与今天不做什么**
- 目标现金 ≥ **70%**；单票 ≤ **6%**；组合总风险 ≤ **1%**；同时持仓 ≤ **2 只**。
- **今天不做**：① 不追突破（今日无 breakout，但出现也不做）；② 不接下跌中的回踩（159558、600206 剔除）；③ 不对任何亏损仓位补仓摊薄；④ 不在盘中用实时价「抢反弹」，所有入场都要等 EOD 信号 + T+1 开盘执行。

**E. 钱挪到哪里**：不新增股票买入；现金留在现金等价物（货币基金/国债逆回购等，本应用不跟踪具体产品）。若个人配置里有黄金（`goldValueCny` 手工值），按既定目标权重持有，不因为「股票跌了」临时加仓黄金——那是另一种追涨。

**F. 如果只能做一件事**：**检查是否有持仓触发 `stop`；没有持仓就什么都不做（现金就是仓位）。**

### 4.4 熊市里「超跌反弹」候选的今日核查（草案规则的实测）

按 §8 的草案条件（`RSI14≤25` + 当日阳线 + 长下影 + `volumeRatio≥1.2` + 沪深300 不创新低）在今日 29 只里筛：
- `002827`：RSI 25.1、阳线、长下影、`volumeRatio 1.14`，但当日 **+9.99%（涨停）**——无法按收盘价买入，且不满足量比门槛 → **不合格**。
- `001216`（RSI 25.0，阴线，量比 1.08）、`000960`（RSI 25.6，阴线）、`002407`（RSI 25.8，阴线）→ **均不合格**。
- 沪深300 当日低点 3957.92 > 前一日低点 3901.49（不创新低，满足），但个股确认不足。
- **结论：今日无合格超跌反弹标的 → 维持 0 买入。**（这是草案规则，不是投资建议；且现有代码没有 reversion action。）

---

## 5. 参数草案（配置，不是代码改动）

> 现状：界面只能改 `capital`、`riskPct`（0.2–2）、`maxPositionPct`（1–50）。以下为**建议目标配置**，其中 `regimeProfile`、`stopAtrMult`、`cashFloorPct`、`maxConcurrentPositions` 等字段当前代码不支持，需新增（§4.2）。**所有数值都是 a priori 草案，未经回测验证。**

```yaml
# 配置草案：与现有 RiskSettings 兼容的字段用注释标出；其余为「需新增」
profiles:
  bull:
    regime: { source: index, ma: [20, 60, 120], drawdownSafePct: 15, breadthBullPct: 60, confirmDays: 2 }
    entries:
      breakout: { enabled: true, volumeRatioMin: 1.15, changePctMin: 1.0, stopAtrMult: 1.4, targetRMult: 1.8 }
      pullback: { enabled: true, stopAtrMult: 0.6, requireAboveMa20: false }
      # 超跌反弹：牛市不启用（逆势）；如启用仅限 Range/Bear
      reversion: { enabled: false }
    sizing:
      riskPct: 1.0            # 现有字段（界面可调）
      maxPositionPct: 15      # 现有字段（界面可调；牛市中值）
      maxConcurrentPositions: 5
      openRiskPctMax: 3.0
      cashFloorPct: 10
    exits:
      trendStopAtrMult: 0.5   # MA20 − 0.5×ATR（现有语义）
      costStopPct: 7          # 成本 −7%（现有语义）
      reduceRsi: 76           # 现有语义
      reduceDeviationAtr: 2.2 # 现有语义
    alerts: { priority: [stop, target, trigger] }

  range:
    regime: { confirmDays: 2 }
    entries:
      breakout: { enabled: true, degraded: true, volumeRatioMin: 1.3, requireAboveMa60: true, sizeFactor: 0.5 }
      pullback: { enabled: true, sizeFactor: 0.5, preferMa10OrMa20: true }
      reversion: { enabled: false }   # 演示数据里 reversion 在 range 最差，但样本太小，未验证
    sizing:
      riskPct: 0.7
      maxPositionPct: 10
      maxConcurrentPositions: 4
      openRiskPctMax: 2.0
      cashFloorPct: 30
    exits:
      trendStopAtrMult: 0.5
      costStopPct: 7
      reduceRsi: 70
      reduceDeviationAtr: 1.8
    alerts: { priority: [stop, target, trigger] }

  bear:
    regime: { confirmDays: 2, minDurationDays: 5, lowConfidenceTreatedAs: range }
    entries:
      breakout: { enabled: false }
      pullback: { enabled: false }
      reversion:                # 唯一允许的熊市入场，且必须「确认」后人工执行
        enabled: true
        requireConfirmations: 3  # 见 §8
        rsiMax: 25
        volumeRatioMin: 1.2
        stopAtrMult: 1.0        # 紧止损；不是把趋势止损压到 1.0
        timeStopDays: 3
        targetAtrMult: 1.5
        sizeFactor: 0.33        # ≈ 正常仓位的 1/3
        maxConcurrentPositions: 2
        maxLossesInARow: 2      # 连续 2 次止损后当周停止
    sizing:
      riskPct: 0.5
      maxPositionPct: 6
      maxConcurrentPositions: 2
      openRiskPctMax: 1.0
      cashFloorPct: 70
    exits:
      trendStopAtrMult: 0.5     # 参照均线从 MA20 换成 MA10（见 §2.3）
      trendStopMa: 10
      costStopPct: 7            # 保留硬止损，不因「长期看好」取消
      reduceRsi: 65
      reduceDeviationAtr: 1.5
    alerts: { priority: [stop, target] }  # 非持仓无 trigger（watch 不提醒），持仓只有 stop/target
```

**参数说明（为什么是这些数）**：
- `riskPct 1.0→0.5`、`maxPositionPct 10→6`、`cashFloor 70%`：熊市波动更大 + 假信号更多，用**仓位**而不是更紧的止损吸收不确定性（§2.3）。
- `stopAtrMult` 保持 1.4 用于突破（只是熊市禁用突破）；熊市唯一入场的 reversion 用 **1.0×ATR**，因为反弹逻辑 2–3 天不成立就该走，不需要宽止损。
- `reduceRsi 76→65`、`reduceDeviationAtr 2.2→1.5`：熊市反弹短促，减仓要提前。
- `confirmDays 2` + `minDurationDays 5`：抑制 regime 抖动（§6.4 的演示样本 160 天出现 14 段切换，就是这个问题的证据）。
- `alerts` 在 Bear 只保留 `stop/target`：与 `live-signals.ts` 的现有语义一致，无需改提醒层；若希望「减仓也提醒」，需新增 `AlertKind='reduce'`。

---

## 6. regime 过滤器设计

### 6.1 数据来源与更新频率

| 项 | 方案 | 现状 |
|---|---|---|
| 主数据 | 沪深300（sh000300）日线，≥120 根；腾讯 fqkline → 新浪 JSON | ✅ 已在 `regime.ts:fetchIndexBars` 实现 |
| 辅助数据 | 宽度：自选/公开清单中「收盘 > MA20」占比（≥20 根日线才算分母） | ✅ 已实现（29 只样本） |
| 风格确认（建议） | 中证1000 / 创业板指日线，判断「小盘 vs 大盘」；本应用暂未实现 | ❌ 需新增 |
| 更新频率 | **EOD 一次**：T 日收盘后计算，T+1 开盘前生效；盘中不随实时价翻转 | ✅ 当前 `useRegime` 按天缓存 |
| 失效降级 | 指数两条源都失败 → `source='breadth'`，confidence 降级并在 UI 标注「样本：公开清单 29 只」 | ✅ 已实现 |

**结论**：现有 `src/lib/regime.ts` 已经足够支撑本 playbook 的 Bull/Range/Bear 三态；缺的是「确认/滞后」与「组合层参数」，不是数据源。

### 6.2 如何避免未来函数（7 条硬规则）

1. **只用 T 日收盘及之前的数据**判定 regime；T 日收盘后生成行动卡，T+1 开盘执行——与 `backtest.ts` 的「收盘信号、次日开盘」一致。
2. **回测里按 `signalIndex` 的日期给交易打 regime 标签，不能按 `entryIndex`/`entryDate`**：入场发生在 T+1 开盘，而 T+1 收盘的 regime 在开盘时不可知。（本人在做演示时第一版按 entryDate 打标签，属于轻微前视，已改为 signalDate；这类错误在小样本里会让结论好看/难看 1–2 个百分点。）
3. **不用全样本极值/分位数**（例如「事后认定 2022 年是熊市」）；回撤、均线、斜率全部滚动窗口。
4. **参数先固定、后看结果**（pre-registration）：regime 阈值与 playbook 规则在看回测结果前写死；不因为某段亏钱就调阈值。
5. **历史 regime 序列不因新数据回改**：live 只缓存 `asOf` 当天结果；回测按当时可得数据逐日计算。
6. **标的池固定或 point-in-time**：本仓库 29 只快照不是 point-in-time（存在选择/幸存者偏差），只能做流程演示，不能做业绩结论。
7. **数据质量**：复权口径（腾讯 qfq / 新浪是否前复权）会影响均线与 ATR；跨源混用时要标注，回测同一标的不混源。

### 6.3 用现有 backtest 做「熊市区间 vs 牛市区间」分组验证

现有 `runBacktest` 是单标的、满仓、无 regime 参数；**不修改代码**也能做归因验证：

**方案 A（推荐先做）：逐笔交易归因。**
1. 外部脚本 import `runAllBacktests`（Node 26 可直接跑 TS），对每只标的跑 4 套策略；
2. 用 `regime.ts` 的 `computeRegime` 逐日计算历史 regime（注意：回测脚本要按日截断 `asOf` 来复现「当时可知」的状态，不能一次性用最新结果回填）；
3. 每笔交易用 `trade.signalIndex` 对应的日期取 regime，按 `strategy × regime` 分组；
4. 指标：`n`、均值/中位数收益、胜率、盈亏比、分年/分 regime 段、最大回撤（组合层需要另算）。

**方案 B：过滤后的策略表现。**
本回测结构是「单标的、同一时刻最多一笔、满仓」，所以**跳过某些信号不改变后续交易的收益率**（现金不变、下一笔仍满仓）；因此对保留的交易做 `∏(1+r)` 复利，等价于「按 regime 过滤入场」的近似（不含组合层资金占用/相关性）。正式实现时建议给 `runBacktest` 加可选 `regimeFilter` 参数（**需改代码，超出本任务**）。

**验收标准（先定后看）**：
- 样本 ≥ 5 年、覆盖至少 2 个熊市段与 2 个牛市段（如 2018 熊、2019–2021 牛、2022 熊、2023–2024 震荡）；
- 每个 `strategy × regime` 单元 `n ≥ 30`，否则只报「样本不足」，不下结论；
- 过滤后「风险调整收益」（收益/最大回撤，或收益/波动）必须改善，且不是由单一年份驱动（分年拆开仍成立）；
- 交易成本从 0.10% 提到 0.20% 单边后结论不翻转；
- `confirmDays`（1/2/3）与 `stopAtrMult`（1.2/1.4/1.6）做敏感性，结论对参数不敏感才采纳；
- 若过滤没有改善 → **regime 只用于仓位缩放，不做入场开关**。

### 6.4 演示运行（真实数据，但**只是管线演示**）

数据：`public/data/latest.json` 29 只、每只 160 根日线（日期并集 2026-03-12 ~ 2026-11-24），等权指数，regime 用「指数 > MA20 > MA60 且 MA20 上行 / 指数 < MA20 < MA60 且 MA20 下行」的简化版（与 `regime.ts` 的 7 条件版相近但更简，仅用于演示）；交易标签按 `signalDate`。结果：

| 策略 | 全部交易 | Bull | Range | Bear |
|---|---|---|---|---|
| `breakout` | n=92，均值 +3.07%，胜率 41.3% | n=31，+0.44%，35.5% | n=25，+4.16%，44.0% | n=5，+14.37%，60.0% |
| `pullback` | n=165，−1.04%，32.1% | n=57，−2.19%，26.3% | n=53，+0.53%，37.7% | n=13，−3.94%，23.1% |
| `trend` | n=128，+2.61%，37.5% | n=37，+0.40%，29.7% | n=45，+3.12%，42.2% | n=10，+5.73%，30.0% |
| `reversion` | n=215，−1.74%，40.0% | n=26，−1.44%，42.3% | n=101，−5.09%，27.7% | n=59，+3.18%，64.4% |

按标的复利后的均值（29 只等权平均）：`breakout` +10.9%、`trend` +12.47%、`pullback` −6.36%、`reversion` −11.97%；若「熊市过滤掉 breakout」（`breakout` 只在非 Bear 入场），均值从 +10.9% 变成 **+8.38%**（因为 Bear 区间恰好有 5 笔大反弹交易，n=5）。

**这张表能说明什么、不能说明什么：**
- 能说明：管线能跑通；`pullback` 在本样本里所有 regime 都偏差（与 §3「Bear 禁 pullback」方向一致，但样本内不足以证明）；regime 标签确实会改变分组结论。
- 不能说明：任何规则赚钱/亏钱；**熊市过滤反而让 breakout 变差（+10.9%→+8.38%）恰恰说明小样本分组会误导**（n=5 的「熊市 breakout」是噪声，不是 alpha）。样本只有 160 天、29 只（非全市场、非 point-in-time），指数期间最大回撤 −37.49%、收盘 97.43（整体下跌），regime 160 天切换 14 段（bull 32 天 / range 53 天 / bear 29 天）。
- 结论：**本节所有数字标注为「未验证」**；正式验证按 §6.3 的 5 年样本 + 验收标准执行，本文不做业绩承诺。

---

## 7. 开源 / 成熟策略调研（出处、能否落地、熊市是否适用）

| 策略 | 出处/年份 | 规则要点 | 在本应用日线数据上能否实现 | 熊市是否适用 |
|---|---|---|---|---|
| **双动量**（绝对 + 相对） | Antonacci, *Dual Momentum Investing*（2014） | 12 个月绝对动量过滤（为正才持有风险资产）+ 相对动量在资产间选最强；月度调仓 | **部分可**：绝对动量可用「HS300 12 个月收益 > 0」实现；相对动量需要跨资产池（本应用只有个股/ETF 清单），**需新增资产池与调仓逻辑** | ✅ 作为「不买/持币」过滤器非常适用；❌ 本应用无法做空/轮动到债券 ETF（未跟踪） |
| **Faber 战术资产配置** | Faber, *A Quantitative Approach to Tactical Asset Allocation*, JOWM（2007） | 月末收盘 > 10 个月 SMA 则持有，否则现金；月度检查 | ✅ 可：HS300 日线已有，10 个月 ≈ 200 日，需新增 MA200 | ✅ 熊市核心工具：跌破即降为现金；代价是拐点滞后、震荡市来回打脸 |
| **时序动量（AQR/TSMOM）** | Moskowitz, Ooi & Pedersen, JFE（2012）；Hurst, Ooi & Pedersen, JPM（2017） | 过去 12 个月收益符号决定多/空；按波动率缩放仓位；多品种分散 | **部分可**：12 个月符号可算；按波动率缩放可用 ATR/20 日波动实现；**做空与多品种分散不可**（A 股个人账户、本应用只做多） | ✅ 熊市里「转为空仓」是同一逻辑的退化形态；❌ 不能做空、不能多品种，效果大打折扣 |
| **波动率目标（vol targeting）** | Moreira & Muir, JF（2017）；Harvey et al., JPM（2018） | 仓位 ∝ 目标波动 / 已实现波动；波动升则减仓 | ✅ 可：用 ATR14/价格 或 20 日收益标准差做分母，输出仓位系数 | ✅ 熊市适用：ATR 抬升自动降仓；注意低波动牛市会少赚 |
| **200 日均线趋势过滤** | 实务惯例；Faber（2007）用 10 个月 SMA 的同族做法 | 指数收盘在 200 日线上方才允许做多 | ✅ 可：`regime.ts` 已有 MA120，扩到 MA200 即可（小幅改动） | ✅ 熊市最常用、最便宜的过滤器；震荡市假信号多，需配合确认天数 |
| **Weinstein 阶段分析** | Stan Weinstein, *Secrets for Profiting in Bull and Bear Markets*（1988） | 四阶段：1 筑底、2 上升、3 做头、4 下跌；30 周均线（≈150 日）；只在阶段 2 突破买入，阶段 4 不买 | **部分可**：日线可近似 30 周 MA150 + 价格/均线关系；「阶段」判定需新增规则（本应用只有 MA20/60/120） | ✅ 熊市 = 阶段 4，规则本身就是「不买」；❌ 需要新增 MA150 与阶段判定 |
| **Minervini 趋势模板** | Mark Minervini, *Trade Like a Stock Market Wizard*（2013） | 8 条：价格 > 150/200 日线、150 > 200、200 日线至少上行 1 个月、50 > 150 > 200、价格 > 50 日线、距 52 周低点 ≥30%、距 52 周高点 ≤25%、相对强度 RS ≥70 | **部分可**：MA20/60/120 已有；需新增 MA150/MA200、52 周高低点、相对强度（需基准指数） | ❌ 熊市里几乎无标的满足（这正是它的作用：强制空仓）；✅ 可作为「熊市不买」的过滤器 |
| **海龟 2N 止损 / Chandelier Exit** | Faith, *Way of the Turtle*（2007）；LeBeau（年份未获取到） | 2×ATR 止损 / 22 日最高 − 3×ATR 移动止损 | ✅ 可：ATR14 已有，ATR20/22 可算；`hold` 退出可换 Chandelier 逻辑（需改代码） | ✅ 熊市保留（保护既有持仓），但不解决「该不该入场」 |

**调研结论**：能直接落到当前日线数据的，是「**过滤器类**」策略（Faber 200 日线 / 200 日线 / 双动量的绝对动量部分 / 波动率目标 / Weinstein 阶段 / Minervini 模板的均线部分）；需要新增数据或逻辑的是「**轮动/做空类**」（相对动量、TSMOM 空头、资产池切换）。熊市里真正有用的不是「更聪明的买入规则」，而是**允许空仓的过滤器**——这与本文决策表一致。

---

## 8. 熊市专用规则草案（超跌反弹，唯一允许的熊市入场）

> 定位：熊市里「不亏」比「赚」重要；如果一定要参与，只做**超跌反弹**，且是**短线、小仓、快进快出**。现有 `generateStrategy` 没有 reversion action，本节规则落地**需新增代码**（`backtest.ts` 里的 reversion 定义可作起点：RSI≤32、close<MA20、当日跌、止损 −1.5ATR、目标 +1.8ATR、RSI≥55 或 8 日出）。以下为更严格的熊市版本。

**入场条件（必须全部满足，缺一不买）**
1. **市场**：regime = Bear（`RegimeInfo.regime==='bear'`），且当日沪深300 **不创新低**（`low > 前一日 low`）；宽度不再恶化（29 只中 close>MA20 的占比不低于前一日，或 ≥40%）。
2. **超跌**：个股 `RSI14 ≤ 25`，且 `close ≤ MA20 − 1.5×ATR14`（明显偏离均线）。
3. **确认 K 线**：当日阳线（`close > open`）+ 长下影（`low ≤ close − 0.5×ATR14`）+ `volumeRatio ≥ 1.2`（放量承接）。
4. **不买涨停**：当日涨幅 ≥ 9.5% 视为无法在合理价位成交（A 股 T+1 + 涨跌停制度），放弃。
5. **次日确认**：T+1 开盘不低开跌破信号日低点；若跌破，取消计划（宁可不做）。

**仓位与止损**
- 单票上限 **3%**（熊市 `maxPositionPct 6%` × `sizeFactor 0.33`）；同时最多 **2 只**；组合总风险 ≤ **1%**。
- 止损：`min(信号日低点 − 0.5×ATR, 入场价 − 1.0×ATR)` 取更近者（紧止损）；**不使用 1.4ATR 宽止损**。
- 时间止损：**3 个交易日**内没有盈利（未达到 +0.5×ATR）→ 离场。
- 目标：`+1.5×ATR` 或反弹到 MA10/MA20 附近分批；**不转 hold、不追加、不摊薄**。
- 连续 2 次止损 → 当周停止该策略（防止在下跌中继里连续接刀）。

**与现有代码的差距**
- `generateStrategy` 没有 `reversion`/`bounce` action → 行动卡里这一行**无法由现有规则自动生成**；当前只能人工按上述条件核对（或等 backtest 的 reversion 规则被提升为正式 action）。
- `AlertKind` 没有 `reduce` → 减仓提醒需新增或用目标价代替。
- `maxConcurrentPositions`、`cashPct` 无字段 → 组合约束需新增（§4.2）。

---

## 9. 风险与局限（含免责声明）

**数据与方法局限**
1. 分组回测是**样本内演示**：29 只标的（公开清单，非全市场）、每只 160 根日线（日期并集仅约 8 个月，不到 1 年）、非 point-in-time（有选择/幸存者偏差）、regime 段最短 1 天；`n` 很小的单元（如 Bear × breakout，n=5）没有任何统计意义。**未做稳健性、未做样本外、未做 bootstrap** → 全部标注「未验证」。
2. 没有跑正式分组回测（§6.3 的方案需要 ≥5 年数据与固定标的池）；本文参数是 a priori 草案，**不是**从回测里拟合出来的「最优参数」。
3. 回测只含 0.10% 单边成本，**未建模**滑点、冲击成本、涨跌停无法成交、停牌、T+1 卖出限制、流动性不足；A 股这些摩擦会让短线结果显著变差。
4. 本应用是日线级：`generateStrategy` 用收盘价与日线指标；盘中只做触发判断（`live-signals.ts`），**没有分时/盘口/资金流/龙虎榜/财报/事件数据**，无法做事件驱动或基本面过滤。
5. 单标的回测（满仓、无组合约束）与真实组合（相关性、行业集中、现金）差异很大；组合层的最大回撤无法用现有 `runBacktest` 直接得到。
6. regime 判定本身滞后：均线/回撤都是事后确认，**熊市确认时可能已经跌了不少**；`regime.ts` 目前没有确认天数/最短持续，均线附近会抖动（演示样本 160 天切换 14 段）。
7. 研究证据以美股/期货为主，A 股直接证据有限（§2 已逐条标注「未获取到」）；跨市场外推有风险。
8. `web_fetch` 在本环境对多数域名不可用，部分论文只确认标题/作者/年份，未核对全文页码；本文刻意不引用无法核实的数字。

**执行与行为风险**
9. 熊市「什么都不做」很难执行；`watch` 不发提醒（`live-signals.ts:54`），可能让人忘记风险，也可能让人手痒乱做——规则要写成清单，而不是靠感觉。
10. `reduce` 没有独立提醒（`AlertKind` 只有 trigger/stop/target），「逢高减仓」可能被错过；熊市建议把减仓价位并入 `target` 或人工盯盘。
11. 行动卡基于 T 日收盘、T+1 开盘执行；隔夜跳空、开盘一字板会让计划失效，必须允许「不执行」。
12. 参数（`riskPct`、`maxPositionPct`、现金比例）是个人风险偏好，不是普适最优；本文给的数值只是起点。

**免责声明**：本文是规则化研究与工程实现说明，**不构成投资建议**，不承诺任何收益，不保证数据与规则的准确性、完整性或时效性。历史/样本内表现不代表未来。据此操作的任何损失由操作者自行承担。本应用不连接券商、不自动下单；个人清单与设置只存本地浏览器（`localStorage`）。

---

## 附录 A：复现说明（本次分析实际怎么跑的）

- **regime 与今日行动卡**：临时脚本 import `src/lib/regime.ts` 的 `fetchIndexBars` / `computeRegime` 与 `src/lib/strategy.ts` 的 `generateStrategy`（Node 26 原生跑 TS），数据为 `public/data/latest.json` + 沪深300 320 根日线（2026-11-24 收盘）。脚本只写入 `/tmp`，**未入库、未改 src**（遵守写作用域）。
- **分组回测演示**：临时脚本 import `src/lib/backtest.ts` 的 `runAllBacktests`，用 29 只标的日线跑 4 套策略；等权指数 = 29 只日收益等权平均后累乘；regime 用简化规则（指数 > MA20 > MA60 且 MA20 上行 = bull；指数 < MA20 < MA60 且 MA20 下行 = bear；其余 range；60 日预热）；交易按 `signalDate` 的 regime 归组；「按标的复利再等权平均」= 对每只标的把保留交易的 `(1+r)` 连乘，再对 29 只取均值。
- **可复现性**：结果依赖 `public/data/latest.json` 的时点（2026-11-24 快照）。若快照更新，数字会变；本文所有数字都标注了时点与数据源。

## 附录 B：来源清单（本文引用）

1. Cooper, M. J., Gutierrez, R. C., & Hameed, A. (2004). *Market States and Momentum*. Journal of Finance.
2. Daniel, K., & Moskowitz, T. J. (2016). *Momentum Crashes*. Journal of Financial Economics；NBER Working Paper w20439.
3. Moskowitz, T. J., Ooi, Y. H., & Pedersen, L. H. (2012). *Time Series Momentum*. Journal of Financial Economics.
4. Hurst, B., Ooi, Y. H., & Pedersen, L. H. (2017). *A Century of Evidence on Trend-Following Investing*. Journal of Portfolio Management.
5. Barroso, P., & Santa-Clara, P. (2015). *Momentum has its moments*. Journal of Financial Economics.
6. Jegadeesh, N., & Titman, S. (1993). *Returns to Buying Winners and Selling Losers*. Journal of Finance.
7. Jegadeesh, N. (1990). *Evidence of Predictable Behavior of Security Returns*. Journal of Finance.
8. De Bondt, W. F. M., & Thaler, R. (1985). *Does the Stock Market Overreact?* Journal of Finance.
9. Moreira, A., & Muir, T. (2017). *Volatility-Managed Portfolios*. Journal of Finance.
10. Harvey, C. R., Hoyle, E., Korgaonkar, R., Rattray, S., Sargaison, M., & van Hemert, O. (2018). *The Impact of Volatility Targeting*. Journal of Portfolio Management.
11. Faber, M. T. (2007). *A Quantitative Approach to Tactical Asset Allocation*. Journal of Wealth Management.
12. Ang, A., & Bekaert, G. (2002). *International Asset Allocation With Regime Shifts*. Review of Financial Studies.
13. Han, Y., Zhou, G., & Zhu, Y. *Taming Momentum Crashes: A Simple Stop-Loss Strategy*（工作论文，约 2016；未获取到正式发表信息）.
14. Faith, C. (2007). *Way of the Turtle*. McGraw-Hill.（海龟规则：N=ATR(20)，止损 2N，单 Unit ≈1% 风险）
15. LeBeau, C. *Chandelier Exit*（交易者文献；未获取到原始发表年份）.
16. Antonacci, G. (2014). *Dual Momentum Investing*.
17. Weinstein, S. (1988). *Secrets for Profiting in Bull and Bear Markets*.
18. Minervini, M. (2013). *Trade Like a Stock Market Wizard*.
19. Cakici, N., Chan, K., & Topyan, K. (2014 在线 / 2017 卷期). *Cross-sectional stock return predictability in China*. European Journal of Finance, DOI 10.1080/1351847X.2014.997369.

> 说明：以上来源通过 `web_search` 检索确认存在；本环境无法 `web_fetch` 多数出版方页面，故未引用具体页码与精确样本数字（除公开常识性规则外）。个别条目标注「未获取到」表示无法在本次环境中核实，本文不据此下结论。
