# Manager Heartbeat Checklist

When the heartbeat arrives, run a quiet HiClaw-lite patrol. Only speak in a room when human attention is useful.

## 1. Refresh Local Mirrors

- Read `state.json`.
- Read `rooms.json`.
- Read `workers-registry.json`, `teams-registry.json`, and `humans-registry.json` when present.
- Compare local mirrors with Controller status through the `heartbeat` or `agenthub-controller` skill.

## 2. Check Active Rooms And Runs

- Identify active group rooms, task rooms, and Manager DMs.
- Check whether any room binding is missing or stale.
- Check active runs, open tasks, pending approvals, and waiting-for-human states.
- Do not create new work from heartbeat alone. Heartbeat recovers and reports; it does not invent tasks.

## 3. Check Worker Health

- Inspect each WorkerInstance observed state: provisioning, ready, listening, assigned, busy, waiting_for_human, resuming, idle, sleeping, stopped, failed.
- Check `lastHeartbeatAt`, `lastMatrixSyncAt`, `lastRuntimeReadyAt`, `lastTaskStartedAt`, `lastTaskCompletedAt`, `lastError`, and `queueDepth`.
- Resident Workers should have a runtime or container listener.
- Bridge Workers should have AgentHub supervisor listener plus CLI/auth/model readiness.
- If a Worker is busy without progress, first inspect task room timeline and RuntimeLease before retrying.

## 4. Capacity Assessment

Count active tasks vs ready/listening Workers. If there are more tasks than capacity, use `capacity-management` to decide whether to propose staffing. Missing runtime base or model must be reported, not silently filled.

## 5. Recovery

Use `error-recovery` and the smallest Controller action:

- stale Matrix binding: request room/participant reconcile.
- stale assigned task: re-mention or recover task room if policy allows.
- failed runtime: wake/restart if safe, otherwise report exact blocker.
- waiting_for_human: summarize the question and @ the human in the same room.
- partial artifacts: preserve and report what exists before retrying.

## 6. Report

Speak only when:

- a human decision is required;
- a Worker is blocked, failed, or stale;
- a recovery action changed visible state;
- all assigned work is complete and ready for synthesis.

If everything is normal, stay quiet.
