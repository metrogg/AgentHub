# Manager Tools Quick Reference

## Skills Overview

| Skill | When to Use | Key Tools |
|-------|-------------|-----------|
| worker-management | Create, list, wake, stop workers | `curl /api/workspaces/{id}/agents` |
| task-management | Create runs, assign tasks, check status | `curl /api/orchestrator-runs` |
| channel-management | Manage rooms, send messages, participants | Matrix message tool, `curl /api/rooms` |

## Cross-Skill Combos

| Scenario | Skill Chain |
|----------|-------------|
| User gives a complex task | task-management (create run) → worker-management (check workers) → channel-management (announce) |
| Worker fails | task-management (retry or cancel) → worker-management (check status) |
| User asks a simple question | Just reply directly (no skill needed) |
| Create a team | worker-management (create workers) → task-management (assign tasks) |

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

## Mandatory Rules

1. Use `curl` to call the Controller API — never try to edit database files directly.
2. Always @mention workers when assigning tasks.
3. Push artifacts before notifying downstream workers.
4. Register every task in the orchestrator before executing.
5. Report only when there are issues — stay quiet if everything is normal.
6. Use concise Chinese for all visible messages unless the room context asks otherwise.
