CREATE TABLE task_threads (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  group_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
  worker_instance_id TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'prepared',
  last_event_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX task_threads_run_task_unique ON task_threads(run_id, task_id);
CREATE INDEX task_threads_run_id_idx ON task_threads(run_id);
CREATE INDEX task_threads_session_id_idx ON task_threads(session_id);
CREATE INDEX task_threads_workspace_id_idx ON task_threads(workspace_id);

ALTER TABLE orchestrator_run_events ADD COLUMN thread_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL;
ALTER TABLE orchestrator_run_events ADD COLUMN worker_instance_id TEXT;
ALTER TABLE orchestrator_run_events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;

CREATE INDEX orchestrator_run_events_run_id_idx ON orchestrator_run_events(run_id);
CREATE INDEX orchestrator_run_events_thread_id_idx ON orchestrator_run_events(thread_id);
