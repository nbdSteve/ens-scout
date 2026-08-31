# AGENTS.md

## Project purpose

This repository contains `ens-scrape`, a Go CLI that checks candidate
second-level `.eth` labels against the ENS subgraph. It is designed for large
word lists, so network efficiency, bounded concurrency, predictable output,
and correct ENS lifecycle classification are core requirements.

## Repository layout

- `cmd/ens-scrape/`: CLI parsing, environment configuration, and process I/O.
- `internal/ens/`: typed GraphQL client and ENS registration lifecycle logic.
- `internal/checker/`: batching and bounded concurrent execution.
- `internal/names/`: input loading, normalization, and deduplication.
- `internal/report/`: filtering and text, JSON Lines, and CSV output.
- `data/words/`: active input word lists.
- `data/results/`: historical output from the original utility; treat as
  reference data, not golden test fixtures.
- `data/archive/`: superseded input lists retained for provenance.

## Development workflow

Run these checks after changing Go code:

```powershell
gofmt -w cmd internal
go test ./...
go vet ./...
```

The project intentionally uses only the Go standard library. Discuss a new
dependency before adding it, and commit `go.sum` if a dependency is accepted.

Do not exercise the real ENS endpoint in automated tests. Use `httptest.Server`
and fixed timestamps so tests remain fast and deterministic.

## Behavioral invariants

- Send labels to GraphQL as variables. Never interpolate candidate names into
  a query string.
- Batch names with the subgraph's `name_in` filter. Do not regress to one HTTP
  request per name.
- Keep concurrency bounded by the `-workers` setting.
- Preserve input deduplication and stable, name-sorted output even though
  network requests complete out of order.
- Keep stdout limited to result records. Diagnostics, progress, and summaries
  belong on stderr so JSON Lines and CSV remain pipe-safe.
- Apply request timeouts, close response bodies promptly, bound response sizes,
  and retry only transient network failures, HTTP 429, and HTTP 5xx responses.
- Never log or embed `THEGRAPH_API_KEY` in source, test fixtures, output, or
  error messages.
- Keep the Graph endpoint configurable through `-endpoint` and
  `ENS_SUBGRAPH_URL`. The rate-limited public ENS endpoint is the fallback;
  `THEGRAPH_API_KEY` selects the authenticated Graph gateway when configured.

## ENS lifecycle rules

This tool currently targets ENSv1 `.eth` registrations:

- Active until the indexed expiry timestamp.
- In grace period for exactly 90 days after expiry.
- Available with a declining temporary premium for the next 21 days.
- Available at standard pricing after the premium period.

Use elapsed durations (`90 * 24h` and `21 * 24h`), not calendar-month
arithmetic. Treat a registered name with an absent or malformed expiry as
unknown rather than available. Keep boundary behavior covered by table-driven
tests if these rules change.

The subgraph is an index, not the registration authority. User-facing docs and
output must tell users to confirm availability and price with ENS before
registering.

## Data and compatibility

- Input files contain one label or second-level `.eth` name per line.
- Blank lines, full-line `#` comments, and duplicates are ignored.
- Do not rewrite, delete, or regenerate files under `data/results/` or
  `data/archive/` unless a task explicitly requests it.
- Avoid committing local scan output, API keys, IDE state, or build artifacts.
- Maintain Go 1.18 compatibility unless the module version is deliberately
  raised and documented.

## Git expectations

Keep commits focused and include tests with behavioral changes. Before handing
off a change, inspect `git diff`, run the full verification commands, and note
any check that could not be run. Do not create commits, tags, or remotes unless
the user explicitly requests them.
