CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES workspace_tasks(id) ON DELETE SET NULL,
  task_thread_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
  workspace_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
  worker_instance_id TEXT,
  kind TEXT NOT NULL DEFAULT 'file',
  title TEXT NOT NULL,
  description TEXT,
  source_path TEXT,
  handoff_path TEXT,
  relative_path TEXT,
  mime_type TEXT,
  size INTEGER,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'registered',
  visibility TEXT NOT NULL DEFAULT 'team',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX artifacts_workspace_id_idx ON artifacts(workspace_id);
CREATE INDEX artifacts_run_id_idx ON artifacts(run_id);
CREATE INDEX artifacts_task_id_idx ON artifacts(task_id);
CREATE INDEX artifacts_task_thread_id_idx ON artifacts(task_thread_id);
CREATE UNIQUE INDEX artifacts_task_relative_path_unique ON artifacts(task_id, relative_path, checksum);
