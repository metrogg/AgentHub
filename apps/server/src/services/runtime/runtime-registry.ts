import {
  isCodeAgentProfile,
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
      throw new Error(
        `未注册的 Runtime 类型: ${profile.runtimeType}。Worker 必须是真实 Code Agent runtime（Codex/ClaudeCode/OpenCode/Gemini 等），AgentHub 自身不再使用 LLM 作为 Worker runtime。`,
      )
    }
    return rt
  }

  /**
   * Resolve a runtime for an Agent profile. AgentHub only supports
   * `code-agent` as a Worker runtime — LLM-backed chat agents are NOT
   * a valid Worker runtime in the AgentHub kernel.
   *
   * This function will throw if:
   * - profile is undefined (caller must always provide a profile)
   * - profile.runtimeType is not `code-agent`
   */
  resolveForProfile(profile?: AgentProfile): AgentRuntime {
    if (!profile) {
      throw new Error(
        'resolveForProfile: profile is required. AgentHub Worker 必须是真实 Code Agent runtime，请提供带 codeAgentType 的 profile。',
      )
    }
    if (!isCodeAgentProfile(profile)) {
      throw new Error(
        `resolveForProfile: AgentHub 不再支持 runtimeType=${profile.runtimeType} 作为 Worker runtime。` +
          `Worker 必须是真实 Code Agent runtime（codex|claude-code|opencode|gemini），` +
          `由 AgentHub 直接调 CLI 子进程。LLM 仅作为 OpenClaw 等 Code Agent runtime 自己的模型后端存在。`,
      )
    }
    const codeAgent = this.runtimes.get('code-agent')
    if (!codeAgent) {
      throw new Error('runtimeRegistry 缺少 code-agent runtime 注册')
    }
    return codeAgent
  }

  list() {
    return [...this.runtimes.values()]
  }
}

export const runtimeRegistry = new RuntimeRegistry()
