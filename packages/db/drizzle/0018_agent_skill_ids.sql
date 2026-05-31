-- Add skill_ids column to workspace_agents for agent-specific skill toolbox
ALTER TABLE workspace_agents ADD COLUMN skill_ids TEXT NOT NULL DEFAULT '[]';
