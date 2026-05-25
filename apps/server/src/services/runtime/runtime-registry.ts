import type { AgentProfile, AgentRuntime } from './agent-runtime'

class RuntimeRegistry {
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
    if (!profile || !profile.runtimeType) {
      return this.runtimes.get('llm')!
    }
    return this.runtimes.get(profile.runtimeType) ?? this.runtimes.get('llm')!
  }

  list() {
    return [...this.runtimes.values()]
  }
}

export const runtimeRegistry = new RuntimeRegistry()
