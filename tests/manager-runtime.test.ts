import { describe, expect, test, beforeAll } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Set up temp data root before importing modules
const tempDir = mkdtempSync(join(tmpdir(), 'agenthub-manager-test-'))
process.env.AGENTHUB_APP_DATA_DIR = tempDir

import {
  loadManagerSkills,
  loadManagerTools,
  buildToolsPrompt,
  executeToolCall,
  getRegisteredToolNames,
  hasExecutor,
} from '../apps/server/src/services/manager-runtime'

describe('Manager Runtime', () => {
  describe('Skill Loader', () => {
    test('loads all builtin skills', () => {
      const skills = loadManagerSkills()
      expect(skills.length).toBeGreaterThanOrEqual(15)
      const names = skills.map((s) => s.name)
      expect(names).toContain('worker-management')
      expect(names).toContain('task-management')
      expect(names).toContain('channel-management')
      expect(names).toContain('file-sync-management')
      expect(names).toContain('human-management')
      expect(names).toContain('project-management')
      expect(names).toContain('heartbeat')
      expect(names).toContain('memory-management')
    })

    test('each skill has required fields', () => {
      const skills = loadManagerSkills()
      for (const skill of skills) {
        expect(skill.name).toBeTruthy()
        expect(skill.description).toBeTruthy()
        expect(skill.raw).toBeTruthy()
      }
    })

    test('skills have YAML frontmatter parsed correctly', () => {
      const skills = loadManagerSkills()
      const workerMgmt = skills.find((s) => s.name === 'worker-management')
      expect(workerMgmt).toBeTruthy()
      expect(workerMgmt!.description).toContain('Worker')
      expect(workerMgmt!.purpose).toBeTruthy()
      expect(workerMgmt!.rules.length).toBeGreaterThan(0)
    })

    test('skills have controller API surface parsed', () => {
      const skills = loadManagerSkills()
      const taskMgmt = skills.find((s) => s.name === 'task-management')
      expect(taskMgmt).toBeTruthy()
      expect(taskMgmt!.controllerApi.length).toBeGreaterThan(0)
      expect(taskMgmt!.controllerApi.some((api) => api.includes('/runs'))).toBe(true)
    })

    test('SKILL.md files are written to disk', () => {
      const skills = loadManagerSkills()
      for (const skill of skills) {
        const skillPath = join(tempDir, 'AgentHub', 'manager', 'global', 'skills', skill.name, 'SKILL.md')
        expect(existsSync(skillPath)).toBe(true)
        const content = readFileSync(skillPath, 'utf8')
        expect(content).toContain(skill.name)
      }
    })
  })

  describe('Tool Extraction', () => {
    test('extracts tools from skills', () => {
      const tools = loadManagerTools()
      expect(tools.length).toBeGreaterThan(0)
    })

    test('worker-management skill has worker tools', () => {
      const tools = loadManagerTools()
      const workerTools = tools.filter((t) => t.skillName === 'worker-management')
      expect(workerTools.length).toBeGreaterThan(0)
      const toolNames = workerTools.map((t) => t.name)
      expect(toolNames.some((n) => n.includes('workers'))).toBe(true)
    })

    test('task-management skill has task tools', () => {
      const tools = loadManagerTools()
      const taskTools = tools.filter((t) => t.skillName === 'task-management')
      expect(taskTools.length).toBeGreaterThan(0)
      const toolNames = taskTools.map((t) => t.name)
      expect(toolNames.some((n) => n.includes('runs') || n.includes('tasks'))).toBe(true)
    })

    test('builds tools prompt', () => {
      const prompt = buildToolsPrompt()
      expect(prompt).toContain('Available Skills and Tools')
      expect(prompt).toContain('worker-management')
      expect(prompt).toContain('task-management')
    })
  })

  describe('Tool Registry', () => {
    test('has registered executors', () => {
      const names = getRegisteredToolNames()
      // Worker management
      expect(names).toContain('controller.workers.list')
      expect(names).toContain('controller.workers.wake')
      expect(names).toContain('controller.workers.stop')
      expect(names).toContain('controller.workers.idle-stop')
      // Run management
      expect(names).toContain('controller.runs.list')
      expect(names).toContain('controller.runs.create')
      expect(names).toContain('controller.runs.reconcile')
      expect(names).toContain('controller.runs.cancel')
      // Task management
      expect(names).toContain('controller.tasks.list')
      expect(names).toContain('controller.tasks.status')
      expect(names).toContain('controller.tasks.complete')
      expect(names).toContain('controller.tasks.retry')
      // Room management
      expect(names).toContain('controller.rooms.create')
      expect(names).toContain('controller.rooms.events.create')
      expect(names).toContain('controller.rooms.mention')
      expect(names).toContain('controller.rooms.participants.add')
      // Artifact management
      expect(names).toContain('controller.artifacts.list')
      expect(names).toContain('controller.artifacts.register')
      // Human management
      expect(names).toContain('controller.interventions.create')
      // Memory management
      expect(names).toContain('controller.memory.create')
      // Coordination
      expect(names).toContain('controller.coordination.lock')
    })

    test('hasExecutor checks correctly', () => {
      expect(hasExecutor('controller.workers.list')).toBe(true)
      expect(hasExecutor('nonexistent.tool')).toBe(false)
    })

    test('workers.list returns worker summary', async () => {
      const result = await executeToolCall(
        { id: 'test-1', name: 'controller.workers.list', arguments: {} },
        { roomId: 'test-room', ownerId: 'test-user', workspaceId: 'test-workspace' },
      )
      expect(result.success).toBe(true)
      expect(result.callId).toBe('test-1')
      expect(result.toolName).toBe('controller.workers.list')
    })

    test('unknown tool returns failure', async () => {
      const result = await executeToolCall(
        { id: 'test-2', name: 'nonexistent.tool', arguments: {} },
        { roomId: 'test-room', ownerId: 'test-user' },
      )
      expect(result.success).toBe(false)
      expect(result.output).toContain('no executor registered')
    })

    test('rooms.create creates a room', async () => {
      const result = await executeToolCall(
        { id: 'test-3', name: 'controller.rooms.create', arguments: { title: 'Test Room' } },
        { roomId: 'test-room', ownerId: 'default-user' },
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('Room created')
    })

    test('rooms.events.create sends a message', async () => {
      // First create a room
      const roomResult = await executeToolCall(
        { id: 'test-4a', name: 'controller.rooms.create', arguments: { title: 'Event Test Room' } },
        { roomId: 'test-room', ownerId: 'default-user' },
      )
      expect(roomResult.success).toBe(true)
      const roomId = roomResult.metadata?.roomId as string

      // Then send a message to it
      const result = await executeToolCall(
        { id: 'test-4b', name: 'controller.rooms.events.create', arguments: { roomId, body: 'Hello from Manager' } },
        { roomId, ownerId: 'default-user' },
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('Message sent')
    })

    test('tasks.list requires runId', async () => {
      const result = await executeToolCall(
        { id: 'test-5', name: 'controller.tasks.list', arguments: {} },
        { roomId: 'test-room', ownerId: 'test-user' },
      )
      expect(result.success).toBe(false)
      expect(result.output).toContain('No runId')
    })

    test('memory.create stores an entry', async () => {
      // First create a room
      const roomResult = await executeToolCall(
        { id: 'test-6a', name: 'controller.rooms.create', arguments: { title: 'Memory Test Room' } },
        { roomId: 'test-room', ownerId: 'default-user' },
      )
      const roomId = roomResult.metadata?.roomId as string

      const result = await executeToolCall(
        {
          id: 'test-6b',
          name: 'controller.memory.create',
          arguments: { roomId, content: 'Test memory entry', category: 'test' },
        },
        { roomId, ownerId: 'default-user' },
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('Memory entry created')
    })

    test('coordination.lock acquires a lock', async () => {
      const roomResult = await executeToolCall(
        { id: 'test-7a', name: 'controller.rooms.create', arguments: { title: 'Lock Test Room' } },
        { roomId: 'test-room', ownerId: 'default-user' },
      )
      const roomId = roomResult.metadata?.roomId as string

      const result = await executeToolCall(
        {
          id: 'test-7b',
          name: 'controller.coordination.lock',
          arguments: { roomId, lockKey: 'test-lock', owner: 'manager' },
        },
        { roomId, ownerId: 'default-user' },
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('Lock acquired')
    })
  })
})
