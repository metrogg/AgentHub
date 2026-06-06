import { describe, expect, test } from 'bun:test'
import { isMissingDockerImageError } from '../apps/server/src/services/container-runtime/docker-runtime'

describe('docker runtime', () => {
  test('treats missing image inspect output as a normal not-present state', () => {
    expect(isMissingDockerImageError('Error response from daemon: No such image: agenthub/openclaw-runtime:local')).toBe(true)
    expect(isMissingDockerImageError('Error response from daemon: manifest unknown')).toBe(true)
    expect(isMissingDockerImageError('some other docker error')).toBe(false)
  })
})
