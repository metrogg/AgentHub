---
name: worker-management
description: Use when you need to create, inspect, wake, sleep, stop, or update Worker agents.
---

## Purpose

Manage the lifecycle of Worker agents. Workers are the execution units that handle concrete tasks.

## Tools

Use the AgentHub Controller API to manage workers:

### List Workers
```bash
curl -s http://localhost:8000/api/workspaces/{workspaceId}/agents | jq .
```

### Create Worker
```bash
curl -s -X POST http://localhost:8000/api/workspaces/{workspaceId}/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"builder","role":"Frontend Builder","roleType":"coder","runtimeType":"code-agent","codeAgentType":"opencode"}'
```

### Get Worker Status
```bash
curl -s http://localhost:8000/api/workspaces/{workspaceId}/agents/{agentId} | jq .
```

## Rules

- Prefer existing suitable workers before creating a new one.
- New worker creation must be visible in the room — announce it.
- Worker names must be lowercase alphanumeric with hyphens.
- Each Worker needs: name, role, roleType, runtimeType, and optionally codeAgentType.

## Decision Pattern

1. Read the room timeline to understand what worker capability is needed.
2. Check existing workers with the list tool.
3. If a suitable worker exists, use it. If not, propose creating one.
4. After creating a worker, announce it in the room.
