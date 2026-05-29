ALTER TABLE `workspace_tasks` ADD COLUMN `progress_percent` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD COLUMN `progress_status` text;
--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD COLUMN `clarification_count` integer DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `task_clarifications` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`question` text NOT NULL,
	`options` text,
	`answer` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`answered_at` integer
);
--> statement-breakpoint
CREATE TABLE `orchestrator_run_controls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`action` text NOT NULL,
	`target_task_id` text,
	`reason` text,
	`created_at` integer NOT NULL
);