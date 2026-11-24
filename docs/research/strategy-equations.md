# 策略数学定义手册（公式 / 伪代码 / 参数 / 数据可行性 / 中国证据）

> 版本：v1.0 · 2026-11-24 · 作者：strategy-research（研究稿）
> 性质：**公式与证据手册**，不是投资建议。所有公式给出可复现的输入/输出与默认参数；凡「日线 OHLCV 不能算」的字段，明确标注需要补充的数据。
> 配套：`docs/research/strategies.md`（regime playbook）、`docs/research/robustness-gate.md`（推荐前门槛）、`src/lib/strategy.ts`、`src/lib/backtest.ts`、`src/lib/regime.ts`。
> 数据现状：`src/types/index.ts` 的 `Bar` 只有 `date, open, close, high, low, volume, amount, changePct`（腾讯日线 `amount=0`）；`Quote` 无股本、无财报、无行业、无 ST/次新/上市日期字段。本文所有「可实现性」判断以此为准。
> 边界：本文件**未跑任何新回测**；文中的数字要么是公式参数，要么是从既有文献/规则引用，要么是明确标注的「粗算」。**没有足够证据的结论一律写「未获取到全文 / 未验证 / 待核实」。**

## Executive summary

1. **Fifteen standard factor/timing rules are specified with exact formulas and pseudocode** (12-1 momentum, 5-day reversal, ATR/realized vol, turnover/abnormal turnover, Amihud, size, EP/BP, ROE, RSI14, MA cross, Donchian-20, MA pullback, dual momentum, vol targeting, TSMOM), each with default parameters, rebalance frequency, and a data-feasibility verdict for daily OHLCV.
2. **Only 8 of 15 can be computed from this app's daily OHLCV alone**; size, EP/BP and ROE need shares outstanding or financial statements, turnover/abnormal turnover need float shares, Amihud needs reliable turnover value (the app's Tencent path returns `amount=0`), and dual momentum/TSMOM need a multi-asset universe and a risk-free/cash leg (the remaining 4 are ⚠️ proxiable: turnover/Amihud via volume/value approximations, dual momentum as an absolute filter, TSMOM as long/flat).
3. **Chinese A-share evidence is directionally consistent with "weak momentum, strong short-horizon reversal"** (Kang, Liu & Ni 2002; Wang & Chin 2004; 王永宏/赵学军 2001; Cakici et al. 2017), but there are credible counter-examples for momentum in China (Cheema & Nartea 2014), and most full texts were not retrievable here — every specific number is marked 未获取到全文/待核实.
4. **For this app this means:** `breakout` (20-day Donchian-like) has a weak prior in A-shares, while `pullback` (trend + short-horizon dip buying) has a more favorable but still unproven prior; neither is "validated", and the 5-day reversal evidence cannot be transferred mechanically to a 5–20-day MA pullback with T+1 execution.
5. **The exclusion list matters as much as the formula:** without float shares, financial statements, industry, ST/new-listing flags and limit-up/limit-down execution filters, the app can compute signals but **cannot run the cross-sectional tests that the Chinese literature is based on**; this is a data limitation, not a modelling choice.

---

## 0. 记号、口径与成本约定

### 0.1 记号

- `C_t, O_t, H_t, L_t, V_t, AMT_t`：T 日收盘/开盘/最高/最低/成交量/成交额；`r_t = C_t/C_{t-1} − 1`（简单收益；对数收益另注）。
- `n`：回看窗口（交易日）；`252`：年化交易日数（A 股约 242–244，本文统一用 252 做年化，比较时需注意）。
- 信号在 **T 日收盘**计算，**T+1 开盘**执行（A 股 T+1：买入当日不能卖出）。
- 横截面策略：把当期信号排序分 10 组（decile），做多 Top 组（或 Bottom 组），等权持有；本文默认「多头组合」版本，因为本应用只做多。
- 「换手」定义：一次调仓中被替换的持仓权重比例；`年成本拖累 ≈ 年换手 × 单边成本 × 2`（粗算，见 §4）。

### 0.2 成本假设（A 股，制度事实 + 常见费率，费率会变）

| 项目 | 常见值 | 备注 |
|---|---|---|
| 佣金 | 0.02%–0.03% 单边 | 各家不同；有最低 5 元 |
| 印花税 | 0.05%（卖出） | 2023 年减半后的现行值，历史回测需按当年规则 |
| 过户费 | 0.001%（沪市，双向） | 小额 |
| 滑点 | 0.1%–0.3% 单边 | 大盘股低、小盘股高；涨跌停/开盘跳空另算 |
| 单边合计（简） | 0.1%–0.2% | 本应用 backtest 只用了 0.1% 单边（`backtest.ts:74`），**偏低** |

### 0.3 A 股制度约束（会用到的）

- **T+1**：T 日买入，T+1 才能卖；止损/目标当天触发也只能次日卖（本应用 backtest 的「当日 bar.low ≤ stop 即按 stop 成交」在真实 T+1 下是**乐观假设**，见 `robustness-gate.md` §5）。
- **涨跌停**：主板 ±10%，创业板/科创板 ±20%，ST ±5%，北交所 ±30%；一字涨停无法买入、一字跌停无法卖出；次新股上市初期无涨跌幅限制或规则不同。
- **停牌**：长期停牌会导致信号无法执行；本应用 bars 可能有缺日（`market.ts` 只校验日期递增，不保证连续）。

---

## 1. 十五个策略的精确公式

> 每个策略给：核心公式 → 伪代码 → 默认参数 → 再平衡 → 数据字段 → 换手/成本 → 与本应用映射。  
> 数据可行性图例：✅ 日线 OHLCV 即可；⚠️ 需额外字段或近似；❌ 日线 OHLCV 不可算。

### 1.1 12-1 动量（Momentum）

**公式**
```
MOM12_1(i,t) = C(i, t-21) / C(i, t-252) - 1
```
即过去约 12 个月收益，但跳过最近约 1 个月（21 个交易日），避免与短期反转重叠。等价月度写法：`Π_{m=t-12}^{t-2}(1+r_m) − 1`。

**伪代码**
```python
# 每个调仓日 t（月末最后一个交易日收盘）
for stock in universe:
    if len(bars[stock]) < 252: skip
    mom = bars[stock][-21].close / bars[stock][-252].close - 1
rank stocks by mom
long = top_decile(mom)              # 或 top 10%
hold equal weight for next month
```
**默认参数**：回看 252 日、跳过 21 日；分组 10 组；月度调仓；持有 1 个月。  
**再平衡**：月末收盘算信号，下月首个交易日开盘调仓。  
**数据字段**：收盘价（✅）；**日线 OHLCV 可算**。  
**换手/成本**：高（月频约 80%–120% 换手；年成本拖累粗算 2%–4%）。  
**本应用映射**：无直接 action；`trend`/`hold` 是它的长周期近亲；`breakout` 是短周期动量，不等价。  
**证据状态**：中国证据**偏弱**（见 §3）；美股中期动量强（Jegadeesh & Titman 1993）。

### 1.2 5 日反转（Short-term Reversal）

**公式**
```
REV5(i,t) = C(i, t-1) / C(i, t-6) - 1          # 过去 5 个交易日，剔除今日
# 或：REV1 = r_{t-1}（上一日收益，1 日反转）
```
做多过去 5 日跌幅最大组（Bottom decile），做空/回避涨幅最大组；或只做多亏损组。

**伪代码**
```python
for stock in universe:
    if len(bars[stock]) < 7: skip
    rev = bars[stock][-2].close / bars[stock][-7].close - 1
long = bottom_decile(rev)
```
**默认参数**：窗口 5 日（1 日/1 周变体均可）；周频或日频调仓；持有 5 日。  
**再平衡**：每周最后一个交易日收盘；或每日换 1/5 仓位（降低换手）。  
**数据字段**：收盘价（✅）。**日线 OHLCV 可算**。  
**换手/成本**：**极高**（周频接近 100% 换手；年成本拖累粗算 10%–16%，很容易吃掉反转收益）。  
**本应用映射**：`reversion`（backtest 内有、`generateStrategy` 无）是它的近亲，但用 RSI≤32 + 跌破 MA20，不是纯 5 日反转。  
**证据状态**：A 股短期反转证据相对强（Kang/Liu/Ni 2002 等），但**扣除成本与 T+1 后的可交易性未验证**（见 §3）。

### 1.3 ATR 与已实现波动率（Volatility）

**ATR（Wilder 标准口径）**
```
TR_t  = max(H_t - L_t, |H_t - C_{t-1}|, |L_t - C_{t-1}|)
ATR_t = (n-1)/n * ATR_{t-1} + TR_t / n     # n=14，首值用前 n 个 TR 均值
ATR%_t = ATR_t / C_t
```
**已实现波动率（收盘价对数收益）**
```
r_t = ln(C_t / C_{t-1})
sigma_t = sqrt( 252/(N-1) * Σ_{i=0}^{N-1} (r_{t-i} - mean(r))^2 )     # N=20 或 60
```
**EWMA（RiskMetrics）**：`sigma²_t = λ·sigma²_{t-1} + (1-λ)·r_t²`，`λ=0.94`（日频）。  
**OHLC 高效估计（可选）**：Parkinson `sigma = sqrt( mean(ln(H/L)²) / (4 ln 2) )`；Garman-Klass 用 O/H/L/C 四价，方差更小。

**本应用口径**：`ATR14` 是「最近 14 根 TR 的简单平均」（`src/lib/strategy.ts:21-29`），不是 Wilder 平滑；两者数值接近但不完全相同。做回测复现时必须以代码口径为准。

**默认参数**：ATR 14（止损）/20（海龟 N）/22（Chandelier）；波动率 20 日或 EWMA λ=0.94。  
**再平衡**：波动率本身不调仓，作为**仓位/止损的输入**每日更新。  
**数据字段**：OHLC（✅）；`amount` 不需要。**日线 OHLCV 可算**。  
**换手/成本**：低（只影响仓位与止损价，不直接产生交易）。  
**本应用映射**：`stop` 的 `MA20−0.5ATR`、`breakout` 的 `1.4ATR` 止损、`hold` 的 `1.3ATR` 保护位、`reduce` 的 `2.2ATR` 乖离全部基于它。  
**证据状态**：ATR 归一化是行业惯例（Faith 2007 海龟 2N）；「用 ATR 定止损」本身不是 alpha 来源。

### 1.4 换手率与异常换手（Turnover / Abnormal Turnover）

**真实换手率（需要流通股本）**
```
TO_t = V_t / FloatShares_t                       # 单位：倍（当日成交量/流通股数）
TO20_t = mean(TO_{t-19..t})
```
**异常换手（两种常用）**
```
ATO_t = TO_t / median(TO_{t-20..t-1})           # 比值；>1 表示异常放量
ATO_t = ln(TO_t) - ln(mean(TO_{t-20..t-1}))     # 对数差，近似正态
```
**成交量比（无需股本，本应用用的近似）**
```
VR_t = V_t / mean(V_{t-5..t-1})                  # 本应用 volumeRatio 就是这个（strategy.ts:45-46）
```
注意：`VR` 是**相对成交量**，不是换手率；两者在流通股本变化时会分叉。

**默认参数**：基准窗口 20 日（异常换手）/5 日（本应用 VR）；阈值常用 `ATO>2` 或 `VR≥1.15`（本应用突破门槛）。  
**再平衡**：换手类多用于**过滤/择时**（放量确认），不单独构成组合；若做横截面因子，月度调仓。  
**数据字段**：`volume`（✅）+ **流通股本**（❌ 日线 OHLCV 没有；本应用无该字段）→ 真实换手率**不可算**；只能用 `VR` / `V_t/mean(V_{20})` 代理。  
**换手/成本**：中（作为过滤器时降低交易次数；作为因子时换手高）。  
**本应用映射**：`breakout` 的 `volumeRatio ≥ 1.15`；这是「放量确认」，不是换手率异象。  
**证据状态**：A 股换手率/异常换手与未来收益负相关的研究存在（如 *Does the turnover effect matter in emerging markets? Evidence from China*, Pacific-Basin Finance Journal 2021；**未获取到全文**）；但本应用无法计算真实换手率，无法复现该类因子。

### 1.5 Amihud 非流动性（Illiquidity）

**公式（Amihud 2002）**
```
ILLIQ_t = (1/D) * Σ_{d=1..D} |r_{t-d}| / DV_{t-d}
```
`DV` = 当日成交额（dollar volume，元）。`ILLIQ` 越大 = 越不流动。D 常取 20 或 60 个交易日；横截面取分位。

**伪代码**
```python
for stock in universe:
    vals = []
    for d in range(1, 21):
        dv = amount[t-d] if amount[t-d] > 0 else price[t-d] * volume[t-d]   # 兜底
        vals.append(abs(ret[t-d]) / dv)
    illiq = mean(vals)
rank by illiq
```
**默认参数**：D=20；分 3 层（高/中/低流动性）做稳健性检验。  
**再平衡**：作为**风控/分层变量**，不单独交易；若做因子，月度。  
**数据字段**：`amount` 最好；本应用腾讯日线 `amount=0`（README 已注明），只能用 `C×V` 近似 → ⚠️ **可算但口径偏**。  
**换手/成本**：低（用于过滤/容量评估）。  
**本应用映射**：无；可用于「容量检查」（§6 的 gate）。  
**证据状态**：Amihud (2002) 原始研究是美股；A 股复现**未获取到全文**。

### 1.6 规模（Size）

**公式**
```
ME_t = C_t × TotalShares_t          # 总市值
lnME_t = ln(ME_t)
```
**默认参数**：月度调仓；分 10 组；小市值组做多（A 股历史上有小盘溢价，但有壳价值/流动性/退市风险）。  
**数据字段**：**总股本/流通股本**（❌ 日线 OHLCV 没有；本应用无该字段）→ **不可算**。用价格代替规模是错的（低价 ≠ 小市值）。  
**换手/成本**：中高（小盘股滑点大）。  
**本应用映射**：无。  
**证据状态**：中国规模因子在 Liu, Stambaugh & Yuan (2019) 的 CH-3 中是核心因子，但论文**剔除了市值最小的一部分股票**以处理壳价值（据二手综述，具体比例**未获取到全文核实**）。

### 1.7 价值（EP / BP）

**公式**
```
EP_t = 净利润(TTM) / 总市值_t
BP_t = 净资产(最新报告期) / 总市值_t
```
**默认参数**：月度调仓；EP 在 A 股通常比 BP 更稳健（Liu/Stambaugh/Yuan 2019 的 CH-3 用 EP 作为价值因子——据二手综述，**待核实**）。  
**数据字段**：**净利润、净资产 + 市值**（❌ 日线 OHLCV 完全没有；本应用无财报数据）→ **不可算**。  
**换手/成本**：低（月频，价值因子换手低）。  
**本应用映射**：无。  
**证据状态**：Liu, Stambaugh & Yuan (2019), *Size and value in China*, JFE；Hu et al. (2019), *Fama-French in China*, International Review of Finance 19(1):3–44（题目/卷期已确认，**全文未获取到**）。

### 1.8 质量（ROE / 毛利率）

**公式**
```
ROE = 净利润(TTM) / 平均净资产
GrossMargin = (营业收入 - 营业成本) / 营业收入
```
**默认参数**：季度更新（财报披露后）；分位数组合；与价值组合成「质量价值」。  
**数据字段**：**利润表/资产负债表**（❌ 日线 OHLCV 没有）→ **不可算**。  
**换手/成本**：低（季度）。  
**本应用映射**：无。  
**证据状态**：A 股质量因子证据**未获取到全文**；不在本文结论中使用。

### 1.9 RSI14（相对强弱指标）

**标准（Wilder）公式**
```
Δ_t = C_t - C_{t-1}
U_t = max(Δ_t, 0),  D_t = max(-Δ_t, 0)
avgU_t = (13/14)·avgU_{t-1} + (1/14)·U_t     # 首值用前 14 日均值
avgD_t = (13/14)·avgD_{t-1} + (1/14)·D_t
RS_t = avgU_t / avgD_t
RSI_t = 100 - 100/(1+RS_t)                   # avgD=0 时 RSI=100
```
**本应用口径**：简单平均（14 个涨跌均值），非 Wilder 平滑（`strategy.ts:7-19`）——结论接近，但极值处会有差异。  
**默认参数**：14；超卖 30、超买 70；本应用用 `RSI≥76` 触发 `reduce`、回测 reversion 用 `RSI≤32`。  
**再平衡**：作为**过滤/止盈**条件，不单独构成组合。  
**数据字段**：收盘价（✅）。**日线 OHLCV 可算**。  
**换手/成本**：中（作为过滤器降低交易频率）。  
**证据状态**：RSI 是技术指标，不是学术因子；**无严格 A 股证据**，不应单独作为 alpha 来源。

### 1.10 均线交叉（MA Golden/Death Cross）

**公式**
```
MA_s,t = (1/s)·Σ_{i=0..s-1} C_{t-i}
GoldenCross_t: MA_s,t > MA_l,t 且 MA_s,t-1 <= MA_l,t-1    # 上穿
DeathCross_t : MA_s,t < MA_l,t 且 MA_s,t-1 >= MA_l,t-1    # 下穿
```
**默认参数**：经典 `s/l = 50/200`；本应用用的是**三线排列**（`MA5>MA10>MA20`，`strategy.ts:49-50`），不是两线交叉，二者信号频率不同。  
**再平衡**：信号日收盘算、次日开盘执行；持有至反向交叉或止损。  
**数据字段**：收盘价（✅）。**日线 OHLCV 可算**。  
**换手/成本**：中（年信号次数少，但震荡市来回打脸）。  
**本应用映射**：`trendUp/trendDown` 判定、`hold` 条件、`stop` 的 MA20 参照。  
**证据状态**：均线规则与 Faber (2007) 的 10 个月 SMA 同类；A 股直接证据**未获取到全文**。

### 1.11 Donchian 20 日突破

**公式**
```
Upper_t = max(H_{t-20..t-1})        # 前 20 日最高（不含当日）
Lower_t = min(L_{t-20..t-1})
Entry_long:  C_t >= Upper_t          # 本应用用 C_t >= 0.998×Upper_t
Exit_long :  C_t <= min(L_{t-10..t-1})   # 10 日反向通道，或用 ATR 跟踪止损
Stop      :  entry - k×ATR14         # 海龟 k=2N；本应用 k=1.4
```
**默认参数**：通道 20/10；止损 `1.4×ATR`（本应用 `breakout`，`strategy.ts:55,88`）或 `2N`（海龟）；可选放量确认 `VR≥1.15`、涨幅 `≥1%`。  
**再平衡**：信号日收盘算、次日开盘执行；持有至反向通道/止损/时间止损（本应用回测 12 日）。  
**数据字段**：OHLC（✅）。**日线 OHLCV 可算**。  
**换手/成本**：中（一次完整交易约 0.2%–0.4% 成本；月均 1–2 次信号时年成本 3%–8%，粗算）。  
**本应用映射**：**就是 `breakout`**（`price ≥ high20×0.998 & changePct≥1 & volumeRatio≥1.15`）。  
**证据状态**：趋势突破在美股/期货有支持（海龟、TSMOM 的近亲）；**A 股 20 日突破的严格证据未获取到全文**，且中国动量弱 → 先验不强。

### 1.12 回踩均线（MA Pullback）

**公式（本应用版本）**
```
趋势条件: MA5 > MA10 > MA20
回踩条件: C_t <= MA5 + 0.25×ATR14
          且 C_t >= MA10 - 0.4×ATR14
          且 当日涨幅 < 1.5%
入场: 次日开盘（本应用 EOD 语义）
止损: min(MA10 - 0.6×ATR14, MA20 - 0.2×ATR14)
目标: max(high20, entry + 1.8×ATR14)
```
**一般化公式（z-score 版）**
```
z_t = (C_t - MA20_t) / ATR14_t          # 或 /(20日收益标准差)
趋势过滤: MA20 上行 且 C_t > MA60
回踩信号: -1.5 <= z_t <= 0 且 当日收阳/止跌
```
**默认参数**：MA 5/10/20（本应用）或 20/60；ATR 缓冲 0.25/0.4/0.6；持有至目标/止损/跌破 MA20。  
**再平衡**：信号日收盘算、次日开盘执行。  
**数据字段**：OHLC（✅）。**日线 OHLCV 可算**。  
**换手/成本**：中（月均 1–3 次信号；年成本粗算 2%–6%）。  
**本应用映射**：**就是 `pullback`**。  
**证据状态**：短期反转文献支持「跌了买」在 1 周尺度；但本应用是 5–20 日均线结构 + 次日开盘执行，**持有期跨越反转窗口后可能失效**（§3）。

### 1.13 双动量（Dual Momentum）

**公式**
```
绝对动量: R12(i,t) > 0（或 > 无风险利率/货币基金收益）
相对动量: winner = argmax_i R12(i,t)
持仓: if R12(winner) > 0: 持有 winner，否则持有现金/短债
```
**默认参数**：12 个月（或 12-1）；月度调仓；资产池 = 股票指数 ETF + 债券 ETF + 黄金 ETF + 现金（Antonacci 原始设定，**具体品种与再平衡细节未获取到全文，待核实**）。  
**数据字段**：多资产收盘价 + 无风险收益（⚠️ 本应用只有个股/ETF 代码，无资产池切换与现金收益字段）→ **部分可做**（可用「HS300 12 个月收益 > 0」做绝对动量过滤，无法做相对轮动）。  
**换手/成本**：低（月频、少数资产）。  
**本应用映射**：可作为 `regime` 的补充过滤器（指数 12 个月动量），不是 action。  
**证据状态**：Antonacci (2014) 专著；学术界对「双动量 vs 单动量」的增量有争议（**未获取到全文**）。

### 1.14 波动率目标（Volatility Targeting）

**公式**
```
sigma_hat_t = 20 日已实现波动（年化）或 EWMA(lambda=0.94)
w_t = min(w_max, sigma_target / sigma_hat_t)       # 目标波动/当前波动
position_value_t = w_t × Capital
shares_t = floor( position_value_t / (100 × C_t) ) × 100   # A 股整手
```
**默认参数**：`sigma_target` = 10%–15% 年化；`w_max` = 1.0–1.5；日频或周频调仓；可加「波动率上限」防杠杆。  
**数据字段**：收盘价（✅）。**日线 OHLCV 可算**。  
**换手/成本**：中高（波动率跳升时快速降仓，可能连续调仓）；成本取决于调仓频率。  
**本应用映射**：可用于「仓位缩放」层（`suggestedShares` 之上再乘 `w_t`），**需新增字段** `portfolio.volTarget`。  
**证据状态**：Moreira & Muir (2017)、Harvey et al. (2018) 支持美股/多资产；A 股直接证据**未获取到全文**。

### 1.15 时间序列动量（TSMOM）

**公式**
```
signal_t = sign( C_{t-21}/C_{t-252} - 1 )        # 过去 12-1 个月收益符号；或 12 个月不跳过
position_notional_t = signal_t × (sigma_target / sigma_hat_t) × Capital
```
**默认参数**：12 个月（或 12-1）；月度调仓；多品种分散（Moskowitz/Ooi/Pedersen 2012 的原始设定是 58 个期货，**具体品种池未获取到全文**）；单品种版本退化严重。  
**数据字段**：多资产 + 波动率（⚠️）；本应用单资产只能做「多/空仓」二值，且**不能做空** → 退化为「12 个月动量为正才持有」的过滤器。  
**换手/成本**：高（月频、多品种）；单资产低频则低。  
**本应用映射**：无直接 action；可作 `regime` 补充。  
**证据状态**：Moskowitz, Ooi & Pedersen (2012) 强；Hurst, Ooi & Pedersen (2017) 百年证据强；**A 股单资产 TSMOM 的证据未获取到全文**。

---

## 2. 数据字段与可实现性矩阵

### 2.1 本应用可用字段（`Bar`）

`date, open, close, high, low, volume, amount, changePct`；`Quote` 带 `price/prevClose/...`；`amount` 在腾讯日线路径为 0（README 已记录）。**没有**：流通股本/总股本、财报、行业、ST 标记、上市日期、复权因子（腾讯路径为前复权，但代码里没有显式复权字段）。

### 2.2 可实现性矩阵

| # | 策略 | 日线 OHLCV 可算？ | 需要补充的字段 | 本应用现状 | 换手/成本敏感度 |
|---|---|---|---|---|---|
| 1 | 12-1 动量 | ✅ | — | 可算（脚本已有 bars） | 高 |
| 2 | 5 日反转 | ✅ | — | 可算 | 极高 |
| 3 | ATR / 已实现波动 | ✅ | — | 已实现（ATR14/RSI14） | 低（作输入） |
| 4 | 换手率 / 异常换手 | ⚠️ | 流通股本（真实换手率）；仅有 VR 代理 | 只有 `volumeRatio`（VR） | 中 |
| 5 | Amihud | ⚠️ | 成交额（`amount`）；本应用常为 0 | 只有成交量，需 `C×V` 近似 | 低 |
| 6 | 规模 | ❌ | 总/流通股本 | 无 | 中 |
| 7 | EP / BP | ❌ | 净利润/净资产 + 市值 | 无财报 | 低 |
| 8 | ROE / 毛利率 | ❌ | 三大报表 | 无财报 | 低 |
| 9 | RSI14 | ✅ | — | 已实现（简单平均口径） | 中 |
| 10 | 均线交叉 | ✅ | — | 已实现（MA5/10/20） | 中 |
| 11 | Donchian 20 | ✅ | — | 已实现（`high20`） | 中 |
| 12 | 回踩均线 | ✅ | — | 已实现（`pullback`） | 中 |
| 13 | 双动量 | ⚠️ | 多资产池 + 现金/无风险收益 | 只能做绝对动量过滤 | 低 |
| 14 | 波动率目标 | ✅ | — | 可算，但无仓位缩放字段 | 中 |
| 15 | TSMOM | ⚠️ | 多资产 + 可做空 | 只能做「正动量才持有」 | 高 |

### 2.3 结论

- **能算信号 ≠ 能复现文献**：中国横截面异象（规模/价值/换手/Amihud）都需要**股本 + 财报 + 全市场股票池**；本应用只有 29 只公开清单 + 个人清单，**无法做横截面分层检验**。
- **优先可实现的**：动量、反转、ATR/波动、RSI、均线、Donchian、回踩、波动率目标（8 个完整可算）；其中**只有 ATR/波动率是「输入」而不是 alpha**。
- **需要新增数据才能做的**：规模、EP/BP、ROE、真实换手、Amihud、ST/次新/行业/涨跌停标记（这些恰好是稳健性检验的分层变量，见 `robustness-gate.md` §4）。

---

## 3. 中国 A 股证据（逐条：作者 + 年份 + 样本区间 + 结论 + 获取状态）

> **重要说明**：本环境 `web_fetch` 对多数出版方域名不可用（DNS 解析到非公网地址），只能通过 `web_search` 确认「题目/作者/年份/期刊/DOI」是否存在。因此下表的「结论」来自论文标题/摘要的二手转述与领域常识，凡未核对全文的**具体数字（样本区间、收益率、t 值）一律标注「未获取到全文」或「待核实」**，不编造。  
> 「正/反」标记相对「A 股动量弱、反转强」这一命题。

| # | 研究 | 样本区间 | 结论（据摘要/二手转述） | 方向 | 获取状态 |
|---|---|---|---|---|---|
| 1 | Kang, Liu & Ni (2002), *Contrarian and momentum strategies in the China stock market: 1993–2000*, Pacific-Basin Finance Journal | 1993–2000（题目明示） | 短期反转（contrarian）策略有显著利润；动量策略不显著/弱 | 正 | 题目/期刊/区间已确认；结论据二手转述，**全文未获取到** |
| 2 | 王永宏、赵学军 (2001)，《中国股市「惯性策略」和「反转策略」的实证分析》，《经济研究》2001 年第 6 期 | 未获取到全文（**待核实**，常见转述为 1990 年代） | 反转策略显著、惯性（动量）策略不显著 | 正 | 题目/期刊/年期已确认（CNKI）；结论据二手转述，**全文未获取到** |
| 3 | 鲁臻、邹恒甫 (2007)，《中国股市的惯性与反转效应研究》，《经济研究》2007 年第 9 期 | 未获取到全文 | 中国股市存在惯性与反转效应（方向与细分待核实） | 待核实 | 题目/期刊/年期已确认（CNKI）；**全文未获取到** |
| 4 | Wang & Chin (2004), *Profitability of return and volume-based investment strategies in China's stock market*, Pacific-Basin Finance Journal 12(5) | 未获取到全文 | 收益/成交量类策略（反转、量能）在中国有可研究性 | 正（弱） | 题目/期刊/卷期已确认；**全文未获取到** |
| 5 | Cakici, Chan & Topyan (2017), *Cross-sectional stock return predictability in China*, European Journal of Finance（DOI 10.1080/1351847X.2014.997369） | 未获取到全文 | 规模、价值、反转类因子较稳健；动量不稳健/弱 | 正 | 题目/DOI 已确认；**全文未获取到** |
| 6 | Cheema & Nartea (2014), *Momentum returns and information uncertainty: Evidence from China*, Pacific-Basin Finance Journal 30:173–188 | 未获取到全文 | 中国存在动量收益，且与信息不确定性相关 | **反**（对「动量弱」的反例） | 题目/期刊/卷期/页码已确认（Google Scholar）；**全文未获取到** |
| 7 | Liu, Stambaugh & Yuan (2019), *Size and value in China*, Journal of Financial Economics | 未获取到全文（**待核实**） | 构造 CH-3（规模 + 价值 EP），剔除市值最小一部分股票以处理壳价值；规模/价值是核心 | 中性（不直接测动量） | 题目/期刊已确认；**全文未获取到**，剔除比例待核实 |
| 8 | Hu, G. X. 等 (2019), *Fama-French in China: Size and Value Factors in Chinese Stock Returns*, International Review of Finance 19(1):3–44 | 未获取到全文 | 中国市场中规模/价值因子可用 | 中性 | 题目/期刊/卷期/页码已确认；**全文未获取到**，完整作者列表待核实 |
| 9 | Jansen & Swinkels 等 (2021), *Anomalies in the China A-share market*, Pacific-Basin Finance Journal 68 | 未获取到全文 | 系统检验 A 股异象，需多重检验后仍显著的异象有限 | 待核实 | 题目/期刊/卷/年已确认（RePEc）；作者列表与**全文未获取到** |
| 10 | *Does the turnover effect matter in emerging markets? Evidence from China*, Pacific-Basin Finance Journal (2021) | 未获取到全文 | 换手率效应在中国存在（高换手→低未来收益） | 待核实 | 题目/期刊/年已确认；作者列表/结论**未获取到全文** |
| 11 | Fang & Wang (2026), *Short-Term Reversal in Chinese A-Shares: Statistical Predictability, Economic Tradability, and Multiple Testing*（工作论文/Zenodo） | 未获取到全文 | 标题即提示：短期反转需同时过「统计显著 + 经济可交易 + 多重检验」三关 | 正（谨慎） | 题目/年份已确认；**全文未获取到**（PDF 无法访问） |
| 12 | Amihud (2002), *Illiquidity and stock returns*, Journal of Financial Markets | 美股 | 非流动性与预期收益正相关（ILLIQ） | 方法来源 | 经典文献（非中国） |

### 3.1 「A 股动量弱、反转强」是否成立？

**支持（多数证据）**：
- 早期经典：Kang/Liu/Ni (2002, 1993–2000) 与 王永宏/赵学军 (2001) 都指向「短期反转有利润、动量不显著」；
- Cakici et al. (2017) 的横截面检验把反转/规模/价值列为较稳健，动量较弱；
- 2026 年 Fang & Wang 仍在研究「A 股短期反转是否可交易」——说明反转是 A 股的核心议题之一，而不是已被轻易赚走的确定收益。

**反对/复杂化（不能忽略）**：
- Cheema & Nartea (2014) 报告中国**存在**动量收益，且与信息不确定性相关——说明「动量弱」不是铁律，可能依赖样本期、股票类型、形成期；
- Liu/Stambaugh/Yuan (2019) 的因子结构是「规模 + 价值」，并未宣称「动量强」；但这不等于「动量可交易」；
- **样本期偏差**：1990 年代 A 股（Kang 等、王永宏等）与 2010 年代后的市场结构（机构化、注册制、涨跌停/停牌规则变化）差异很大；旧结论**不能直接搬到今天**（这一点是本文的判断，不是某篇论文的结论）。
- 交易成本：A 股反转策略换手极高，**扣成本后的可交易性**在文献中通常最弱（Fang & Wang 2026 的标题正是在处理这个问题）；具体数字**未获取到全文**。

**结论（本文判断，标注为待验证）**：**「A 股短期反转相对强、中期动量相对弱」有较多方向性证据支持，但不是无争议的定律；且证据是扣费前/特定样本期的，不能直接作为「回踩低吸一定赚」的依据。**

### 3.2 对 breakout vs pullback 的含义

1. **`breakout`（20 日突破）是短周期动量**：如果 A 股中期动量弱，那么 20 日突破的**先验并不强**；它可能只在特定阶段（趋势市/放量题材）有效，且假突破成本高。
2. **`pullback` 的「低吸」部分与短期反转同向**：短期反转证据给 `pullback` 一个**略好于 breakout 的先验**；但本应用的 `pullback` 还要求 `MA5>MA10>MA20`（趋势过滤）并在**次日开盘**买入，这两个特征会把「1–5 日反转」变成「5–20 日趋势回调」，**不能直接引用反转文献为它背书**。
3. **两者都没有中国样本上的扣费后稳健证据**：按 `robustness-gate.md`，`breakout` 与 `pullback` 都是 **UNKNOWN（暂不推荐）**，不是「一个该做、一个不该做」。文献只给出**先验方向**，不给出「可推荐」的结论。

---

## 4. 成本、换手与执行（公式层面的约束）

**年成本拖累粗算**
```
AnnualCostDrag ≈ (每年调仓次数) × (每次换手比例) × (单边成本 × 2)
```
示例（粗算，不是回测）：5 日反转周频、每次 100% 换手、单边 0.15% → `52 × 1.0 × 0.3% ≈ 15.6%/年`；这还没有算滑点与涨跌停无法成交。  
**含义**：任何「日频/周频、全换手」的策略，在 A 股散户成本下都需要**极高的毛收益**才能覆盖成本；文献里的反转收益多数是**等权、扣费前、无涨跌停约束**的。

**执行顺序（必须与回测一致）**
1. T 日收盘算信号（只用 ≤T 的数据）；
2. T+1 开盘按开盘价成交（含滑点）；
3. 止损/目标触发只能 T+1 及以后卖出（A 股 T+1）；
4. 一字涨停不买、一字跌停不卖；
5. 停牌日不交易，信号顺延或作废（需明确规则）。

**本应用 backtest 的偏差**（详见 `robustness-gate.md` §5）：
- 止损按当日 `bar.low ≤ stop` 就假定在 `stop` 成交——但 A 股 T+1，当天买入当天不能卖；若 `entryIndex` 当天就触发止损，回测允许卖出而实盘不允许。
- 只有 0.1% 单边成本，没有印花税、滑点、涨跌停、停牌。
- 单标的满仓，无组合成本/容量约束。

---

## 5. 与现有代码的对应关系

| 策略/公式 | 代码位置 | 现状 |
|---|---|---|
| `breakout`（Donchian 20 变体） | `strategy.ts:55, 82-90`；`backtest.ts:117, 125-128` | 已实现；阈值见 §1.11 |
| `pullback`（MA 回踩） | `strategy.ts:56, 91-99`；`backtest.ts:118, 129` | 已实现；止损/目标见 §1.12 |
| `trend`（均线趋势持有） | `backtest.ts:119, 130, 137` | 已在回测；`generateStrategy` 无独立 trend action |
| `reversion`（RSI 超跌反弹） | `backtest.ts:120, 131, 138` | **只在回测**；`generateStrategy` 无对应 action |
| ATR14 | `strategy.ts:21-29`（SMA 口径） | 已实现；与 Wilder 有差异 |
| RSI14 | `strategy.ts:7-19`（简单平均口径） | 已实现；与 Wilder 有差异 |
| `high20` | `strategy.ts:38-42`；`backtest.ts:108` | 已实现（不含当日） |
| `regime`（MA20/60/120 + 回撤 + 宽度） | `src/lib/regime.ts` | 已实现（provisional） |
| 规模/EP/BP/ROE/真实换手/Amihud/多资产 | — | **未实现，缺数据** |

---

## 6. 局限

1. 本文是**公式与文献手册**，没有跑任何新回测；所有「可算」只表示数据字段够，不表示策略有效。
2. 中国证据的**全文获取失败**是硬限制：具体样本区间、收益率、t 值均未核对，本文刻意不引用这些数字。
3. 公式默认参数是文献/行业惯例，不是本应用的最优参数；参数敏感性见 `robustness-gate.md` §6。
4. 本应用数据只有日线 OHLCV 的**子集**（无股本/财报/行业/ST/上市日期），因此**规模、价值、质量、真实换手、Amihud 这几类「中国证据最强」的因子在应用内无法实现**。
5. 不构成投资建议；历史与文献结论不代表未来。

---

## 附录：来源清单（已确认存在；全文未获取到的已标注）

1. Kang, J.-K., Liu, M.-H., & Ni, S. X. (2002). *Contrarian and momentum strategies in the China stock market: 1993–2000*. Pacific-Basin Finance Journal.
2. 王永宏、赵学军 (2001).《中国股市「惯性策略」和「反转策略」的实证分析》.《经济研究》2001(6).（CNKI 条目）
3. 鲁臻、邹恒甫 (2007).《中国股市的惯性与反转效应研究》.《经济研究》2007(9).（CNKI 条目）
4. Wang, C., & Chin, S. (2004). *Profitability of return and volume-based investment strategies in China's stock market*. Pacific-Basin Finance Journal 12(5).
5. Cakici, N., Chan, K., & Topyan, K. (2017). *Cross-sectional stock return predictability in China*. European Journal of Finance. DOI 10.1080/1351847X.2014.997369.
6. Cheema, M. A., & Nartea, G. V. (2014). *Momentum returns and information uncertainty: Evidence from China*. Pacific-Basin Finance Journal 30:173–188.
7. Liu, J., Stambaugh, R. F., & Yuan, Y. (2019). *Size and value in China*. Journal of Financial Economics.
8. Hu, G. X. 等 (2019). *Fama-French in China: Size and Value Factors in Chinese Stock Returns*. International Review of Finance 19(1):3–44.
9. Jansen, M., Swinkels, L. 等 (2021). *Anomalies in the China A-share market*. Pacific-Basin Finance Journal 68.
10. *Does the turnover effect matter in emerging markets? Evidence from China*. Pacific-Basin Finance Journal (2021).
11. Fang, ? & Wang, ? (2026). *Short-Term Reversal in Chinese A-Shares: Statistical Predictability, Economic Tradability, and Multiple Testing*. 工作论文（Zenodo）.
12. Amihud, Y. (2002). *Illiquidity and stock returns: cross-section and time-series effects*. Journal of Financial Markets.
13. Jegadeesh, N., & Titman, S. (1993). *Returns to Buying Winners and Selling Losers*. Journal of Finance.
14. Jegadeesh, N. (1990). *Evidence of Predictable Behavior of Security Returns*. Journal of Finance.
15. Faith, C. (2007). *Way of the Turtle*.（N=ATR(20)，2N 止损）
16. Antonacci, G. (2014). *Dual Momentum Investing*.
17. Moskowitz, T. J., Ooi, Y. H., & Pedersen, L. H. (2012). *Time Series Momentum*. Journal of Financial Economics.
18. Hurst, B., Ooi, Y. H., & Pedersen, L. H. (2017). *A Century of Evidence on Trend-Following Investing*. Journal of Portfolio Management.
19. Moreira, A., & Muir, T. (2017). *Volatility-Managed Portfolios*. Journal of Finance.
20. Harvey, C. R., et al. (2018). *The Impact of Volatility Targeting*. Journal of Portfolio Management.

> 获取状态说明：以上条目的题目/作者/期刊/年份通过 `web_search` 检索确认；本环境无法 `web_fetch` 出版方页面，**所有具体数字与样本区间均未核对全文**，文中已逐条标注「未获取到全文/待核实」。
