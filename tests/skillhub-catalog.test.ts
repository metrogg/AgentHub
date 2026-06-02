import { describe, expect, test } from 'bun:test'
import {
  SkillhubCatalogService,
  __skillhubCatalogTestHooks,
} from '../apps/server/src/services/skillhub-catalog'

describe('SkillhubCatalogService', () => {
  test('finds a remote skill through the expanded search index even when the direct query misses it', async () => {
    const calls: string[] = []
    const service = new SkillhubCatalogService({
      cacheFilePath: null,
      initialSeeds: ['*'],
      maxQueries: 6,
      concurrency: 1,
      requestTimeoutMs: 2000,
      timeBudgetMs: 5000,
      searchLimit: 20,
      fetchImpl: async (input) => {
        const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
        const q = url.searchParams.get('q') ?? ''
        calls.push(q)
        if (q === '*') {
          return jsonResponse([
            {
              slug: 'seeded-guide',
              displayName: 'Seeded Guide',
              description: 'Use gateway to uncover buried tools.',
              source: 'clawhub',
              downloads: 10,
            },
          ])
        }
        if (q === 'gateway') {
          return jsonResponse([
            {
              slug: 'secret-tool',
              displayName: 'Secret Tool',
              description: 'Hidden workflow for secret reports.',
              source: 'community',
              downloads: 99,
            },
          ])
        }
        return jsonResponse([])
      },
    })

    const result = await service.search('secret')

    expect(result.ok).toBe(true)
    expect(result.items[0]?.slug).toBe('secret-tool')
    expect(calls).toContain('*')
    expect(calls).toContain('gateway')
  })

  test('normalizes remote entries to the shared SkillHub source label', () => {
    const { normalizeSkillhubItem } = __skillhubCatalogTestHooks

    const item = normalizeSkillhubItem({
      slug: 'word-docx',
      displayName: 'Word / DOCX',
      description_zh: '创建、检查和编辑 Word 文档。',
      source: 'clawhub',
      tags: ['office'],
    })

    expect(item?.source).toBe('SkillHub')
    expect(item?.remoteSource).toBe('clawhub')
    expect(item?.tags).toContain('office')
  })
})

function jsonResponse(results: unknown[]) {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
