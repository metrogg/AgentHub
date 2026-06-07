CREATE TABLE IF NOT EXISTS controller_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  apply_operation_id TEXT,
  danger TEXT NOT NULL,
  approval_level TEXT NOT NULL DEFAULT 'not_required',
  approval_required INTEGER NOT NULL DEFAULT 0,
  approval_provided INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approval_reason TEXT,
  manifest_kind TEXT NOT NULL,
  manifest_name TEXT,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  resource_id TEXT,
  resource_kind TEXT,
  audit_fields TEXT NOT NULL DEFAULT '{}',
  result_summary TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS controller_audit_events_operation_id_idx ON controller_audit_events(operation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS controller_audit_events_workspace_id_idx ON controller_audit_events(workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS controller_audit_events_resource_idx ON controller_audit_events(resource_kind, resource_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS controller_audit_events_created_at_idx ON controller_audit_events(created_at);
