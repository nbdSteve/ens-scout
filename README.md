# ENS Scrape

ENS Scrape checks lists of candidate `.eth` labels and reports names that are
available, temporarily premium-priced, or approaching an expiry boundary.

It queries the maintained ENS subgraph in batches and runs a bounded number of
requests concurrently. With the bundled 4- and 5-letter lists, the default
configuration checks 17,758 names using 178 GraphQL requests instead of making
one or two requests for every name.

## Requirements

- Go 1.18 or newer

The current ENS mainnet subgraph is documented in the
[ENS subgraph guide](https://docs.ens.domains/web/subgraph/).

## Run

PowerShell:

```powershell
go run ./cmd/ens-scrape
```

Bash:

```bash
go run ./cmd/ens-scrape
```

No API key is required. By default the command uses ENS's shared public
endpoint, which is globally rate-limited and intended for testing or
occasional use. For larger or repeated scans, a free personal
[The Graph API key](https://thegraph.com/studio/apikeys/) avoids competing for
that shared allowance:

```powershell
$env:THEGRAPH_API_KEY = "your-api-key"
go run ./cmd/ens-scrape
```

By default the command reads `data/words/4-letters.txt` and
`data/words/5-letters.txt`. Supply other files as positional arguments, with
one label or second-level `.eth` name per line:

```powershell
go run ./cmd/ens-scrape data/words/3-letters.txt
Get-Content my-names.txt | go run ./cmd/ens-scrape -
```

The endpoint can also be supplied through `ENS_SUBGRAPH_URL` or `-endpoint`.
An explicit endpoint takes precedence over the environment variables, followed
by `ENS_SUBGRAPH_URL`, `THEGRAPH_API_KEY`, and finally the shared public
endpoint.

## Useful options

```text
-workers 8          maximum concurrent requests
-batch-size 100     names in each GraphQL query (maximum 1000)
-retries 3          retries for rate limits, server errors, and network errors
-timeout 30s        timeout for each request
-soon-days 7        threshold for expiry warnings
-format text        text, jsonl, or csv
-output PATH        write results to a file instead of stdout
-show STATUSES      statuses to output, or all
```

The default selection is:

```text
available,premium,expiring-soon,grace-ending-soon
```

For a full lifecycle snapshot:

```powershell
go run ./cmd/ens-scrape -show all -format csv -output scan.csv
```

Progress and status totals are written to stderr, so stdout remains safe to
redirect or process as JSON Lines/CSV.

## ENS lifecycle

The scanner classifies indexed `.eth` registrations as:

- `registered`
- `expiring-soon`
- `grace-period`
- `grace-ending-soon`
- `premium`
- `available`
- `unknown`

ENSv1 names remain in grace for 90 days after expiry. They are then available
for registration with a declining temporary premium for 21 days, after which
standard pricing applies. Lifecycle status is derived from the subgraph's
indexed expiry timestamp and the current time; confirm a name and its price in
the ENS app before attempting to register it.

## Project layout

```text
cmd/ens-scrape/       CLI entry point
internal/ens/         typed GraphQL client and lifecycle classification
internal/checker/     batching and bounded worker pool
internal/names/       input loading, normalization, and deduplication
internal/report/      text, JSON Lines, and CSV output
internal/snapshot/    deterministic snapshot contract, storage fakes, fixtures
data/words/           current candidate lists
data/fixtures/        committed fixture snapshots for local development
data/results/         historical scan output from the original utility
data/archive/         superseded candidate lists
```

## Snapshot contract

`internal/snapshot` defines the deterministic, storage-neutral snapshot the
planned website publishes and reads. The same logical scan always serializes to
the same bytes and the same checksum, whatever order the input arrives in and
whatever order the workers finish in. Snapshots are compressed, checksummed, and
split into immutable chunks, and a reader rejects a snapshot whose chunks are
missing, duplicated, reordered, or corrupt.

The package depends only on the standard library and on no AWS package.
`MemoryStore` and `FileStore` implement the same interfaces a cloud backend will,
so the publisher and reader can be developed and tested locally.

The committed fixtures in `data/fixtures/` cover every lifecycle status and let
frontend work proceed without credentials and without querying The Graph.
Regenerate them after an intentional contract change:

```powershell
go test ./internal/snapshot -update
```

## Development

```powershell
go test ./...
go vet ./...
gofmt -w cmd internal
```

The serverless website architecture and delivery phases are documented in
[docs/website-plan.md](docs/website-plan.md).
