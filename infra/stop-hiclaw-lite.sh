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

# ─── 1. 按 PID 文件停止 ───────────────────────────────────────────────
log_info "按 PID 文件停止 OpenClaw 进程..."

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
  log_warn "PID 文件中没有运行中的 OpenClaw 进程"
fi

# ─── 2. 兜底：按名称查找停止 ──────────────────────────────────────────
echo ""
log_info "兜底查找残留 OpenClaw 进程..."

# 尝试多种方式查找并停止 openclaw 进程
found_any=false

# 方式 A: pkill (Linux/macOS/WSL)
if command -v pkill &>/dev/null; then
  openclaw_pids=$(pgrep -f "openclaw.*gateway" 2>/dev/null || true)
  if [ -n "$openclaw_pids" ]; then
    for p in $openclaw_pids; do
      log_warn "发现残留 openclaw 进程 PID $p，正在停止..."
      kill -9 "$p" 2>/dev/null || true
      found_any=true
    done
  fi
fi

# 方式 B: taskkill (Windows)
if [ "$found_any" = false ] && command -v taskkill &>/dev/null; then
  # 先尝试按窗口标题查找（如果进程有控制台窗口）
  taskkill /F /FI "WINDOWTITLE eq openclaw*" 2>/dev/null || true
  # 再尝试按命令行参数查找 node.exe 运行的 openclaw
  # 注意：这会杀死所有 node.exe 运行的 openclaw，包括可能的其他实例
  wmic process where "CommandLine like '%openclaw%gateway%'" get ProcessId 2>/dev/null | tail -n +2 | while read -r pid; do
    pid=$(echo "$pid" | tr -d '[:space:]')
    if [ -n "$pid" ] && [ "$pid" != "ProcessId" ]; then
      log_warn "发现残留 openclaw 进程 PID $pid，正在停止..."
      taskkill /F /PID "$pid" 2>/dev/null || true
      found_any=true
    fi
  done
fi

# 方式 C: 按端口查找并停止（Windows netstat）
if command -v netstat &>/dev/null; then
  for port in 18799 18800; do
    pid=$(netstat -ano 2>/dev/null | grep ":$port " | grep LISTENING | awk '{print $5}' | head -1)
    if [ -n "$pid" ]; then
      log_warn "发现端口 $port 被 PID $pid 占用，正在停止..."
      if command -v taskkill &>/dev/null; then
        taskkill /F /PID "$pid" 2>/dev/null || true
      else
        kill -9 "$pid" 2>/dev/null || true
      fi
      found_any=true
    fi
  done
fi

if [ "$found_any" = false ]; then
  log_ok "没有残留的 OpenClaw 进程"
fi

# 清理 PID 目录
rm -rf "$PID_DIR"

# ─── 3. 停止 Docker（如果传了 --all）───────────────────────────────────
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
