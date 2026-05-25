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
- **LLM**: Custom streaming client supporting OpenAI-compatible and Anthropic APIs, plus Mastra agent framework
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
- **LLM**: `src/services/llm-client.ts` — multi-provider streaming client (OpenAI-compatible + Anthropic). Config resolved from DB `settings` table first, then env vars. `src/services/llm.ts` is the thin wrapper used by the agent runner.
- **Agent Runner**: `src/services/agent-runner.ts` — manages WebSocket rooms per session, streams LLM replies, broadcasts `message:stream` events to connected clients
- **Auth**: `src/middleware/auth.ts` — JWT-based, single-user mode with a seeded default user
- **Env**: `src/env.ts` — Zod-validated env config. Key vars: `DATABASE_URL`, `LLM_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, `LLM_PROVIDER`, `PORT`

### Multi-Agent Orchestration

The orchestrator pattern lives in `src/routes/messages.ts`:
- `@orchestrator` mention triggers plan generation (Architect/Coder/Reviewer tasks)
- Dispatching a plan creates a **Workspace** with agents, tasks, and a group session
- Group sessions route `@agent` mentions to the correct agent profile
- Each task gets its own direct session + agent reply stream
- Workspaces have a `/summary` endpoint that aggregates all agent outputs

### Database (`packages/db`)

SQLite with WAL mode. Key tables: `users`, `sessions` (direct/group), `messages`, `agents`, `workspaces`, `workspace_agents`, `workspace_tasks`, `session_members`, `settings`, `tasks`. DB file defaults to `./storage/agenthub.db`.

### Web (`apps/web`)

- Vite dev server proxies `/api` → `:8000` and `/ws` → `ws://:8000`
- Path alias: `@` → `./src`
- State managed via Zustand stores in `src/stores/`

## Docker

```bash
docker compose up          # server + web
docker compose --profile agents up  # includes cli-agent container
```

Server runs migrations automatically on start in Docker.
