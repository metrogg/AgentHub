# AgentHub

> An open, local-first AI workbench for coordinating real coding agents through group chat, task rooms, resident runtimes, and artifact delivery.

[![Local First](https://img.shields.io/badge/local--first-AgentHub-111827)](#local-setup)
[![Matrix](https://img.shields.io/badge/room-Matrix-0f766e)](#runtime-model)
[![Runtime](https://img.shields.io/badge/runtime-HiClaw--lite-2563eb)](#runtime-model)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Chinese](README_ZH.md) · [Security](SECURITY.md) · [Docs](docs/) · [Agent Guide](AGENTS.md)

AgentHub is an AI work platform built for real execution. It combines a Coze / Kimi inspired product shell with a HiClaw-lite open kernel: Matrix rooms are the collaboration source of truth, the Manager is a resident coordinator, Workers are real runtime entities, and generated outputs become traceable shared artifacts.

AgentHub is not one model pretending to be a team, and it is not a fixed-template task pipeline. Its core loop is observable, interruptible, and handoff-friendly: the user states a goal, the Manager organizes the team, Workers execute inside their own rooms, and the main group chat presents progress, reports, artifacts, and the final synthesis.

## Product Shape

The first screen is a workbench, not a landing page. Users can continue from a space, a group chat, an agent direct chat, or a previous artifact.

![AgentHub home](public/img/首页.png)

In AgentHub, chat is not just an input box. It is the collaboration surface:

- **Group chat** carries goals, discussion, coordination, task status, member reports, and final review.
- **Agent direct chat** keeps long-running context with a single expert agent.
- **Task rooms** preserve a Worker’s full execution process: assignment, progress, clarification, failure, retry, and output.
- **Artifact preview** turns generated files, web pages, reports, and shared task directories into inspectable work assets.

![AgentHub direct chat](public/img/单聊.png)

![AgentHub artifact preview](public/img/image.png)

## Design Principles

### 1. Rooms Are The Collaboration Source Of Truth

Humans, Managers, and Workers are Room participants. Messages, mentions, files, approvals, clarifications, and progress events enter the timeline. The frontend projects UI from Room timeline events and resource state instead of relying on opaque chat caches.

### 2. The Manager Coordinates, Not Just Plans

The Manager / Orchestrator behaves like a team lead. It observes rooms, understands goals, asks for missing context, proposes members, assigns work, handles interruptions, and performs final review. Planning is one Manager capability, not the system brain.

### 3. Workers Are Real Runtime Entities

Workers have identity, state, model binding, skills, workspace, RuntimeLease, Room membership, and heartbeat. OpenClaw resident Workers, Codex CLI, Claude Code, OpenCode, and Gemini CLI expose their capabilities through a shared AgentHub contract.

### 4. Artifacts Are First-Class Resources

Code, pages, documents, images, reports, and handoff files enter ArtifactStore / SharedStorage. Artifact references use S3-compatible object-key semantics. Local filesystem storage is the default implementation; MinIO/S3 uses the same adapter shape.

### 5. Local-First, Team-Hostable

AgentHub runs locally by default for developer workflows and project workspaces. Communication, storage, runtimes, and model gateways are adapter-based, so the same product shell can connect to a real Matrix homeserver, MinIO/S3, Docker resident runtimes, and OpenAI-compatible gateways.

## Core Experience

```text
User states a goal in group chat
  -> Manager observes context and decides whether to reply, ask, propose members, or assign work
  -> Controller Plane creates Run / Task / TaskRoom / RuntimeLease
  -> Worker claims the task room and executes
  -> Process events, clarifications, artifacts, and results are written back to Room timeline
  -> Main group chat shows progress, reports, artifact cards, and final review
```

Users can enter any task room to inspect what the Worker did, where it got blocked, and where the artifact came from. Complex work becomes an execution trace that can be reviewed, interrupted, resumed, and handed off.

## Product Modules

| Module | Purpose |
| --- | --- |
| Space | Organize projects, team members, agents, tasks, and assets |
| Agent Chat | Keep long-running direct conversations with expert agents |
| Agent Group | Coordinate users, Manager, and Workers in a shared room |
| Task Room | Preserve a Worker’s task context, process, and output |
| Task Center | Track runs, tasks, status, dependencies, retries, and human intervention |
| Asset Center | Manage generated artifacts, shared files, previews, and delivery records |
| Expert / Skill Center | Configure agents, role background, skills, MCP, and tool permissions |
| Eval / Trace | Inspect runtime events, model calls, resource state, and failure causes |

## Runtime Model

```text
AgentHub Web / Desktop
  -> AgentHub Server
  -> Controller API
  -> RoomService + Matrix Adapter
  -> Matrix Homeserver / Tuwunel
  -> OpenClaw Manager
  -> Worker Runtime
  -> ArtifactStore / SharedStorage
  -> UI Projection
```

### Layers

| Layer | Responsibility |
| --- | --- |
| Product interaction | Group chat, agent direct chat, task rooms, task board, artifact cards |
| Orchestration | Manager, controller actions, runs, tasks, RuntimeLease, final review |
| Communication | Matrix rooms, timeline, participants, mentions, file events |
| Protocol projection | AG-UI, Room timeline projection, resource-state projection |
| Execution | OpenClaw Manager, OpenClaw Worker, Codex CLI, Claude Code, OpenCode, Gemini CLI |
| Capabilities | MCP, skills, rules, shell, filesystem, browser, model gateways |
| Storage | SQLite resource index, local SharedStorage, MinIO/S3-compatible object store |

## Repository Layout

```text
apps/
  server/       Hono/Bun API, Room, Manager runtime, Worker runtime, Controller Plane
  web/          React/Vite web workbench
  desktop/      Tauri desktop shell
  Android/      Android client
packages/
  db/           Drizzle schema, migrations, SQLite access
  shared/       Shared schemas, constants, and types
infra/
  docker-compose.hiclaw-lite.yml
  start-hiclaw-lite.sh
  stop-hiclaw-lite.sh
  openclaw-runtime/
docs/           Product, architecture, runtime, and engineering notes
tests/          bun:test integration, projection, and boundary tests
scripts/        Development process helpers
```

## Local Setup

### Requirements

- [Bun](https://bun.sh) >= 1.1.0
- Node.js available on `PATH`
- Docker Desktop for local Tuwunel / MinIO
- Optional coding-agent CLIs: Codex CLI, Claude Code, OpenCode, Gemini CLI

### Install

```bash
bun install
cp .env.example .env
```

Review at least these settings:

```text
DATABASE_URL
LLM_PROVIDER
LLM_API_KEY
LLM_BASE_URL
LLM_MODEL
AGENTHUB_ROOM_PROVIDER=matrix
AGENTHUB_MATRIX_HOMESERVER_URL
AGENTHUB_MATRIX_SERVER_NAME
AGENTHUB_MATRIX_REGISTRATION_TOKEN
```

### Start HiClaw-lite Infrastructure

```bash
bash infra/start-hiclaw-lite.sh
```

The script prepares the local Matrix / MinIO / OpenClaw runtime environment and prints the relevant ports, health status, and diagnostics.

Stop the infrastructure:

```bash
bash infra/stop-hiclaw-lite.sh
```

### Start AgentHub

```bash
bun run dev
```

The dev script runs database migrations, starts the server, selects an available web port, writes `.agenthub-port`, and starts the resident Manager when configuration allows it.

Open the web URL printed by the terminal, usually:

```text
http://127.0.0.1:5644/
```

## Common Commands

```bash
bun run dev              # server + web
bun run dev:stop         # stop AgentHub dev processes
bun run dev:server       # server only
bun run dev:web          # web only
bun run dev:desktop      # desktop shell

bash infra/start-hiclaw-lite.sh
bash infra/stop-hiclaw-lite.sh

bun run infra:up         # Docker Compose: Tuwunel + MinIO
bun run infra:down       # stop local infrastructure
bun run infra:logs       # follow infrastructure logs

bun run typecheck
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck
bun test
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | AgentHub Server port, default `8000` |
| `DATABASE_URL` | SQLite database path |
| `LLM_PROVIDER` | Internal model provider |
| `LLM_API_KEY` | Model gateway key |
| `LLM_BASE_URL` | OpenAI-compatible gateway URL |
| `LLM_MODEL` | Internal default model |
| `AGENTHUB_ROOM_PROVIDER` | Room provider; product path uses `matrix` |
| `AGENTHUB_MATRIX_HOMESERVER_URL` | Matrix homeserver URL |
| `AGENTHUB_MATRIX_SERVER_NAME` | Matrix server name, default `agenthub.local` |
| `AGENTHUB_MATRIX_REGISTRATION_TOKEN` | Local Matrix registration token |
| `AGENTHUB_OBJECT_STORE_PROVIDER` | Local filesystem or S3-compatible object store |
| `AGENTHUB_CONTAINER_RUNTIME` | Set to `docker` for Docker resident runtime |
| `AGENTHUB_MANAGER_BACKEND` | Manager backend override |
| `AGENTHUB_WORKER_BACKEND` | Worker backend override |
| `AGENTHUB_CODE_AGENT_TIMEOUT_MS` | Code Agent execution timeout |
| `AGENTHUB_SANDBOX_PROVIDER` | `local-workdir` or Docker sandbox |

See [.env.example](.env.example) for the full template.

## Runtime Contract

AgentHub generates a unified runtime contract for Manager and Worker entities:

```text
SOUL.md
AGENTS.md
TOOLS.md
skills/
state.json
rooms.json
workers-registry.json
teams-registry.json
runtime.json
runtime-manifest.json
heartbeat
workspace
logs
```

This contract gives different runtime bases a consistent surface: identity, rooms, model binding, skills, workspace, shared task contract, health state, and Controller reconcile.

## Documentation

- [AGENTS.md](AGENTS.md): authoritative engineering guide for AI coding agents.
- [docs/文档索引与权威口径.md](docs/文档索引与权威口径.md): documentation index and source-of-truth notes.
- [docs/AgentHub-HiClaw-lite开源内核重构方案.md](docs/AgentHub-HiClaw-lite开源内核重构方案.md): HiClaw-lite kernel design.
- [docs/使用指南.md](docs/使用指南.md): product usage guide.
- [SECURITY.md](SECURITY.md): security model and vulnerability reporting.

## Contributing

Before changing runtime, Room, task, artifact, or Controller behavior, read [AGENTS.md](AGENTS.md). Core rules:

1. Identify the layer you are touching.
2. Treat Room timeline and resource state as the source of truth.
3. Keep Manager / Worker runtime boundaries explicit.
4. Do not restore DAG-first, template-first, or local fake-transport paths.
5. Add focused tests for projection, lifecycle, failure visibility, and boundary conditions.

Recommended checks:

```bash
bun run typecheck
bun test
```

## Security

AgentHub can run local CLIs, read and write workspaces, and access Matrix tokens, model keys, and generated artifacts. Do not commit:

- `.env`
- model provider keys
- Matrix access tokens
- local CLI auth files
- database files
- generated workspaces
- runtime logs or diagnostics containing secrets

Use disposable workspaces, scoped provider keys, and stronger sandboxing when running untrusted prompts, repositories, or generated code.

## License

AgentHub is released under the [MIT License](LICENSE).
