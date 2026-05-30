-- Ensure the persisted workspace state table exists in the formal migration chain.
CREATE TABLE IF NOT EXISTS workspace_states (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
