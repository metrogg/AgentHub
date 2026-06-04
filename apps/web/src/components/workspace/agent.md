# agent.md

Scope: `apps\web\src\components\workspace`

Role: Reusable workspace file browsing, file preview entry points, and workspace-scoped file actions.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep workspace file explorer logic reusable from chat rails, artifact pages, and future workspace surfaces.
- Do not move file explorer state or filesystem UI back into `components\assistant-ui`.
- Prefer narrow, testable changes and keep preview behavior routed through shared artifact preview utilities.

Verification: Run `bun --filter @agenthub/web typecheck` and targeted Bun tests for touched utilities/components.
