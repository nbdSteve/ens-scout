# Offline OG ranking

This directory owns the editorial ranking and featured-placement safety review
for the fixed three-, four-, and five-letter corpus. Ranking is independent of
ENS lifecycle state. These files make no availability, registration, expiry,
premium, price, or legal claim.

The browser does not run a model. `cmd/og-ranking` is a manual artifact tool, and
its Bedrock adapter is outside every Lambda and frontend import path.

## Sources

- `og-v1.rubric.md` defines the anchored dimensions, deductions, formula, facets,
  and policy enums.
- `og-v1.prompt.md` is the fixed model instruction. Supplied labels are untrusted
  data and must be copied exactly.
- `og-v1.calibration.json` contains 20 strong, 20 ordinary, 20 awkward, and 20
  policy-ineligible corpus examples.
- `og-v1.decisions.json` is the explicit human review layer. Missing labels stay
  `review_required`.
- `generation/og-v1.pass-*.jsonl` contains only validated structured model
  records. Raw provider envelopes, request identifiers, credentials, and account
  information are never retained.
- `og-v1.generation.json` records the bounded generation inputs, model identity,
  order seeds, batch hashes, attempt counts, and token usage.

## Generated review and production artifacts

- `og-v1.review.jsonl` is the complete canonical audit source. Its first line
  documents the tuple fields; following lines are label-sorted records.
- `og-v1.manifest.json` records corpus, rubric, prompt, model, generator commit,
  generation settings, passes, and review scope.
- `og-v1.head.md` is the review-friendly ranked head and safety summary.
- `featured-safe-v1.json` is the canonical reviewed allowlist.
- `featured-safe-v1.fixture.json` contains the first twelve ranked allowlisted
  labels for future selector tests.
- `../../web/public/data/og-rank-v1.json` is the compact browser tuple artifact.
- `../../web/src/data/featured-safe-v1.json` is the exact allowlist copy consumed
  by the browser's strict parser and deterministic fallback. The pure runtime
  seam is not yet wired into `App`, so these artifacts still change no UI
  behavior.

The full review source uses compact tuples because repeating field names across
19,051 records would dominate the pull-request diff without adding audit value.
The header, this document, and `og-v1.head.md` keep the representation readable;
the generator validates every position and deterministically rebuilds all
derived files.

## Workflow

Generation must start from a clean commit containing the generator:

```bash
go run ./cmd/og-ranking generate -generator-commit "$(git rev-parse HEAD)"
```

The command deterministically scores the full corpus locally, selects 128
candidates from each label length, and submits only those 384 labels. It performs
three independently ordered, temperature-zero passes in batches of 128. The run
is bounded by attempts, time, response bytes, and total input/output tokens. A
batch with any missing, invented, duplicated, changed, out-of-range, or unknown
value fails closed.

Generate the ignored review queue, then add explicit decisions for the
configured ranked head, every deterministic policy finding, every model policy
signal, and every label proposed for the allowlist:

```bash
go run ./cmd/og-ranking review-queue -head 128
```

The queue is written under `data/ranking/work/`; it contains no provider
envelope or lifecycle data. After reviewing it and updating
`og-v1.decisions.json`, build the committed head summary and artifacts:

```bash
go run ./cmd/og-ranking build
go run ./cmd/og-ranking check
go test ./internal/ogranking ./cmd/og-ranking
```

`check` never calls a model. Corpus changes invalidate the recorded count/hash
and candidate set, forcing a deliberate generation and review update.
