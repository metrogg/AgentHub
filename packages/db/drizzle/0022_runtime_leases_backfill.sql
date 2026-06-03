CREATE TABLE IF NOT EXISTS runtime_leases (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES workspace_tasks(id) ON DELETE SET NULL,
  worker_instance_id TEXT REFERENCES worker_instances(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'local-workdir',
  status TEXT NOT NULL DEFAULT 'creating',
  cwd TEXT,
  home_dir TEXT,
  config_dir TEXT,
  cache_dir TEXT,
  tmp_dir TEXT,
  data_dir TEXT,
  container_id TEXT,
  sandbox_id TEXT,
  pid INTEGER,
  started_at INTEGER,
  released_at INTEGER,
  error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS runtime_leases_workspace_id_idx ON runtime_leases(workspace_id);
CREATE INDEX IF NOT EXISTS runtime_leases_run_id_idx ON runtime_leases(run_id);
CREATE INDEX IF NOT EXISTS runtime_leases_task_id_idx ON runtime_leases(task_id);
CREATE INDEX IF NOT EXISTS runtime_leases_worker_instance_id_idx ON runtime_leases(worker_instance_id);
