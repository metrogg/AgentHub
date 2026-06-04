ALTER TABLE artifacts ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local-filesystem';
--> statement-breakpoint
ALTER TABLE artifacts ADD COLUMN bucket TEXT NOT NULL DEFAULT 'agenthub-artifacts';
--> statement-breakpoint
ALTER TABLE artifacts ADD COLUMN object_key TEXT;
--> statement-breakpoint
ALTER TABLE artifacts ADD COLUMN storage_path TEXT;
--> statement-breakpoint
ALTER TABLE artifacts ADD COLUMN room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS artifacts_object_key_idx ON artifacts(object_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS artifacts_room_id_idx ON artifacts(room_id);
