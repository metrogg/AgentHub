import { describe, expect, test } from 'bun:test'
import { mergeMobileContacts } from '../apps/server/src/routes/mobile'

describe('mobile contacts', () => {
  test('merges saved library and workspace contacts without dropping either source', () => {
    const savedBuilder = {
      id: 'saved-builder',
      source: 'library',
      workspaceId: null,
      workspaceAgentId: null,
      name: 'Builder',
      role: 'Coder',
      roleType: 'coder',
      description: '',
      avatar: null,
      color: '#111827',
      runtimeType: 'code-agent',
      codeAgentType: 'claude-code',
      capabilityTags: [],
    }
    const workspaceBuilder = {
      ...savedBuilder,
      id: 'workspace-builder',
      source: 'workspace-agent',
      workspaceId: 'workspace-1',
      workspaceAgentId: 'workspace-builder',
    }
    const savedReviewer = {
      ...savedBuilder,
      id: 'saved-reviewer',
      name: 'Reviewer',
      role: 'Reviewer',
      codeAgentType: 'codex',
    }

    const merged = mergeMobileContacts([workspaceBuilder], [savedBuilder, savedReviewer])

    expect(merged).toHaveLength(2)
    expect(merged.find((contact) => contact.name === 'Builder')?.workspaceAgentId).toBe('workspace-builder')
    expect(merged.find((contact) => contact.name === 'Reviewer')?.id).toBe('saved-reviewer')
  })
})
