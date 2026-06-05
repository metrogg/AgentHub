import { runtimeRegistry } from './runtime-registry'
import { CodeAgentRuntime } from './code-agent-runtime'

// Agent Runtime — Worker is always a real Code Agent runtime (Codex/ClaudeCode/OpenCode/Gemini).
// LLM is NEVER a Worker runtime. It can only be used by the configured Code Agent CLI process
// via its own `openclaw.json` (model/apiKey/etc), never by AgentHub itself.
// A2A is a protocol, not an Agent type. MCP/Skills are tool/capability layers, not Agent types.
runtimeRegistry.register(new CodeAgentRuntime())

export { runtimeRegistry }
export * from './agent-runtime'
