#!/bin/bash
# ─── OpenClaw Setup Script for AgentHub ───────────────────────────────
# Installs OpenClaw and configures it as the Manager/Worker runtime.
#
# Two installation modes:
#   1. npm (default): `npm install -g openclaw` — fast, no compilation
#   2. source: clone + pnpm build — for HiClaw-specific fork
#
# Prerequisites: Node.js 22+
# Usage: bash infra/setup-openclaw.sh [--from-source]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FROM_SOURCE="${1:-}"

echo "=== AgentHub OpenClaw Setup ==="

# ─── Step 1: Check Node.js ───────────────────────────────────────────
echo ""
echo "[1/4] Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 22+ first."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "ERROR: Node.js 22+ required, found v$NODE_VERSION"
  exit 1
fi

echo "Node.js $(node -v)"

# ─── Step 2: Install OpenClaw ────────────────────────────────────────
echo ""

if [ "$FROM_SOURCE" = "--from-source" ]; then
  echo "[2/4] Installing OpenClaw from source..."
  OPENCLAW_DIR="$PROJECT_ROOT/.openclaw-runtime"
  OPENCLAW_BRANCH="hiclaw-2026.4.14"

  # Fix PATH for npm global binaries
  NPM_GLOBAL="$(npm config get prefix 2>/dev/null)/bin"
  if [ -d "$NPM_GLOBAL" ] && [[ ":$PATH:" != *":$NPM_GLOBAL:"* ]]; then
    export PATH="$NPM_GLOBAL:$PATH"
  fi

  if ! command -v pnpm &>/dev/null; then
    npm install -g pnpm
  fi

  if [ -d "$OPENCLAW_DIR/.git" ]; then
    echo "OpenClaw already cloned at $OPENCLAW_DIR"
    cd "$OPENCLAW_DIR"
  else
    CLONE_URLS=(
      "https://github.com/higress-group/openclaw.git"
      "https://gitee.com/mirrors/openclaw.git"
    )
    CLONED=false
    for url in "${CLONE_URLS[@]}"; do
      echo "Cloning from $url..."
      rm -rf "$OPENCLAW_DIR" 2>/dev/null || true
      if git clone --depth 1 --single-branch -b "$OPENCLAW_BRANCH" "$url" "$OPENCLAW_DIR" 2>&1; then
        CLONED=true
        break
      fi
    done
    if [ "$CLONED" = false ]; then
      echo "ERROR: Failed to clone. Try: npm install -g openclaw (without --from-source)"
      exit 1
    fi
    cd "$OPENCLAW_DIR"
  fi

  pnpm install
  pnpm build
  chmod +x "$OPENCLAW_DIR/openclaw.mjs" 2>/dev/null || true
  echo "OpenClaw built at: $OPENCLAW_DIR/openclaw.mjs"

else
  echo "[2/4] Installing OpenClaw from npm..."
  npm install -g openclaw

  if ! command -v openclaw &>/dev/null; then
    echo "ERROR: openclaw command not found after install."
    echo "Try: npm install -g openclaw"
    exit 1
  fi

  echo "OpenClaw installed: $(openclaw --version 2>/dev/null || echo 'unknown version')"
fi

# ─── Step 3: Create Manager workspace ────────────────────────────────
echo ""
echo "[3/4] Setting up Manager workspace..."

AGENTHUB_DATA="${AGENTHUB_APP_DATA_DIR:-$HOME/.local/share}/AgentHub"
MANAGER_WORKSPACE="$AGENTHUB_DATA/manager/global"

mkdir -p "$MANAGER_WORKSPACE/skills"

# Copy agent files
for file in SOUL.md AGENTS.md HEARTBEAT.md TOOLS.md; do
  src="$SCRIPT_DIR/manager-agent/$file"
  dst="$MANAGER_WORKSPACE/$file"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    echo "  Copied $file"
  fi
done

# Copy skills
if [ -d "$SCRIPT_DIR/manager-agent/skills" ]; then
  cp -rn "$SCRIPT_DIR/manager-agent/skills/"* "$MANAGER_WORKSPACE/skills/" 2>/dev/null || true
  echo "  Copied skills/"
fi

# Ensure state files
for file in state.json workers-registry.json; do
  if [ ! -f "$MANAGER_WORKSPACE/$file" ]; then
    echo '{"schemaVersion":1}' > "$MANAGER_WORKSPACE/$file"
  fi
done

# ─── Step 4: Verify ─────────────────────────────────────────────────
echo ""
echo "[4/4] Verification..."

OPENCLAW_BIN=""
if command -v openclaw &>/dev/null; then
  OPENCLAW_BIN="$(command -v openclaw)"
elif [ -f "$PROJECT_ROOT/.openclaw-runtime/openclaw.mjs" ]; then
  OPENCLAW_BIN="$PROJECT_ROOT/.openclaw-runtime/openclaw.mjs"
fi

if [ -n "$OPENCLAW_BIN" ]; then
  echo "OpenClaw binary: $OPENCLAW_BIN"
else
  echo "WARNING: OpenClaw binary not found in PATH or .openclaw-runtime/"
fi

echo "Manager workspace: $MANAGER_WORKSPACE"
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Start Tuwunel: docker compose -f infra/docker-compose.hiclaw-lite.yml up -d tuwunel"
echo "  2. Start AgentHub: bun run dev:server"
echo "  3. OpenClaw will be launched automatically by AgentHub when needed"
echo ""
echo "Or manually: openclaw gateway run --verbose --force"
