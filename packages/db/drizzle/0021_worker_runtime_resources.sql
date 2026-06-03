CREATE TABLE worker_instances (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workspace_agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  runtime_family TEXT NOT NULL DEFAULT 'worker',
  runtime_base TEXT NOT NULL,
  model_id TEXT,
  skill_ids TEXT NOT NULL DEFAULT '[]',
  mcp_server_ids TEXT NOT NULL DEFAULT '[]',
  sandbox_policy TEXT NOT NULL DEFAULT 'workspace-write',
  desired_state TEXT NOT NULL DEFAULT 'running',
  observed_state TEXT NOT NULL DEFAULT 'provisioning',
  health TEXT NOT NULL DEFAULT '{}',
  runtime_home TEXT,
  runtime_config_path TEXT,
  last_heartbeat_at INTEGER,
  message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX worker_instances_workspace_id_idx ON worker_instances(workspace_id);
CREATE INDEX worker_instances_workspace_agent_id_idx ON worker_instances(workspace_agent_id);
CREATE UNIQUE INDEX worker_instances_workspace_agent_unique ON worker_instances(workspace_id, workspace_agent_id);

CREATE TABLE runtime_leases (
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

CREATE INDEX runtime_leases_workspace_id_idx ON runtime_leases(workspace_id);
CREATE INDEX runtime_leases_run_id_idx ON runtime_leases(run_id);
CREATE INDEX runtime_leases_task_id_idx ON runtime_leases(task_id);
CREATE INDEX runtime_leases_worker_instance_id_idx ON runtime_leases(worker_instance_id);
