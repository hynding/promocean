import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

function app() { return createApp(makeFakes([], null)) }

describe('GET /v1/openapi.json', () => {
  it('is reachable without an Authorization header', async () => {
    const res = await app().request('/v1/openapi.json')
    expect(res.status).toBe(200)
  })

  it('describes all six documented endpoints', async () => {
    const res = await app().request('/v1/openapi.json')
    const doc = await res.json()
    expect(doc.openapi).toBe('3.0.3')
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/events',
        '/v1/users/{userId}/achievements',
        '/v1/users/{userId}',
        '/v1/placements/{slug}/offer',
        '/v1/offers/{id}/click',
        '/v1/events/live',
      ]),
    )
  })

  it('includes the error envelope schema', async () => {
    const res = await app().request('/v1/openapi.json')
    const doc = await res.json()
    expect(doc.components.schemas.errorEnvelope).toBeDefined()
  })

  it('reports a non-empty info.version', async () => {
    const res = await app().request('/v1/openapi.json')
    const doc = await res.json()
    expect(typeof doc.info.version).toBe('string')
    expect(doc.info.version.length).toBeGreaterThan(0)
  })
})
