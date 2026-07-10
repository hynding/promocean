import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

function app() { return createApp(makeFakes([], null)) }

describe('GET /v1/openapi.json', () => {
  it('is reachable without an Authorization header', async () => {
    const res = await app().request('/v1/openapi.json')
    expect(res.status).toBe(200)
  })

  it('describes all sixteen documented endpoints', async () => {
    const res = await app().request('/v1/openapi.json')
    const doc = await res.json()
    expect(doc.openapi).toBe('3.0.3')
    expect(Object.keys(doc.paths)).toHaveLength(16)
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/events',
        '/v1/users/{userId}/achievements',
        '/v1/users/{userId}',
        '/v1/placements/{slug}/offer',
        '/v1/offers/{id}/click',
        '/v1/offers/{id}/impression',
        '/v1/events/live',
        '/v1/stats',
        '/v1/users/{userId}/wallet',
        '/v1/users/{userId}/streak',
        '/v1/leaderboard',
        '/v1/rewards',
        '/v1/rewards/{slug}/claim',
        '/v1/coupons/validate',
        '/v1/coupons/redeem',
        '/v1/achievements/{id}/backfill',
      ]),
    )
  })

  it('documents 403 and 404 responses for the backfill endpoint', async () => {
    const res = await app().request('/v1/openapi.json')
    const doc = await res.json()
    const responses = doc.paths['/v1/achievements/{id}/backfill'].post.responses
    expect(responses['403']).toBeDefined()
    expect(responses['404']).toBeDefined()
  })

  it('documents a uniform 403 response on every sk-only endpoint', async () => {
    const res = await app().request('/v1/openapi.json')
    const doc = await res.json()
    const skEndpoints: Array<{ path: string; method: 'get' | 'post' | 'delete' }> = [
      { path: '/v1/stats', method: 'get' },
      { path: '/v1/users/{userId}', method: 'delete' },
      { path: '/v1/coupons/validate', method: 'post' },
      { path: '/v1/coupons/redeem', method: 'post' },
      { path: '/v1/achievements/{id}/backfill', method: 'post' },
    ]
    for (const { path, method } of skEndpoints) {
      const responses = doc.paths[path][method].responses
      expect(responses['403']).toBeDefined()
      expect(responses['403'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/errorEnvelope' })
    }
  })

  it('no longer documents the dead userId query param on the placements offer endpoint', async () => {
    const res = await app().request('/v1/openapi.json')
    const doc = await res.json()
    const parameters = doc.paths['/v1/placements/{slug}/offer'].get.parameters
    expect(parameters).toEqual([{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }])
  })

  it('documents the disabled-events inclusion note on the stats endpoint', async () => {
    const res = await app().request('/v1/openapi.json')
    const doc = await res.json()
    expect(doc.paths['/v1/stats'].get.description).toContain('historical windows of since-disabled events are included')
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

describe('GET /docs', () => {
  it('is reachable without an Authorization header and serves the Redoc viewer', async () => {
    const res = await app().request('/docs')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toContain('<redoc spec-url="/v1/openapi.json"></redoc>')
    expect(html).toContain('cdn.redoc.ly')
  })
})
