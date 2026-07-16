---
"@promocean/cli": minor
"@promocean/contracts": minor
---

New package **`@promocean/cli`** (`promocean` binary): `export`/`import`
commands for config-as-code — pull a project's placements, achievements,
timed events, offers, rewards, and project settings into a single JSON
file, and push edits back through a plan-before-apply workflow
(`--dry-run` prints the plan and exits 2 if it would change anything,
0 if not — a ready-made CI drift check; `--prune` additionally deletes
server-side content absent from the file). The config-plane secret is read
only from `PROMOCEAN_CONFIG_SECRET`, never a flag.

`@promocean/contracts` gains the schemas backing the config file and the
import request/response (`configFileSchema`, `importRequestSchema`,
`importResponseSchema`, and their inferred `ConfigFile`/`ImportRequest`/
`ImportResponse` types) — additive, no existing schema changed.
