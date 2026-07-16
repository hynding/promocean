# @promocean/cli

Config-as-code CLI for Promocean projects: export a project's configuration
(placements, achievements, timed events, offers, rewards, project settings)
to a JSON file, and import a JSON file back into a project with a
plan-before-apply workflow.

Requires Node 20+.

## Install

    npm i -g @promocean/cli

Or run ad hoc with `npx @promocean/cli ...`.

## Authentication

Both commands read the config-plane secret from the `PROMOCEAN_CONFIG_SECRET`
environment variable — there is no `--secret` flag, so the secret never shows
up in shell history or process listings. If the variable isn't set, the CLI
exits 1 with an error naming it.

    export PROMOCEAN_CONFIG_SECRET=...

## Usage

### Export

Fetch a project's current configuration and write it as pretty-printed JSON.
The server's response is validated against the config file schema before
anything is written, as a defense against a drifted server.

    promocean export --url https://cms.example.com --project <projectId> --out project.json

Omit `--out` to print the JSON to stdout instead.

### Import

Validate a config file locally (fail fast, listing every schema issue before
any network call), then upload it. The server computes a plan (creates,
updates, deletes, unchanged counts per content type) and — unless `--dry-run`
is given — applies it.

    promocean import --url https://cms.example.com --project <projectId> --file project.json [--prune] [--dry-run]

- `--prune`: delete content that exists on the server but is absent from the
  file (per content type). Without it, absent content is left alone.
- `--dry-run`: compute and print the plan without applying it.

The plan is printed as a table: per content type, counts of creates/updates/
deletes/unchanged, plus the slugs affected.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success, or a dry run that found no changes to make |
| 1 | Any error: bad arguments, missing `PROMOCEAN_CONFIG_SECRET`, a file that fails schema validation, an HTTP error, or a partially-applied import (HTTP 422) |
| 2 | A dry run completed and found at least one create, update, or delete anywhere in the plan |

A 422 response from the import endpoint means the server started applying
changes and hit an error partway through; the CLI renders which stage failed,
the error message, and the plan actually applied (not the one that was
intended) — always exiting 1.

## Programmatic use

`runExport` and `runImport` (from `@promocean/cli/dist/commands/*`) both
accept an injectable `fetchImpl: typeof fetch` and return
`{ exitCode, output }` without ever calling `process.exit`, which is how this
package's own tests drive them.
