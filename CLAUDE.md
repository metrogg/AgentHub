# AgentHub Development Guide

This file is for Claude Code and other coding agents working inside this repository. For product context, first read `README.md` and `docs/当前状态与下一步路线.md`, then read `docs/当前多Agent协作架构.md`, `docs/场景角色团队协作调研.md`, `docs/角色提示词与动态组队设计.md`, `docs/专家库与开源角色Skill生态调研.md`, `docs/SpecKit契约与AGUI事件落地路线.md`, and `docs/多Agent协作分层架构与业内对比.md`.

## Product Definition

AgentHub is an IM-style multi-agent collaboration platform. The expected behavior is:

1. The user starts from a group chat.
2. Orchestrator reasons about the request and creates a dynamic task DAG.
3. Multiple agents receive concrete tasks in their own child conversations.
4. The main group chat shows orchestration progress, member reports, artifacts, and final synthesis.
5. Users can open child conversations to inspect each agent's real execution trace.

Do not implement fixed scenario templates as the core path. The platform must stay general-purpose first.
Role presets may be used as a manual creation library, but they must not auto-seed a workspace, define a default team, or override model-generated assignments.
Role prompts should follow `docs/角色提示词与动态组队设计.md`: shared collaboration protocol + role background + bound skills + runtime task context + output contract. Group goals may drive member recommendations, but not fixed execution templates. If an existing group lacks needed capability, Orchestrator may propose adding a new agent; this must be visible and user-approved by default.
Preinstalled agent templates and lightweight expert-team recommendations live in `docs/专家库与开源角色Skill生态调研.md`. You may borrow structure from Claude Code subagents, BMAD, SuperClaude, awesome-cursor-skills, and MCP server ecosystems, but first adapt for license, safety boundaries, quality, and AgentHub schemas. Do not build a separate "my experts" system or full expert marketplace yet, and do not directly copy unaudited prompts or enable third-party MCP servers by default.

## Layered Mental Model

Before changing code, identify which layer you are working on:

- Product interaction: IM group chat, global agent direct chat, task child conversations, task boards, artifact cards.
- Orchestration: Orchestrator, Planner, dynamic DAG, TaskScheduler, Synthesizer, approvals, cancellation, retry, resume.
- Protocols: A2A for agent-to-agent message/task/artifact semantics; AG-UI for run events surfaced to the frontend.
- Execution: Codex CLI, Claude Code, OpenCode, and Gemini CLI are the primary agent bases. `llm` is internal/fallback support.
- Capabilities: MCP, Skills, Rules, shell, files, browser, and other tools are capabilities used by code agents, not agent runtime types.
- Collaboration contracts: user-explicit Specs may describe scope, allowed paths, required outputs, and acceptance criteria; they must not be trigger-based scenario templates.
- Workspace and state: the system default workspace root, `.agenthub/workdirs`, `.agenthub/handoff`, blackboard entries, execution logs, run events, and persisted task state.

AgentHub should not become a fixed-role CrewAI clone or a thin LangGraph-only backend. The intended product is an IM-style collaboration workspace for multiple coding agents, with workflow/checkpoint/event-trace discipline behind it.

## Stack

- Runtime: Bun >= 1.1.0
- Monorepo: Bun workspaces under `apps/*` and `packages/*`
- Server: Hono on `Bun.serve`, HTTP and WebSocket on one port
- Web: React 18 + Vite + TypeScript
- UI: Tailwind CSS + Radix UI + `@assistant-ui/react`
- State: Zustand
- DB: SQLite via `bun:sqlite` + Drizzle ORM
- LLM: OpenAI-compatible and Anthropic-compatible streaming client
- Agent communication: A2A v0.3 `message/send` via AgentHub local transport
- Code agents: Codex CLI, Claude Code, OpenCode, Gemini CLI
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
  -> group complex task: create dynamic plan + task board
  -> dispatch: OrchestratorEngine.dispatch()
```

Old `GroupChatManager` is deprecated. Do not reintroduce it as the active group path.

### Orchestrator

Core files:

- `apps/server/src/services/orchestrator/orchestrator-engine.ts`
- `apps/server/src/services/orchestrator/planner.ts`
- `apps/server/src/services/orchestrator/task-scheduler.ts`
- `apps/server/src/services/orchestrator/task-graph.ts`
- `apps/server/src/services/orchestrator/synthesizer.ts`
- `apps/server/src/services/orchestrator/run-events.ts`

Execution flow:

```text
OrchestratorEngine.dispatch()
  -> Planner produces ExecutionPlan
  -> workspace_tasks + orchestrator_runs persist run state
  -> ensureOrchestratorTaskSession() creates child sessions
  -> TaskScheduler executes dependency layers
  -> Orchestrator builds A2A message/send envelope
  -> TaskExecutionService sends through LocalA2ATransport
  -> local execution host adapts to LLM fallback / Code Agent runtime
  -> blackboard stores summaries, decisions, artifact refs as A2A metadata/artifact extensions
  -> .agenthub/handoff materializes readable upstream artifacts
  -> main group chat receives task result messages
  -> Synthesizer writes final summary
```

### A2A Boundary

Internal agent-to-agent task dispatch must use A2A objects, not a parallel hidden protocol:

- `apps/server/src/services/protocols/a2a-internal.ts` builds the internal `message/send` envelope and response `Task`.
- `apps/server/src/services/execution/local-a2a-transport.ts` is the local transport facade.
- Child conversation user messages persist the A2A request envelope in metadata.
- Agent outputs and group task reports persist A2A response message/task metadata.
- A2A is a communication protocol, not an agent runtime type. Remote A2A endpoints belong in `roleProfile.protocol = "a2a"` plus `roleProfile.a2aEndpoint`.
- Blackboard and `.agenthub/handoff` remain AgentHub extensions to A2A artifacts, not separate static routing systems.

The current implementation is an internal A2A envelope plus AgentHub local transport. Do not reintroduce `runtimeType = "a2a"` or show A2A as a selectable agent kind.

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
- `apps/server/src/services/execution/task-execution-service.ts`

Rules:

- Write-capable agents execute in `.agenthub/workdirs/...`.
- Read-only agents may read the project root.
- If the user did not choose a project workspace, AgentHub creates an auto workspace under the system user data directory, such as `%LOCALAPPDATA%\AgentHub\workspaces` on Windows. Do not fall back to the AgentHub source repository.
- Each task also gets a sandbox root under the system cache directory, used for temp/cache/config isolation for CLI runtimes.
- Execution isolation is behind `SandboxProvider`; the default provider is now `docker-sandbox`, with `local-workdir` only as a compatibility fallback. `local-workdir` hardens workdir plus process env, but it is not an OS/network permission sandbox.
- Upstream artifacts that can be reused by downstream agents are copied into `.agenthub/handoff/...`.
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
- Static agent routing, keyword-based task reassignment, auto Researcher injection, and artifact-extension follow-up tasks are removed from the active path. Do not reintroduce them; validate explicit Orchestrator/Planner assignments instead.
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
