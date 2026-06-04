# AgentHub Development Guide

This file is for Claude Code and other coding agents working inside this repository. For product context, first read `README.md`, `AGENTS.md`, `docs/文档索引与权威口径.md`, `docs/当前状态与下一步路线.md`, `docs/AgentHub-HiClaw-lite开源内核重构方案.md`, and `docs/HiClaw架构调研与AgentHub底层重构方案.md`.

## Product Definition

AgentHub is an open-source Coze/Kimi-style AI work platform shell evolving toward a HiClaw-lite open collaboration kernel. The expected behavior is:

1. The user starts from a group chat.
2. Manager / Orchestrator behaves like a team lead: it understands the request, decides whether to reply, clarify, request members, assign work, review, or summarize.
3. Planner is not the brain. Structured decomposition is only a planning skill/action that Manager may call.
4. Multiple agents receive concrete tasks in their own child conversations.
5. The main group chat shows Manager progress, member reports, artifacts, and final synthesis.
6. Users can open child conversations to inspect each agent's real execution trace.

Do not implement fixed scenario templates as the core path. The platform must stay general-purpose first.
Role presets may be used as a manual creation library, but they must not auto-seed a workspace, define a default team, or override model-generated assignments.
Role prompts should follow the composition model: shared collaboration protocol + role background + bound skills + runtime task context + output contract. Group goals may drive member recommendations, but not fixed execution templates. If an existing group lacks needed capability, Orchestrator may propose adding a new agent; this must be visible and user-approved by default.
Preinstalled agent templates and lightweight expert-team recommendations are agent configuration assets, not fixed execution teams. You may borrow structure from Claude Code subagents, BMAD, SuperClaude, awesome-cursor-skills, and MCP server ecosystems, but first adapt for license, safety boundaries, quality, and AgentHub schemas. Do not build a separate "my experts" system or full expert marketplace yet, and do not directly copy unaudited prompts or enable third-party MCP servers by default.

## Current Kernel Direction

The new architecture target is **AgentHub Product Shell + HiClaw-lite Open Kernel**:

- Keep AgentHub's own product UI: group chat, task rooms, experts, task board, artifact cards, settings, trace/eval.
- Use Matrix as the internal collaboration source of truth: Room, timeline, participant, and mention are first-class.
- Learn Manager Runtime from HiClaw OpenClaw/QwenPaw: Manager is a real coordinator runtime, not a one-shot Planner function.
- Learn Worker Runtime from HiClaw, while keeping AgentHub's coding-agent advantage: Claude Code, OpenCode, Codex, and Gemini are core Worker bases.
- Use local filesystem SharedStorage as the default lightweight contract store, but keep S3-compatible object key semantics so MinIO/S3 can be swapped in later.
- Abstract AI Gateway. Short term: LocalGateway/LiteLLM. Long term: Higress-style model/MCP/credential governance.
- A2A is no longer the first-stage internal communication backbone. Keep it for external interoperability or optional task semantic envelopes inside Matrix events.
- This is still development. Old sessions, tasks, database rows, and workspace/storage data are not architecture constraints. Prefer clearing/rebuilding old data over preserving old execution paths.

The four highest-priority kernel modules are:

1. Manager coordinator: runtime, persona config, skills, state, worker registry, Room communication, heartbeat/patrol.
2. Worker runtime: real participant identity, model binding, skills/MCP scope, heartbeat, sleep/wake/stop, runtime lease.
3. Matrix communication: real Matrix homeserver Room/timeline/participant/mention instead of session metadata or local tables pretending to be rooms. Prefer Tuwunel; keep Synapse/Conduit compatible.
4. Shared storage: filesystem-first ArtifactStore/SharedStorage with canonical `shared/tasks/{taskId}/...` object refs and S3-compatible object key semantics.

Use `docs/hiclaw-wiki.agent.final.md` and local `hiclaw源码参考/` as the main HiClaw reference materials.

## Layered Mental Model

Before changing code, identify which layer you are working on:

- Product interaction: IM group chat, global agent direct chat, task child conversations, task boards, artifact cards.
- Orchestration: Manager / Orchestrator, Manager actions, WorkLedger / dependency validation, Manager final review, approvals, cancellation, retry, resume.
- Communication: Matrix for Room/timeline/participant/mention semantics. This is the internal collaboration source of truth, backed by a real Matrix homeserver. `LocalMatrixCompatibleRoomAdapter` is test/dev fallback only.
- Protocol projection: AG-UI for frontend projections. A2A only for external interoperability or optional task semantic envelopes inside Matrix events.
- Execution: OpenClaw / QwenPaw are preferred Manager / Team Leader bases. Codex CLI, Claude Code, OpenCode, and Gemini CLI are the primary Worker bases. Plain `llm` is not a product-path runtime; keep it only for non-core fallback.
- Capabilities: MCP, Skills, Rules, shell, files, browser, and other tools are capabilities used by code agents, not agent runtime types.
- Collaboration contracts: user-explicit Specs may describe scope, allowed paths, required outputs, and acceptance criteria; they must not be trigger-based scenario templates.
- Workspace, storage, and state: the system default workspace root, Worker workdirs, filesystem-first ArtifactStore/SharedStorage, optional MinIO/S3 adapter, compatibility-only old `.agenthub/handoff`, resource events, trace events, and persisted task state.

Configuration truth is split deliberately:

- Model Management: model catalog, endpoints, credentials, model connectivity tests.
- Agent Runtimes / Agent Bases: Claude Code, OpenCode, Codex, Gemini, OpenClaw, QwenPaw installation status, native auth/config, and platform diagnostics only. Legacy UI may still say `Coding Tools`, but do not treat that as the architecture term.
- Agent Configuration: the only place allowed to choose `code agent × model × skills × sandbox`.

Keep the internal default model visible and separate. It is only for welcome prompts, temporary diagnostics, and non-core fallback paths. Manager / Orchestrator should run through OpenClaw / QwenPaw-style runtime and skills, not default to an internal LLM brain.

AgentHub should not become a fixed-role CrewAI clone or a thin LangGraph-only backend. The intended product is an IM-style collaboration workspace for multiple coding agents, with workflow/checkpoint/event-trace discipline behind it.

The next architecture direction is a lightweight HiClaw-style open kernel, not more patches on the old DAG-first path and not a direct copy of HiClaw's enterprise deployment stack. The default shape is one AgentHub server process plus CLI Worker subprocesses, AgentHub's own UI, Room/Matrix timeline semantics, and filesystem-first SharedStorage. Real Matrix/Tuwunel and MinIO/S3 remain adapters, not mandatory first-stage runtime dependencies. Kubernetes/full Higress/enterprise tenancy are not default first-stage dependencies, but their abstractions should shape Gateway and Controller/Reconciler boundaries. Gradually make `Room`, `TimelineEvent`, `Run`, `Task`, `WorkerInstance`, `Artifact`, and `RuntimeLease` first-class resources. `messages.ts` should shrink toward chat ingress and lightweight routing; task boards, child conversations, progress, and artifact cards should be projected from Room timeline, resource state, and AG-UI, not stitched together from legacy message metadata. See `docs/AgentHub-HiClaw-lite开源内核重构方案.md` before changing orchestration, child-thread, artifact, event, or runtime lifecycle code.

## Stack

- Runtime: Bun >= 1.1.0
- Monorepo: Bun workspaces under `apps/*` and `packages/*`
- Server: Hono on `Bun.serve`, HTTP and WebSocket on one port
- Web: React 18 + Vite + TypeScript
- UI: Tailwind CSS + Radix UI + `@assistant-ui/react`
- State: Zustand
- DB: SQLite via `bun:sqlite` + Drizzle ORM
- LLM: OpenAI-compatible and Anthropic-compatible streaming client
- Agent communication: internal collaboration uses real Matrix Room/timeline semantics; local Matrix-compatible adapter is test/dev fallback only; A2A is external interoperability only.
- Agent runtimes / bases: Manager: OpenClaw / QwenPaw. Workers: Codex CLI, Claude Code, OpenCode, Gemini CLI.
- MCP, Skills, and Rules are tool/capability layers for code agents, not agent runtime types.

## Commands

```bash
bun install
bun run dev
bun run dev:server
bun run dev:web
bun run typecheck
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck
bun test
bun test tests/orchestrator-routing.test.ts
```

## Current Architecture

### Message Routing

Main entry: `apps/server/src/routes/messages.ts`.

```text
POST /api/messages/:sessionId
  -> direct chat: run target agent
  -> group simple chat: Orchestrator replies directly
  -> group capability gap: Orchestrator emits structured memberProposals; UI shows an approval card; confirmed proposals create/join real workspace agents
  -> group complex task: Manager creates a team action plan + task board
  -> dispatch: Coordinator assign creates task rooms, leases, and WorkerRuntime execution
```

Old `GroupChatManager` is deprecated. Do not reintroduce it as the active group path.

### Orchestrator

Core files:

- `apps/server/src/services/orchestrator/manager-planner.ts`
- `apps/server/src/services/orchestrator/planner.ts`
- `apps/server/src/services/orchestrator/run-events.ts`
- `apps/server/src/services/manager-runtime/types.ts` — ManagerRuntime 接口、Tool/Action/Skill 类型
- `apps/server/src/services/manager-runtime/skill-loader.ts` — 从 SKILL.md 加载 16 个技能
- `apps/server/src/services/manager-runtime/tool-registry.ts` — 22 个 Controller API executor
- `apps/server/src/services/manager-runtime/local-manager-runtime.ts` — LLM tool-calling loop
- `apps/server/src/services/manager-runtime/openclaw-launcher.ts` — OpenClaw 进程管理

Execution flow:

```text
messages.ts works as ChatIngress
  -> RunController / ManagerLoop creates run.started + manager.thinking
  -> RunController asks the Manager runtime for next action
  -> Manager-first planning action produces executable Worker tasks
  -> CoordinatorRuntime returns assign actions
  -> dispatchCoordinatorAssignBatch creates task rooms + RuntimeLeases
  -> WorkerRuntimeService.runTaskRoom executes via Code Agent CLI
  -> Worker progress/results/artifacts write to Room timeline
  -> ArtifactStore registers artifacts with S3-compatible object keys
  -> RunController syncs task/thread/run state
  -> ManagerLoop does final review from Room timeline + ArtifactStore
  -> main group chat receives Manager review + artifact cards
```

`OrchestratorEngine`, `TaskExecutionService`, `LocalA2ATransport` have been deleted. All execution goes through `RunController` / `ManagerLoop` / `WorkerRuntimeService` / `CoordinatorRuntime` / `RoomService` / `ArtifactStore`.

### Matrix / A2A Boundary

Target internal collaboration uses Matrix:

- Human, Manager, and Worker are Room participants.
- Manager assignment, Worker progress, clarification, failure, artifact refs, and Human interruption should appear on Room timelines.
- AgentHub keeps its own UI; Element Web is not the default product shell.

A2A is kept for interoperability:

- A2A is a protocol, not an agent runtime type.
- Remote A2A endpoints belong in `roleProfile.protocol = "a2a"` plus `roleProfile.a2aEndpoint`.
- Old A2A envelopes may become optional `taskEnvelope` payloads inside Matrix events.
- Do not reintroduce `runtimeType = "a2a"` or show A2A as a selectable agent kind.

`LocalA2ATransport` and the old internal A2A execution chain have been deleted. Keep only protocol mapping helpers for external interoperability or optional Matrix `taskEnvelope` payloads; do not rebuild a local A2A transport as the internal task path.

### Session Tree Rules

Core files:

- `apps/web/src/lib/sessionTree.ts`
- `apps/web/src/components/chat/SessionList.tsx`
- `apps/web/src/stores/chatStore.ts`
- `apps/web/src/lib/ws.ts`

Rules:

- `direct + metadata.kind === "agent-direct"` belongs in the global Agent private chat list.
- `group` belongs in the group chat list.
- `direct + metadata.kind === "orchestrator-task"` is a real task child conversation under a group.
- `workspace-agent-child` is legacy and should not appear as the current group child UX.
- Do not fabricate "missing member" child sessions in the group tree. Only show real task child sessions.

### Workspace And Workdirs

Current default design is not branch-per-agent. The active path is a normal local project directory plus AgentHub-managed subdirectories:

```text
{projectRoot}/.agenthub/
  workdirs/{runId}/{agentName}/{taskId}/
  handoff/{runId}/{taskId}/
```

Important files:

- `apps/server/src/services/execution/agent-workdir.ts`
- `apps/server/src/services/execution/agent-execution-envelope.ts`
- `apps/server/src/services/worker-runtime/worker-runtime-service.ts`

Rules:

- Code agents execute in `.agenthub/workdirs/...` with `workspace-write` by default.
- `read-only` is no longer a public code-agent sandbox option; express research/review safety through role duties, tool permissions, context policy, and approval policy.
- If the user did not choose a project workspace, AgentHub creates an auto workspace under the system user data directory, such as `%LOCALAPPDATA%\AgentHub\workspaces` on Windows. Do not fall back to the AgentHub source repository.
- Each task also gets a sandbox root under the system cache directory, used for temp/cache/config isolation for CLI runtimes.
- Execution isolation is behind `SandboxProvider`; the current default provider is `local-workdir` because it best matches the lightweight local Coding Agent experience. `docker-sandbox` is optional and should run only when explicitly enabled and `sandboxRunnable=true`. `local-workdir` hardens workdir plus process env, but it is not an OS/network permission sandbox.
- For code agents, user-facing sandbox choices are now only `workspace-write` and `danger-full-access`. Do not reintroduce `read-only` as a public code-agent option.
- New upstream artifacts that can be reused by downstream agents are copied first into `.agenthub/shared/tasks/{taskId}/artifacts/...`; `.agenthub/handoff/...` is only a compatibility or historical path.
- Downstream prompts must prefer `handoffPath`.
- If a blackboard entry only has `filePath` or `path`, treat it as an upstream record, not as proof that the file exists in the current workdir.

### Runtime Layer

Core files:

- `apps/server/src/services/runtime/agent-runtime.ts`
- `apps/server/src/services/runtime/runtime-registry.ts`
- `apps/server/src/services/runtime/llm-runtime.ts`
- `apps/server/src/services/runtime/code-agent-runtime.ts`
- `apps/server/src/services/code-agent-adapter.ts`

When reporting CLI errors, use the actual adapter display name. For example, an OpenCode failure must not say "Codex CLI started".

If a CLI generated files but failed later, report it as a failed task with partial artifacts retained. Do not say the task produced nothing.

User-created agents are specialist profiles on top of coding agents: name, role, system prompt, tool permissions, MCP/Skills, sandbox policy, and context policy. Do not model them as plain LLM agents unless explicitly configured as fallback.

## Data Model

Important tables:

- `sessions`: direct/group conversations and metadata kind.
- `messages`: chat messages and task result metadata.
- `workspaces`: local project workspaces.
- `workspace_agents`: group members.
- `workspace_tasks`: DAG tasks, progress, artifacts, child session IDs.
- `orchestrator_runs`: orchestration lifecycle.
- `blackboard_entries`: structured handoff state between agents.
- `execution_logs`: execution traces.
- `settings`: model/provider and app settings.

## Frontend Notes

Key components:

- `Thread.tsx`: message rendering and task board message parts.
- `TaskBoard.tsx`: DAG task progress, child conversation links, artifacts.
- `SessionList.tsx`: left navigation and group child tree.
- `WorkspaceChatPage.tsx`: chat page layout.
- `GlobalNewSessionDialog.tsx`: new private/group chat flow and workspace selection.

Design constraints:

- Keep the UI IM-like, not a landing page.
- The first screen should be usable chat/workspace UI.
- Do not place group child placeholders under the group list.
- Running state must be visible before the final message appears.
- Child conversation links should open the actual `orchestrator-task` session.

## Environment

Common environment variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite database path |
| `PORT` | server start port |
| `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | default model config |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | OpenAI-compatible config |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` | Anthropic config |
| `ENABLE_LOCAL_CLI_PROBES` | probe local CLIs |
| `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION` | enable Code Agent execution |
| `AGENTHUB_CODE_AGENT_TIMEOUT_MS` | Code Agent timeout; dev default should be 600000 |
| `AGENTHUB_ENABLE_DYNAMIC_QUICK_PROMPTS` | model-generated quick prompts |

## Error Handling

- Use `AppError` and `AppErrorCodes` in new routes.
- Do not add raw `HTTPException` in new code.
- Use `apps/server/src/lib/logger.ts`; avoid `console.log`.
- Include request/run/task IDs in logs when available.

## Testing Expectations

For routing or orchestration changes, run:

```bash
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck
bun test tests/orchestrator-routing.test.ts
```

Broader changes should also run:

```bash
bun test
```

## Deprecated Or Risky Areas

- `workspace-agent-child`: legacy child session design. Keep hidden from current group UX.
- A2A/MCP/Skills as runtime types: removed from the active identity model. They are protocol/capability layers.
- Static fallback plan templates: avoid as normal UX. Prefer model-generated dynamic plans.
- Built-in `.agenthub/specs/*.spec.yml` scenario templates and trigger-based Spec matching are removed. Specs may return only as user-explicit collaboration contracts.
- Static agent routing, keyword-based task reassignment, auto Researcher injection, and artifact-extension follow-up tasks are removed from the active path. Do not reintroduce them; validate explicit Manager / Orchestrator choices instead.
- Do not add keyword heuristic fallbacks for Orchestrator decisions. If the Orchestrator output is not parseable, surface a transparent model/config error.
- Runtime member additions must be driven by structured `memberProposals` from Orchestrator and explicit user approval. Do not silently create agents.
- `classic` workspace seeding, default code teams, and `create-from-template` are removed from the active product path.
- Branch-per-agent docs: old design. Git utilities may remain, but current default execution is workdir + handoff.
- Old static quick prompt fallback: user does not want static prompt content.
- `GroupChatManager`: deprecated path; do not route new group behavior through it.

## Coding Style

- ESM throughout.
- TypeScript strict mode.
- Prefer existing patterns and small scoped edits.
- Use structured parsing/data models instead of string hacks when possible.
- Keep Chinese UI copy concise and explicit.
- Do not revert unrelated user changes.
