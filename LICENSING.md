# Licensing

Embeddable client code (the SDK, widgets, shared schemas, and shared tooling
config) ships MIT so integrators can adopt it in their own codebases without a
copyleft obligation; everything that makes up the Promocean platform itself
(the CMS, the runtime API, the demo app, and the core/domain and adapter
packages behind them) stays GPL-3.0-only for the open-core angle.

| Package                     | License      |
| ---------------------------- | ------------ |
| (root)                       | GPL-3.0-only |
| `packages/core`               | GPL-3.0-only |
| `packages/adapter-db`         | GPL-3.0-only |
| `packages/adapter-strapi`     | GPL-3.0-only |
| `apps/api`                    | GPL-3.0-only |
| `apps/cms`                    | GPL-3.0-only |
| `apps/demo`                   | GPL-3.0-only |
| `packages/contracts`          | MIT          |
| `packages/sdk`                | MIT          |
| `packages/widgets`            | MIT          |
| `packages/config`             | MIT          |

Each MIT package carries its own `LICENSE` file; the root `LICENSE` covers
everything GPL-3.0-only.
