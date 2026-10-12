# ENS Scout website

A React and TypeScript single-page app that browses one published ENS snapshot by
lifecycle status.

It is a presentation and interaction layer, and nothing more.
Every status, expiry, grace end, and premium end on the page was computed by the Go
scanner and read out of a snapshot, or out of one fresh check the read API made.
The browser never queries The Graph itself, never classifies a name, and never decides
whether a name is available.
The ENS app is the only authority on that, and the page says so and links to it.

## Run it from a clean clone

No credentials, no API, and no network access to ENS are needed.

```bash
npm ci
npm run dev
```

That serves the committed `preview` fixture from `data/fixtures/`, whose ten names
cover every lifecycle status across three source lists.

## Configuration

Both variables are read at build time, and Vite inlines them into the bundle, so
this is a public surface.
Never put a Graph endpoint, a Graph API key, or an AWS credential in a `VITE_*`
variable: anyone who opens the JavaScript can read it, and the browser has no use
for any of them.

| Variable            | Effect                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | Read API origin or path prefix. Empty or unset selects fixture mode.    |
| `VITE_FIXTURE`      | Which committed fixture to serve in fixture mode: `preview` or `stale`. |

With an API configured, the app sends `If-None-Match` and keeps only the last valid
snapshot in `localStorage`, so a reload is cheap and an outage still shows the last
good scan with its age.
That is also the only thing that enables fresh checks: fixture mode has no endpoint to
ask, so it offers no tick boxes and no links out at all.

The production workflow builds with `VITE_API_BASE_URL=/`. `readConfig` normalizes
that to the empty path prefix while keeping API mode enabled, so `/api/snapshot` and
`/api/check` stay on the generated CloudFront hostname. No AWS endpoint, Graph
endpoint, or credential is embedded in the bundle.

## Fresh checks

A snapshot is minutes to hours old by the time anyone reads it, so neither the hero nor
a raw row offers a registration link until a fresh check has covered that exact name,
has not expired, and still reports it as registerable. Nothing else opens that gate -
not an `available` snapshot status, not a recent scan, and not a countdown that has run
down.

Select up to the number of names one check covers, ask for the check, and the endpoint
reads the ENS index once for the whole selection.
The answer says which names it covers and the instant it was obtained, and the page
shows that instant beside the result rather than folding it into the snapshot's own.
The two stay visibly separate because they are two claims about two different moments.

A check that fails changes no status.
The row keeps saying what the snapshot said, the page says the check did not happen and
why in its own words, and the selection is left alone so nothing has to be retyped.
If a fresh status disagrees with the snapshot, both surfaces keep the name visible, show
the newer result, and close any registration action that no longer fits it.
Every link out still says ENS decides: a name the index does not hold may still fail to
register.

`?now=` moves the expiry of a fresh answer too, so an expired check can be demonstrated
the same way a stale snapshot can.

## The simulated clock

The committed fixtures were scanned at a fixed instant, so against a real clock they
are permanently and increasingly stale.
`?now=<ISO instant>` measures every age and countdown from that instant instead.

It is always honoured and always announced: the page carries a notice naming the
simulated instant, and a link to give it up.
A page that quietly lied about the time would be worse than a stale one.

## URL state

Every control writes to the address bar, so a link always reproduces what the sender
was looking at.

| Parameter    | Meaning                                               |
| ------------ | ----------------------------------------------------- |
| `view`       | `all`, `available`, `premium`, `expiring`, or `grace` |
| `q`          | Substring match on the label, case-insensitive        |
| `status`     | Comma-separated statuses recorded at the scan time    |
| `min`, `max` | Label length in characters, without the `.eth` suffix |
| `list`       | Source list ID                                        |
| `sort`       | `name`, `expiry`, `grace-end`, or `premium-end`       |
| `dir`        | `asc` or `desc`                                       |
| `page`       | 1-based page number                                   |
| `now`        | Simulated clock, as above                             |

A default is written as the absence of its parameter, so the shortest link is the
canonical one and the app rewrites any longer spelling of the same state to it.
`view` defaults to `available`, which is the question a visitor arrives with; a URL
with no `view` opens the available names.

## Featured entrance

The canonical empty-query Available route opens on a full-viewport editorial map of twelve reviewed names on desktop and tablet, or the first seven of the same ranking on mobile.
The names remain in ranked order in the DOM and keyboard sequence even though fixed slots position them spatially.
The hero renders the names without visible scores, positions, facet tags, or explanatory copy; ranking remains an ordering and placement input only.
Ordinary scrolling reveals the complete searchable and filterable field; the skip link and `Explore all` action both focus its heading.
One floating `Data` button opens snapshot and ranking provenance from either the hero or a discovery deep link.

Any search, non-default view, status/lifecycle filter, length filter, source-list filter, sort direction, page number, or simulated clock is a discovery deep link and bypasses the hero.
The address bar remains the authority rather than a second UI state.

`public/data/og-rank-v1.json` is the complete offline editorial rank, and `src/data/featured-safe-v1.json` is its separately reviewed placement allowlist.
The selector intersects those artifacts with names whose current snapshot status is exactly `available`, then applies one deterministic diversity pass without running a simulation in the browser.
The rank artifact loads independently of the snapshot.
While it is pending the page reserves the final geometry without showing candidate names.
A missing, slow, blocked, or corrupt rank uses the deterministic allowlist-only fallback through the same selector, while a refused safety policy omits the hero and starts at ordinary discovery.
Neither case shifts or delays the ordinary snapshot list.

`go run ./cmd/og-ranking build` regenerates the rank, allowlist, fixture, review summary, and sanitized browser provenance from the reviewed repository inputs.
`go run ./cmd/og-ranking check` proves those committed artifacts are current without contacting a model.
The compact `Featured ranking` group in the Data drawer shows the approved method, versions, corpus identity, generator identity and hashes, review scope, safety policy, runtime source, and the snapshot used for the availability join.
That public provenance is generated at `src/data/featured-ranking-provenance-v1.json` and deliberately excludes prompts, raw responses, provider request metadata, account identifiers, credentials, and local paths.
Editorial rank never opens a registration link; only an unexpired fresh check for that exact name can pass the outbound gate.

## Development

```bash
npm run dev             # dev server, fixture mode
npm run test            # unit and component tests (vitest, jsdom)
npm run test:browser    # browser tests against two production builds
npm run browser:install # one-off: download the Chromium the browser tests need
npm run verify          # the whole gate, in order
```

`npm run verify` runs format check, lint, typecheck, unit tests, the production
build, and the browser tests.
That is the gate a change has to pass.

The browser suite runs against a real production build served by `vite preview`, not
against the dev server, so what it asserts is what a visitor gets: the same minified
bundle, the same asset graph, and the same absence of any endpoint or credential.

There are two of those builds, on two ports, and Playwright builds and serves both.
`dist` is fixture mode, which is what proves the page needs no endpoint.
`dist-verify`, built by `build:verify` and served by `preview:verify`, has
`VITE_API_BASE_URL` configured, which is the only place the fresh-check action exists to
be driven.
That URL is the page's own origin, so a request Playwright fulfils is same-origin and
CORS never enters into what the specs assert; the CORS rules themselves are Go's, and
`internal/api` tests them.
The origins each build was given are not copied into a spec either: `assets.spec.ts`
reads them from the same definition the servers do, or it could pass while scanning the
wrong bundle.
Both directories are git-ignored.

It runs seven projects.

| Project            | Why it exists                                                        |
| ------------------ | -------------------------------------------------------------------- |
| `desktop` (1440)   | The layout most visitors see                                         |
| `tablet` (834)     | The width the filter and count grids reflow at                       |
| `mobile` (Pixel 7) | A real phone context, including its viewport-meta behaviour          |
| `narrow` (320)     | WCAG 1.4.10 Reflow, in a desktop context on purpose - see below      |
| `verify`           | `dist-verify` against a stub read API: the whole fresh-check surface |
| `performance`      | Local mid-tier mobile LCP, INP, and CLS budgets                      |
| `assets`           | Reads both builds with no browser: secret scan and origin allowlist  |

`performance` uses the local production fixture at 390 by 844 CSS pixels with touch, a mobile user agent, and four-times CPU slowdown.
It observes Chrome's buffered Largest Contentful Paint, Layout Shift, and Event Timing entries and fails above 2.5 seconds LCP, 200 milliseconds INP, or 0.10 CLS.
It runs after the functional and asset projects, so concurrent browser workers cannot become input delay in the measured page.
Its result records the input delay, processing time, presentation delay, and target for every measured interaction before enforcing those budgets, so a CI failure retains the evidence needed to diagnose it.
The performance project disables Playwright trace capture because trace screenshots and DOM snapshots compete with the throttled renderer; its structured metrics attachment provides the failure diagnostics instead.
Run `npx playwright test --project=performance --no-deps` to exercise only this profile while developing it.
It does not emulate a public network, whose variance would make the gate flaky; `assets` enforces the transfer side separately.
The rank must remain at or below 80,000 bytes Brotli and 130,000 bytes gzip, while the initial entry JavaScript must remain below 350,000 bytes raw and 110,000 bytes gzip.
The same production-asset suite rejects model runtimes, model assets or hosts, provider credentials, WebGPU probes, shader requirements, model caches, generation calls, and runtime force or collision solvers.
Layout coverage separately caps the rendered hero at twelve name controls.

`verify` runs with reduced motion asked for, because what it drives is a sequence of
states rather than a layout, and it is the one project whose base URL is the second
build.
Its bundle has no fixture compiled in, so both the pointer and the snapshot are served
to it out of the same committed `preview` fixture the other projects use: the rows, the
counts, and the statuses match, and the only difference between the two bundles is
whether a check can be made at all.
The check responses in that stub are written by hand rather than built by importing
anything from `src/`, because a document the production parser helped construct would
agree with it by construction and what those tests are for is the parser refusing one.

`narrow` is deliberately a desktop window rather than a phone descriptor.
A phone context honours the viewport meta tag, so Chrome answers content that is too
wide by zooming the page out instead of scrolling it, and a reflow check then passes
on a layout that really does overflow.
That is exactly how a 320px overflow went unnoticed here once.

## Structure

```text
src/wire/          the primitive readers both fail-closed parsers are built from
src/snapshot/      the browser's half of the snapshot contract, and its parser
src/verify/        the browser's half of the check contract, its parser, and the gate
src/ranking/       strict editorial artifact parsing, deterministic selection, and fallback
src/data/          fixture loading, the read API client, and the local cache
src/state/         URL state, filtering, paging, the clock, ranking load, and one fresh check
src/format/        time and text formatting
src/components/    the featured entrance, discovery field, evidence, and disclosures
src/test/          test-only helpers, including the reader for the Go sources
tests/browser/     Playwright specs
```

`src/snapshot/contract.ts` restates the few constants a reader cannot derive from the
payload it is handed: the format version it accepts, the cadence intervals, and the
staleness factor.
Go owns all of them.
`contract.drift.test.ts` parses the Go sources and fails when any value stops
matching, so the duplication cannot drift silently.

`src/verify/contract.ts` is the same arrangement for one fresh check, and it keeps two
groups apart.
Go owns the first - the format version this build accepts, and the source and authority
a genuine answer declares - and its own drift test holds them to the Go sources.
The second group is this page's own bounds, which are not a mirror of the endpoint's:
those are per deployment and configurable, so the page keeps its own smaller ones and
still handles a refusal from a deployment that set one lower.

`src/verify/gate.ts` is the only place a name is judged fit for a link out, and it takes
no parameter that could relax the rule.
Every current or future surface that offers a way to act on a name has to come through it,
so there is one answer to whether a name may be acted on rather than two that could drift.
`tests/browser/assets.spec.ts` inspects both built sites without launching a browser and
fails if a removed model runtime, model asset reference, endpoint, or credential returns.

`public/data/og-rank-v1.json`, `src/data/featured-safe-v1.json`, and `src/data/featured-ranking-provenance-v1.json` are generated reviewed offline data read by the pure modules under `src/ranking/`.
The runtime parsers accept only the pinned corpus, rubric, policy, provenance shape, tuple shape, facet mask, and zero flags, and they require the manifest identities to agree.
The selector then intersects the allowlist and the snapshot's exact `available` results.
`App` consumes that result only on the canonical default route.
A refused rank uses deterministic allowlist-only scoring, and a refused allowlist yields an omitted featured state.
Both the hero and raw list receive the same fresh-check binding and outbound gate.

## What this app must not do

- No lifecycle arithmetic.
  Reuse the boundaries the snapshot published; never derive a grace end from an
  expiry, and never let a countdown reaching zero change a status.
  Only a later scan can do that.
- No requests to The Graph or DynamoDB from the browser.
  A fresh check is a request to the read API, which owns the credential, the endpoint,
  and every bound on what one check may cost.
- No model runtime or model-asset download in the browser.
  The production-asset tests fail if the removed package, model identifiers, model hosts,
  or WebGPU probe return to either bundle.
- No sentence about a failure taken from a response.
  Every one of them is a fixed literal in `src/verify/failure.ts`, chosen by kind,
  because text from a response is text an unexpected answer could put on screen.
- No secrets in source, fixtures, tests, or built assets, and none in a comment either.
  Vite ships source maps, so every comment under `src/` is a file `dist/` serves.
  The `assets` project fails the build if one appears; reword the comment rather than
  narrowing its patterns.
- No deployment or infrastructure lives here.

## Version pins

Dependencies are pinned exactly and `package-lock.json` is committed, so a clean
clone and CI resolve the same tree.
Two pins sit below the current latest on purpose.

- **ESLint 9**, not 10, because `eslint-plugin-jsx-a11y` still peers only on ESLint 9.
  Those accessibility rules are a requirement here, so the linter waits for the
  plugin.
- **TypeScript 5.9**, not 7, because `typescript-eslint` 8 supports `>=4.8.4 <6.1.0`.
  Outside that range the type-aware rules are unsupported, and they are the ones
  worth having.

Revisit both when the upstream ranges move.
