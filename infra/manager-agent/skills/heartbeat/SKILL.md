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

## Health Fields

- `lastHeartbeatAt`
- `lastMatrixSyncAt`
- `lastRuntimeReadyAt`
- `lastTaskStartedAt`
- `lastTaskCompletedAt`
- `lastError`
- `queueDepth`

## Decision Pattern

1. Compare expected rooms and Workers with Controller status.
2. Detect stale bindings, stale leases, failed runtimes, and waiting approvals.
3. Use `error-recovery` when action is needed.
4. Stay quiet when healthy.
