# apps/demo

Next.js reference app that wires up `@promocean/sdk` and `@promocean/widgets`
against a live Promocean API — tracks events, unlocks achievements, and
renders a placement offer and live-event countdown. Also hosts the
Playwright e2e suite (`e2e/`) used as this repo's CI proof of the
track → unlock → badge loop.

See the root [README](../../README.md) for full setup, environment
variables, and how to boot the whole stack.
