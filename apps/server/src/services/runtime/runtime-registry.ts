import {
  isCodeAgentProfile,
  isNativeAgentProfile,
  type AgentProfile,
  type AgentRuntime,
} from './agent-runtime'

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>()

  register(runtime: AgentRuntime) {
    this.runtimes.set(runtime.runtimeType, runtime)
    return this
  }

  resolve(profile: AgentProfile): AgentRuntime {
    const rt = this.runtimes.get(profile.runtimeType)
    if (!rt) {
      throw new Error(`未注册的 Runtime 类型: ${profile.runtimeType}`)
    }
    return rt
  }

  resolveForProfile(profile?: AgentProfile): AgentRuntime {
    const fallback = this.runtimes.get('llm')!
    if (!profile || !profile.runtimeType) {
      return fallback
    }
    if (isCodeAgentProfile(profile)) {
      return this.runtimes.get('code-agent') ?? fallback
    }
    if (isNativeAgentProfile(profile)) {
      return this.runtimes.get('mcp') ?? fallback
    }
    return this.runtimes.get(profile.runtimeType) ?? fallback
  }

  list() {
    return [...this.runtimes.values()]
  }
}

export const runtimeRegistry = new RuntimeRegistry()
