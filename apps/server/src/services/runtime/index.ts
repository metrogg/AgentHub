import { runtimeRegistry } from './runtime-registry'
import { LlmRuntime } from './llm-runtime'
import { NativeToolRuntime } from './native-tool-runtime'
import { CodeAgentRuntime } from './code-agent-runtime'
import { A2ARuntime } from './a2a-runtime'

// 注册所有 Runtime
runtimeRegistry.register(new LlmRuntime())
runtimeRegistry.register(new NativeToolRuntime())
runtimeRegistry.register(new CodeAgentRuntime())
runtimeRegistry.register(new A2ARuntime())

export { runtimeRegistry }
export * from './agent-runtime'
