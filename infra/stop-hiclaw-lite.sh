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

# ─── Helper: Windows PowerShell kill ───────────────────────────────────
win_kill_pid() {
  local target_pid=$1
  local reason=$2
  if [ -z "$target_pid" ]; then return 1; fi
  # Git Bash 下 taskkill /F 会解析失败，用 PowerShell 兜底
  if command -v powershell.exe &>/dev/null; then
    powershell.exe -NoProfile -Command "Stop-Process -Id $target_pid -Force -ErrorAction SilentlyContinue" 2>/dev/null
    return 0
  elif command -v taskkill &>/dev/null; then
    # cmd //c 避免 Git Bash 把 /F 解析为路径
    cmd //c "taskkill /F /PID $target_pid" 2>/dev/null
    return 0
  fi
  return 1
}

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
    if ! kill -0 "$pid" 2>/dev/null; then
      log_ok "$name 已停止"
      stopped=$((stopped + 1))
    else
      log_warn "$name 仍在运行，尝试强制停止..."
      win_kill_pid "$pid" "$name"
    fi
  else
    log_warn "$name 不在运行"
  fi
  rm -f "$pidfile"
done

if [ "$stopped" -eq 0 ]; then
  log_warn "PID 文件中没有运行中的 OpenClaw 进程"
fi

# ─── 2. 兜底：按名称/端口查找停止 ────────────────────────────────────
echo ""
log_info "兜底查找残留 OpenClaw 进程..."

found_any=false

# 方式 A: pgrep 查找 (WSL/Linux/macOS)
# OpenClaw 在 Windows 上实际进程名是 node.exe，所以同时查命令行
if command -v pgrep &>/dev/null; then
  # 尝试多种模式匹配
  for pattern in "openclaw.*gateway" "node.*openclaw"; do
    openclaw_pids=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [ -n "$openclaw_pids" ]; then
      for p in $openclaw_pids; do
        # 避免重复 kill
        if kill -0 "$p" 2>/dev/null; then
          log_warn "发现残留 openclaw 进程 PID $p (pattern: $pattern)，正在停止..."
          kill -9 "$p" 2>/dev/null || win_kill_pid "$p" "pgrep-fallback"
          found_any=true
        fi
      done
    fi
  done
fi

# 方式 B: wmic 按命令行查找 (Windows native)
if command -v wmic &>/dev/null; then
  wmic_pids=$(wmic process where "CommandLine like '%openclaw%gateway%'" get ProcessId 2>/dev/null | tail -n +2 | tr -d '[:space:]' | tr '\r\n' ' ')
  for wpid in $wmic_pids; do
    if [ -n "$wpid" ] && [ "$wpid" != "ProcessId" ] && [ "$wpid" -gt 0 ] 2>/dev/null; then
      log_warn "发现残留 openclaw 进程 PID $wpid (wmic)，正在停止..."
      win_kill_pid "$wpid" "wmic-fallback"
      found_any=true
    fi
  done
fi

# 方式 C: 按端口查找并停止（通用，最可靠）
for port in 18799 18800; do
  pid=""
  if command -v netstat &>/dev/null; then
    pid=$(netstat -ano 2>/dev/null | grep ":$port " | grep LISTENING | awk '{print $5}' | head -1)
  elif command -v ss &>/dev/null; then
    pid=$(ss -tlnp 2>/dev/null | grep ":$port " | sed 's/.*pid=//;s/,.*//' | head -1)
  fi
  if [ -n "$pid" ]; then
    log_warn "发现端口 $port 被 PID $pid 占用，正在停止..."
    kill -9 "$pid" 2>/dev/null || win_kill_pid "$pid" "port-$port"
    found_any=true
  fi
done

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
