-- Fix missing cascade for execution_logs.sessionId and orchestrator_runs message references
PRAGMA foreign_keys = ON;

-- Recreate execution_logs with cascade on sessionId
CREATE TABLE __execution_logs_new (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  type TEXT NOT NULL,
  input TEXT,
  output TEXT,
  duration_ms INTEGER,
  token_usage TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO __execution_logs_new SELECT * FROM execution_logs;
DROP TABLE execution_logs;
ALTER TABLE __execution_logs_new RENAME TO execution_logs;

-- Recreate orchestrator_runs with set null on message references
CREATE TABLE __orchestrator_runs_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  plan_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  plan TEXT,
  summary_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  conflict_report TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO __orchestrator_runs_new SELECT * FROM orchestrator_runs;
DROP TABLE orchestrator_runs;
ALTER TABLE __orchestrator_runs_new RENAME TO orchestrator_runs;
