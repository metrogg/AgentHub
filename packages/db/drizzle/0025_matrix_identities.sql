CREATE TABLE IF NOT EXISTS matrix_identities (
  id TEXT PRIMARY KEY NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  localpart TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_token TEXT,
  password TEXT,
  display_name TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS matrix_identities_owner_unique ON matrix_identities(owner_type, owner_id, server_name);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS matrix_identities_user_id_unique ON matrix_identities(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS matrix_identities_localpart_idx ON matrix_identities(localpart);
