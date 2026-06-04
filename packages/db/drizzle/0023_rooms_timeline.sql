CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL DEFAULT 'local-matrix-compatible',
  provider_room_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES orchestrator_runs(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES workspace_tasks(id) ON DELETE SET NULL,
  task_thread_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS rooms_provider_room_id_unique ON rooms(provider, provider_room_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rooms_owner_id_idx ON rooms(owner_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rooms_workspace_id_idx ON rooms(workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rooms_session_id_idx ON rooms(session_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rooms_run_id_idx ON rooms(run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rooms_task_thread_id_idx ON rooms(task_thread_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS room_participants (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  provider_user_id TEXT,
  participant_type TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  workspace_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
  worker_instance_id TEXT REFERENCES worker_instances(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'joined',
  metadata TEXT NOT NULL DEFAULT '{}',
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS room_participants_room_id_idx ON room_participants(room_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS room_participants_user_id_idx ON room_participants(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS room_participants_workspace_agent_id_idx ON room_participants(workspace_agent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS room_participants_worker_instance_id_idx ON room_participants(worker_instance_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL,
  sender_participant_id TEXT REFERENCES room_participants(id) ON DELETE SET NULL,
  sender_type TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS timeline_events_room_id_idx ON timeline_events(room_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS timeline_events_room_sequence_unique ON timeline_events(room_id, sequence);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS timeline_events_provider_event_id_unique ON timeline_events(room_id, provider_event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS timeline_events_sender_participant_id_idx ON timeline_events(sender_participant_id);
