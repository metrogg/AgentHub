-- 补齐 session_members.joined_at（此前只在 ensureLegacySchema 中添加，不在任何 migration 中）
ALTER TABLE session_members ADD COLUMN joined_at integer;
--> statement-breakpoint

-- 兼容旧数据：复制 created_at 到 joined_at
UPDATE session_members SET joined_at = created_at WHERE joined_at IS NULL AND created_at IS NOT NULL;
--> statement-breakpoint

-- 0006 已添加 retry_count，此处仅同步旧数据（attempt_count → retry_count）
UPDATE workspace_tasks SET retry_count = COALESCE(attempt_count, 0) WHERE attempt_count IS NOT NULL AND retry_count = 0;
--> statement-breakpoint

-- 统一 max_retries 默认值为 3（早期 migration 0005 中默认值为 2）
UPDATE workspace_tasks SET max_retries = 3 WHERE max_retries = 2;
