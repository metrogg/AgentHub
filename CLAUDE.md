# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentHub is a multi-agent collaboration platform where users can chat with AI agents individually or orchestrate teams of agents (Architect, Coder, Reviewer, Researcher) to work on tasks together. Built for the ByteDance AI Full-Stack Challenge competition.

## Tech Stack

- **Runtime**: Bun (>=1.1.0) — used for both server and package scripts
- **Monorepo**: Bun workspaces (`apps/*`, `packages/*`)
- **Server**: Hono framework on Bun.serve with WebSocket support
- **Frontend**: React 18 + Vite + Tailwind CSS + Zustand (state) + Radix UI (primitives) + assistant-ui
- **Database**: SQLite via `bun:sqlite` + Drizzle ORM (WAL mode)
- **LLM**: Custom streaming client supporting OpenAI-compatible and Anthropic APIs
- **Desktop**: Tauri v2 + Rust + Bun compiled sidecar
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
bun run dev:desktop   # Tauri dev with sidecar

# Build
bun run build
bun run build:desktop

# Typecheck all packages
bun run typecheck

# Typecheck a single package
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck

# Lint
bun run lint

# Test
bun test              # Run all tests
bun test tests/smoke.test.ts   # Run a single test file

# Database
bun run db:generate   # Generate Drizzle migrations
bun run db:migrate    # Run migrations
bun run db:studio     # Open Drizzle Studio

# Desktop sidecar preparation
bun --filter @agenthub/desktop prepare:sidecar
```

## Architecture

```
apps/
  server/    — Hono REST API + WebSocket server (Bun.serve)
  web/       — React SPA (Vite, proxies /api and /ws to server)
  desktop/   — Tauri v2 shell with Rust + server sidecar
packages/
  db/        — Drizzle ORM schema, migrations, SQLite connection
  shared/    — Zod validation schemas, shared constants/types
tests/       — Smoke tests (Bun test runner)
docs/        — Product docs, design records and competition materials
```

### Server (`apps/server`)

- **Entry**: `src/index.ts` — seeds default user, starts Bun.serve with HTTP + WebSocket upgrade, auto-increments port if occupied
- **Routes**: `src/routes/` — Hono routers mounted at `/api/sessions`, `/api/messages`, `/api/settings`, `/api/workspaces`, `/api/coding-tools`, `/api/skills`, `/api/artifacts`, `/api/orchestrator-runs`
  - `DELETE /api/sessions/all` — bulk delete all sessions and their messages for the current user
- **LLM**: `src/services/llm-client.ts` — multi-provider streaming client (OpenAI-compatible + Anthropic). Config resolved from DB `settings` table first, then env vars. `src/services/llm.ts` is the thin wrapper used by agent runners.
- **Agent Runner**: `src/services/agent-runner.ts` — manages WebSocket rooms per session, routes execution through `RuntimeRegistry`, broadcasts `message:stream` / `message:completed` / `message:cancelled` events
- **Auth**: `src/middleware/auth.ts` — JWT-based, single-user mode with a seeded default user (`default-user`)
- **Env**: `src/env.ts` — Zod-validated env config. Key vars: `DATABASE_URL`, `LLM_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, `LLM_PROVIDER`, `PORT`, `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION`
- **Blackboard**: `src/services/blackboard.ts` — namespaced key-value store for agent task outputs with versioning, tagging, and pub/sub. Used by the orchestrator to share state between tasks.
- **Execution Tracer**: `src/services/execution-tracer.ts` — records agent runs, tool calls, blackboard operations, errors, and token usage into `execution_logs` table.

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

- `orchestrator-engine.ts` — master controller: `dispatch()` → build DAG → schedule → auto-review → conflict resolve → synthesize. `injectAutoReviewTasks()` auto-creates Reviewer tasks for code tasks with `requiresReview: true`.
- `planner.ts` — LLM-based task DAG generator with **Spec-first planning**: generates a `ProjectSpec` (module decomposition, interface contracts, data flow) before task breakdown, then derives tasks from the spec. Includes fallback templates. Generates `clarificationQuestions` when goal is ambiguous.
- `types.ts` — `ExecutionPlan`, `ClarificationQuestion`, `ExecutionTask`, `TaskOutputContract`, `TaskValidation`, `TaskLedger`, `ProgressLedger`
- `input-guardrails.ts` — security guardrails: pattern matching for dangerous operations (rm -rf, .env deletion, force push, etc.)
- `task-graph.ts` — DAG utilities (topological sort, cycle detection)
- `task-scheduler.ts` — concurrent executor (max 3 parallel), dependency-aware
- `synthesizer.ts` — LLM-based intelligent aggregation of agent outputs
- `conflict-resolver.ts` — detects file conflicts across agent diffs, auto-merge or LLM 3-way merge
- `replanning-engine.ts` — dynamic failure recovery: retry with backoff, agent substitution, local replan, task split, escalation to user, global replan

**Intent Router**: `chatStore.ts` `shouldRouteToOrchestratorPlan()` uses `assessIntentComplexity()` to auto-route complex messages (multi-file, multi-phase, architecture keywords) to orchestrator without explicit `@orchestrator`.

**Handoff Context Trimming**: `agent-runner.ts` `trimHistoryForHandoff()` trims group session history to pinned + last 3 messages + context summary, reducing token consumption.

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
User: "@orchestrator write a login page" (or complex message auto-routed by Intent Router)
  → messages.ts: createOrchestratorPlan() → LLM generates ExecutionPlan (task card shown in chat)
  → If ambiguous: plan includes clarificationQuestions (Clarifier)
  → User confirms plan → POST .../dispatch → OrchestratorEngine.dispatch()
    1. Create workspace + agents + group session
    2. Insert orchestratorRuns record
    3. Planner → TaskGraph → topological order
    4. TaskScheduler: execute tasks by dependency layer (max 3 concurrent)
    5. For each task:
       - Create child session
       - Git branch isolation (if non read-only)
       - AgentRuntime.execute() → stream reply (history trimmed for group sessions)
       - Collect diff artifact
       - Write output to Blackboard
       - If code task with requiresReview: auto-inject Reviewer task
    6. ConflictResolver: detect & resolve file conflicts
    7. Synthesizer: LLM aggregate → post summary to group chat
    8. Cleanup Blackboard namespace
```

### Database (`packages/db`)

SQLite with WAL mode. Key tables:

- `users`, `sessions` (direct/group, with `metadata` JSON), `messages`, `session_members`, `settings`
- `workspaces`, `workspace_agents`, `workspace_tasks`
- `orchestrator_runs` — tracks orchestrator dispatch lifecycle (planning → running → synthesizing → completed/failed). `planMessageId` and `summaryMessageId` reference `messages.id` with `onDelete: 'set null'`.
- `blackboard_entries` — namespaced key-value store with versioning
- `execution_logs` — tracing records for agent runs and tool calls. `sessionId` references `sessions.id` with `onDelete: 'cascade'`.

`workspace_tasks` extended fields for DAG scheduling:
- `run_id`, `dependencies` (JSON array), `parallel_group`, `max_retries`, `attempt_count`
- `fallback_agent_id`, `artifacts` (JSON), `started_at`, `completed_at`, `error_log`

DB file defaults to `./storage/agenthub.db`.

### Web (`apps/web`)

- Vite dev server proxies `/api` → `:8000` and `/ws` → `ws://:8000`
- Path alias: `@` → `./src`
- State managed via Zustand stores in `src/stores/` (chatStore, workspaceStore)
- Routing: React Router with pages: Chat, AgentConfig, AgentWorld, Office, SkillsMarket, OrchestratorRuns, ExecutionLogs, CodingTools, Settings
- Desktop integration: `src/lib/native.ts` detects Tauri runtime; `src/components/DesktopAppMenu.tsx` renders native menu when in desktop mode
- API client: `src/lib/api.ts` — typed wrapper around `fetch` for all backend endpoints
- **Orchestrator Plan Card** (`Thread.tsx`): `OrchestratorPlanCard` renders plan with task list, contract details, clarification questions, diff viewer, and conflict resolution UI. Uses `useMessage` + `useChatStore` for live metadata updates via WebSocket `run:event`.

### Desktop (`apps/desktop`)

- Tauri v2 Rust shell in `src-tauri/`
- Sidecar: `apps/server` compiled to `agenthub-server.exe`, placed in `src-tauri/resources/binaries/`
- Startup flow: splash screen → find port 8000-8079 → spawn server sidecar → wait for `/health` → load web UI
- Desktop commands: `pick_workspace_folder`, `open_in_editor`, `notify_user`, `desktop_info`, `open_desktop_window`
- Data paths on Windows: `%APPDATA%\com.agenthub.desktop\{data,config,logs}`
- Prepare sidecar: `bun --filter @agenthub/desktop prepare:sidecar`

### Shared (`packages/shared`)

- Zod schemas for API validation and types: `auth.ts`, `session.ts`, `message.ts`, `task.ts`, `agent.ts`, `artifact.ts`
- Shared constants in `constants.ts`

## Testing

Smoke tests live in `tests/smoke.test.ts` and use Bun's built-in test runner. They spin up the Hono app in-memory with a temporary SQLite database.

Covered areas:
- Health endpoint, session/message CRUD
- Settings model test mocking
- Workspace task dispatch and failure handling
- Agent draft confirmation
- TaskGraph DAG topology sort and cycle detection
- ConflictResolver multi-agent file conflict detection
- GitBranchManager branch lifecycle

## Security & Runtime Policy

- **Auth**: Single-user mode (`default-user` injected by auth middleware). No production login flow.
- **API Key protection**: `llm-client.ts` redacts Bearer tokens and `sk-*` / `sess-*` patterns from logs.
- **Code Agent sandbox** (three-tier):
  - `read-only`: no branch created, agent only reads files
  - `workspace-write`: isolated Git branch per task, diff collected after execution
  - `danger-full-access`: same branch isolation, but allows broader operations
- **`AGENTHUB_ENABLE_CODE_AGENT_EXECUTION`**: default is `true`. Actual restrictions enforced by `sandboxPolicy`.
  **Note**: Always use `env.AGENTHUB_ENABLE_CODE_AGENT_EXECUTION` from `src/env.ts` instead of raw `readEnv()` string checks. The `.env` file value overrides the Zod default at runtime.
- **MCP runtime**: read-only only (`nativeToolRuntime` only exposes read tools).

## Environment Variables

Key env vars from `apps/server/src/env.ts`:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `./storage/agenthub.db` | SQLite file path |
| `PORT` | `8000` | Server port |
| `LLM_PROVIDER` | `openai` | Default LLM provider |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | — | Generic LLM config |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | — | OpenAI-specific |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` | — | Anthropic-specific |
| `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION` | `true` | Code Agent execution switch |
| `AGENTHUB_CODE_AGENT_TIMEOUT_MS` | `120000` | Code Agent timeout |
| `AGENTHUB_NATIVE_MAX_TOOL_ROUNDS` | `6` | Max tool rounds for native runtime |
| `ENABLE_LOCAL_CLI_PROBES` | `true` | Probe host-installed CLI tools |

Web env vars (`.env` or Vite):
- `VITE_PROXY_TARGET` → backend for dev proxy
- `VITE_WS_PROXY_TARGET` → WebSocket proxy target

## Docker

```bash
docker compose up          # server + web
docker compose --profile agents up  # includes cli-agent container
```

Server runs migrations automatically on start in Docker.

## Communication Preferences

- **Advisory mode first**: When asked to explain or advise on architecture/design, provide written analysis and explanation first. Do not start building, compiling, or modifying code unless explicitly asked (e.g., user says "MODE: IMPLEMENT").
- **Focused explanations**: Answer the specific question directly first. Only expand to broader exploration if explicitly requested.
- **Local-first preference**: Before suggesting Docker, WSL, or remote solutions, verify local environment has required tools. Check PATH and common install locations.
- **China network context**: For Docker builds, package installations, or downloads, default to domestic mirrors (Tsinghua, Alibaba) and verify mirror persistence after source list modifications.
- **Git state verification**: Always confirm baseline/reference state is synced with remote before comparisons (e.g., `git fetch origin`). Never assume local branches are up to date.

## Development Conventions

- ESM throughout the project.
- TypeScript strict mode + isolatedModules.
- Code formatting by Prettier.
- UI language is Chinese; key types and protocol fields remain English.
- **Frontend (`apps/web`) is maintained by a colleague. Do NOT modify frontend code directly.** If you find frontend issues, report them with file path, line number, root cause, and suggested fix. Only modify frontend when the user explicitly requests it.

## Legacy Code References

The following files are still present and internally referenced by the new Runtime layer, but their primary logic has been migrated:
- `src/services/code-agent-adapter.ts` — referenced by `CodeAgentRuntime`
- `src/services/native-agent-loop.ts` — referenced by `NativeToolRuntime`
