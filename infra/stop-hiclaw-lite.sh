#!/bin/bash
# ─── AgentHub HiClaw-lite 停止脚本 ────────────────────────────────────
# 停止 OpenClaw Manager + Worker，可选停止 Docker
#
# 用法: bash infra/stop-hiclaw-lite.sh [--all]
#   --all   同时停止 Docker 容器（Tuwunel + MinIO）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PID_DIR="$PROJECT_ROOT/.pids"
STOP_ALL="${1:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}   $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo "=== AgentHub HiClaw-lite 停止 ==="
echo ""

# 停止 OpenClaw 进程
log_info "停止 OpenClaw 进程..."

stopped=0
for pidfile in "$PID_DIR"/openclaw-*.pid; do
  [ -f "$pidfile" ] || continue
  name=$(basename "$pidfile" .pid)
  pid=$(cat "$pidfile" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log_info "停止 $name (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    log_ok "$name 已停止"
    stopped=$((stopped + 1))
  else
    log_warn "$name 不在运行"
  fi
  rm -f "$pidfile"
done

if [ "$stopped" -eq 0 ]; then
  log_warn "没有找到运行中的 OpenClaw 进程"
fi

# 停止 Docker（如果传了 --all）
if [ "$STOP_ALL" = "--all" ]; then
  echo ""
  log_info "停止 Docker 容器..."
  cd "$SCRIPT_DIR"
  if docker compose version &>/dev/null; then
    docker compose -f docker-compose.hiclaw-lite.yml down
  elif docker-compose version &>/dev/null; then
    docker-compose -f docker-compose.hiclaw-lite.yml down
  else
    log_error "docker compose 未安装"
  fi
  log_ok "Docker 容器已停止"
fi

echo ""
log_ok "AgentHub HiClaw-lite 已停止"
echo ""
