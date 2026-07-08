import { z } from 'zod'
import {
  errorEnvelopeSchema,
  eraseUserResponseSchema,
  liveEventsResponseSchema,
  offerClickRequestSchema,
  offerClickResponseSchema,
  placementOfferResponseSchema,
  trackEventRequestSchema,
  trackEventResponseSchema,
  userAchievementsResponseSchema,
} from '@promocean/contracts'

// zod v4's z.toJSONSchema accepts a `target` option; 'openapi-3.0' produces
// `nullable: true` siblings instead of `type: [x, "null"]` unions, which is
// what OpenAPI 3.0/3.1 tooling generally expects for our nullable fields.
const toSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0' })

const errorResponse = {
  description: 'Error response.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/errorEnvelope' } } },
}

const userIdParam = {
  name: 'userId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
}

export function buildOpenApiDocument(version: string) {
  const schemas = {
    trackEventRequest: toSchema(trackEventRequestSchema),
    trackEventResponse: toSchema(trackEventResponseSchema),
    userAchievementsResponse: toSchema(userAchievementsResponseSchema),
    eraseUserResponse: toSchema(eraseUserResponseSchema),
    placementOfferResponse: toSchema(placementOfferResponseSchema),
    offerClickRequest: toSchema(offerClickRequestSchema),
    offerClickResponse: toSchema(offerClickResponseSchema),
    liveEventsResponse: toSchema(liveEventsResponseSchema),
    errorEnvelope: toSchema(errorEnvelopeSchema),
  }

  const paths = {
    '/v1/events': {
      post: {
        summary: 'Track an event, evaluating achievement progress and unlocks.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/trackEventRequest' } } },
        },
        responses: {
          '200': {
            description: 'Event tracked (or deduped by idempotency key).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/trackEventResponse' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/users/{userId}/achievements': {
      get: {
        summary: "Get a user's achievement progress and unlock state.",
        parameters: [userIdParam],
        responses: {
          '200': {
            description: 'Achievement statuses for the user.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/userAchievementsResponse' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/users/{userId}': {
      delete: {
        summary: 'Erase all stored data for a user (right to erasure). Requires a secret key.',
        parameters: [userIdParam],
        responses: {
          '200': {
            description: 'User data erased.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/eraseUserResponse' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/placements/{slug}/offer': {
      get: {
        summary: 'Resolve the currently active offer for a placement.',
        parameters: [
          { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'userId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'The active offer for the placement, or null if none.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/placementOfferResponse' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/offers/{id}/click': {
      post: {
        summary: 'Record a click on an offer.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/offerClickRequest' } } },
        },
        responses: {
          '200': {
            description: 'Click recorded.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/offerClickResponse' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/events/live': {
      get: {
        summary: 'List timed events that are scheduled, live, or ending soon.',
        responses: {
          '200': {
            description: 'Live and upcoming timed events.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/liveEventsResponse' } } },
          },
          default: errorResponse,
        },
      },
    },
  }

  return {
    openapi: '3.0.3',
    info: { title: 'Promocean API', version },
    paths,
    components: {
      schemas,
      securitySchemes: { bearerKey: { type: 'http', scheme: 'bearer' } },
    },
    security: [{ bearerKey: [] }],
  }
}
