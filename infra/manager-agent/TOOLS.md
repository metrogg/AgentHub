# Manager Tools Quick Reference

## Skills Overview

| Skill | When to Use | Key Tools |
|-------|-------------|-----------|
| worker-management | Create, list, wake, stop workers | `curl /api/workspaces/{id}/agents` |
| task-management | Create runs, assign tasks, check status | `curl /api/orchestrator-runs` |
| channel-management | Manage rooms, send messages, participants | Matrix message tool, `curl /api/rooms` |
| file-sync-management | Register artifacts, read shared results | `curl /api/artifacts` |
| human-management | Handle clarifications, approvals, interventions | Room timeline events |
| project-management | Multi-worker projects with DAG plans | `curl /api/orchestrator-runs` + task dependencies |
| heartbeat | Periodic health check | Read `~/HEARTBEAT.md` |
| memory-management | Record and recall decisions | Write to `~/memory/` |

## Cross-Skill Combos

| Scenario | Skill Chain |
|----------|-------------|
| User gives a complex task | task-management → worker-management (check workers) → channel-management (create rooms) |
| Worker fails | error-recovery → worker-management (retry or replace) → task-management (reassign) |
| User asks a simple question | Just reply directly (no skill needed) |
| Create a team | worker-management (create workers) → channel-management (create rooms) → task-management (assign tasks) |
| Check project status | task-management (list tasks) → channel-management (read room timeline) |

## AgentHub Controller API

The AgentHub server runs at `http://localhost:8000`. Key endpoints:

### Workspaces
- `GET /api/workspaces` — List workspaces
- `POST /api/workspaces` — Create workspace
- `GET /api/workspaces/{id}/agents` — List agents in workspace
- `POST /api/workspaces/{id}/agents` — Create agent

### Orchestrator
- `POST /api/orchestrator-runs` — Create a run
- `GET /api/orchestrator-runs/{id}` — Get run status
- `GET /api/orchestrator-runs/{id}/tasks` — List tasks
- `POST /api/orchestrator-runs/{id}/retry-task/{taskId}` — Retry task
- `POST /api/orchestrator-runs/{id}/cancel` — Cancel run

### Rooms
- `GET /api/rooms/{roomId}` — Get room
- `GET /api/rooms/{roomId}/timeline` — Get timeline events
- `GET /api/rooms/{roomId}/participants` — List participants

### Artifacts
- `GET /api/artifacts?taskId={id}` — List artifacts for task
- `POST /api/artifacts` — Register artifact

## Mandatory Rules

1. Use `curl` to call the Controller API — never try to edit database files directly.
2. Always @mention workers when assigning tasks.
3. Push artifacts before notifying downstream workers.
4. Register every task in the orchestrator before executing.
5. Report only when there are issues — stay quiet if everything is normal.
