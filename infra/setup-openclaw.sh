#!/bin/bash
# ─── OpenClaw Setup Script for AgentHub ───────────────────────────────
# This script clones, builds, and configures OpenClaw as the Manager/Worker
# runtime for AgentHub. Aligned with HiClaw's openclaw-base/Dockerfile.
#
# Prerequisites: Node.js 22+, pnpm, git, build-essential (python3, make, g++)
# Usage: bash infra/setup-openclaw.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
OPENCLAW_DIR="${OPENCLAW_DIR:-$PROJECT_ROOT/.openclaw-runtime}"
OPENCLAW_BRANCH="hiclaw-2026.4.14"
OPENCLAW_COMMIT="2f35b6fa6b65d012e3b0c9f24af3f8a4b617a6e0"

echo "=== AgentHub OpenClaw Setup ==="
echo "Install directory: $OPENCLAW_DIR"

# ─── Step 1: Check prerequisites ─────────────────────────────────────
echo ""
echo "[1/6] Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 22+ first."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "ERROR: Node.js 22+ required, found v$NODE_VERSION"
  exit 1
fi

if ! command -v pnpm &>/dev/null; then
  echo "Installing pnpm..."
  npm install -g pnpm
fi

if ! command -v git &>/dev/null; then
  echo "ERROR: git not found."
  exit 1
fi

echo "Node.js $(node -v), pnpm $(pnpm -v), git $(git --version)"

# ─── Step 2: Clone OpenClaw ──────────────────────────────────────────
echo ""
echo "[2/6] Cloning OpenClaw..."

if [ -d "$OPENCLAW_DIR/.git" ]; then
  echo "OpenClaw already cloned at $OPENCLAW_DIR, updating..."
  cd "$OPENCLAW_DIR"
  git fetch --depth 1 origin "$OPENCLAW_COMMIT" 2>/dev/null || true
  git checkout "$OPENCLAW_COMMIT" 2>/dev/null || {
    echo "Checking out branch $OPENCLAW_BRANCH..."
    git checkout "$OPENCLAW_BRANCH"
  }
else
  git clone --depth 1 --single-branch -b "$OPENCLAW_BRANCH" \
    https://github.com/higress-group/openclaw.git "$OPENCLAW_DIR"
  cd "$OPENCLAW_DIR"
  git fetch --depth 1 origin "$OPENCLAW_COMMIT" 2>/dev/null || true
  git checkout "$OPENCLAW_COMMIT" 2>/dev/null || true
fi

echo "OpenClaw at: $(git rev-parse --short HEAD)"

# ─── Step 3: Install dependencies and build ──────────────────────────
echo ""
echo "[3/6] Installing dependencies..."
cd "$OPENCLAW_DIR"
pnpm install

echo ""
echo "[4/6] Building OpenClaw..."
pnpm build
pnpm ui:build 2>/dev/null || echo "UI build skipped (optional)"

# Make binary executable
chmod +x "$OPENCLAW_DIR/openclaw.mjs" 2>/dev/null || true

# Create symlink
OPENCLAW_BIN="/usr/local/bin/openclaw"
if [ -w "/usr/local/bin" ] 2>/dev/null; then
  ln -sf "$OPENCLAW_DIR/openclaw.mjs" "$OPENCLAW_BIN"
  echo "Symlinked: openclaw -> $OPENCLAW_DIR/openclaw.mjs"
else
  echo "NOTE: Cannot symlink to $OPENCLAW_BIN (no write permission)."
  echo "Add to PATH manually: export PATH=\"$OPENCLAW_DIR:\$PATH\""
fi

# ─── Step 5: Verify Matrix crypto addon ──────────────────────────────
echo ""
echo "[5/6] Verifying Matrix E2EE crypto addon..."

CRYPTO_NODE="$OPENCLAW_DIR/node_modules/@matrix-org/matrix-sdk-crypto-nodejs"
if [ -d "$CRYPTO_NODE" ]; then
  echo "Matrix crypto addon: OK"
else
  echo "Matrix crypto addon: NOT FOUND (E2EE will be disabled)"
  echo "Install manually: cd $OPENCLAW_DIR && pnpm add @matrix-org/matrix-sdk-crypto-nodejs"
fi

# ─── Step 6: Create AgentHub Manager workspace ──────────────────────
echo ""
echo "[6/6] Setting up AgentHub Manager workspace..."

AGENTHUB_DATA="${AGENTHUB_APP_DATA_DIR:-$HOME/.local/share}/AgentHub"
MANAGER_WORKSPACE="$AGENTHUB_DATA/manager/global"
MANAGER_SKILLS="$MANAGER_WORKSPACE/skills"

mkdir -p "$MANAGER_WORKSPACE"
mkdir -p "$MANAGER_SKILLS"
mkdir -p "$AGENTHUB_DATA/openclaw-matrix"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "OpenClaw binary: $OPENCLAW_DIR/openclaw.mjs"
echo "Manager workspace: $MANAGER_WORKSPACE"
echo "Manager skills: $MANAGER_SKILLS"
echo ""
echo "Next steps:"
echo "  1. Start Tuwunel (Matrix homeserver): docker compose -f infra/docker-compose.hiclaw-lite.yml up -d tuwunel"
echo "  2. Start AgentHub server: bun run dev:server"
echo "  3. Configure Manager: copy infra/manager-openclaw.json to $MANAGER_WORKSPACE/openclaw.json"
echo "  4. Launch Manager: openclaw gateway run --verbose --force"
echo ""
echo "Or use: bun run dev:manager (to launch everything together)"
