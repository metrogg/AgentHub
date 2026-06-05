---
name: model-switch
description: Use when switching the Manager's own LLM model or checking the current model configuration.
---

# Model Switch

Switch the Manager's LLM model at runtime.

## How It Works

The Manager runs on an OpenClaw process configured with a specific model. To switch:

1. Update the openclaw.json configuration with the new model.
2. Restart the OpenClaw process for the change to take effect.

## Current Model

Check the current model configuration:
```bash
cat ~/openclaw.json | grep -A 5 '"primary"'
```

## Rules

- Model changes require a Manager restart — inform the human admin before switching.
- Always verify the new model is available and responsive before committing.
- Keep a record of model switches in `memory/YYYY-MM-DD.md`.
