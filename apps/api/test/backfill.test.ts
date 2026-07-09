import { describe, expect, it } from 'vitest'
import type { AchievementDefinition, AuthContext } from '@promocean/core'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

const headers = { authorization: 'Bearer pk_test_valid_key_1' }

function pkAuth(): AuthContext { return { projectId: 'p1', environment: 'test', keyType: 'publishable', allowedOrigins: null } }
function skAuth(): AuthContext { return { projectId: 'p1', environment: 'test', keyType: 'secret', allowedOrigins: null } }

function achievement(overrides: Partial<AchievementDefinition> = {}): AchievementDefinition {
  return {
    id: 'a1', name: 'Regular', description: null, artworkUrl: null,
    eventType: 'purchase', targetCount: 5, pointsValue: 10,
    ...overrides,
  }
}

function setup(auth: AuthContext, definitions: AchievementDefinition[] = []) {
  const fakes = makeFakes(definitions, auth)
  return { app: createApp(fakes, { rateLimitPerMinute: 0 }), fakes }
}

describe('POST /v1/achievements/:id/backfill', () => {
  it('publishable key -> 403 forbidden', async () => {
    const { app } = setup(pkAuth(), [achievement()])
    const res = await app.request('/v1/achievements/a1/backfill', { method: 'POST', headers })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden')
  })

  it('unknown achievement id -> 404 not_found', async () => {
    const { app } = setup(skAuth(), [achievement({ id: 'a1' })])
    const res = await app.request('/v1/achievements/does-not-exist/backfill', { method: 'POST', headers })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })

  it('happy path passes the resolved definition to the store and maps the summary verbatim', async () => {
    const def = achievement({ id: 'a1', eventType: 'purchase', targetCount: 5 })
    const { app, fakes } = setup(skAuth(), [def])
    fakes.setBackfillResult({ usersEvaluated: 42, progressRaised: 10, unlocksGranted: 3, pointsAwarded: 30 })
    const res = await app.request('/v1/achievements/a1/backfill', { method: 'POST', headers })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ usersEvaluated: 42, progressRaised: 10, unlocksGranted: 3, pointsAwarded: 30 })
    expect(fakes.backfillCalls).toHaveLength(1)
    expect(fakes.backfillCalls[0].scope).toEqual({ projectId: 'p1', environment: 'test' })
    expect(fakes.backfillCalls[0].def).toEqual(def)
  })
})
