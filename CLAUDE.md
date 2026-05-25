# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentHub is a multi-agent collaboration platform where users can chat with AI agents individually or orchestrate teams of agents (Architect, Coder, Reviewer, Researcher) to work on tasks together. Built for the ByteDance AI Full-Stack Challenge competition.

## Tech Stack

- **Runtime**: Bun (>=1.1.0) — used for both server and package scripts
- **Monorepo**: Bun workspaces (`apps/*`, `packages/*`)
- **Server**: Hono framework on Bun.serve with WebSocket support
- **Frontend**: React 18 + Vite + Tailwind CSS + Zustand (state) + Radix UI (primitives)
- **Database**: SQLite via `bun:sqlite` + Drizzle ORM (WAL mode)
- **LLM**: Custom streaming client supporting OpenAI-compatible and Anthropic APIs
- **Shared**: Zod schemas + constants shared between server and web

## Common Commands

```bash
# Install dependencies
bun install

# Run everything (server + web in parallel)
bun run dev

# Run individually
bun run dev:server    # Server on :8000 with --watch
bun run dev:web       # Vite dev server on :5173

# Build
bun run build

# Typecheck all packages
bun run typecheck

# Lint
bun run lint

# Test
bun test

# Database
bun run db:generate   # Generate Drizzle migrations
bun run db:migrate    # Run migrations
bun run db:studio     # Open Drizzle Studio

# Typecheck a single package
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck
```

## Architecture

```
apps/
  server/    — Hono REST API + WebSocket server (Bun.serve)
  web/       — React SPA (Vite, proxies /api and /ws to server)
packages/
  db/        — Drizzle ORM schema, migrations, SQLite connection
  shared/    — Zod validation schemas, shared constants/types
```

### Server (`apps/server`)

- **Entry**: `src/index.ts` — seeds default user, starts Bun.serve with HTTP + WebSocket upgrade
- **Routes**: `src/routes/` — Hono routers mounted at `/api/sessions`, `/api/messages`, `/api/settings`, `/api/workspaces`, `/api/coding-tools`
- **LLM**: `src/services/llm-client.ts` — multi-provider streaming client (OpenAI-compatible + Anthropic). Config resolved from DB `settings` table first, then env vars. `src/services/llm.ts` is the thin wrapper used by agent runners.
- **Agent Runner**: `src/services/agent-runner.ts` — manages WebSocket rooms per session, routes execution through `RuntimeRegistry`, broadcasts `message:stream` / `message:completed` events
- **Auth**: `src/middleware/auth.ts` — JWT-based, single-user mode with a seeded default user
- **Env**: `src/env.ts` — Zod-validated env config. Key vars: `DATABASE_URL`, `LLM_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, `LLM_PROVIDER`, `PORT`

### Agent Runtime Layer (`src/services/runtime/`)

All agent execution goes through a unified `AgentRuntime` interface:

- `agent-runtime.ts` — interface definition (`AgentProfile`, `ExecutionContext`, `AgentOutputChunk`)
- `runtime-registry.ts` — maps `profile.runtimeType` to the correct runtime (`llm` | `code-agent` | `mcp`)
- `llm-runtime.ts` — standard LLM chat (wraps `streamReply`)
- `code-agent-runtime.ts` — Codex / Claude Code / OpenCode CLI adapter
- `native-tool-runtime.ts` — LLM + read-only tool loop (OpenAI function calling / Anthropic tool_use)

`agent-runner.ts` resolves the runtime via `runtimeRegistry.resolveForProfile(profile)` and streams chunks through the WebSocket room.

### Orchestrator Engine (`src/services/orchestrator/`)

Multi-agent task orchestration with DAG scheduling:

- `orchestrator-engine.ts` — master controller: `dispatch()` → build DAG → schedule → conflict resolve → synthesize
- `planner.ts` — LLM-based task DAG generator with fallback templates
- `task-graph.ts` — DAG utilities (topological sort, cycle detection)
- `task-scheduler.ts` — concurrent executor (max 3 parallel), dependency-aware
- `synthesizer.ts` — LLM-based intelligent aggregation of agent outputs
- `conflict-resolver.ts` — detects file conflicts across agent diffs, auto-merge or LLM 3-way merge
- `fallback-engine.ts` — retry → fallback agent → orchestrator takeover on failure

Triggered via `POST /messages/:sessionId/orchestrator-plan/:messageId/dispatch` in `messages.ts`.

### Git Branch Isolation (`src/services/git/`)

- `branch-manager.ts` — per-agent task branch lifecycle:
  - `prepareBranch()` → `git stash` → `git checkout -b agenthub/{runId}/{agentKey}/{taskId}`
  - `collectDiff()` → `git diff main...branch`
  - `tryMerge()` → merge multiple agent branches to detect conflicts
  - `cleanupBranch()` → delete branch + pop stash

Applies to `workspace-write` and `danger-full-access` sandbox policies. `read-only` agents do not create branches.

### Multi-Agent Orchestration Flow

```
User: "@orchestrator write a login page"
  → messages.ts: createOrchestratorPlan() → LLM generates ExecutionPlan (task card shown in chat)
  → User confirms plan → POST .../dispatch → OrchestratorEngine.dispatch()
    1. Create workspace + agents + group session
    2. Insert orchestratorRuns record
    3. Planner → TaskGraph → topological order
    4. TaskScheduler: execute tasks by dependency layer (max 3 concurrent)
    5. For each task:
       - Create child session
       - Git branch isolation (if non read-only)
       - AgentRuntime.execute() → stream reply
       - Collect diff artifact
    6. ConflictResolver: detect & resolve file conflicts
    7. Synthesizer: LLM aggregate → post summary to group chat
```

### Database (`packages/db`)

SQLite with WAL mode. Key tables:

- `users`, `sessions` (direct/group), `messages`, `session_members`, `settings`
- `workspaces`, `workspace_agents`, `workspace_tasks`
- `orchestrator_runs` — tracks orchestrator dispatch lifecycle (planning → running → synthesizing → completed/failed)

`workspace_tasks` extended fields for DAG scheduling:
- `run_id`, `dependencies` (JSON array), `parallel_group`, `max_retries`, `attempt_count`
- `fallback_agent_id`, `artifacts` (JSON), `started_at`, `completed_at`, `error_log`

DB file defaults to `./storage/agenthub.db`.

### Web (`apps/web`)

- Vite dev server proxies `/api` → `:8000` and `/ws` → `ws://:8000`
- Path alias: `@` → `./src`
- State managed via Zustand stores in `src/stores/`
- Fully compatible with new backend — no frontend changes needed for the new architecture

## Security & Runtime Policy

- **Auth**: Single-user mode (`default-user` injected by auth middleware). No production login flow.
- **API Key protection**: `llm-client.ts` redacts Bearer tokens and `sk-*` / `sess-*` patterns from logs.
- **Code Agent sandbox** (three-tier):
  - `read-only`: no branch created, agent only reads files
  - `workspace-write`: isolated Git branch per task, diff collected after execution
  - `danger-full-access`: same branch isolation, but allows broader operations
- **`AGENTHUB_ENABLE_CODE_AGENT_EXECUTION`**: default is now `true` (was `false`). Actual restrictions enforced by `sandboxPolicy`.
- **MCP runtime**: read-only only (`nativeToolRuntime` only exposes read tools).

## Legacy Code References

The following files are still present and internally referenced by the new Runtime layer, but their primary logic has been migrated:
- `src/services/code-agent-adapter.ts` — referenced by `CodeAgentRuntime`
- `src/services/native-agent-loop.ts` — referenced by `NativeToolRuntime`

## Docker

```bash
docker compose up          # server + web
docker compose --profile agents up  # includes cli-agent container
```

Server runs migrations automatically on start in Docker.
