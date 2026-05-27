ALTER TABLE workspace_agents ADD COLUMN role_type TEXT NOT NULL DEFAULT 'custom';
--> statement-breakpoint
ALTER TABLE workspace_agents ADD COLUMN role_profile TEXT;
--> statement-breakpoint

CREATE TABLE workspace_agent_relations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  target_agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint

CREATE UNIQUE INDEX workspace_agent_relations_unique
  ON workspace_agent_relations(workspace_id, source_agent_id, target_agent_id, relation_type);
