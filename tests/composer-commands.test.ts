import { describe, expect, test } from 'bun:test'
import {
  extractMentionedAgentIds,
  mentionAliasEntries,
  readMentionCommand,
  readSlashCommand,
  type MentionAgent,
} from '../apps/web/src/lib/composerCommands'

const agents: MentionAgent[] = [
  {
    id: 'orchestrator-1',
    name: 'Manager',
    role: '项目协调员',
    roleType: 'orchestrator',
  },
  {
    id: 'frontend-1',
    name: '高级前端工程师',
    role: '前端实现',
    roleType: 'coder',
  },
]

describe('composer commands', () => {
  test('reads slash command ranges at the cursor', () => {
    expect(readSlashCommand('请使用 /deploy', '请使用 /deploy'.length)).toEqual({
      start: 4,
      end: 11,
      query: 'deploy',
    })
    expect(readSlashCommand('https://example.com/a/b', 12)).toBeNull()
  })

  test('reads mention ranges at the cursor', () => {
    expect(readMentionCommand('交给 @高级前端', '交给 @高级前端'.length)).toEqual({
      start: 3,
      end: 8,
      query: '高级前端',
    })
    expect(readMentionCommand('mail@example.com', 'mail@example.com'.length)).toBeNull()
  })

  test('extracts agent mentions by name, role, and orchestrator aliases', () => {
    expect(mentionAliasEntries(agents).map((entry) => entry.alias)).toContain('总指挥')
    expect(extractMentionedAgentIds('@高级前端工程师 请实现，@总指挥 汇总', agents)).toEqual([
      'frontend-1',
      'orchestrator-1',
    ])
    expect(extractMentionedAgentIds('@高级前端工程师 @前端实现', agents)).toEqual([
      'frontend-1',
    ])
  })
})
