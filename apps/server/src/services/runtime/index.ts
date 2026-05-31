import { runtimeRegistry } from './runtime-registry'
import { LlmRuntime } from './llm-runtime'
import { CodeAgentRuntime } from './code-agent-runtime'

// Runtime 是 Agent 执行基底。A2A 是通信协议，MCP/Skills 是工具能力，不注册为 Agent 类型。
runtimeRegistry.register(new LlmRuntime())
runtimeRegistry.register(new CodeAgentRuntime())

export { runtimeRegistry }
export * from './agent-runtime'
