#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

AGENTHUB_DATA="${AGENTHUB_APP_DATA_DIR:-$HOME/.local/share}/AgentHub"
PID_DIR="$PROJECT_ROOT/.pids"
REG_TOKEN="${AGENTHUB_REGISTRATION_TOKEN:-agenthub-dev-registration-token}"

TUWUNEL_URL="http://localhost:6167"
MATRIX_DOMAIN="agenthub.local"
MANAGER_USER="manager"
MANAGER_PASS="manager-dev-password-2026"
WORKER_USER="worker"
WORKER_PASS="worker-dev-password-2026"
ADMIN_USER="admin"
ADMIN_PASS="admin-dev-password-2026"
MANAGER_PORT=18799
WORKER_PORT=18800

MANAGER_WORKSPACE="$AGENTHUB_DATA/manager/global"
WORKER_WORKSPACE="$AGENTHUB_DATA/workers/openclaw-worker-1"
MANAGER_CONFIG="$MANAGER_WORKSPACE/openclaw.json"
WORKER_CONFIG="$WORKER_WORKSPACE/openclaw.json"
MANAGER_TEMPLATE="$SCRIPT_DIR/manager-openclaw.json"
WORKER_TEMPLATE="$SCRIPT_DIR/worker-openclaw.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[信息]${NC}  $1"; }
log_ok() { echo -e "${GREEN}[完成]${NC}  $1"; }
log_warn() { echo -e "${YELLOW}[警告]${NC}  $1"; }
log_error() { echo -e "${RED}[错误]${NC}  $1"; }

to_win_path() {
  local path="$1"
  if command -v wslpath >/dev/null 2>&1; then
    wslpath -w "$path"
  elif command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$path"
  else
    printf '%s' "$path"
  fi
}

node_is_22_plus() {
  local major
  major="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 22 ]
}

detect_openclaw() {
  local node_bin node_path shim shim_dir mjs

  if command -v node.exe >/dev/null 2>&1; then
    node_bin="$(command -v node.exe)"
    if [ -f "$PROJECT_ROOT/.openclaw-runtime/openclaw.mjs" ]; then
      node_path="$(to_win_path "$PROJECT_ROOT/.openclaw-runtime/openclaw.mjs")"
      OPENCLAW_CMD=("$node_bin" "$node_path")
      OPENCLAW_LABEL="$node_bin $node_path"
      OPENCLAW_KIND="windows"
      return 0
    fi
    if command -v openclaw >/dev/null 2>&1; then
      shim="$(command -v openclaw)"
      shim_dir="$(cd "$(dirname "$shim")" && pwd)"
      mjs="$shim_dir/node_modules/openclaw/openclaw.mjs"
      if [ -f "$mjs" ]; then
        node_path="$(to_win_path "$mjs")"
        OPENCLAW_CMD=("$node_bin" "$node_path")
        OPENCLAW_LABEL="$node_bin $node_path"
        OPENCLAW_KIND="windows"
        return 0
      fi
    fi
  fi

  if command -v node >/dev/null 2>&1 && node_is_22_plus; then
    node_bin="$(command -v node)"
    if [ -f "$PROJECT_ROOT/.openclaw-runtime/openclaw.mjs" ]; then
      OPENCLAW_CMD=("$node_bin" "$PROJECT_ROOT/.openclaw-runtime/openclaw.mjs")
      OPENCLAW_LABEL="$node_bin $PROJECT_ROOT/.openclaw-runtime/openclaw.mjs"
      OPENCLAW_KIND="native"
      return 0
    fi
    if command -v openclaw >/dev/null 2>&1; then
      shim="$(command -v openclaw)"
      shim_dir="$(cd "$(dirname "$shim")" && pwd)"
      mjs="$shim_dir/node_modules/openclaw/openclaw.mjs"
      if [ -f "$mjs" ]; then
        OPENCLAW_CMD=("$node_bin" "$mjs")
        OPENCLAW_LABEL="$node_bin $mjs"
        OPENCLAW_KIND="native"
        return 0
      fi
    fi
  fi

  return 1
}

update_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  python3 - "$file" "$key" "$value" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]

lines = path.read_text(encoding='utf-8').splitlines() if path.exists() else []
out = []
updated = False

for line in lines:
    if line.startswith(f'{key}='):
        out.append(f'{key}={value}')
        updated = True
    else:
        out.append(line)

if not updated:
    out.append(f'{key}={value}')

path.write_text('\n'.join(out) + '\n', encoding='utf-8')
PY
}

generate_openclaw_config() {
  local template="$1"
  local output="$2"
  local token="$3"
  local port="$4"
  local llm_url="$5"
  local llm_key="$6"
  local llm_model="$7"
  local workspace="$8"

  python3 - "$template" "$output" "$token" "$port" "$llm_url" "$llm_key" "$llm_model" "$workspace" <<'PY'
from pathlib import Path
import json
import os
import sys

template_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
token = sys.argv[3]
port = int(sys.argv[4])
llm_url = sys.argv[5]
llm_key = sys.argv[6]
llm_model = sys.argv[7]
workspace = sys.argv[8]

config = json.loads(template_path.read_text(encoding='utf-8'))
config['gateway']['port'] = port
config['channels']['matrix']['accessToken'] = token
provider = config['models']['providers']['agenthub-llm']
provider['baseUrl'] = llm_url
provider['apiKey'] = llm_key
provider['models'][0]['id'] = llm_model
provider['models'][0]['name'] = llm_model
config['agents']['defaults']['model']['primary'] = f'agenthub-llm/{llm_model}'
if workspace:
    config['agents']['defaults']['workspace'] = workspace
for group in config.get('channels', {}).get('matrix', {}).get('groups', {}).values():
    group.pop('allow', None)

output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(output_path)
PY
}

copy_agent_files() {
  local source_dir="$1"
  local target_dir="$2"
  local file
  local copied=0

  mkdir -p "$target_dir/skills"

  for file in SOUL.md AGENTS.md HEARTBEAT.md TOOLS.md; do
    if [ -f "$source_dir/$file" ] && [ ! -f "$target_dir/$file" ]; then
      cp "$source_dir/$file" "$target_dir/$file"
      copied=1
    fi
  done

  if [ -d "$source_dir/skills" ]; then
    if compgen -G "$source_dir/skills/*" >/dev/null; then
      cp -rn "$source_dir/skills/"* "$target_dir/skills/" 2>/dev/null || true
      copied=1
    fi
  fi

  if [ "$copied" -eq 1 ]; then
    log_ok "$(basename "$target_dir") Agent 文件已就绪"
  else
    log_info "$(basename "$target_dir") Agent 文件已是最新"
  fi
}

wait_for_tuwunel() {
  local i code
  for i in $(seq 1 40); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$TUWUNEL_URL/_matrix/client/versions" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then
      log_ok "Tuwunel 已就绪 ($TUWUNEL_URL)"
      return 0
    fi
    if [ "$i" -eq 40 ]; then
      log_error "Tuwunel 启动超时。检查命令：docker logs agenthub-tuwunel"
      return 1
    fi
    echo -n "."
    sleep 0.5
  done
}

reuse_or_login() {
  local user="$1"
  local pass="$2"
  local login_resp token

  login_resp="$(curl -s -X POST "$TUWUNEL_URL/_matrix/client/v3/login" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$user\"},\"password\":\"$pass\"}" 2>/dev/null || true)"
  token="$(printf '%s' "$login_resp" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4 || true)"
  if [ -n "$token" ]; then
    printf '%s\n' "$token"
    return 0
  fi

  register_or_login "$user" "$pass"
}

register_or_login() {
  local user="$1"
  local pass="$2"
  local user_id="@$user:$MATRIX_DOMAIN"
  local reg_resp login_resp token

  reg_resp="$(curl -s -X POST "$TUWUNEL_URL/_matrix/client/v3/register" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$user\",\"password\":\"$pass\",\"auth\":{\"type\":\"m.login.registration_token\",\"token\":\"$REG_TOKEN\"}}" 2>/dev/null || true)"
  token="$(printf '%s' "$reg_resp" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4 || true)"
  if [ -n "$token" ]; then
    printf '%s\n' "$token"
    return 0
  fi

  login_resp="$(curl -s -X POST "$TUWUNEL_URL/_matrix/client/v3/login" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$user\"},\"password\":\"$pass\"}" 2>/dev/null || true)"
  token="$(printf '%s' "$login_resp" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4 || true)"
  if [ -n "$token" ]; then
    printf '%s\n' "$token"
    return 0
  fi

  log_error "无法注册或登录 $user_id"
  log_error "注册响应：$reg_resp"
  log_error "登录响应：$login_resp"
  return 1
}

start_openclaw() {
  local name="$1"
  local shell_home="$2"
  local runtime_home="$3"
  local runtime_config="$4"
  local pidfile="$5"
  local logfile="$6"

  (
    export OPENCLAW_CONFIG_PATH="$runtime_config"
    export OPENCLAW_NO_RESPAWN=1
    export HOME="$runtime_home"
    export USERPROFILE="$runtime_home"
    cd "$shell_home"
    exec "${OPENCLAW_CMD[@]}" gateway run --verbose --force > "$logfile" 2>&1
  ) &

  local pid=$!
  echo "$pid" > "$pidfile"
  log_ok "$name PID：$pid"
}

print_process_status() {
  local name="$1"
  local pidfile="$2"
  local logfile="$3"
  local pid

  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log_ok "$name 进程运行中 (pid=$pid)"
  else
    log_error "$name 进程未运行"
  fi
  echo "  PID 文件：$pidfile"
  echo "  日志文件：$logfile"
}

print_http_probe() {
  local label="$1"
  local url="$2"
  local output

  if output="$(curl -fsS --max-time 3 "$url" 2>&1)"; then
    log_ok "$label 探测通过：$url"
    printf '  %s\n' "$output" | head -n 4
  else
    log_warn "$label 探测失败：$url"
    [ -n "$output" ] && printf '  %s\n' "$output" | head -n 4
  fi
}

print_log_preview() {
  local label="$1"
  local logfile="$2"

  if [ -f "$logfile" ]; then
    echo ""
    log_info "$label 日志预览：$logfile"
    tail -n 8 "$logfile" | sed 's/^/  /'
  else
    log_warn "$label 日志尚未生成：$logfile"
  fi
}

echo "=== AgentHub HiClaw-lite 启动 ==="
echo ""
log_info "[0/6] 检查前置条件..."

mkdir -p "$PID_DIR" "$MANAGER_WORKSPACE" "$WORKER_WORKSPACE"

if ! command -v docker >/dev/null 2>&1; then
  log_error "未安装 Docker。请先安装 Docker Desktop。"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1 && ! docker-compose version >/dev/null 2>&1; then
  log_error "docker compose 不可用。"
  exit 1
fi

COMPOSE_CMD="docker compose"
if ! docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
fi

if ! detect_openclaw; then
  log_error "未找到 OpenClaw。请运行：npm install -g openclaw"
  exit 1
fi

MANAGER_RUNTIME_HOME="$MANAGER_WORKSPACE"
WORKER_RUNTIME_HOME="$WORKER_WORKSPACE"
MANAGER_RUNTIME_CONFIG="$MANAGER_CONFIG"
WORKER_RUNTIME_CONFIG="$WORKER_CONFIG"
if [ "$OPENCLAW_KIND" = "windows" ]; then
  MANAGER_RUNTIME_HOME="$(to_win_path "$MANAGER_WORKSPACE")"
  WORKER_RUNTIME_HOME="$(to_win_path "$WORKER_WORKSPACE")"
  MANAGER_RUNTIME_CONFIG="$(to_win_path "$MANAGER_CONFIG")"
  WORKER_RUNTIME_CONFIG="$(to_win_path "$WORKER_CONFIG")"
fi

OPENCLAW_VERSION="$("${OPENCLAW_CMD[@]}" --version 2>/dev/null || echo 未知)"
log_ok "OpenClaw：$OPENCLAW_LABEL ($OPENCLAW_VERSION)"
log_ok "docker compose 命令：$COMPOSE_CMD"

echo ""
log_info "[1/6] 启动 Tuwunel + MinIO..."

cd "$SCRIPT_DIR"
$COMPOSE_CMD -f docker-compose.hiclaw-lite.yml up -d

log_ok "Docker 容器已启动"

echo ""
log_info "[2/6] 等待 Tuwunel 就绪（最多 20 秒）..."
wait_for_tuwunel

echo ""
log_info "[3/6] 准备 Matrix 账号..."

MANAGER_TOKEN="$(reuse_or_login "$MANAGER_USER" "$MANAGER_PASS")"
log_ok "Manager 账号：@$MANAGER_USER:$MATRIX_DOMAIN"

WORKER_TOKEN="$(reuse_or_login "$WORKER_USER" "$WORKER_PASS")"
log_ok "Worker 账号：@$WORKER_USER:$MATRIX_DOMAIN"

echo ""
log_info "[3.5/6] 准备管理员 Matrix 账号..."

ADMIN_TOKEN="$(reuse_or_login "$ADMIN_USER" "$ADMIN_PASS")"
log_ok "管理员账号：@$ADMIN_USER:$MATRIX_DOMAIN"

ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  update_env_var "$ENV_FILE" "AGENTHUB_MATRIX_HOMESERVER_URL" "$TUWUNEL_URL"
  update_env_var "$ENV_FILE" "AGENTHUB_MATRIX_SERVER_NAME" "$MATRIX_DOMAIN"
  update_env_var "$ENV_FILE" "AGENTHUB_MATRIX_REGISTRATION_TOKEN" "$REG_TOKEN"
  update_env_var "$ENV_FILE" "AGENTHUB_MATRIX_ACCESS_TOKEN" "$ADMIN_TOKEN"
  update_env_var "$ENV_FILE" "AGENTHUB_ROOM_PROVIDER" "matrix"
  log_ok "已更新 $ENV_FILE 的 Matrix 配置"
else
  log_warn "未找到 $ENV_FILE。请手动添加以下配置："
  echo "  AGENTHUB_MATRIX_HOMESERVER_URL=$TUWUNEL_URL"
  echo "  AGENTHUB_MATRIX_SERVER_NAME=$MATRIX_DOMAIN"
  echo "  AGENTHUB_MATRIX_REGISTRATION_TOKEN=$REG_TOKEN"
  echo "  AGENTHUB_MATRIX_ACCESS_TOKEN=$ADMIN_TOKEN"
  echo "  AGENTHUB_ROOM_PROVIDER=matrix"
fi

echo ""
log_info "[4/6] 生成 OpenClaw 配置..."

LLM_BASE_URL="${AGENTHUB_LLM_BASE_URL:-http://localhost:8000/v1}"
LLM_API_KEY="${AGENTHUB_LLM_API_KEY:-agenthub-internal}"
LLM_MODEL="${AGENTHUB_LLM_MODEL:-default}"

if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      AGENTHUB_LLM_BASE_URL) LLM_BASE_URL="$value" ;;
      AGENTHUB_LLM_API_KEY) LLM_API_KEY="$value" ;;
      AGENTHUB_LLM_MODEL) LLM_MODEL="$value" ;;
    esac
  done < <(grep -E '^(AGENTHUB_LLM_BASE_URL|AGENTHUB_LLM_API_KEY|AGENTHUB_LLM_MODEL)=' "$ENV_FILE" 2>/dev/null || true)
fi

generate_openclaw_config "$MANAGER_TEMPLATE" "$MANAGER_CONFIG" "$MANAGER_TOKEN" "$MANAGER_PORT" "$LLM_BASE_URL" "$LLM_API_KEY" "$LLM_MODEL" "$MANAGER_RUNTIME_HOME"
generate_openclaw_config "$WORKER_TEMPLATE" "$WORKER_CONFIG" "$WORKER_TOKEN" "$WORKER_PORT" "$LLM_BASE_URL" "$LLM_API_KEY" "$LLM_MODEL" "$WORKER_RUNTIME_HOME"

log_ok "Manager 配置：$MANAGER_CONFIG（端口 $MANAGER_PORT）"
log_ok "Worker 配置：$WORKER_CONFIG（端口 $WORKER_PORT）"

echo ""
log_info "[5/6] 复制 Agent 文件..."
copy_agent_files "$SCRIPT_DIR/manager-agent" "$MANAGER_WORKSPACE"
copy_agent_files "$SCRIPT_DIR/worker-agent" "$WORKER_WORKSPACE"

echo ""
log_info "[6/6] 启动 OpenClaw Manager + Worker..."

for pidfile in "$PID_DIR"/openclaw-*.pid; do
  [ -f "$pidfile" ] || continue
  old_pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    log_warn "停止旧进程 PID $old_pid ($pidfile)"
    kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$pidfile"
done

start_openclaw "Manager" "$MANAGER_WORKSPACE" "$MANAGER_RUNTIME_HOME" "$MANAGER_RUNTIME_CONFIG" "$PID_DIR/openclaw-manager.pid" "$MANAGER_WORKSPACE/openclaw.log"
start_openclaw "Worker" "$WORKER_WORKSPACE" "$WORKER_RUNTIME_HOME" "$WORKER_RUNTIME_CONFIG" "$PID_DIR/openclaw-worker.pid" "$WORKER_WORKSPACE/openclaw.log"

sleep 1

if kill -0 "$(cat "$PID_DIR/openclaw-manager.pid")" 2>/dev/null; then
  log_ok "Manager 运行中"
else
  log_error "Manager 启动失败，请查看 $MANAGER_WORKSPACE/openclaw.log"
fi

if kill -0 "$(cat "$PID_DIR/openclaw-worker.pid")" 2>/dev/null; then
  log_ok "Worker 运行中"
else
  log_error "Worker 启动失败，请查看 $WORKER_WORKSPACE/openclaw.log"
fi

echo ""
echo "========================================"
echo "  AgentHub HiClaw-lite 启动完成"
echo "========================================"
echo ""
log_info "运行端点"
echo "  Matrix Homeserver：$TUWUNEL_URL ($MATRIX_DOMAIN)"
echo "  MinIO API：         http://localhost:9000"
echo "  MinIO 控制台：      http://localhost:9001 (minioadmin/minioadmin)"
echo "  Manager 网关：      http://localhost:$MANAGER_PORT"
echo "  Worker 网关：       http://localhost:$WORKER_PORT"
echo "  LLM 网关：          $LLM_BASE_URL"
echo "  LLM 模型：          $LLM_MODEL"
echo ""
log_info "Matrix 身份"
echo "  管理员： @$ADMIN_USER:$MATRIX_DOMAIN"
echo "  Manager： @$MANAGER_USER:$MATRIX_DOMAIN"
echo "  Worker：  @$WORKER_USER:$MATRIX_DOMAIN"
echo "  .env：    $ENV_FILE"
echo ""
log_info "OpenClaw 运行时"
echo "  命令：       $OPENCLAW_LABEL"
echo "  Manager 配置：$MANAGER_CONFIG"
echo "  Worker 配置： $WORKER_CONFIG"
print_process_status "Manager" "$PID_DIR/openclaw-manager.pid" "$MANAGER_WORKSPACE/openclaw.log"
print_process_status "Worker" "$PID_DIR/openclaw-worker.pid" "$WORKER_WORKSPACE/openclaw.log"
echo ""
log_info "容器状态"
(cd "$SCRIPT_DIR" && $COMPOSE_CMD -f docker-compose.hiclaw-lite.yml ps) || true
echo ""
log_info "健康探测"
print_http_probe "Tuwunel" "$TUWUNEL_URL/_matrix/client/versions"
print_http_probe "Manager 网关" "http://localhost:$MANAGER_PORT/health"
print_http_probe "Worker 网关" "http://localhost:$WORKER_PORT/health"
print_log_preview "Manager" "$MANAGER_WORKSPACE/openclaw.log"
print_log_preview "Worker" "$WORKER_WORKSPACE/openclaw.log"
echo ""
log_info "常用命令"
echo "  启动：             bash infra/start-hiclaw-lite.sh"
echo "  停止：             bash infra/stop-hiclaw-lite.sh"
echo "  Matrix 日志：      docker logs agenthub-tuwunel"
echo "  MinIO 日志：       docker logs agenthub-minio"
echo "  查看 Manager 日志：tail -n 80 \"$MANAGER_WORKSPACE/openclaw.log\""
echo "  查看 Worker 日志： tail -n 80 \"$WORKER_WORKSPACE/openclaw.log\""
echo ""
log_info "下一步"
echo "  1. 启动 AgentHub Server：bun run dev:server"
echo "  2. 启动 AgentHub Web：  bun run dev:web"
echo "  3. 打开浏览器，新建群聊，然后 @manager"
echo ""
