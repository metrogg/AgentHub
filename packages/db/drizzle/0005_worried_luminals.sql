CREATE TABLE `orchestrator_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`group_session_id` text NOT NULL,
	`plan_message_id` text,
	`status` text DEFAULT 'planning' NOT NULL,
	`plan` text,
	`summary_message_id` text,
	`conflict_report` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`summary_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD `dependencies` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD `parallel_group` text;--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD `max_retries` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD `fallback_agent_id` text;--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD `artifacts` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD `completed_at` integer;--> statement-breakpoint
ALTER TABLE `workspace_tasks` ADD `error_log` text;
