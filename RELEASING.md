# Releasing

The publishable packages are the three MIT-licensed ones (see `LICENSING.md`):

| Package | Publish? |
|---|---|
| `@promocean/contracts` | yes (npm) |
| `@promocean/sdk` | yes (npm) |
| `@promocean/widgets` | yes (npm) |
| `@promocean/core`, `@promocean/adapter-db`, `@promocean/adapter-strapi`, `@promocean/config`, `api`, `cms`, `demo` | no — GPL/private, listed in `.changeset/config.json` `ignore` |

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
check the printed tarball contents:

- [ ] `dist/` present; `src/` and `test/` **absent** (the `files` allowlist is
      `["dist", "README.md", "LICENSE"]`)
- [ ] `LICENSE` (MIT) and `README.md` present
- [ ] version matches the `changeset version` bump

Then inspect the packed manifests directly (dry-run output doesn't show them):

```sh
pnpm --filter @promocean/contracts --filter @promocean/sdk --filter @promocean/widgets exec \
  pnpm pack --pack-destination /tmp/promocean-pack
for f in /tmp/promocean-pack/*.tgz; do tar -xOzf "$f" package/package.json; done
```

- [ ] every `workspace:*` dep is rewritten to a real version
      (e.g. `"@promocean/contracts": "0.1.0"`)
- [ ] `main`/`types` point into `dist/`

Note: the dry-run also prints the **non-publishable** workspace packages
(config/core/adapters) because `pnpm publish -r` walks every non-private
workspace package. That's expected for the dry-run; the real publish goes
through `changeset publish`, which only publishes the packages changesets
versioned (the ignored ones are never versioned, and CI's registry auth is
scoped to the real release flow). Their tarball listings can be ignored here.

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

pnpm --filter @promocean/contracts --filter @promocean/sdk --filter @promocean/widgets \
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
```

`smoke.mjs` must exercise all three packages:

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
