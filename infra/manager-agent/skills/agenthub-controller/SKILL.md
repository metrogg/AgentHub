# Skill: AgentHub Controller API

## When to Use

Use this skill whenever you need to:
- Create a new task for a Worker
- Create a new Worker
- Check the status of a run or task
- List available Workers
- Send a heartbeat to AgentHub

## Authentication

Your Manager token is available in the environment:
```
AGENTHUB_MANAGER_TOKEN=<your-matrix-access-token>
AGENTHUB_CONTROLLER_URL=http://localhost:3001
```

Always include the token in the Authorization header:
```
Authorization: Bearer $AGENTHUB_MANAGER_TOKEN
```

## API Endpoints

### 1. Create Task

Create a task and assign it to a Worker.

```bash
curl -s -X POST "$AGENTHUB_CONTROLLER_URL/api/internal/manager/actions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENTHUB_MANAGER_TOKEN" \
  -d '{
    "action": "create_task",
    "params": {
      "workspaceId": "<workspace-id>",
      "runId": "<run-id-or-omit>",
      "title": "Task title",
      "spec": "## Goal\nWhat to do.\n\n## Requirements\n- Requirement 1\n- Requirement 2",
      "assignToAgentId": "<agent-id>"
    }
  }'
```

**Rules:**
- `workspaceId` is required. Get it from the room metadata or workspace context.
- `runId` is optional. If omitted, a new run will be created.
- `spec` should be a markdown document with clear goal and requirements.
- Either `assignToAgentId` or `assignToWorkerInstanceId` is required.
- The response contains `result.runId`, `result.tasks[].taskId`, `result.tasks[].taskRoomId`.

### 2. Create Worker

Create a new Worker agent.

```bash
curl -s -X POST "$AGENTHUB_CONTROLLER_URL/api/internal/manager/actions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENTHUB_MANAGER_TOKEN" \
  -d '{
    "action": "create_worker",
    "params": {
      "workspaceId": "<workspace-id>",
      "name": "builder-1",
      "runtimeType": "code-agent",
      "codeAgentType": "codex",
      "modelId": "gpt-4o"
    }
  }'
```

**Rules:**
- `name` must be unique within the workspace.
- `runtimeType`: `code-agent` (default) or `llm`.
- `codeAgentType`: `codex`, `claude-code`, `opencode`, `gemini`.
- The response contains `agentId` and `worker` details.

### 3. List Workers

List all Workers in a workspace.

```bash
curl -s -X POST "$AGENTHUB_CONTROLLER_URL/api/internal/manager/actions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENTHUB_MANAGER_TOKEN" \
  -d '{
    "action": "list_workers",
    "params": {
      "workspaceId": "<workspace-id>"
    }
  }'
```

### 4. Get Workspace State

Get the full state of a workspace: latest run, tasks, workers, agents.

```bash
curl -s -X POST "$AGENTHUB_CONTROLLER_URL/api/internal/manager/actions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENTHUB_MANAGER_TOKEN" \
  -d '{
    "action": "get_workspace_state",
    "params": {
      "workspaceId": "<workspace-id>"
    }
  }'
```

### 5. Heartbeat

Send a heartbeat to AgentHub.

```bash
curl -s -X POST "$AGENTHUB_CONTROLLER_URL/api/internal/manager/actions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENTHUB_MANAGER_TOKEN" \
  -d '{
    "action": "heartbeat",
    "params": {
      "workspaceId": "<workspace-id>"
    }
  }'
```

## Task File Protocol

When you create a task, AgentHub automatically writes files to:
```
.agenthub/shared/tasks/<task-id>/
  meta.json     # Task metadata
  spec.md       # Task specification (you should write this before creating the task)
  plan.md       # Execution plan (Worker writes this)
  result.md     # Final result (Worker writes this)
  artifacts/    # Deliverables (Worker writes this)
```

**Rules:**
1. Write `spec.md` BEFORE calling `create_task` if you want full control over the specification.
2. The `spec` param in `create_task` will be used as the task description if `spec.md` is not pre-written.
3. Workers read `spec.md` before executing.
4. After creating a task, @mention the Worker in their task room with the task ID.

## Decision Pattern

### Simple goal (1 task, 1 Worker)
1. Check available Workers via `list_workers`
2. If no suitable Worker, create one via `create_worker`
3. Create task via `create_task`
4. @mention Worker in task room with task ID and spec path

### Complex goal (multiple tasks)
1. Analyze dependencies
2. Create Workers if needed
3. Create run + tasks in dependency order
4. @mention each Worker when their dependencies are met
5. Monitor progress via `get_run_status`
6. Synthesize results when all tasks complete

## Error Handling

- HTTP 401: Token expired or invalid. Do not retry; report to human.
- HTTP 404: Resource not found. Check IDs.
- HTTP 422: Validation failed. Read the error message and fix params.
- Network errors: Retry up to 3 times with 2s backoff.
