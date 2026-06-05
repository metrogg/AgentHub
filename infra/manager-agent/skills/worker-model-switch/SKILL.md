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
