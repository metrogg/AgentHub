# AgentHub Development Guide

This file is for Claude Code and other coding agents working inside this repository. For product context, also read `README.md` and `docs/当前多Agent协作架构.md`.

## Product Definition

AgentHub is an IM-style multi-agent collaboration platform. The expected behavior is:

1. The user starts from a group chat.
2. Orchestrator reasons about the request and creates a dynamic task DAG.
3. Multiple agents receive concrete tasks in their own child conversations.
4. The main group chat shows orchestration progress, member reports, artifacts, and final synthesis.
5. Users can open child conversations to inspect each agent's real execution trace.

Do not implement fixed scenario templates as the core path. The platform must stay general-purpose first.

## Stack

- Runtime: Bun >= 1.1.0
- Monorepo: Bun workspaces under `apps/*` and `packages/*`
- Server: Hono on `Bun.serve`, HTTP and WebSocket on one port
- Web: React 18 + Vite + TypeScript
- UI: Tailwind CSS + Radix UI + `@assistant-ui/react`
- State: Zustand
- DB: SQLite via `bun:sqlite` + Drizzle ORM
- LLM: OpenAI-compatible and Anthropic-compatible streaming client
- Code agents: Codex CLI, Claude Code, OpenCode, Gemini CLI

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
  -> TaskExecutionService runs each agent
  -> blackboard stores summaries, decisions, artifact refs
  -> .agenthub/handoff materializes readable upstream artifacts
  -> main group chat receives task result messages
  -> Synthesizer writes final summary
```

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
- Upstream artifacts that can be reused by downstream agents are copied into `.agenthub/handoff/...`.
- Downstream prompts must prefer `handoffPath`.
- If a blackboard entry only has `filePath` or `path`, treat it as an upstream record, not as proof that the file exists in the current workdir.

### Runtime Layer

Core files:

- `apps/server/src/services/runtime/agent-runtime.ts`
- `apps/server/src/services/runtime/runtime-registry.ts`
- `apps/server/src/services/runtime/llm-runtime.ts`
- `apps/server/src/services/runtime/code-agent-runtime.ts`
- `apps/server/src/services/runtime/native-tool-runtime.ts`
- `apps/server/src/services/code-agent-adapter.ts`

When reporting CLI errors, use the actual adapter display name. For example, an OpenCode failure must not say "Codex CLI started".

If a CLI generated files but failed later, report it as a failed task with partial artifacts retained. Do not say the task produced nothing.

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
- Static fallback plan templates: avoid as normal UX. Prefer model-generated dynamic plans.
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
