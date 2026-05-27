CREATE TABLE orchestrator_run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  severity TEXT NOT NULL DEFAULT 'info',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
