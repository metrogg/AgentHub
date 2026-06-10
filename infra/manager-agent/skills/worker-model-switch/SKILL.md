---
name: worker-model-switch
description: Use when switching a Worker's LLM model.
---

# Worker Model Switch

Switch a Worker's LLM model via the CLI.

## Commands

```bash
# Switch worker model
agenthub worker update --id <worker-id> --model <model-id>

# Verify the change
agenthub worker status --id <worker-id>
```

## Rules

- Verify the model is available before switching.
- If the worker is currently running a task, the switch takes effect on the next task.
- Announce model switches in the relevant room.

## Decision Pattern

1. Confirm the human or policy explicitly requested a Worker model switch.
2. Check Worker state so an active task is not disrupted unexpectedly.
3. Verify the target model is compatible with the Worker runtime base.
4. Apply the model binding through Controller APIs.
5. Announce when the switch takes effect and record it in the room timeline.
