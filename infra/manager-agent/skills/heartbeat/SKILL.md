---
name: heartbeat
description: Use during Manager patrol to inspect room bindings, Worker health, RuntimeLeases, and active tasks.
---

# Heartbeat

Heartbeat is quiet patrol. It should not spam rooms.

## Inspect

- `state.json`
- `rooms.json`
- `workers-registry.json`
- Controller Worker runtime diagnostics
- active runs, tasks, RuntimeLeases, and task rooms

## Commands

```bash
# Read the current Controller operation schema.
agenthub schema

# Quiet heartbeat ping.
agenthub heartbeat --workspace <workspace-id>

# Refresh the Manager contract workspace and registries.
# Contract-only unless manager.yaml explicitly sets spec.desiredState.
agenthub apply -f manager.yaml
```

## Manager Manifest

```yaml
kind: Manager
metadata:
  name: global
spec:
  runtimeType: openclaw
  # Optional: running | stopped | observed
  desiredState: observed
  controllerUrl: <controller-url>
  matrixServerName: agenthub.local
```

## Health Fields

- `lastHeartbeatAt`
- `lastMatrixSyncAt`
- `lastRuntimeReadyAt`
- `lastTaskStartedAt`
- `lastTaskCompletedAt`
- `lastError`
- `queueDepth`

## Decision Pattern

1. `agenthub schema` to inspect `managers.reconcile`, `heartbeat.manager`, and `apply.manifest`.
2. Compare expected rooms and Workers with Controller status.
3. Refresh Manager mirrors with `agenthub apply -f manager.yaml` if local registries are stale.
4. Detect stale bindings, stale leases, failed runtimes, and waiting approvals.
5. Use `error-recovery` when action is needed.
6. Stay quiet when healthy.
