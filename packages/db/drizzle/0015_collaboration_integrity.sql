-- Tighten collaboration data integrity.
-- Earlier migrations added several reference columns with ALTER TABLE, which left SQLite
-- without the foreign keys declared in schema.ts.
PRAGMA foreign_keys = OFF;
--> statement-breakpoint

CREATE TABLE __sessions_new (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'direct',
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  workspace_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint

INSERT INTO __sessions_new (
  id,
  title,
  type,
  owner_id,
  workspace_id,
  workspace_agent_id,
  metadata,
  created_at,
  updated_at
)
SELECT
  s.id,
  s.title,
  s.type,
  s.owner_id,
  CASE WHEN w.id IS NOT NULL THEN s.workspace_id ELSE NULL END,
  CASE
    WHEN w.id IS NOT NULL AND a.id IS NOT NULL AND a.workspace_id = s.workspace_id
      THEN s.workspace_agent_id
    ELSE NULL
  END,
  s.metadata,
  s.created_at,
  s.updated_at
FROM sessions s
LEFT JOIN workspaces w ON w.id = s.workspace_id
LEFT JOIN workspace_agents a ON a.id = s.workspace_agent_id;
--> statement-breakpoint

DROP TABLE sessions;
--> statement-breakpoint
ALTER TABLE __sessions_new RENAME TO sessions;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_workspace_id_idx ON sessions(workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_workspace_agent_id_idx ON sessions(workspace_agent_id);
--> statement-breakpoint

CREATE TABLE __workspace_tasks_new (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  order_idx INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  run_id TEXT REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
  phase_id TEXT,
  dependencies TEXT NOT NULL DEFAULT '[]',
  input_refs TEXT NOT NULL DEFAULT '[]',
  output_key TEXT,
  parallel_group TEXT,
  max_retries INTEGER NOT NULL DEFAULT 3,
  retry_count INTEGER NOT NULL DEFAULT 0,
  timeout INTEGER NOT NULL DEFAULT 300000,
  fallback_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
  artifacts TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER,
  completed_at INTEGER,
  error_log TEXT,
  progress_percent INTEGER DEFAULT 0,
  progress_status TEXT,
  clarification_count INTEGER DEFAULT 0
);
--> statement-breakpoint

INSERT INTO __workspace_tasks_new (
  id,
  workspace_id,
  agent_id,
  title,
  description,
  status,
  session_id,
  order_idx,
  created_at,
  updated_at,
  run_id,
  phase_id,
  dependencies,
  input_refs,
  output_key,
  parallel_group,
  max_retries,
  retry_count,
  timeout,
  fallback_agent_id,
  artifacts,
  started_at,
  completed_at,
  error_log,
  progress_percent,
  progress_status,
  clarification_count
)
SELECT
  wt.id,
  wt.workspace_id,
  CASE WHEN a.id IS NOT NULL AND a.workspace_id = wt.workspace_id THEN wt.agent_id ELSE NULL END,
  wt.title,
  wt.description,
  wt.status,
  CASE WHEN s.id IS NOT NULL AND s.workspace_id = wt.workspace_id THEN wt.session_id ELSE NULL END,
  wt.order_idx,
  wt.created_at,
  wt.updated_at,
  CASE WHEN r.id IS NOT NULL AND r.workspace_id = wt.workspace_id THEN wt.run_id ELSE NULL END,
  wt.phase_id,
  wt.dependencies,
  wt.input_refs,
  wt.output_key,
  wt.parallel_group,
  COALESCE(wt.max_retries, 3),
  COALESCE(wt.retry_count, wt.attempt_count, 0),
  COALESCE(wt.timeout, 300000),
  CASE
    WHEN fa.id IS NOT NULL AND fa.workspace_id = wt.workspace_id THEN wt.fallback_agent_id
    ELSE NULL
  END,
  wt.artifacts,
  wt.started_at,
  wt.completed_at,
  wt.error_log,
  COALESCE(wt.progress_percent, 0),
  wt.progress_status,
  COALESCE(wt.clarification_count, 0)
FROM workspace_tasks wt
JOIN workspaces w ON w.id = wt.workspace_id
LEFT JOIN workspace_agents a ON a.id = wt.agent_id
LEFT JOIN sessions s ON s.id = wt.session_id
LEFT JOIN orchestrator_runs r ON r.id = wt.run_id
LEFT JOIN workspace_agents fa ON fa.id = wt.fallback_agent_id;
--> statement-breakpoint

DROP TABLE workspace_tasks;
--> statement-breakpoint
ALTER TABLE __workspace_tasks_new RENAME TO workspace_tasks;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_tasks_workspace_id_idx ON workspace_tasks(workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_tasks_run_id_idx ON workspace_tasks(run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_tasks_session_id_idx ON workspace_tasks(session_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_tasks_agent_id_idx ON workspace_tasks(agent_id);
--> statement-breakpoint

CREATE TABLE __execution_logs_new (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  type TEXT NOT NULL,
  input TEXT,
  output TEXT,
  duration_ms INTEGER,
  token_usage TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint

INSERT INTO __execution_logs_new
SELECT el.*
FROM execution_logs el
JOIN orchestrator_runs r ON r.id = el.run_id
JOIN sessions s ON s.id = el.session_id;
--> statement-breakpoint

DROP TABLE execution_logs;
--> statement-breakpoint
ALTER TABLE __execution_logs_new RENAME TO execution_logs;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_logs_run_id_idx ON execution_logs(run_id);
--> statement-breakpoint

CREATE TABLE __task_clarifications_new (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
--> statement-breakpoint

INSERT INTO __task_clarifications_new
SELECT tc.*
FROM task_clarifications tc
JOIN orchestrator_runs r ON r.id = tc.run_id;
--> statement-breakpoint

DROP TABLE task_clarifications;
--> statement-breakpoint
ALTER TABLE __task_clarifications_new RENAME TO task_clarifications;
--> statement-breakpoint

CREATE TABLE __orchestrator_run_controls_new (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_task_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint

INSERT INTO __orchestrator_run_controls_new
SELECT rc.*
FROM orchestrator_run_controls rc
JOIN orchestrator_runs r ON r.id = rc.run_id;
--> statement-breakpoint

DROP TABLE orchestrator_run_controls;
--> statement-breakpoint
ALTER TABLE __orchestrator_run_controls_new RENAME TO orchestrator_run_controls;
--> statement-breakpoint

PRAGMA foreign_keys = ON;
--> statement-breakpoint

CREATE TRIGGER sessions_workspace_agent_guard_insert
BEFORE INSERT ON sessions
WHEN NEW.workspace_agent_id IS NOT NULL
  AND (
    NEW.workspace_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM workspace_agents
      WHERE id = NEW.workspace_agent_id AND workspace_id = NEW.workspace_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'sessions.workspace_agent_id must belong to sessions.workspace_id');
END;
--> statement-breakpoint

CREATE TRIGGER sessions_workspace_agent_guard_update
BEFORE UPDATE ON sessions
WHEN NEW.workspace_agent_id IS NOT NULL
  AND (
    NEW.workspace_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM workspace_agents
      WHERE id = NEW.workspace_agent_id AND workspace_id = NEW.workspace_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'sessions.workspace_agent_id must belong to sessions.workspace_id');
END;
--> statement-breakpoint

CREATE TRIGGER workspace_tasks_reference_guard_insert
BEFORE INSERT ON workspace_tasks
WHEN
  (
    NEW.agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM workspace_agents
      WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id
    )
  )
  OR (
    NEW.fallback_agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM workspace_agents
      WHERE id = NEW.fallback_agent_id AND workspace_id = NEW.workspace_id
    )
  )
  OR (
    NEW.session_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM sessions
      WHERE id = NEW.session_id AND workspace_id = NEW.workspace_id
    )
  )
  OR (
    NEW.run_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM orchestrator_runs
      WHERE id = NEW.run_id AND workspace_id = NEW.workspace_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'workspace_tasks references must belong to workspace_id');
END;
--> statement-breakpoint

CREATE TRIGGER workspace_tasks_reference_guard_update
BEFORE UPDATE ON workspace_tasks
WHEN
  (
    NEW.agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM workspace_agents
      WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id
    )
  )
  OR (
    NEW.fallback_agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM workspace_agents
      WHERE id = NEW.fallback_agent_id AND workspace_id = NEW.workspace_id
    )
  )
  OR (
    NEW.session_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM sessions
      WHERE id = NEW.session_id AND workspace_id = NEW.workspace_id
    )
  )
  OR (
    NEW.run_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM orchestrator_runs
      WHERE id = NEW.run_id AND workspace_id = NEW.workspace_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'workspace_tasks references must belong to workspace_id');
END;
