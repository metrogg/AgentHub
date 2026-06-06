---
name: memory-management
description: Use when recording durable lessons about rooms, Workers, tasks, failures, or human preferences.
---

# Memory Management

Memory helps the Manager avoid repeating mistakes.

## Store

- Important human preferences.
- Worker reliability observations.
- Repeated runtime/config blockers.
- Project-level decisions that affect future coordination.

## Rules

- Do not store secrets.
- Do not store irrelevant chat.
- Keep memory concise and useful for future Manager decisions.
- Treat Controller resources and Room timeline as the audit source; memory is a distilled helper.

## Decision Pattern

1. Decide whether the fact will matter in future coordination.
2. Write a concise note to memory.
3. Reference the originating room/task when useful.
