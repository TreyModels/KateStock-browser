#!/usr/bin/env bash
#
# 发布候选（RC）一键验收：按顺序跑全部可自动化检查，汇总 PASS/FAIL/SKIP/PENDING，
# 并生成 docs/rc-status.md（当前 commit、日期、结果表、证据路径、真实输出、已知未验证项、RC 结论）。
#
# 用法：
#   cd kate-dashboard
#   bash scripts/acceptance-all.sh            # 一键（任意目录也可用绝对路径）
#
# 退出码：0 = 全部 PASS（允许 PENDING=待盘中 / SKIP）；1 = 有 FAIL。
#
# 说明：不改应用代码；market-window-check.mjs 的行为不变（只在本脚本里按交易时段决定是否调用）。
# 依赖：dev server http://localhost:3000（浏览器类步骤需要）；Playwright 在 /tmp（浏览器类步骤需要）。

set -uo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "用法：bash scripts/acceptance-all.sh"
  echo "依次运行：verify.sh → check_baseline → python unittest → personal-stock-e2e → preopen-check（仅盘前）→ market-window（仅交易时段）"
  echo "退出码：0=无 FAIL（PENDING/SKIP 允许）；1=有 FAIL。生成 docs/rc-status.md 与 docs/acceptance-logs/<时间戳>/。"
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}" || { echo "无法进入仓库根目录 ${ROOT}"; exit 1; }

export PATH="/opt/homebrew/bin:${PATH}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/tmp/pw-browsers}"
export PLAYWRIGHT_MODULE="${PLAYWRIGHT_MODULE:-/tmp/pw-tools/node_modules/playwright}"
BASE_URL="${BASE_URL:-http://localhost:3000}"

STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="${ROOT}/docs/acceptance-logs/${STAMP}"
mkdir -p "${LOG_DIR}"
ROWS_FILE="${LOG_DIR}/rows.md"
TAILS_FILE="${LOG_DIR}/tails.md"
: > "${ROWS_FILE}"
: > "${TAILS_FILE}"

FAIL_COUNT=0
PENDING_COUNT=0
SKIP_COUNT=0
PASS_COUNT=0

record_row() {
  # $1 step, $2 status, $3 evidence, $4 reason
  printf '| %s | %s | %s | %s |\n' "$1" "$2" "$3" "$4" >> "${ROWS_FILE}"
}
append_tail() {
  # $1 step label, $2 log file, $3 status/detail
  {
    echo "### $1（$3）"
    echo '```'
    if [ -s "$2" ]; then tail -n 12 "$2"; else echo '（无输出）'; fi
    echo '```'
    echo
  } >> "${TAILS_FILE}"
}
run_step() {
  # $1 name, $2 evidence, rest: command
  local name="$1" evidence="$2"
  shift 2
  local log="${LOG_DIR}/${name}.log"
  echo ""
  echo "── [${name}] $* ─────────────────────────────────────────────"
  "$@" >"${log}" 2>&1
  local status=$?
  if [ "${status}" -eq 0 ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    record_row "${name}" "PASS" "${evidence}" "exit 0"
    append_tail "${name}" "${log}" "PASS"
    echo "→ PASS"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    record_row "${name}" "**FAIL**" "${evidence}" "exit ${status}（见 docs/acceptance-logs/${STAMP}/${name}.log）"
    append_tail "${name}" "${log}" "FAIL exit ${status}"
    echo "→ FAIL（exit ${status}）"
  fi
  tail -n 4 "${log}" 2>/dev/null || true
}
skip_step() {
  # $1 name, $2 evidence, $3 reason
  SKIP_COUNT=$((SKIP_COUNT + 1))
  record_row "$1" "SKIP" "$2" "$3"
  {
    echo "### $1（SKIP）"
    echo '```'
    echo "$3"
    echo '```'
    echo
  } >> "${TAILS_FILE}"
  echo ""
  echo "── [$1] SKIP：$3"
}
server_up() {
  local code
  code="$(curl -sS -m 6 -o /dev/null -w '%{http_code}' "${BASE_URL}/" 2>/dev/null || echo '000')"
  [ "${code}" = "200" ]
}
playwright_ready() {
  [ -e "${PLAYWRIGHT_MODULE}" ] && [ -d "${PLAYWRIGHT_BROWSERS_PATH}" ]
}

# ── 环境/时段判定（北京时间，Asia/Shanghai） ──────────────────────────────
IFS='|' read -r NOW_TEXT PHASE IS_TRADING IS_PREOPEN <<<"$(python3 - <<'PY'
import datetime, json
from zoneinfo import ZoneInfo
now = datetime.datetime.now(ZoneInfo('Asia/Shanghai'))
minutes = now.hour * 60 + now.minute + now.second / 60
weekday = now.weekday()  # 0=Mon
if weekday >= 5:
    phase = 'non-trading'
elif minutes < 9 * 60 + 15:
    phase = 'preopen'
elif minutes < 9 * 60 + 25:
    phase = 'auction'
elif minutes < 9 * 60 + 30:
    phase = 'preopen-wait'
elif minutes < 11 * 60 + 30:
    phase = 'trading'
elif minutes < 13 * 60:
    phase = 'lunch'
elif minutes < 15 * 60:
    phase = 'trading'
else:
    phase = 'closed'
trading = weekday < 5 and ((9 * 60 + 15 <= minutes < 11 * 60 + 30) or (13 * 60 <= minutes < 15 * 60))
preopen_ok = weekday < 5 and minutes < 9 * 60 + 15
print('|'.join([now.strftime('%Y-%m-%d %H:%M:%S'), phase, str(int(trading)), str(int(preopen_ok))]))
PY
)"

COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
COMMIT_SUBJECT="$(git log -1 --pretty=%s 2>/dev/null || echo '')"
NODE_VERSION="$(node --version 2>/dev/null || echo '未安装')"
DIRTY_COUNT="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
APP_DIRTY="$(git status --porcelain 2>/dev/null | grep -c '^.. src/' || true)"
SNAPSHOT_STATE="缺失"
[ -f "${ROOT}/public/data/latest.json" ] && SNAPSHOT_STATE="存在（$(wc -c < "${ROOT}/public/data/latest.json" | tr -d ' ') bytes）"

echo "══════════════════════════════════════════════════════════"
echo "发布候选一键验收"
echo "  仓库：${ROOT}"
echo "  时间：${NOW_TEXT}（Asia/Shanghai，相位=${PHASE}）"
echo "  commit：${COMMIT} ${COMMIT_SUBJECT}"
echo "  Node：${NODE_VERSION}｜dev server：$(server_up && echo 可达 || echo 不可达)｜快照：${SNAPSHOT_STATE}"
echo "  日志：${LOG_DIR}"
echo "══════════════════════════════════════════════════════════"

# ── a) verify.sh（build + lint + node tests） ──────────────────────────────
run_step "verify.sh" "scripts/verify.sh（build/lint/node tests；日志 docs/acceptance-logs/${STAMP}/verify.sh.log）" \
  bash scripts/verify.sh

# ── b) 基线不变量 ─────────────────────────────────────────────────────────
run_step "check_baseline" "tests/acceptance/check_baseline.mjs" \
  node tests/acceptance/check_baseline.mjs

# ── c) Python 回归 ────────────────────────────────────────────────────────
run_step "python-unittest" "tests/（python3 -m unittest discover -s tests）" \
  python3 -m unittest discover -s tests

# ── d) 浏览器 E2E：添加非公开股票 → 腾讯日线回退（任何时段） ─────────────
if ! server_up; then
  skip_step "personal-stock-e2e" "docs/personal-stock-e2e.md" "dev server 不可达（${BASE_URL}）"
elif ! playwright_ready; then
  skip_step "personal-stock-e2e" "docs/personal-stock-e2e.md" "Playwright 环境缺失（${PLAYWRIGHT_MODULE} / ${PLAYWRIGHT_BROWSERS_PATH}）"
else
  run_step "personal-stock-e2e" "docs/personal-stock-e2e.md、docs/screenshots/personal-stock-*.png" \
    node scripts/personal-stock-e2e.mjs
fi

# ── e) 真实时钟盘前检查（仅盘前 09:15 前） ────────────────────────────────
if [ "${IS_PREOPEN}" != "1" ]; then
  skip_step "preopen-check" "docs/preopen-check.md" "非盘前（当前相位=${PHASE}；preopen-check 仅在交易日 09:15 前运行）"
elif ! server_up; then
  skip_step "preopen-check" "docs/preopen-check.md" "dev server 不可达（${BASE_URL}）"
elif ! playwright_ready; then
  skip_step "preopen-check" "docs/preopen-check.md" "Playwright 环境缺失"
else
  run_step "preopen-check" "docs/preopen-check.md、docs/screenshots/preopen-*.png" \
    node scripts/preopen-check.mjs
fi

# ── f) 交易时段实弹（仅交易窗口；exit 3=PENDING 不算失败） ───────────────
if [ "${IS_TRADING}" != "1" ]; then
  skip_step "market-window" "docs/market-window-report.md" "非交易时段（当前相位=${PHASE}；仅在 09:15–11:30 / 13:00–15:00 运行）"
elif ! server_up; then
  skip_step "market-window" "docs/market-window-report.md" "dev server 不可达（${BASE_URL}）"
elif ! playwright_ready; then
  skip_step "market-window" "docs/market-window-report.md" "Playwright 环境缺失"
else
  echo ""
  echo "── [market-window] node scripts/market-window-check.mjs ───────────────"
  MARKET_LOG="${LOG_DIR}/market-window.log"
  node scripts/market-window-check.mjs >"${MARKET_LOG}" 2>&1
  MARKET_EXIT=$?
  case "${MARKET_EXIT}" in
    0)
      PASS_COUNT=$((PASS_COUNT + 1))
      record_row "market-window" "PASS" "docs/market-window-report.md" "exit 0"
      append_tail "market-window" "${MARKET_LOG}" "PASS"
      echo "→ PASS"
      ;;
    3)
      PENDING_COUNT=$((PENDING_COUNT + 1))
      record_row "market-window" "PENDING（待盘中）" "docs/market-window-report.md" "exit 3：硬断言+告警链路通过，窗口内未自然触发提醒（按约定不判失败）"
      append_tail "market-window" "${MARKET_LOG}" "PENDING（待盘中）"
      echo "→ PENDING（待盘中，不算失败）"
      ;;
    2)
      skip_step "market-window" "docs/market-window-report.md" "脚本判定非交易时段（exit 2）"
      ;;
    *)
      FAIL_COUNT=$((FAIL_COUNT + 1))
      record_row "market-window" "**FAIL**" "docs/market-window-report.md" "exit ${MARKET_EXIT}（见 docs/acceptance-logs/${STAMP}/market-window.log）"
      append_tail "market-window" "${MARKET_LOG}" "FAIL exit ${MARKET_EXIT}"
      echo "→ FAIL（exit ${MARKET_EXIT}）"
      ;;
  esac
  tail -n 5 "${MARKET_LOG}" 2>/dev/null || true
fi

# ── 汇总 ──────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════ 汇总 ══════════════════════"
echo "  PASS=${PASS_COUNT}  FAIL=${FAIL_COUNT}  SKIP=${SKIP_COUNT}  PENDING=${PENDING_COUNT}"
echo "  日志：${LOG_DIR}"
if [ "${FAIL_COUNT}" -gt 0 ]; then
  echo "  结果：FAIL（${FAIL_COUNT} 项失败）"
else
  echo "  结果：PASS（允许的 PENDING/SKIP 已单列）"
fi

# ── 生成 docs/rc-status.md ────────────────────────────────────────────────
RC_DOC="${ROOT}/docs/rc-status.md"
if [ "${FAIL_COUNT}" -gt 0 ]; then
  RC_CONCLUSION="**不通过（有 FAIL）**：不可作为发布候选；请修复后重跑 \`bash scripts/acceptance-all.sh\`。"
else
  RC_CONCLUSION="**自动化通过（发布候选 RC）**：可作为发布候选交用户做收盘后/真机走查。真实盘中实弹、移动端真机、生产 Service Worker 仍待人工，见「已知未验证项」。"
fi
MARKET_LINE="本次 market-window:"
if [ "${IS_TRADING}" = "1" ]; then
  if [ "${PENDING_COUNT}" -gt 0 ]; then MARKET_LINE="${MARKET_LINE} PENDING（待盘中）"; else MARKET_LINE="${MARKET_LINE} 已运行"; fi
else
  MARKET_LINE="${MARKET_LINE} SKIP（非交易时段，当前相位=${PHASE}）"
fi

{
  echo "# 发布候选（RC）状态"
  echo ""
  echo "- 版本：\`${COMMIT}\` — ${COMMIT_SUBJECT}"
  echo "- 生成时间：${NOW_TEXT}（Asia/Shanghai）；相位：${PHASE}"
  echo "- 环境：macOS，Node ${NODE_VERSION}，dev server ${BASE_URL}（$(server_up && echo 可达 || echo 不可达)），公开快照：${SNAPSHOT_STATE}"
  if [ "${APP_DIRTY}" = "0" ]; then
    echo "- 工作区：${DIRTY_COUNT} 个未提交文件（验收脚本/文档/日志；**src/ 应用代码零改动**）"
  else
    echo "- 工作区：${DIRTY_COUNT} 个未提交文件，其中 src/ 有 ${APP_DIRTY} 个改动（⚠️ 发布前需确认）"
  fi
  echo "- 一键复跑：\`bash scripts/acceptance-all.sh\`（退出码 0=无 FAIL；1=有 FAIL）"
  echo "- 本次日志：\`docs/acceptance-logs/${STAMP}/\`（已 gitignore）"
  echo "- ${MARKET_LINE}"
  echo ""
  echo "## 本次结果"
  echo ""
  echo "| 检查 | 结果 | 证据 | 说明 |"
  echo "| --- | --- | --- | --- |"
  cat "${ROWS_FILE}"
  echo ""
  echo "汇总：PASS=${PASS_COUNT}，FAIL=${FAIL_COUNT}，SKIP=${SKIP_COUNT}，PENDING=${PENDING_COUNT}。"
  echo ""
  echo "## 真实输出（每步 tail；完整日志见 \`docs/acceptance-logs/${STAMP}/\`）"
  echo ""
  cat "${TAILS_FILE}"
  echo ""
  echo "## 证据索引"
  echo ""
  echo "- 基线与验收清单：\`docs/baseline.md\`、\`docs/acceptance.md\`"
  echo "- 复验报告：\`docs/acceptance-report-round2.md\`、\`docs/acceptance-report-round3.md\`"
  echo "- 可视化/移动端：\`docs/visual-check.md\`、\`docs/screenshots/*.png\`（本地，gitignored）"
  echo "- 核心路径 E2E：\`docs/personal-stock-e2e.md\`"
  echo "- 盘前态：\`docs/preopen-check.md\`"
  echo "- 交易窗口实弹：\`docs/market-window.md\`、\`docs/market-window-report.md\`"
  echo ""
  echo "## 已知风险"
  echo ""
  echo "1. **数据源复权口径混用**：东财/腾讯日线为**前复权**；新浪日线回退（2026-11-24 因腾讯 fqkline 501 WAF 新增的第四级）为**不复权**（\`Quote.adjustment\` 已标注 \`不复权（tushare 未验证）\`）。个人清单若混源，同一页面不同股票的均线/ATR/RSI 口径可能不一致，策略价位不可跨数据源直接比较；重要决策前请核对数据来源，生产优先东财/腾讯前复权。"
  echo "2. **数据可用性依赖多级回退**：本机东财 push2 反爬、腾讯 fqkline 返回 501 WAF，个股日线目前依赖新浪 JSONP；若新浪也不可用，该股日线会失败并走手动行情，不会伪造数据。"
  echo "3. **盘中数据与提醒**：本次非交易时段跑，market-window SKIP；盘中价格更新/告警链路/通知声音尚未在交易时段实弹验证。"
  echo "4. **移动端真机 / 生产部署**：iOS Safari 安全区/触控/通知、生产 Service Worker/Pages 缓存（data/latest.json）仍未验证。"
  echo ""
  echo "## 已知未验证项（人工/盘中/部署）"
  echo ""
  echo "1. **真实盘中实弹**：盘中价格更新、告警链路、通知/声音，需交易时段跑 \`node scripts/market-window-check.mjs\`（09:35 计划）；本次 $([ "${IS_TRADING}" = "1" ] && echo '已尝试' || echo '因非交易时段 SKIP')。"
  echo "2. **移动端真机**：iOS Safari 安全区/触控/通知权限；headless 视口截图见 \`docs/visual-check.md\`（E5 PASS*，遗留 P2 触控/FAB 已由后续提交修复，仍建议真机确认）。"
  echo "3. **生产 Service Worker / GitHub Pages**：\`data/latest.json\` 缓存、旧快照回退提示、通知权限；本地 dev server 不注册 SW，需部署后验证（P1-8）。"
  echo "4. **集合竞价 09:15–09:25**：腾讯时间戳行为未经实测（P1-3）。"
  echo "5. **生产网络下东财主链路**：本机东财 push2 被反爬，日线已验证腾讯回退；东财可用网络下的主链路未在本机覆盖。"
  echo "6. **服务端功能**：\`server/app.py\` 的语音/DeepSeek 研究接口、AI 简报未纳入本机验收。"
  echo ""
  echo "## 发布候选结论"
  echo ""
  echo "${RC_CONCLUSION}"
  echo ""
  echo "> 本文件由 \`scripts/acceptance-all.sh\` 每次运行自动覆盖；人工结论与遗留项请以对应子报告为准。"
} > "${RC_DOC}"

echo "  RC 状态：${RC_DOC}"

if [ "${FAIL_COUNT}" -gt 0 ]; then
  exit 1
fi
exit 0
