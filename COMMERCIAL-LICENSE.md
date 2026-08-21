# Commercial licensing

Promocean is open core. The embeddable client packages (`@promocean/sdk`,
`@promocean/widgets`, `@promocean/contracts`, `@promocean/cli`,
`@promocean/config`) are MIT-licensed: use them in any codebase, commercial or
not, with no further obligations. See [LICENSING.md](LICENSING.md) for the map.

The platform itself (the runtime API, the CMS, the demo app, and the
core/adapter packages behind them) is licensed **GPL-3.0-only**. You can
self-host it in production for free, forever, provided you comply with the
GPL's terms, including making the source of any modifications you distribute
available under the same license.

## When you need a commercial license

A commercial (non-GPL) license for the platform is available if you want to:

- embed or white-label the Promocean platform inside a proprietary product you
  distribute to customers;
- offer Promocean itself (or a derivative) as a hosted service without GPL
  source obligations;
- satisfy an internal policy that disallows GPL software in your deployment,
  even where the GPL's obligations would not actually bind you.

Simply *using* a self-hosted Promocean to serve your own app (calling its API
from your proprietary frontend/backend) does **not** require a commercial
license: the GPL applies to distributing the platform, and the MIT client
packages are what live in your codebase.

## How to inquire

Open a [licensing inquiry](https://github.com/hynding/promocean/issues/new?labels=licensing&title=Commercial+license+inquiry)
on GitHub (fine to keep details high-level in public; we'll move to email for
specifics). Include roughly: what you're deploying, whether it's distributed or
hosted, and your expected scale. Enterprise plans on Promocean Cloud include a
commercial license.
