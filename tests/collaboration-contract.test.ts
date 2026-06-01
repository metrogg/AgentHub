import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  loadExplicitCollaborationContracts,
  parseCollaborationContract,
} from '../apps/server/src/services/orchestrator/collaboration-contract'

describe('collaboration contracts', () => {
  test('parses explicit contract files without workflow template keys', () => {
    const contract = parseCollaborationContract(JSON.stringify({
      id: 'delivery',
      name: '交付契约',
      scope: {
        allowedPaths: ['docs/**', 'public/**'],
        forbiddenPaths: ['.env'],
      },
      outputs: {
        artifactChain: ['research notes', 'implementation', 'validation'],
        requiredArtifacts: ['report.pdf'],
        requiredBlackboardWrites: ['delivery/summary'],
      },
      quality: {
        acceptanceCriteria: ['说明数据来源', '列出风险'],
        qualityGates: ['产物必须可追踪'],
      },
      capabilities: {
        preferredSkills: ['research'],
        requiredTools: ['workspace:read'],
        requiredMcpServers: ['browser'],
        rules: ['code-quality'],
      },
    }))

    expect(contract?.id).toBe('delivery')
    expect(contract?.scope.allowedPaths).toEqual(['docs/**', 'public/**'])
    expect(contract?.outputs.artifactChain).toEqual(['research notes', 'implementation', 'validation'])
    expect(contract?.outputs.requiredArtifacts).toEqual(['report.pdf'])
    expect(contract?.quality.qualityGates).toEqual(['产物必须可追踪'])
    expect(contract?.capabilities.requiredMcpServers).toEqual(['browser'])
  })

  test('rejects old trigger or phase based workflow templates', () => {
    expect(() => parseCollaborationContract(JSON.stringify({
      id: 'web-app-building',
      triggers: ['build.*web'],
      phases: [{ name: 'implementation' }],
      scope: { allowedPaths: ['src/**'] },
    }))).toThrow('workflow/template keys')
  })

  test('loads contracts only from .agenthub/contracts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenthub-contract-'))
    const specsDir = join(root, '.agenthub', 'specs')
    const contractsDir = join(root, '.agenthub', 'contracts')
    await mkdir(specsDir, { recursive: true })
    await mkdir(contractsDir, { recursive: true })
    await writeFile(
      join(specsDir, 'web-app-building.spec.yml'),
      'id: web-app-building\ntriggers:\n  - web\n',
      'utf8',
    )
    await writeFile(
      join(specsDir, 'legacy.contract.json'),
      JSON.stringify({
        id: 'legacy',
        scope: { allowedPaths: ['legacy/**'] },
      }),
      'utf8',
    )
    await writeFile(
      join(contractsDir, 'delivery.contract.json'),
      JSON.stringify({
        id: 'delivery',
        scope: { allowedPaths: ['docs/**'] },
      }),
      'utf8',
    )

    const contracts = await loadExplicitCollaborationContracts(root)

    expect(contracts.map((contract) => contract.id)).toEqual(['delivery'])
  })
})
