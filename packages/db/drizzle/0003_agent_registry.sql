ALTER TABLE `workspace_agents` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_agents` ADD `avatar` text;--> statement-breakpoint
ALTER TABLE `workspace_agents` ADD `model_id` text;--> statement-breakpoint
ALTER TABLE `workspace_agents` ADD `runtime_type` text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_agents` ADD `code_agent_type` text;--> statement-breakpoint
ALTER TABLE `workspace_agents` ADD `capability_tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_agents` ADD `tool_permissions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_agents` ADD `sandbox_policy` text DEFAULT 'workspace-write' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_agents` ADD `context_policy` text DEFAULT 'workspace-aware' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_agents` ADD `auto_invoke` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_agents` ADD `approval_required` integer DEFAULT true NOT NULL;
