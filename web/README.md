# ENS Scout website

A React and TypeScript single-page app that browses one published ENS snapshot by
lifecycle status.

It is a presentation and interaction layer, and nothing more.
Every status, expiry, grace end, and premium end on the page was computed by the Go
scanner and read out of a snapshot.
The browser never queries The Graph, never re-checks a name, and never decides
whether a name is available.
The ENS app is the only authority on that, and the page says so and links to it.

## Run it from a clean clone

No credentials, no API, and no network access to ENS are needed.

```bash
npm ci
npm run dev
```

That serves the committed `preview` fixture from `data/fixtures/`, which carries one
name in every lifecycle status across three source lists.

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

## Development

```bash
npm run dev             # dev server, fixture mode
npm run test            # unit and component tests (vitest, jsdom)
npm run test:browser    # browser tests against a production build
npm run browser:install # one-off: download the Chromium the browser tests need
npm run verify          # the whole gate, in order
```

`npm run verify` runs format check, lint, typecheck, unit tests, the production
build, and the browser tests.
That is the gate a change has to pass.

The browser suite runs against a real production build served by `vite preview`, not
against the dev server, so what it asserts is what a visitor gets: the same minified
bundle, the same asset graph, and the same absence of any endpoint or credential.
It runs five projects.

| Project            | Why it exists                                                   |
| ------------------ | --------------------------------------------------------------- |
| `desktop` (1440)   | The layout most visitors see                                    |
| `tablet` (834)     | The width the filter and count grids reflow at                  |
| `mobile` (Pixel 7) | A real phone context, including its viewport-meta behaviour     |
| `narrow` (320)     | WCAG 1.4.10 Reflow, in a desktop context on purpose - see below |
| `assets`           | Reads `dist/` with no browser: secret scan and origin allowlist |

`narrow` is deliberately a desktop window rather than a phone descriptor.
A phone context honours the viewport meta tag, so Chrome answers content that is too
wide by zooming the page out instead of scrolling it, and a reflow check then passes
on a layout that really does overflow.
That is exactly how a 320px overflow went unnoticed here once.

## Structure

```text
src/snapshot/     the browser's half of the snapshot contract, and its parser
src/data/         fixture loading, the read API client, and the local cache
src/state/        URL state, filtering, sorting, paging, and the clock
src/format/       time and text formatting
src/components/   presentation
tests/browser/    Playwright specs
```

`src/snapshot/contract.ts` restates the few constants a reader cannot derive from the
payload it is handed: the format version it accepts, the cadence intervals, and the
staleness factor.
Go owns all of them.
`contract.drift.test.ts` parses the Go sources and fails when any value stops
matching, so the duplication cannot drift silently.

## What this app must not do

- No lifecycle arithmetic.
  Reuse the boundaries the snapshot published; never derive a grace end from an
  expiry, and never let a countdown reaching zero change a status.
  Only a later scan can do that.
- No fresh checks, and no requests to The Graph or DynamoDB from the browser.
- No secrets in source, fixtures, tests, or built assets.
  The `assets` project fails the build if one appears.
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
