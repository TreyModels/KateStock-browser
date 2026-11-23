#!/usr/bin/env bash
#
# KateStock 一键验证门禁（qa-verifier）
#
# 用法（相对/绝对路径均可，脚本会自行切到仓库根目录）：
#   bash scripts/verify.sh
#   cd /tmp && bash "/path/to/kate-dashboard/scripts/verify.sh"
#
# 依次运行：
#   1) npm run build                          （tsc -b && vite build）
#   2) npm run lint                           （eslint .）
#   3) node --experimental-strip-types --test tests/*.test.mjs
#
# 说明：
#   - 三步都会执行（不会因前一步失败而跳过后面），便于一次拿到完整结果；
#   - 任一失败（或命令不存在）最终 exit 1；全部通过 exit 0；
#   - 环境问题（不在仓库根、node/npm 缺失、node_modules 符号链接缺失）exit 2；
#   - 不执行 npm install；不修改除 dist/ 与构建缓存以外的工作区文件；
#   - 输出同时 tee 到 ${TMPDIR:-/tmp}/katestock-verify-<时间戳>.log。

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

export PATH="/opt/homebrew/bin:$PATH"

LOG_FILE="${TMPDIR:-/tmp}/katestock-verify-$(date +%Y%m%d-%H%M%S).log"
RESULTS=()
FAILURES=0

log() { printf '%s\n' "$*" | tee -a "$LOG_FILE"; }

fail_env() {
  log "✗ 环境错误：$*"
  log "  仓库根：$ROOT_DIR"
  log "  依赖说明：node_modules 应为符号链接，禁止 npm install；请让 Lead 恢复依赖后再跑。"
  exit 2
}

run_step() {
  local name="$1"
  shift
  log ""
  log "────────────────────────────────────────────────────────────"
  log "==> ${name}"
  log "    \$ $*"
  log "────────────────────────────────────────────────────────────"
  if "$@" 2>&1 | tee -a "$LOG_FILE"; then
    RESULTS+=("PASS  ${name}")
    log "--> PASS: ${name}"
  else
    RESULTS+=("FAIL  ${name}")
    FAILURES=$((FAILURES + 1))
    log "--> FAIL: ${name}"
  fi
}

# ---------- 预检（不计入三步门禁） ----------
[ -f "$ROOT_DIR/package.json" ] || fail_env "找不到 $ROOT_DIR/package.json"
[ -f "$ROOT_DIR/src/App.tsx" ] || fail_env "仓库结构异常：缺少 src/App.tsx"
cd "$ROOT_DIR" || fail_env "无法进入仓库根目录 $ROOT_DIR"
command -v node >/dev/null 2>&1 || fail_env "找不到 node（已尝试 PATH=/opt/homebrew/bin:$PATH）"
command -v npm >/dev/null 2>&1 || fail_env "找不到 npm（已尝试 PATH=/opt/homebrew/bin:$PATH）"
[ -e "$ROOT_DIR/node_modules" ] || fail_env "node_modules 不存在（符号链接可能被破坏）"

log "KateStock verify gate"
log "  时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
log "  仓库：$ROOT_DIR"
log "  node：$(node --version)  npm：$(npm --version)"
log "  日志：$LOG_FILE"

# ---------- 三步门禁 ----------
run_step "build" npm run build
run_step "lint" npm run lint

# 至少要有测试文件；否则 --test 在无匹配时可能静默通过，门禁形同虚设。
shopt -s nullglob
TEST_FILES=(tests/*.test.mjs)
shopt -u nullglob
if [ "${#TEST_FILES[@]}" -eq 0 ]; then
  RESULTS+=("FAIL  node tests（找不到 tests/*.test.mjs）")
  FAILURES=$((FAILURES + 1))
  log ""
  log "--> FAIL: node tests（找不到 tests/*.test.mjs，门禁不可静默通过）"
else
  run_step "node tests" node --experimental-strip-types --test "${TEST_FILES[@]}"
fi

# ---------- 汇总 ----------
log ""
log "════════════════════════ 汇总 ════════════════════════"
for line in "${RESULTS[@]}"; do log "  $line"; done
log "  日志：$LOG_FILE"
log "══════════════════════════════════════════════════════"

if [ "$FAILURES" -gt 0 ]; then
  log "结果：FAIL（$FAILURES 步失败）"
  exit 1
fi

log "结果：PASS（build + lint + node tests 全部通过）"
exit 0
