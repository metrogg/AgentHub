-- Normalize legacy runtime identity values into the current model.
UPDATE workspace_agents
SET runtime_type = 'code-agent',
    code_agent_type = COALESCE(code_agent_type, 'codex')
WHERE runtime_type IN ('mcp', 'a2a');

UPDATE workspace_agents
SET code_agent_type = COALESCE(code_agent_type, 'codex')
WHERE runtime_type = 'code-agent' AND code_agent_type IS NULL;

UPDATE workspace_agents
SET code_agent_type = NULL
WHERE runtime_type = 'llm';
