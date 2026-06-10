# AgentHub

> An open, local-first AI workbench for coordinating multiple coding agents through chat, rooms, tasks, and artifacts.

[![Status](https://img.shields.io/badge/status-alpha-orange)](#roadmap)
[![Runtime](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![Frontend](https://img.shields.io/badge/frontend-React%20%2B%20Vite-61dafb)](https://vite.dev)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[中文文档](README_ZH.md) · [Security](SECURITY.md) · [Docs](docs/)

AgentHub is evolving from an IM-style multi-agent collaboration prototype into a Coze/Kimi-inspired AI work platform. The product shell is AgentHub's own chat-first workspace, while the runtime direction is a lightweight HiClaw-style open kernel: Matrix rooms as the collaboration source of truth, a resident Manager runtime, real Worker runtimes, and a shared artifact store.

The current north star is not "one model pretending to be a team." AgentHub is designed around a real coordination loop:

1. A human starts from a group chat or a direct agent chat.
2. A Manager / Orchestrator understands the goal and decides whether to reply, ask, propose members, assign work, or summarize.
3. Workers execute in their own rooms and workdirs.
4. The main room shows progress, reports, artifacts, and the final synthesis.
5. Users can inspect the full worker process instead of only seeing the final answer.

## Preview

![AgentHub home screen](public/img/首页.png)

![AgentHub direct chat](public/img/单聊.png)

![AgentHub workspace preview](public/img/image.png)

## Highlights

- **Chat-native workspace**: direct agent chats, project group chats, and task sub-rooms.
- **Resident Manager runtime**: OpenClaw Manager is the primary coordination path.
- **Matrix-first collaboration**: rooms, timeline events, participants, and mentions are the internal source of truth.
- **Real coding workers**: OpenClaw resident workers plus AgentHub-managed bridges for Codex CLI, Claude Code, OpenCode, and Gemini CLI.
- **Task and artifact visibility**: task rooms, run state, progress events, generated files, previews, and artifact records.
- **Local-first storage**: filesystem-backed shared storage by default, designed with S3-compatible object-key semantics for later MinIO/S3 swaps.
- **Controller plane**: Manager skills and future CLIs can operate real resources through a unified controller API.
- **Developer-friendly stack**: Bun, Hono, React, Vite, Drizzle, SQLite, Docker Compose for local Matrix/MinIO infrastructure.

## Project Status

AgentHub is in active alpha development. APIs, database schema, runtime contracts, and local workspace formats are still moving quickly. Old sessions, old tasks, old database rows, and old workspace data are not considered compatibility constraints while the HiClaw-lite kernel is being rebuilt.

Use this project if you want to explore:

- local-first multi-agent coding collaboration,
- Matrix-backed agent rooms,
- OpenClaw-style resident Manager / Worker runtimes,
- task rooms and artifact handoff,
- Coze-style AI workbench primitives in an open-source shell.

## Architecture

```text
Human
  -> AgentHub Web
  -> AgentHub Server / Controller API
  -> RoomService + Matrix adapter
  -> Matrix homeserver / Tuwunel
  -> OpenClaw Manager
  -> Controller Plane
  -> Worker runtime / task room
  -> ArtifactStore / SharedStorage
  -> UI projections
```

### Layers

| Layer | Responsibility |
| --- | --- |
| Product shell | IM-style workspace: direct chats, group chats, task rooms, task board, artifact cards |
| Orchestration | Manager / Orchestrator, controller actions, runs, task assignment, final review |
| Communication | Matrix rooms, timeline, participants, mentions, file events |
| Protocol projection | AG-UI and UI projections from room/resource events |
| Execution | OpenClaw Manager, OpenClaw resident Worker, Codex CLI, Claude Code, OpenCode, Gemini CLI |
| Capabilities | MCP, skills, rules, shell, files, browser, model gateways |
| Storage | SQLite resource index, local filesystem object store, optional MinIO/S3-compatible adapter |

## Repository Layout

```text
apps/
  server/       Hono/Bun API, rooms, Manager runtime, Worker runtime, controller plane
  web/          React/Vite web app
  desktop/      Tauri desktop shell
  Android/      Android experiments
packages/
  db/           Drizzle schema, migrations, SQLite access
  shared/       shared schemas, constants, and types
infra/
  docker-compose.hiclaw-lite.yml
  openclaw-runtime/
docs/           product, architecture, and migration notes
tests/          bun:test integration and projection tests
scripts/        dev process helpers
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.1.0
- Node.js available on PATH for some local tooling
- Docker Desktop, recommended for the local Matrix / MinIO stack
- Optional local agent CLIs: Codex CLI, Claude Code, OpenCode, Gemini CLI

### Install

```bash
bun install
```

### Configure

```bash
cp .env.example .env
```

At minimum, review:

- `DATABASE_URL`
- `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`
- `AGENTHUB_ROOM_PROVIDER=matrix`
- `AGENTHUB_MATRIX_HOMESERVER_URL`
- `AGENTHUB_MATRIX_SERVER_NAME`
- `AGENTHUB_MATRIX_REGISTRATION_TOKEN`

### Start Local Infrastructure

```bash
bun run infra:up
bash infra/start-hiclaw-lite.sh
```

This starts the local HiClaw-lite infrastructure defined in `infra/docker-compose.hiclaw-lite.yml`, including Tuwunel for Matrix and MinIO for S3-compatible storage experiments.

### Start AgentHub

```bash
bun run dev
```

The dev script:

- runs database migrations,
- starts the server,
- picks an available web port from `5644-5700`,
- writes the actual server port to `.agenthub-port`,
- auto-starts the resident Manager when configured.

Open the printed web URL, usually:

```text
http://127.0.0.1:5644/
```

## Common Commands

```bash
bun run dev              # server + web
bun run dev:stop         # stop stale AgentHub dev processes
bun run dev:server       # server only
bun run dev:web          # web only
bun run dev:desktop      # desktop shell

bun run infra:up         # start Tuwunel + MinIO
bun run infra:down       # stop local infra
bun run infra:logs       # follow infra logs

bun run typecheck        # typecheck all workspaces
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck
bun test                 # run tests
```

## Runtime Model

### Manager

OpenClaw Manager is the primary Manager / Team Leader runtime. AgentHub generates a Manager contract under the local app data directory and mirrors the OpenClaw config, skills, registries, rooms, state, and heartbeat files.

Manager model selection is resolved from:

1. explicit Manager runtime environment override,
2. the Manager / Team Leader agent model binding,
3. the internal default model or active configured model.

Catalog entries are resolved to their real provider model IDs before writing `openclaw.json`.

### Workers

Workers can be:

- OpenClaw resident workers,
- AgentHub-managed bridge workers backed by Codex CLI,
- Claude Code,
- OpenCode,
- Gemini CLI.

Workers receive room context, task contracts, isolated workdirs, runtime leases, sandbox environment variables, and shared storage references.

## Configuration Notes

Important environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port, default `8000` |
| `DATABASE_URL` | SQLite database path |
| `AGENTHUB_ROOM_PROVIDER` | Use `matrix` for the product/development path |
| `AGENTHUB_MATRIX_HOMESERVER_URL` | Matrix homeserver URL |
| `AGENTHUB_MATRIX_SERVER_NAME` | Matrix server name, usually `agenthub.local` |
| `AGENTHUB_OBJECT_STORE_PROVIDER` | Local filesystem or S3-compatible object storage |
| `AGENTHUB_CONTAINER_RUNTIME` | Set `docker` to enable Docker-backed Manager and Worker runtimes |
| `AGENTHUB_MANAGER_BACKEND` | Override Manager backend |
| `AGENTHUB_WORKER_BACKEND` | Override Worker backend |
| `AGENTHUB_CODE_AGENT_TIMEOUT_MS` | Code agent execution timeout |
| `AGENTHUB_SANDBOX_PROVIDER` | `local-workdir` or optional Docker sandbox |

See `.env.example` for the full list.

## Documentation

Useful entry points:

- [AGENTS.md](AGENTS.md): authoritative engineering instructions for AI coding agents.
- [docs/](docs/): architecture notes, product research, and migration plans.
- [infra/](infra/): local Matrix / MinIO / OpenClaw runtime infrastructure.
- [SECURITY.md](SECURITY.md): vulnerability reporting and security model notes.

Some historical documents may describe deprecated DAG-first, template-first, or local-only transport paths. Prefer `AGENTS.md`, this README, and current implementation code when there is a conflict.

## Roadmap

Near-term:

- stabilize Matrix room projection and runtime diagnostics,
- improve Manager / Worker lifecycle recovery,
- harden ArtifactStore and shared storage behavior,
- make task rooms, run history, and artifact library easier to inspect,
- improve model/runtime configuration UX.

Mid-term:

- Space / Task Center / Asset Center / Expert Center,
- Eval / Trace views,
- long-running coding and deployment workflows,
- stronger resident Worker support,
- optional MinIO/S3 production adapter.

Long-term:

- a Coze-style open AI workbench for local and team-hosted coding-agent collaboration.

## Contributing

This repository is moving quickly. Before changing runtime, room, task, or artifact behavior:

1. Read `AGENTS.md`.
2. Identify the layer you are touching.
3. Prefer Room timeline and resource state over legacy message caches.
4. Keep Manager / Worker runtime boundaries explicit.
5. Add targeted tests for projection, lifecycle, and failure visibility.

Useful checks:

```bash
bun run typecheck
bun test
```

## Security

Do not commit secrets, model keys, Matrix access tokens, local CLI auth files, generated workspaces, or runtime logs. See [SECURITY.md](SECURITY.md) for reporting and local security assumptions.

## License

AgentHub is released under the [MIT License](LICENSE).
