import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const sourceRoot = join(process.cwd(), 'apps/server/src')

describe('HiClaw-lite kernel boundary', () => {
  test('legacy execution chain modules do not exist', () => {
    // The old in-memory orchestrator stack has been deleted. Verify these
    // modules are not reintroduced as parallel control paths.
    const legacyModules = [
      'orchestrator-engine.ts',
      'task-execution-service.ts',
      'local-a2a-transport.ts',
      'task-scheduler.ts',
      'task-graph.ts',
      'replanning-engine.ts',
      'synthesizer.ts',
      'conflict-resolver.ts',
    ]
    const files = listSourceFiles(sourceRoot)
    const violations: string[] = []

    for (const file of files) {
      const rel = toRepoPath(file)
      for (const mod of legacyModules) {
        if (rel.endsWith(mod)) {
          violations.push(`legacy module reintroduced: ${rel}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  test('LLM is never a Worker / Manager runtime in the AgentHub kernel', () => {
    // AgentHub Manager must be a real OpenClaw / QwenPaw process and Worker
    // must be a real Code Agent runtime (codex|claude-code|opencode|gemini).
    // LLM-backed chat is NOT a valid Worker / Manager / Coordinator runtime
    // in the kernel. The deleted LlmRuntime, manager-planner,
    // orchestrator-decision, planner must NOT be reintroduced.
    const forbiddenFiles = [
      'runtime/llm-runtime.ts',
      'orchestrator/manager-planner.ts',
      'orchestrator/orchestrator-decision.ts',
      'orchestrator/planner.ts',
    ]
    const files = listSourceFiles(sourceRoot)
    const violations: string[] = []

    for (const file of files) {
      const rel = toRepoPath(file)
      for (const forbidden of forbiddenFiles) {
        if (rel.endsWith(forbidden)) {
          violations.push(`LLM-driven module reintroduced: ${rel}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  test('runtime registry does not register an llm runtime', () => {
    // The runtime registry is the single source of truth for which Agent
    // runtimes AgentHub will dispatch to. After removing LlmRuntime, the
    // registry must NOT contain a runtime registered with runtimeType='llm'.
    const registry = readFileSync(
      join(process.cwd(), 'apps/server/src/services/runtime/index.ts'),
      'utf8',
    )
    expect(registry).not.toMatch(/register\s*\(\s*new\s+LlmRuntime\s*\(/)
    expect(registry).not.toMatch(/LlmRuntime/)
  })

  test('resolveForProfile throws for non-code-agent profiles (no LLM fallback)', () => {
    // The runtime-registry must hard-fail on LLM profiles instead of
    // silently falling back. This protects the invariant that AgentHub
    // never uses LLM as a Worker runtime.
    const registry = readFileSync(
      join(process.cwd(), 'apps/server/src/services/runtime/runtime-registry.ts'),
      'utf8',
    )
    expect(registry).toMatch(/AgentHub 不再支持/)
    expect(registry).toMatch(/profile is required/)
  })

  test('local-worker-runtime fails fast on non-code-agent profile', () => {
    // WorkerRuntime must not silently fall back to LLM. It must hard-fail
    // when the resolved profile is not a code-agent.
    const worker = readFileSync(
      join(process.cwd(), 'apps/server/src/services/worker-runtime/local-worker-runtime.ts'),
      'utf8',
    )
    expect(worker).toMatch(/不是 code-agent/)
    expect(worker).toMatch(/isCodeAgentProfile/)
  })

  test('coordinator-runtime directory has been fully removed', () => {
    // The coordinator-runtime directory was the old orchestration layer.
    // It has been deleted; all logic migrated to manager-runtime/ and
    // controller-plane/task-dispatcher.ts.
    const coordinatorDir = join(process.cwd(), 'apps/server/src/services/coordinator-runtime')
    expect(() => statSync(coordinatorDir)).toThrow()
  })

  test('plan-generator dynamic build is a fail-loudly stub', () => {
    // buildDynamicOrchestratorPlan() previously called createManagerActionPlan
    // (LLM). After cleanup, it must throw instead of silently producing an
    // empty / fake plan via AgentHub's local LLM.
    const gen = readFileSync(
      join(process.cwd(), 'apps/server/src/services/orchestrator/plan-generator.ts'),
      'utf8',
    )
    expect(gen).toMatch(/LLM-driven dynamic plan generation is no longer supported/)
    const stripped = stripComments(gen)
    expect(stripped).not.toMatch(/streamReply\s*\(/)
  })

  test('new kernel modules do not use A2A as their internal task transport', () => {
    const kernelDirs = [
      'apps/server/src/services/rooms',
      'apps/server/src/services/controller-plane',
      'apps/server/src/services/worker-runtime',
    ]
    const files = kernelDirs.flatMap((dir) => listSourceFiles(join(process.cwd(), dir)))
    const violations: string[] = []

    for (const file of files) {
      const rel = toRepoPath(file)
      const text = readFileSync(file, 'utf8')
      if (references(text, 'a2a-internal') || references(text, 'local-a2a-transport')) {
        violations.push(`${rel} references legacy A2A internal transport`)
      }
    }

    expect(violations).toEqual([])
  })

  test('Manager HiClaw skill surface is sourced from the normalized manager-agent bundle', () => {
    // The Manager skill surface is now generated through agent-contract and
    // seeded from infra/manager-agent/skills, not from a private source-code
    // constant. This keeps OpenClaw/QwenPaw and future Manager runtimes on
    // the same file contract.
    const skillRoot = join(process.cwd(), 'infra/manager-agent/skills')
    const newSkillNames = [
      'team-management',
      'project-management',
      'hiclaw-find-worker',
      'task-coordination',
    ]
    for (const name of newSkillNames) {
      const skill = readFileSync(join(skillRoot, name, 'SKILL.md'), 'utf8')
      expect(skill).toContain(`#`)
      expect(skill).toContain('Decision Pattern')
    }
  })

  test('Manager skill bundle uses Controller schema/apply instead of legacy manager actions', () => {
    const managerRoot = join(process.cwd(), 'infra/manager-agent')
    const files = listTextFiles(managerRoot, /\.(md|json|ya?ml|sh|ts)$/)
    const violations: string[] = []

    for (const file of files) {
      const rel = toRepoPath(file)
      const text = readFileSync(file, 'utf8')
      if (text.includes('/api/internal/manager/actions')) {
        violations.push(`${rel} references legacy manager action endpoint`)
      }
      if (/localhost:8000\/api\/rooms/.test(text)) {
        violations.push(`${rel} hard-codes product room routes`)
      }
    }

    expect(violations).toEqual([])
  })

  test('core Manager skills discover Controller capabilities through agenthub schema', () => {
    const skillRoot = join(process.cwd(), 'infra/manager-agent/skills')
    const requiredSchemaSkills = [
      'agenthub-controller',
      'worker-management',
      'task-management',
      'channel-management',
      'project-management',
    ]

    for (const skillName of requiredSchemaSkills) {
      const skill = readFileSync(join(skillRoot, skillName, 'SKILL.md'), 'utf8')
      expect(skill).toContain('agenthub schema')
    }

    const worker = readFileSync(join(skillRoot, 'worker-management', 'SKILL.md'), 'utf8')
    expect(worker).toContain('kind: Worker')
    expect(worker).toContain('runtimeBase: <openclaw|qwenpaw|opencode|claude-code|codex|gemini>')

    const task = readFileSync(join(skillRoot, 'task-management', 'SKILL.md'), 'utf8')
    expect(task).toContain('kind: Task')
    expect(task).toContain('Controller assignment creates the task room')

    const channel = readFileSync(join(skillRoot, 'channel-management', 'SKILL.md'), 'utf8')
    expect(channel).toContain('kind: Room')
    expect(channel).toContain('Do not call product UI `/api/rooms` routes directly')
  })

  test('Manager contract generator owns SOUL AGENTS registries and runtime context', () => {
    const contract = readFileSync(
      join(process.cwd(), 'apps/server/src/services/agent-contract/manager-contract.ts'),
      'utf8',
    )
    for (const expected of [
      'SOUL.md',
      'AGENTS.md',
      'TOOLS.md',
      'HEARTBEAT.md',
      'workers-registry.json',
      'teams-registry.json',
      'humans-registry.json',
      'rooms.json',
      'EnsureManagerIdentity',
      'EnsureRuntimeProcess',
      'ObserveRoomBindingsAndHeartbeat',
    ]) {
      expect(contract).toContain(expected)
    }
  })

  test('AgentHub Controller CLI requires explicit Worker runtime base', () => {
    const cli = readFileSync(join(process.cwd(), 'infra/agenthub-cli/agenthub.ts'), 'utf8')
    expect(cli).toContain('--runtime-base <openclaw|qwenpaw|opencode|claude-code|codex|gemini> is required')
    expect(cli).not.toContain("|| 'codex'")
    expect(cli).not.toContain('|| "codex"')
  })

  test('backend Worker creation and bridge paths do not silently default missing bases to Codex', () => {
    const guardedFiles = [
      'apps/server/src/services/agents/profile-builder.ts',
      'apps/server/src/services/rooms/room-chat-bridge.ts',
      'apps/server/src/services/workspace/workspace-queries.ts',
      'apps/server/src/services/code-agent-adapter.ts',
      'apps/server/src/services/agent-draft.ts',
      'apps/server/src/routes/workspaces.ts',
      'apps/server/src/routes/messages.ts',
    ]
    const forbiddenPatterns = [
      /\?\?\s*['"]codex['"]/,
      /\|\|\s*['"]codex['"]/,
      /codeAgentType:\s*[^,\n]*\?\?\s*['"]codex['"]/,
    ]
    const violations: string[] = []
    for (const file of guardedFiles) {
      const text = readFileSync(join(process.cwd(), file), 'utf8')
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(text)) violations.push(`${file} matches ${pattern}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('frontend Agent configuration does not silently default missing Worker bases to Codex', () => {
    const guardedFiles = [
      'apps/web/src/pages/AgentConfigPage.tsx',
      'apps/web/src/lib/agentLibrary.ts',
      'apps/web/src/lib/expertProfiles.ts',
      'apps/web/src/lib/codingToolsLifecycle.ts',
      'packages/shared/src/agent-role-presets.ts',
    ]
    const forbiddenPatterns = [
      /\?\?\s*['"]codex['"]/,
      /\|\|\s*['"]codex['"]/,
      /codeAgentType:\s*['"]codex['"]/,
      /defaultCodeAgentTypeFor/,
    ]
    const violations: string[] = []
    for (const file of guardedFiles) {
      const text = readFileSync(join(process.cwd(), file), 'utf8')
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(text)) violations.push(`${file} matches ${pattern}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('new lifecycle paths use controllers instead of runtime lease persistence helpers', () => {
    const guardedDirs = [
      'apps/server/src/services/rooms',
      'apps/server/src/services/controller-plane',
      'apps/server/src/services/worker-runtime',
    ]
    const guardedFiles = [
      'apps/server/src/index.ts',
      'apps/server/src/services/orchestrator/manager-loop.ts',
      'apps/server/src/services/orchestrator/manager-patrol.ts',
      'apps/server/src/services/orchestrator/task-thread-service.ts',
      'apps/server/src/services/orchestrator/run-controller.ts',
    ]
    const files = [
      ...guardedDirs.flatMap((dir) => listSourceFiles(join(process.cwd(), dir))),
      ...guardedFiles.map((file) => join(process.cwd(), file)),
    ]
    const forbiddenHelpers = [
      'createRuntimeLease',
      'markRuntimeLeaseReady',
      'markRuntimeLeaseRunning',
      'markRuntimeLeaseWaitingForHuman',
      'releaseRuntimeLease',
      'failRuntimeLease',
      'markRuntimeLeaseStale',
      'markInterruptedRuntimeLeasesStale',
    ]
    const violations: string[] = []

    for (const file of files) {
      const rel = toRepoPath(file)
      const text = readFileSync(file, 'utf8')
      if (rel.endsWith('runtime-lease-controller.ts')) continue
      for (const helper of forbiddenHelpers) {
        if (new RegExp(`\\b${helper}\\b`).test(text)) {
          violations.push(`${rel} references ${helper} instead of RuntimeLeaseController`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})

function listSourceFiles(root: string): string[] {
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path))
      continue
    }
    if (/\.(ts|tsx)$/.test(entry)) {
      files.push(path)
    }
  }
  return files
}

function listTextFiles(root: string, pattern: RegExp): string[] {
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...listTextFiles(path, pattern))
      continue
    }
    if (pattern.test(entry)) {
      files.push(path)
    }
  }
  return files
}

function references(text: string, moduleName: string) {
  return new RegExp(`\\b(from|import)\\s*\\(?\\s*['"][^'"]*${escapeRegExp(moduleName)}['"]`).test(text)
}

function toRepoPath(path: string) {
  return relative(process.cwd(), path).replace(/\\/g, '/')
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripComments(source: string) {
  // Remove /* ... */ block comments and // line comments, while keeping
  // string contents intact (approximate but sufficient for boundary
  // matching).
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
