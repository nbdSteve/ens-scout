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

A snapshot is minutes to hours old by the time anyone reads it, so a row offers no link
to register a name until a fresh check has covered that exact name and has not expired.
Nothing else opens that gate - not an `available` status, not a recent scan, and not a
countdown that has run down.

Select up to the number of names one check covers, ask for the check, and the endpoint
reads the ENS index once for the whole selection.
The answer says which names it covers and the instant it was obtained, and the page
shows that instant beside the result rather than folding it into the snapshot's own.
The two stay visibly separate because they are two claims about two different moments.

A check that fails changes no status.
The row keeps saying what the snapshot said, the page says the check did not happen and
why in its own words, and the selection is left alone so nothing has to be retyped.
Every link out still says ENS decides: a name the index does not hold may still fail to
register.

`?now=` moves the expiry of a fresh answer too, so an expired check can be demonstrated
the same way a stale snapshot can.

## Name suggestions

The page can put forward a handful of names from the list you are already looking at,
for a built-in vibe or a short theme you type.
Every suggestion is a name the published snapshot holds, narrowed by whatever filters
are set: nothing here invents a name, and nothing here decides that a name can be
registered.
A suggestion earns a link out through exactly the same gate a table row does, so it is
still one fresh check away from being actionable.

There are two recommenders behind one control.

The deterministic one ranks the shortlist by how closely each label matches what was
asked for, and writes a fixed sentence per name saying which part of the score applied.
It needs no model, it is the same order on every device, and it is what answers on a
device without WebGPU, on a device that refused the download, and whenever the optional
model does not produce something usable.
It is a real answer rather than a placeholder.

The optional one is a small language model that runs inside the browser.
It is shown the same shortlist and asked only to reorder it.
It is never asked whether a name is available, when it expires, or whether it can be
registered - those are the snapshot's to state and a fresh check's to confirm.
Every explanation remains a fixed sentence derived from the deterministic scoring
evidence, and the page says plainly when the model supplied the order.

An answer from the model is refused whole - not repaired, and not partly used - when it
is not JSON, carries a field the page did not ask for, repeats a name, contains forbidden
control text, or names anything that was not in the shortlist it was given.
A pick may contain only its exact name, so generated lifecycle claims, prices, sale
claims, and references to any other `.eth` name are refused structurally rather than
redacted or repaired.
A refusal costs the model's ordering and nothing else: the deterministic ranking stays
on screen and a sentence says the answer was not used.

Nothing about a suggestion leaves the device.
The prompt, the shortlist, the theme, and the generated text stay in the browser.
There is no hosted inference, no model service, and no telemetry.
The only thing fetched is the model's own weights, from the pinned configuration in
`src/suggest/engine/webllm.ts` and from nowhere else.

### The pinned model

|                         |                                                                     |
| ----------------------- | ------------------------------------------------------------------- |
| Model                   | `SmolLM2-360M-Instruct-q4f16_1-MLC`                                 |
| First download          | 211,553,449 bytes (212 MB decimal, quoted to a visitor as `212 MB`) |
| Graphics memory         | 376 MB, as the library declares it                                  |
| Required WebGPU feature | `shader-f16`                                                        |
| Library                 | `@mlc-ai/web-llm` 0.2.84, pinned exactly                            |
| Cache                   | the Cache API, so a second visit transfers nothing                  |

It is the smallest instruction-tuned download in the library's own catalogue.
The 135M model in that catalogue ships unquantized and is therefore larger on the wire
than this one despite having fewer parameters, so "smallest that does the job" and
"fewest parameters" point at different models here and the download is what was
optimised.
The task is bounded to ranking exact names from a supplied list of at most 24 under a JSON grammar whose name field is an enum over that exact list.
The model returns no explanation field.
Repository-owned code renders one bounded explanation from the shortlist evidence already computed for each candidate.
The model is not being asked to be knowledgeable, and a larger one would cost a visitor more bandwidth for a job this one can do.
There is deliberately no fallback to a larger model: when this one does not work, the deterministic recommender answers.

The download figure is the whole first transfer and not the weights alone, because it is
quoted to a visitor before anything is fetched.
It is the seven weight shards (203,614,080 bytes), the compiled shader library
(5,708,562), `tokenizer.json` (2,104,556), `ndarray-cache.json` (124,230), and
`mlc-chat-config.json` (2,021).
It is deliberately not the repository's total size: the library fetches `tokenizer.json`
and stops, so `vocab.json`, `merges.txt`, and `tokenizer_config.json` are published
beside the weights and never transferred, and counting them would overstate what a
visitor is asked to agree to by about 1.2 MB.

To reproduce the figure, read `ndarray-cache.json` from the model repository named by
`PINNED_MODEL.model`, sum the `content-length` of every `dataPath` in it, and add the
four files above.
The `model_lib` URL carries the library's own version segment, so it moves with the npm
pin rather than independently.

What is not measured here is a latency or quality number, and the reason is that neither
would mean anything as a committed figure: load time is a visitor's connection and the
browser cache, and output quality under a grammar this tight is either an answer the
parser accepts or one it refuses.
The bounds are what the code enforces instead - one initialization attempt, a 10 minute
load ceiling, a 60 second generation ceiling, 384 generated tokens, and a "this is taking
a while" notice at 45 seconds - and every one of them ends with the deterministic
recommender answering rather than with a retry.

`src/suggest/contract.drift.test.ts` compares the pinned record against the installed
library's own catalogue field by field, so an upgrade that moves the weights, bumps the
shader library, or raises the memory requirement fails the gate rather than a visitor's
device.
It reads the installed dependency and downloads nothing.

### What a visitor is asked, and when

Nothing model-related begins until the page is interactive - the snapshot parsed, the
rows rendered, the filters and the fresh-check action working - and then it still waits
`START_GRACE_MS` before fetching anything.
That window is not a performance tweak: it is when the download size is on screen with
the pause and disable controls reachable and nothing yet in flight, so a download this
large can be refused before it starts rather than discovered afterwards.

Pausing and turning it off are two different promises and are labelled as two.
Pausing stops what is happening now and is forgotten on the next load; turning it off is
remembered on this device under a versioned local key.
Cancelling releases what the library permits - the engine is unloaded and holds no
graphics memory - but the library exposes no way to stop fetches it has already started,
so an in-flight transfer may finish and be discarded.
That is the honest bound on what cancellation can do here.

Unsupported, disabled, offline, cancelled, slow, memory-constrained, and refused are
seven separate sentences, because they are seven different things and one hedged sentence
would be wrong for six of them.
None of them is an application error, and in every one of them asking for names still
produces names.

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

It runs six projects.

| Project            | Why it exists                                                        |
| ------------------ | -------------------------------------------------------------------- |
| `desktop` (1440)   | The layout most visitors see                                         |
| `tablet` (834)     | The width the filter and count grids reflow at                       |
| `mobile` (Pixel 7) | A real phone context, including its viewport-meta behaviour          |
| `narrow` (320)     | WCAG 1.4.10 Reflow, in a desktop context on purpose - see below      |
| `verify`           | `dist-verify` against a stub read API: the whole fresh-check surface |
| `assets`           | Reads both builds with no browser: secret scan and origin allowlist  |

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
src/data/          fixture loading, the read API client, and the local cache
src/state/         URL state, filtering, sorting, paging, the clock, one check, one model
src/suggest/       the shortlist, the two recommenders, the bounds, and the model seam
src/format/        time and text formatting
src/components/    presentation
src/optics/        the ambient optical background, mounted behind the page
src/constellation/ the deterministic name composition
src/test/          test-only helpers, including the reader for the Go sources
tests/browser/     Playwright specs
```

`src/constellation/` composes the name arrangement that replaces the results table in a
later visual slice, so it is unit-tested and nothing renders it yet.

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
Anything that suggests a name and then offers a way to act on it has to come through it,
which now includes the local recommender: `SuggestionItem` derives its row through the
same `rowVerification` the table uses, so there is one answer to whether a name may be
acted on rather than two that could drift.

`src/suggest/engine/` is the model boundary, four functions wide.
`load.ts` holds the only dynamic import of `@mlc-ai/web-llm` in the repository, which is what makes the library a separate chunk the first screen never requests, and `webllm.ts` is the only file that imports it.
`src/suggest/contract.drift.test.ts` is the deliberate unit-test exception: it imports the installed WebLLM package and the real adapter module to compare the pinned record with the installed catalogue.
It creates no engine and downloads nothing.
The state-machine unit tests inject an `EngineModule`, and component tests render a `SuggestStore`, so neither crosses the dynamic import.
`tests/browser/suggest.spec.ts` and `tests/browser/suggestVerify.spec.ts` replace the same-origin model chunk with the module in `tests/browser/suggestModel.ts`.
They intercept the chunk in a real production build rather than using a test-only seam in `src/`, because such a hook would be a name in the shipped bundle.
The remaining app-rendering browser suites use the unmodified production bundle and may fetch and evaluate the installed WebLLM chunk after the grace period when `navigator.gpu` is present.
`tests/browser/support.ts` installs model-host abort routes on every browser context, so evaluating the real chunk cannot send a public model-asset request.
`tests/browser/assets.spec.ts` inspects the built files without launching a browser or evaluating the runtime.

## What this app must not do

- No lifecycle arithmetic.
  Reuse the boundaries the snapshot published; never derive a grace end from an
  expiry, and never let a countdown reaching zero change a status.
  Only a later scan can do that.
  The local model is held to the same rule and to a stricter one: it may reorder a
  supplied shortlist and nothing else, and it is never asked about a lifecycle.
- No requests to The Graph or DynamoDB from the browser.
  A fresh check is a request to the read API, which owns the credential, the endpoint,
  and every bound on what one check may cost.
- No hosted inference, no model service, and no telemetry carrying prompts, themes, or
  preferences.
  Model assets download only through the pinned configuration in
  `src/suggest/engine/webllm.ts`, which offers exactly one model, so nothing a visitor
  types or chooses can name a URL.
  No automated test may download a real model or contact a model host.
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

`@mlc-ai/web-llm` is pinned for a different reason: the version segment appears inside the
pinned model's `model_lib` URL, so an upgrade changes which compiled shader library a
visitor's device fetches.
That is a change to read rather than to take, and `src/suggest/contract.drift.test.ts`
fails the gate when a bump moves it.
