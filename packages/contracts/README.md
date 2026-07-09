# @promocean/contracts

Zod schemas and TypeScript types shared across the Promocean API, SDK, and
widgets: event tracking, achievements, offers, timed events, webhooks,
stats, users, and the error envelope. This package has no runtime behavior
of its own — it's the single source of truth for request/response shapes so
the API and its clients can't drift.

## Install

    npm i @promocean/contracts

## Usage

```ts
import { trackEventRequestSchema, type TrackEventResponse } from '@promocean/contracts'

const parsed = trackEventRequestSchema.safeParse(body)
```

Most consumers won't need this package directly — [`@promocean/sdk`](../sdk/README.md)
re-exports the types it uses and validates responses against these schemas
at runtime.
