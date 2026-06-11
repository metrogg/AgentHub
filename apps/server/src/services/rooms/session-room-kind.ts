import type { EnsureRoomForSessionInput, RoomKind } from './types'

export function resolveRoomKindForSession(input: EnsureRoomForSessionInput): RoomKind {
  if (input.metadata?.kind === 'agent-direct') return 'direct'
  if (input.metadata?.kind === 'orchestrator-task') return 'task'
  return input.sessionType === 'group' ? 'group' : 'direct'
}
