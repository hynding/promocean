# Releasing

The publishable packages are the four MIT-licensed ones (see `LICENSING.md`):

| Package | Publish? |
|---|---|
| `@promocean/contracts` | yes (npm) |
| `@promocean/sdk` | yes (npm) |
| `@promocean/widgets` | yes (npm) |
| `@promocean/cli` | yes (npm) — ships a `promocean` binary, not a library; same publish path |
| `@promocean/core`, `@promocean/adapter-db`, `@promocean/adapter-strapi`, `@promocean/config`, `api`, `cms`, `demo` | no — `"private": true` in their `package.json` |

Versioning is driven by [Changesets](https://github.com/changesets/changesets).

## 1. The changeset flow

1. **During feature work** — any PR that changes a publishable package adds a
   changeset: `pnpm changeset`, pick the affected packages and semver level,
   write a consumer-facing summary. The changeset markdown files accumulate in
   `.changeset/`.
2. **At release time** — on a release branch run:

   ```sh
   pnpm changeset version
   ```

   This consumes **all** pending changesets: bumps each affected
   `package.json` version, writes/updates each package's `CHANGELOG.md`
   (internal dependents get at least a patch via
   `updateInternalDependencies: "patch"`), and deletes the consumed changeset
   files. Commit all of that output together.
3. **Publish** — `changeset publish` (run by CI, see §3) publishes every
   package whose version isn't yet on the registry and creates a
   `@promocean/<name>@<version>` git tag per package.

Internal deps are declared as `workspace:*`; **pnpm rewrites them to the real
pinned versions at pack/publish time**. Never hand-edit them to concrete
versions.

## 2. Release rehearsal (repeatable checklist)

Run this before any real publish. It never touches the public registry.

### 2.1 Pack validation (dry-run)

```sh
pnpm turbo run build --filter='./packages/*'
pnpm publish -r --dry-run --no-git-checks
```

For each of `@promocean/contracts`, `@promocean/sdk`, `@promocean/widgets`,
`@promocean/cli`, check the printed tarball contents:

- [ ] `dist/` present; `src/` and `test/` **absent** (the `files` allowlist is
      `["dist", "README.md", "LICENSE"]` — `@promocean/cli`'s is the same set,
      listed as `["dist", "LICENSE", "README.md"]`)
- [ ] `LICENSE` (MIT) and `README.md` present
- [ ] version matches the `changeset version` bump
- [ ] for `@promocean/cli` only: `dist/cli.js` keeps its `#!/usr/bin/env node`
      shebang and `bin.promocean` in the packed manifest points at it

Then inspect the packed manifests directly (dry-run output doesn't show them):

```sh
pnpm --filter @promocean/contracts --filter @promocean/sdk --filter @promocean/widgets --filter @promocean/cli exec \
  pnpm pack --pack-destination /tmp/promocean-pack
for f in /tmp/promocean-pack/*.tgz; do tar -xOzf "$f" package/package.json; done
```

- [ ] every `workspace:*` dep is rewritten to a real version
      (e.g. `"@promocean/contracts": "0.1.0"`)
- [ ] `main`/`types` point into `dist/`

Note: `@promocean/core`, `@promocean/adapter-db`, `@promocean/adapter-strapi`,
`@promocean/config`, and `api` are all `"private": true`, so `pnpm publish -r`
(including this dry-run) skips them entirely — you should **not** see their
tarball listings in this step at all. That's a load-bearing property, not
cosmetic: `changeset publish` decides what to publish by walking every
**non-private** workspace package and publishing whichever ones have a local
version not yet on the registry. It does **not** consult
`.changeset/config.json`'s `ignore` list at publish time — that list only
keeps `changeset version` from bumping those packages' versions/changelogs.
Before these five were marked `private`, nothing at publish time stood
between them and npm; the very first real `changeset publish` run would have
tried to publish all five GPL/internal packages (`api` included) to the
`@promocean` scope. `private: true` is the actual guard here — the `ignore`
list alone never was.

**Never run `pnpm publish -r` without `--dry-run`.** The real publish path is
`changeset publish`, invoked only via the manually-dispatched `release.yml`
workflow (§3) — never run a bare recursive `pnpm publish` yourself.

### 2.2 Publish to a local verdaccio

```sh
docker run -d --name verdaccio -p 4873:4873 verdaccio/verdaccio
# wait until: curl -fsS http://localhost:4873/-/ping   -> {}

# Throwaway auth: verdaccio's default config auto-registers any new user
# (htpasswd, max_users unrestricted). `npm adduser` is interactive-only on
# npm >= 9, so register via the legacy couchdb endpoint and store the token
# it returns — this is the approach that works non-interactively:
TOKEN=$(curl -fsS -XPUT http://localhost:4873/-/user/org.couchdb.user:rehearsal \
  -H 'content-type: application/json' \
  -d '{"name":"rehearsal","password":"rehearsal"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
npm config set //localhost:4873/:_authToken "$TOKEN"
npm whoami --registry http://localhost:4873   # -> rehearsal

pnpm --filter @promocean/contracts --filter @promocean/sdk --filter @promocean/widgets --filter @promocean/cli \
  publish --registry http://localhost:4873 --no-git-checks
```

If the Docker daemon can't pull `verdaccio/verdaccio` (registry pulls
wedged), the same rehearsal works from any locally cached Node image:

```sh
docker run -d --name verdaccio -p 4873:4873 node:22 \
  sh -c 'npx --yes verdaccio@6 --listen http://0.0.0.0:4873'
```

### 2.3 Install + smoke-test from verdaccio

```sh
mkdir -p /tmp/promocean-rehearsal && cd /tmp/promocean-rehearsal
npm init -y
npm install @promocean/contracts @promocean/sdk @promocean/widgets react react-dom \
  --registry http://localhost:4873
node smoke.mjs   # see below

# @promocean/cli ships a binary, not a library — its own smoke check is
# installing it globally and confirming the bin resolves and runs:
npm install -g @promocean/cli --registry http://localhost:4873
promocean export --url http://localhost:1 --project x 2>&1 | grep -q PROMOCEAN_CONFIG_SECRET \
  && echo 'cli bin OK (env-guard message printed)'
npm uninstall -g @promocean/cli
```

`smoke.mjs` must exercise all three library packages (`@promocean/cli` is
smoke-tested separately above, as a binary rather than an import):

- parse one `@promocean/contracts` schema (e.g. `rewardSchema.parse({...})`)
- `new Promocean({ publishableKey, baseUrl, fetchImpl: mockFetch })` and
  `await client.listRewards()` against a canned `{ rewards: [...] }` response
- `import { PromoceanProvider, RewardsStore } from '@promocean/widgets'` and
  assert both are functions

### 2.4 Teardown

```sh
docker rm -f verdaccio
npm config delete //localhost:4873/:_authToken
```

Verdaccio is always this ephemeral container — never add it to
`docker-compose.yml`.

## 3. CI publish — `.github/workflows/release.yml`

The release workflow is **manually dispatched** (`on: workflow_dispatch`) —
nothing publishes on merge. It: checks out, installs with a frozen lockfile,
builds and tests `./packages/*`, then runs `npx changeset publish` with
`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` against `registry.npmjs.org`, and
pushes the release tags.

To cut a release:

1. Land the `pnpm changeset version` commit (§1.2) on `main` via PR.
2. Run the rehearsal (§2).
3. GitHub → Actions → **release** → *Run workflow* on `main`.

## 4. Remaining manual step before the first public publish

The only thing standing between this repo and a real npm publish:

1. Create the **`promocean` npm org/scope** (or claim the `@promocean` scope
   on npmjs.com) and grant publish access.
2. Create an npm **automation token** and add it to the GitHub repo as the
   **`NPM_TOKEN`** secret (`Settings → Secrets and variables → Actions`).
3. Dispatch the release workflow (§3).

`.changeset/config.json` already sets `"access": "public"`, so the scoped
packages publish publicly without extra flags.
