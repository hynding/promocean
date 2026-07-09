import { z } from 'zod'
import {
  claimRewardRequestSchema,
  claimRewardResponseSchema,
  errorEnvelopeSchema,
  eraseUserResponseSchema,
  leaderboardResponseSchema,
  liveEventsResponseSchema,
  offerClickRequestSchema,
  offerClickResponseSchema,
  offerImpressionRequestSchema,
  offerImpressionResponseSchema,
  placementOfferResponseSchema,
  redeemCouponRequestSchema,
  redeemCouponResponseSchema,
  rewardsResponseSchema,
  statsResponseSchema,
  streakResponseSchema,
  trackEventRequestSchema,
  trackEventResponseSchema,
  userAchievementsResponseSchema,
  validateCouponRequestSchema,
  validateCouponResponseSchema,
  walletResponseSchema,
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
    offerImpressionRequest: toSchema(offerImpressionRequestSchema),
    offerImpressionResponse: toSchema(offerImpressionResponseSchema),
    liveEventsResponse: toSchema(liveEventsResponseSchema),
    statsResponse: toSchema(statsResponseSchema),
    walletResponse: toSchema(walletResponseSchema),
    streakResponse: toSchema(streakResponseSchema),
    leaderboardResponse: toSchema(leaderboardResponseSchema),
    rewardsResponse: toSchema(rewardsResponseSchema),
    claimRewardRequest: toSchema(claimRewardRequestSchema),
    claimRewardResponse: toSchema(claimRewardResponseSchema),
    validateCouponRequest: toSchema(validateCouponRequestSchema),
    validateCouponResponse: toSchema(validateCouponResponseSchema),
    redeemCouponRequest: toSchema(redeemCouponRequestSchema),
    redeemCouponResponse: toSchema(redeemCouponResponseSchema),
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
    '/v1/offers/{id}/impression': {
      post: {
        summary: 'Record an impression on an offer, deduped by client-supplied impressionId.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/offerImpressionRequest' } } },
        },
        responses: {
          '200': {
            description: 'Impression recorded (or already recorded for this impressionId).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/offerImpressionResponse' } } },
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
    '/v1/stats': {
      get: {
        summary: 'Aggregate project stats: totals, achievements, offers (with CTR), and timed events. Requires a secret key.',
        description: 'For recurring timed events, participation is aggregated across every occurrence window intersecting the requested range, clamped to the most recent 400 occurrences per event.',
        parameters: [
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          '200': {
            description: 'Aggregated stats for the requested range.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/statsResponse' } } },
          },
          '403': {
            description: 'A publishable key was used; a secret key is required.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/errorEnvelope' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/users/{userId}/wallet': {
      get: {
        summary: "Get a user's points balance and recent ledger activity.",
        parameters: [userIdParam],
        responses: {
          '200': {
            description: 'Wallet balance and recent activity for the user.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/walletResponse' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/users/{userId}/streak': {
      get: {
        summary: "Get a user's current and longest daily-activity streak.",
        parameters: [userIdParam],
        responses: {
          '200': {
            description: 'Streak state for the user.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/streakResponse' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/leaderboard': {
      get: {
        summary: 'Rank users by points earned within a window.',
        parameters: [
          { name: 'window', in: 'query', required: false, schema: { type: 'string', enum: ['all', '7d', '30d'] } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: {
          '200': {
            description: 'Ranked leaderboard entries for the requested window.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/leaderboardResponse' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/rewards': {
      get: {
        summary: 'List the enabled, in-window reward catalog with per-reward remaining inventory.',
        responses: {
          '200': {
            description: 'The reward catalog visible to the caller.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/rewardsResponse' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/rewards/{slug}/claim': {
      post: {
        summary: 'Claim a reward for a user, issuing a coupon code.',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/claimRewardRequest' } } },
        },
        responses: {
          '200': {
            description: 'Reward claimed; a coupon code was issued.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/claimRewardResponse' } } },
          },
          '404': {
            description: 'No reward exists with this slug.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/errorEnvelope' } } },
          },
          '409': {
            description: 'Claim rejected: reward_unavailable (disabled, out of window, or inventory exhausted), claim_limit_reached (per-user limit reached), or insufficient_points (balance too low).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/errorEnvelope' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/coupons/validate': {
      post: {
        summary: 'Check whether a coupon code is valid, without mutating anything. Requires a secret key.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/validateCouponRequest' } } },
        },
        responses: {
          '200': {
            description: 'Validation result. Always 200 — see the `valid`/`reason` fields for outcome.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/validateCouponResponse' } } },
          },
          '403': {
            description: 'A publishable key was used; a secret key is required.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/errorEnvelope' } } },
          },
          default: errorResponse,
        },
      },
    },
    '/v1/coupons/redeem': {
      post: {
        summary: 'Redeem a coupon code, marking it used. Requires a secret key.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/redeemCouponRequest' } } },
        },
        responses: {
          '200': {
            description: 'Coupon redeemed.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/redeemCouponResponse' } } },
          },
          '403': {
            description: 'A publishable key was used; a secret key is required.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/errorEnvelope' } } },
          },
          '404': {
            description: 'No coupon exists with this code.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/errorEnvelope' } } },
          },
          '409': {
            description: 'Redeem rejected: reward_unavailable (the reward has expired or no longer exists) or already_redeemed (the coupon was already used).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/errorEnvelope' } } },
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
