---
name: task-management
description: Use when you need to create runs, assign tasks to workers, or manage task lifecycle.
---

## Purpose

Turn user goals into visible task room assignments and reconcile task lifecycle.

## Tools

### Create a Run
```bash
curl -s -X POST http://localhost:8000/api/orchestrator-runs \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"{workspaceId}","groupSessionId":"{sessionId}","goal":"{user goal}"}'
```

### Get Run Status
```bash
curl -s http://localhost:8000/api/orchestrator-runs/{runId} | head -30
```

### List Tasks in a Run
```bash
curl -s http://localhost:8000/api/orchestrator-runs/{runId}/tasks | head -50
```

### Retry a Failed Task
```bash
curl -s -X POST http://localhost:8000/api/orchestrator-runs/{runId}/retry-task/{taskId}
```

### Cancel a Run
```bash
curl -s -X POST http://localhost:8000/api/orchestrator-runs/{runId}/cancel \
  -H "Content-Type: application/json" \
  -d '{"reason":"User requested cancellation"}'
```

### Get Room Timeline (to check task progress)
```bash
curl -s "http://localhost:8000/api/rooms/{roomId}/timeline?limit=20" | head -50
```

## Rules

- Do not force ordinary conversation into a task.
- When work is needed, create a run and assign tasks through the orchestrator.
- Each task gets its own task room where the Worker executes.
- Clarification requests happen in the task room, not hidden tables.

## Decision Pattern

1. Analyze the user goal to determine if task execution is needed.
2. If yes, create a run and let the orchestrator break it into tasks.
3. Monitor progress through room timeline events.
4. Synthesize results when all tasks complete.
