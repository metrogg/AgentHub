-- 补齐 session_members.joined_at（此前只在 ensureLegacySchema 中添加，不在任何 migration 中）
ALTER TABLE session_members ADD COLUMN joined_at integer;
--> statement-breakpoint

-- 兼容旧数据：复制 created_at 到 joined_at
UPDATE session_members SET joined_at = created_at WHERE joined_at IS NULL AND created_at IS NOT NULL;
--> statement-breakpoint

-- 兼容早期 migration 中 attempt_count 列名与 schema 不一致的问题
-- 如果存在 attempt_count 且不存在 retry_count，复制数据并重命名（SQLite 不支持 RENAME COLUMN，故新建列）
ALTER TABLE workspace_tasks ADD COLUMN retry_count integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

UPDATE workspace_tasks SET retry_count = COALESCE(attempt_count, 0) WHERE attempt_count IS NOT NULL;
--> statement-breakpoint

-- 统一 max_retries 默认值为 3（早期 migration 0005 中默认值为 2）
UPDATE workspace_tasks SET max_retries = 3 WHERE max_retries = 2;
