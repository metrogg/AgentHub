---
name: worker-management
description: Use when you need to create, inspect, wake, sleep, stop, or update Worker agents.
---

# Worker Management

Manage the lifecycle of Worker agents via the `agenthub` CLI.

## Commands

```bash
# Read the current Controller operation schema before creating or changing Workers.
agenthub schema

# List all workers
agenthub worker list --workspace <workspace-id>

# Create a new worker with an explicit Worker runtime base
agenthub worker create --workspace <workspace-id> --name builder --runtime-base <openclaw|qwenpaw|opencode|claude-code|codex|gemini> --model <model-id> --join-group-room true

# Apply a declarative Worker manifest through Member Reconcile
agenthub apply -f worker.yaml

# Check worker status
agenthub worker status --id <worker-id>

# Wake a sleeping worker
agenthub worker wake --id <worker-id>

# Stop a running worker
agenthub worker stop --id <worker-id>
```

## Worker Manifest

Use a manifest when the worker needs role text, skills, sandbox policy, or room membership to be auditable.

```yaml
kind: Worker
metadata:
  name: builder
spec:
  workspaceId: <workspace-id>
  name: builder
  displayName: Builder
  description: Implements project changes and reports artifacts.
  runtimeBase: <openclaw|qwenpaw|opencode|claude-code|codex|gemini>
  modelId: <model-id>
  skillIds:
    - task-management
    - artifact-management
  sandboxPolicy:
    mode: workspace-write
  joinGroupRoom: true
  announce: true
```

## Rules

- Prefer existing suitable workers before creating a new one.
- New worker creation must be visible in the room — announce it.
- Worker names must be lowercase alphanumeric with hyphens.
- Each Worker needs: name, Worker runtime base, model binding, skills, and sandbox policy.
- Never default a missing runtime base to Codex. Ask the human or report the missing configuration.
- Use `--runtime-base`; `--code-agent` is only a compatibility alias for Codex/OpenCode/Claude Code/Gemini CLI bases and must not be used as a default.
- OpenClaw/QwenPaw Workers are resident Worker bases. They should eventually listen to Matrix rooms themselves.
- Claude Code/OpenCode/Codex/Gemini Workers may currently be AgentHub-managed bridge Workers, but they must still use the same Room timeline, SOUL/AGENTS, skills, RuntimeLease, and shared task contract.
- If the user says "use what I have installed", list available Worker runtime diagnostics first instead of guessing.
- Prefer `agenthub apply -f worker.yaml` when creating a real member from a proposal, because it lets Controller record the desired runtime base, skills, sandbox, room join, and reconcile result together.
- Do not create a Worker by only sending a chat message. A Worker exists only after Controller has created or reconciled the `workspace_agent`, `worker_instance`, Matrix identity, Room participant, workspace contract, and runtime readiness.

## Worker Reconcile Stages

1. ResolveMemberSpec — name, role, runtime base, model, skills, sandbox.
2. ApplyWorkspaceAgent — persistent Agent profile.
3. ApplyWorkerInstance — lifecycle resource and runtime binding.
4. JoinRooms — group room, direct room, task rooms, Matrix identity.
5. AnnounceAndObserve — Manager announcement and Worker ready/listening status.

## Decision Pattern

1. `agenthub schema` to confirm Worker create/apply fields and runtime enum.
2. Read the room timeline to understand what worker capability is needed.
3. `agenthub worker list --workspace <id>` to check existing workers.
4. If a suitable worker exists, use it. If not, propose creating one with explicit runtime base, model, skills, and sandbox.
5. After human confirmation or explicit instruction, create via `agenthub worker create` or `agenthub apply -f worker.yaml`.
6. Let Member Reconcile join rooms and announce readiness; do not manually pretend the Worker joined.
7. If creation fails, report the failed reconcile stage and configuration blocker.
