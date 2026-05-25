CREATE TABLE `blackboard_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`agent_id` text,
	`task_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD COLUMN `phase_id` text;
--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD COLUMN `input_refs` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD COLUMN `output_key` text;
--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD COLUMN `retry_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD COLUMN `timeout` integer DEFAULT 300000 NOT NULL;
--> statement-breakpoint
CREATE TABLE `execution_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text,
	`type` text NOT NULL,
	`input` text,
	`output` text,
	`duration_ms` integer,
	`token_usage` text,
	`created_at` integer NOT NULL
);
