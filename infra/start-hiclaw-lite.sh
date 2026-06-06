#!/bin/bash
# ─── AgentHub HiClaw-lite 一键启动脚本 ──────────────────────────────────
# 启动 Tuwunel + MinIO，注册 Matrix 账号，启动 OpenClaw Manager + Worker
#
# 用法: bash infra/start-hiclaw-lite.sh
# 环境: Windows Git Bash / macOS / Linux
# 前置: Docker, openclaw (npm install -g openclaw)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# ─── 配置 ──────────────────────────────────────────────────────────────
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
MANAGER_CONFIG="$SCRIPT_DIR/manager-openclaw.json"
WORKER_CONFIG="$SCRIPT_DIR/worker-openclaw.json"
PID_DIR="$PROJECT_ROOT/.pids"
REG_TOKEN="${AGENTHUB_REGISTRATION_TOKEN:-agenthub-dev-registration-token}"

mkdir -p "$PID_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}   $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

find_node_bin() {
  local candidate version major
  for candidate in node.exe node; do
    if command -v "$candidate" &>/dev/null; then
      version="$("$candidate" -v 2>/dev/null | sed 's/^v//')"
      major="${version%%.*}"
      if [ -n "$major" ] && [ "$major" -ge 22 ] 2>/dev/null; then
        echo "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

to_windows_path() {
  if command -v wslpath &>/dev/null; then
    wslpath -w "$1"
  else
    echo "$1"
  fi
}

find_openclaw_entry() {
  local candidate wrapper_dir
  if [ -f "$PROJECT_ROOT/.openclaw-runtime/openclaw.mjs" ]; then
    echo "$PROJECT_ROOT/.openclaw-runtime/openclaw.mjs"
    return 0
  fi
  if command -v openclaw &>/dev/null; then
    wrapper_dir="$(cd "$(dirname "$(command -v openclaw)")" && pwd)"
    candidate="$wrapper_dir/node_modules/openclaw/openclaw.mjs"
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  fi
  return 1
}

# ─── Step 0: 检查依赖 ──────────────────────────────────────────────────
echo ""
echo "=== AgentHub HiClaw-lite 启动 ==="
echo ""

log_info "[0/6] 检查依赖..."

if ! command -v docker &>/dev/null; then
  log_error "Docker 未安装。请安装 Docker Desktop: https://docs.docker.com/desktop/"
  exit 1
fi

if ! docker compose version &>/dev/null && ! docker-compose version &>/dev/null; then
  log_error "docker compose 插件未安装"
  exit 1
fi

COMPOSE_CMD="docker compose"
if ! docker compose version &>/dev/null; then
  COMPOSE_CMD="docker-compose"
fi

NODE_BIN="$(find_node_bin || true)"
OPENCLAW_ENTRY="$(find_openclaw_entry || true)"

if [ -z "$NODE_BIN" ]; then
  log_error "Node.js 22+ 未找到。请安装 node.exe 24+ 或 node 22+"
  exit 1
fi

if [ -z "$OPENCLAW_ENTRY" ]; then
  log_error "openclaw 未找到。请先运行: npm install -g openclaw 或 bash infra/setup-openclaw.sh"
  exit 1
fi

OPENCLAW_ENTRY_WIN="$(to_windows_path "$OPENCLAW_ENTRY")"

log_ok "node: $("$NODE_BIN" -v 2>/dev/null || echo 'unknown')"
log_ok "openclaw: $NODE_BIN $OPENCLAW_ENTRY_WIN ($("$NODE_BIN" "$OPENCLAW_ENTRY_WIN" --version 2>/dev/null || echo 'unknown'))"
log_ok "docker compose: $COMPOSE_CMD"

# ─── Step 1: 启动基础设施 ──────────────────────────────────────────────
echo ""
log_info "[1/6] 启动 Tuwunel + MinIO..."

cd "$SCRIPT_DIR"
$COMPOSE_CMD -f docker-compose.hiclaw-lite.yml up -d

if [ $? -ne 0 ]; then
  log_error "Docker Compose 启动失败"
  exit 1
fi

log_ok "Docker 容器已启动"

# ─── Step 2: 等待 Tuwunel 就绪 ────────────────────────────────────────
echo ""
log_info "[2/6] 等待 Tuwunel 就绪 (最多 60s)..."

for i in $(seq 1 60); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TUWUNEL_URL/_matrix/client/versions" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    log_ok "Tuwunel 就绪 ($TUWUNEL_URL)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    log_error "Tuwunel 启动超时。请检查: docker logs agenthub-tuwunel"
    exit 1
  fi
  echo -n "."
  sleep 1
done

# ─── Step 3: 注册/登录 Matrix 账号 ────────────────────────────────────
echo ""
log_info "[3/6] 注册 Matrix 账号..."

register_or_login() {
  local user=$1
  local pass=$2
  local user_id="@$user:$MATRIX_DOMAIN"

  # 尝试注册（带 registration token）
  local reg_resp
  reg_resp=$(curl -s -X POST "$TUWUNEL_URL/_matrix/client/v3/register" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$user\",\"password\":\"$pass\",\"auth\":{\"type\":\"m.login.registration_token\",\"token\":\"$REG_TOKEN\"}}" 2>/dev/null)

  local access_token
  access_token=$(echo "$reg_resp" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

  if [ -n "$access_token" ]; then
    echo "$access_token"
    return 0
  fi

  # 如果注册失败（用户已存在），尝试登录
  local login_resp
  login_resp=$(curl -s -X POST "$TUWUNEL_URL/_matrix/client/v3/login" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$user\"},\"password\":\"$pass\"}" 2>/dev/null)

  access_token=$(echo "$login_resp" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

  if [ -n "$access_token" ]; then
    echo "$access_token"
    return 0
  fi

  log_error "无法注册或登录 $user_id"
  log_error "注册响应: $reg_resp"
  log_error "登录响应: $login_resp"
  return 1
}

MANAGER_TOKEN=$(register_or_login "$MANAGER_USER" "$MANAGER_PASS")
if [ $? -ne 0 ]; then exit 1; fi
log_ok "Manager 账号: @$MANAGER_USER:$MATRIX_DOMAIN"

WORKER_TOKEN=$(register_or_login "$WORKER_USER" "$WORKER_PASS")
if [ $? -ne 0 ]; then exit 1; fi
log_ok "Worker 账号: @$WORKER_USER:$MATRIX_DOMAIN"

# ─── Step 3.5: 注册 Admin 账号（AgentHub Server 需要）───────────────────
echo ""
log_info "[3.5/6] 注册 AgentHub Admin Matrix 账号..."

ADMIN_USER="admin"
ADMIN_PASS="admin-dev-password-2026"
ADMIN_TOKEN=$(register_or_login "$ADMIN_USER" "$ADMIN_PASS")
if [ $? -ne 0 ]; then exit 1; fi
log_ok "Admin 账号: @$ADMIN_USER:$MATRIX_DOMAIN"

# 更新 .env 文件中的 Matrix 配置
update_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  if [ ! -f "$file" ]; then
    echo "$key=$value" >> "$file"
    return
  fi
  if grep -q "^$key=" "$file" 2>/dev/null; then
    sed -i.bak "s|^$key=.*|$key=$value|" "$file"
  else
    echo "$key=$value" >> "$file"
  fi
}

ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  update_env_var "$ENV_FILE" "AGENTHUB_MATRIX_HOMESERVER_URL" "$TUWUNEL_URL"
  update_env_var "$ENV_FILE" "AGENTHUB_MATRIX_SERVER_NAME" "$MATRIX_DOMAIN"
  update_env_var "$ENV_FILE" "AGENTHUB_MATRIX_REGISTRATION_TOKEN" "$REG_TOKEN"
  update_env_var "$ENV_FILE" "AGENTHUB_MATRIX_ACCESS_TOKEN" "$ADMIN_TOKEN"
  update_env_var "$ENV_FILE" "AGENTHUB_ROOM_PROVIDER" "matrix"
  log_ok "已更新 $ENV_FILE 中的 Matrix 配置"
else
  log_warn "未找到 $ENV_FILE，请手动添加以下配置："
  echo "  AGENTHUB_MATRIX_HOMESERVER_URL=$TUWUNEL_URL"
  echo "  AGENTHUB_MATRIX_SERVER_NAME=$MATRIX_DOMAIN"
  echo "  AGENTHUB_MATRIX_REGISTRATION_TOKEN=$REG_TOKEN"
  echo "  AGENTHUB_MATRIX_ACCESS_TOKEN=$ADMIN_TOKEN"
  echo "  AGENTHUB_ROOM_PROVIDER=matrix"
fi

# ─── Step 4: 生成 OpenClaw 配置 ───────────────────────────────────────
echo ""
log_info "[4/6] 生成 OpenClaw 配置..."

# 读取 .env 中的 LLM 配置，或使用默认值
LLM_BASE_URL="${AGENTHUB_LLM_BASE_URL:-http://localhost:8000/v1}"
LLM_API_KEY="${AGENTHUB_LLM_API_KEY:-agenthub-internal}"
LLM_MODEL="${AGENTHUB_LLM_MODEL:-default}"

# 如果 .env 存在，尝试从中读取
ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  # 安全地 source 环境变量
  while IFS='=' read -r key value; do
    case "$key" in
      AGENTHUB_LLM_BASE_URL) LLM_BASE_URL="$value" ;;
      AGENTHUB_LLM_API_KEY)  LLM_API_KEY="$value" ;;
      AGENTHUB_LLM_MODEL)    LLM_MODEL="$value" ;;
    esac
  done < <(grep -E '^(AGENTHUB_LLM_BASE_URL|AGENTHUB_LLM_API_KEY|AGENTHUB_LLM_MODEL)=' "$ENV_FILE" 2>/dev/null)
fi

# Manager 配置
MANAGER_WORKSPACE="${AGENTHUB_APP_DATA_DIR:-$HOME/.local/share}/AgentHub/manager/global"
mkdir -p "$MANAGER_WORKSPACE/skills"

python3 - "$MANAGER_TOKEN" "$MANAGER_PORT" "$LLM_BASE_URL" "$LLM_API_KEY" "$LLM_MODEL" "$MANAGER_CONFIG" <<'PYEOF'
import json, sys, os

token, port, llm_url, llm_key, llm_model, config_path = sys.argv[1:7]

with open(config_path, 'r', encoding='utf-8') as f:
    config = json.load(f)

config['gateway']['port'] = int(port)
config['channels']['matrix']['accessToken'] = token
config['models']['providers']['agenthub-llm']['baseUrl'] = llm_url
config['models']['providers']['agenthub-llm']['apiKey'] = llm_key
config['models']['providers']['agenthub-llm']['models'][0]['id'] = llm_model
config['models']['providers']['agenthub-llm']['models'][0]['name'] = llm_model
config['agents']['defaults']['model']['primary'] = f'agenthub-llm/{llm_model}'
# OpenClaw 2026.6.1: groups entries must not have 'allow' property
for gkey in config['channels']['matrix'].get('groups', {}):
    config['channels']['matrix']['groups'][gkey].pop('allow', None)

with open(config_path, 'w', encoding='utf-8') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print(config_path)
PYEOF

if [ $? -ne 0 ]; then
  # fallback: 用 sed 简单替换（如果 python3 不可用）
  sed -i.bak "s/\"accessToken\": \"\"/\"accessToken\": \"$MANAGER_TOKEN\"/" "$MANAGER_CONFIG" 2>/dev/null || true
  sed -i.bak "s/\"port\": 18799/\"port\": $MANAGER_PORT/" "$MANAGER_CONFIG" 2>/dev/null || true
fi

# Worker 配置
WORKER_WORKSPACE="${AGENTHUB_APP_DATA_DIR:-$HOME/.local/share}/AgentHub/workers/openclaw-worker-1"
mkdir -p "$WORKER_WORKSPACE/skills"

python3 - "$WORKER_TOKEN" "$WORKER_PORT" "$LLM_BASE_URL" "$LLM_API_KEY" "$LLM_MODEL" "$WORKER_CONFIG" <<'PYEOF'
import json, sys, os

token, port, llm_url, llm_key, llm_model, config_path = sys.argv[1:7]

with open(config_path, 'r', encoding='utf-8') as f:
    config = json.load(f)

config['gateway']['port'] = int(port)
config['channels']['matrix']['accessToken'] = token
config['models']['providers']['agenthub-llm']['baseUrl'] = llm_url
config['models']['providers']['agenthub-llm']['apiKey'] = llm_key
config['models']['providers']['agenthub-llm']['models'][0]['id'] = llm_model
config['models']['providers']['agenthub-llm']['models'][0]['name'] = llm_model
config['agents']['defaults']['model']['primary'] = f'agenthub-llm/{llm_model}'
config['agents']['defaults']['workspace'] = os.path.dirname(config_path)
# OpenClaw 2026.6.1: groups entries must not have 'allow' property
for gkey in config['channels']['matrix'].get('groups', {}):
    config['channels']['matrix']['groups'][gkey].pop('allow', None)

with open(config_path, 'w', encoding='utf-8') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print(config_path)
PYEOF

if [ $? -ne 0 ]; then
  sed -i.bak "s/\"accessToken\": \"\"/\"accessToken\": \"$WORKER_TOKEN\"/" "$WORKER_CONFIG" 2>/dev/null || true
  sed -i.bak "s/\"port\": 0/\"port\": $WORKER_PORT/" "$WORKER_CONFIG" 2>/dev/null || true
fi

log_ok "Manager 配置: $MANAGER_CONFIG (port $MANAGER_PORT)"
log_ok "Worker 配置: $WORKER_CONFIG (port $WORKER_PORT)"

# ─── Step 5: 复制 Agent 文件 ───────────────────────────────────────────
echo ""
log_info "[5/6] 复制 Agent 文件..."

for file in SOUL.md AGENTS.md HEARTBEAT.md TOOLS.md; do
  src="$SCRIPT_DIR/manager-agent/$file"
  dst="$MANAGER_WORKSPACE/$file"
  if [ -f "$src" ]; then
    cp "$src" "$dst"
    log_ok "Manager $file"
  fi
done

if [ -d "$SCRIPT_DIR/manager-agent/skills" ]; then
  cp -r "$SCRIPT_DIR/manager-agent/skills/"* "$MANAGER_WORKSPACE/skills/" 2>/dev/null || true
  log_ok "Manager skills/"
fi

for file in SOUL.md AGENTS.md; do
  src="$SCRIPT_DIR/worker-agent/$file"
  dst="$WORKER_WORKSPACE/$file"
  if [ -f "$src" ]; then
    cp "$src" "$dst"
    log_ok "Worker $file"
  fi
done

if [ -d "$SCRIPT_DIR/worker-agent/skills" ]; then
  mkdir -p "$WORKER_WORKSPACE/skills"
  cp -r "$SCRIPT_DIR/worker-agent/skills/"* "$WORKER_WORKSPACE/skills/" 2>/dev/null || true
  log_ok "Worker skills/"
fi

# ─── Step 6: 启动 OpenClaw ─────────────────────────────────────────────
echo ""
log_info "[6/6] 启动 OpenClaw Manager + Worker..."

# 先停止旧的
for pidfile in "$PID_DIR"/openclaw-*.pid; do
  [ -f "$pidfile" ] || continue
  old_pid=$(cat "$pidfile" 2>/dev/null)
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    log_warn "停止旧进程 PID $old_pid ($pidfile)"
    kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$pidfile"
done

# 启动 Manager
log_info "启动 OpenClaw Manager (port $MANAGER_PORT)..."
(
  export OPENCLAW_CONFIG_PATH="$MANAGER_CONFIG"
  export OPENCLAW_NO_RESPAWN=1
  export HOME="$MANAGER_WORKSPACE"
  cd "$MANAGER_WORKSPACE"
  exec "$NODE_BIN" "$OPENCLAW_ENTRY_WIN" gateway run --verbose --force > "$MANAGER_WORKSPACE/openclaw.log" 2>&1
) &
MANAGER_PID=$!
echo $MANAGER_PID > "$PID_DIR/openclaw-manager.pid"
log_ok "Manager PID: $MANAGER_PID"

# 启动 Worker
log_info "启动 OpenClaw Worker (port $WORKER_PORT)..."
(
  export OPENCLAW_CONFIG_PATH="$WORKER_CONFIG"
  export OPENCLAW_NO_RESPAWN=1
  export HOME="$WORKER_WORKSPACE"
  cd "$WORKER_WORKSPACE"
  exec "$NODE_BIN" "$OPENCLAW_ENTRY_WIN" gateway run --verbose --force > "$WORKER_WORKSPACE/openclaw.log" 2>&1
) &
WORKER_PID=$!
echo $WORKER_PID > "$PID_DIR/openclaw-worker.pid"
log_ok "Worker PID: $WORKER_PID"

sleep 2

# 检查进程是否存活
if kill -0 "$MANAGER_PID" 2>/dev/null; then
  log_ok "Manager 运行中"
else
  log_error "Manager 启动失败，查看日志: $MANAGER_WORKSPACE/openclaw.log"
fi

if kill -0 "$WORKER_PID" 2>/dev/null; then
  log_ok "Worker 运行中"
else
  log_error "Worker 启动失败，查看日志: $WORKER_WORKSPACE/openclaw.log"
fi

# ─── 完成 ──────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  AgentHub HiClaw-lite 启动完成"
echo "========================================"
echo ""
echo "Tuwunel (Matrix): $TUWUNEL_URL"
echo "MinIO Console:     http://localhost:9001 (minioadmin/minioadmin)"
echo "Manager Gateway:   http://localhost:$MANAGER_PORT"
echo "Worker Gateway:    http://localhost:$WORKER_PORT"
echo ""
echo "Manager 日志:      $MANAGER_WORKSPACE/openclaw.log"
echo "Worker 日志:       $WORKER_WORKSPACE/openclaw.log"
echo ""
echo "下一步:"
echo "  1. 启动 AgentHub Server: bun run dev:server"
echo "  2. 启动 AgentHub Web:   bun run dev:web"
echo "  3. 打开浏览器访问前端，创建群聊并 @manager"
echo ""
echo "停止命令:"
echo "  bash infra/stop-hiclaw-lite.sh"
echo ""
