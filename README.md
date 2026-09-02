# ENS Scrape

ENS Scrape checks lists of candidate `.eth` labels and reports names that are
available, temporarily premium-priced, or approaching an expiry boundary.

It queries the maintained ENS subgraph in batches and runs a bounded number of
requests concurrently. With the bundled 4- and 5-letter lists, the default
configuration checks 17,758 names using 178 GraphQL requests instead of making
one or two requests for every name.

## Requirements

- Go 1.18 or newer

The CLI and the snapshot contract use only the standard library. The scheduled
publisher adds the AWS Lambda library and the AWS SDK for Go v2, pinned to the
newest versions that still build under Go 1.18.

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
cmd/scan-lambda/      scheduled publisher entry point
internal/ens/         typed GraphQL client and lifecycle classification
internal/checker/     batching and bounded worker pool
internal/names/       input loading, normalization, and deduplication
internal/report/      text, JSON Lines, and CSV output
internal/snapshot/    deterministic snapshot contract, storage fakes, fixtures
internal/scanner/     one scheduled scan, from event to published pointer
internal/dynamo/      DynamoDB snapshot storage
internal/api/         cached HTTP read API for the published snapshot
infra/                TypeScript AWS CDK definition of the publisher stack
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
`MemoryStore` and `FileStore` implement the same interfaces `internal/dynamo`
does, so the publisher and reader can be developed and tested locally.

The committed fixtures in `data/fixtures/` cover every lifecycle status and let
frontend work proceed without credentials and without querying The Graph.
Regenerate them after an intentional contract change:

```powershell
go test ./internal/snapshot -update
```

## Scheduled publisher

`cmd/scan-lambda` is the AWS Lambda that publishes snapshots on a schedule. One
invocation scans one group of lists, carries the other group forward from the
snapshot already published, and writes a new latest pointer only after every
chunk of the new snapshot is stored, read back, and checksum-verified. A failure
at any stage leaves the previous snapshot serving.

The group being carried forward is read after the fresh scan finishes, so a
snapshot the other schedule published during those minutes is carried rather than
overwritten.

A publication that stores every chunk and then fails to move the pointer leaves a
chunk set nothing references. Each run records the snapshot it is about to write
before it writes a chunk, so a later run finds that set and gives it a TTL. The
record is durable before anything can go wrong, which is what makes this work for
a run that was killed rather than one that failed politely.

Two schedules drive it, each sending only a group name:

```json
{ "group": "three-four-letter" }
{ "group": "five-letter" }
```

The three- and four-letter lists are scanned every three hours and the
five-letter list daily, so the shorter and more valuable labels are fresher
without rescanning everything eight times a day.

Configuration is environment only:

```text
ENS_SNAPSHOT_TABLE                 DynamoDB table name (required)
THEGRAPH_API_KEY                   with ENS_SUBGRAPH_ID, selects the Graph gateway
ENS_SUBGRAPH_URL                   explicit endpoint, takes precedence
ENS_WORD_LIST_DIR                  word lists in the deployment bundle
ENS_SCAN_WORKERS                   concurrent requests
ENS_SCAN_BATCH_SIZE                names per GraphQL query
ENS_SCAN_HTTP_RETRIES              retries per request
ENS_SCAN_REQUEST_TIMEOUT_SECONDS   timeout per request
ENS_SCAN_BUDGET_SECONDS            limit on the Graph phase
ENS_SCAN_SOON_DAYS                 threshold for expiry warnings
ENS_SCAN_PREVIOUS_READ_ATTEMPTS    reads of the snapshot being merged forward
```

Unlike the CLI there is no fallback to the shared public endpoint: a scheduled
scan of this size must fail at startup on a missing credential rather than fail
slowly against a rate-limited endpoint.

Logs are JSON lines on stdout. They carry counts, identifiers, and durations, and
never a candidate name, an endpoint, or a credential. Error text from any layer is
redacted first, including the configured API key as a literal, because an upstream
response body can quote a credential with no URL around it.

Build it for the Lambda runtime:

```powershell
$env:GOOS = "linux"; $env:GOARCH = "arm64"; $env:CGO_ENABLED = "0"
go build -o bootstrap ./cmd/scan-lambda
```

## Infrastructure

`infra/` is a TypeScript AWS CDK application that defines the stack this Lambda
runs in: the snapshot table, the function, the two schedules, the failure queue, the
log group, the alarms, and a hand-written least-privilege role. Every CDK command
cross-compiles the scanner first, so a synth needs the Go toolchain and no AWS
credentials.

```powershell
cd infra
npm ci
npm run check
```

The Graph API key is never in the repository or the synthesized template. The stack
references an existing Secrets Manager secret, and CloudFormation resolves it at
deploy time. See [infra/README.md](infra/README.md) for the context keys, the
schedule offset, and the trade-offs behind each choice.

## Read API

`internal/api` serves the published snapshot over HTTP. It is the read half of
the website: a browser fetches one snapshot, keeps it locally, and does every
filter, sort, and countdown itself, so ordinary browsing never reaches DynamoDB
or The Graph.

```text
GET /api/snapshot        the published snapshot, byte for byte
GET /api/snapshot/meta   scan time, counts, sources, and staleness thresholds
GET /health              whether a complete snapshot is being served
```

Only a complete, checksum-verified snapshot is served. Nothing is repaired and
nothing partial is returned, so a store with nothing published, a snapshot whose
chunks have gone, and a payload that failed verification are three distinct
responses rather than one.

The `/api/snapshot` body is the canonical JSON that was published, unchanged, so
its SHA-256 is the checksum the latest pointer carries. The snapshot ID is the
`ETag` and the scan time is `Last-Modified`, so a client that already holds the
snapshot revalidates with `If-None-Match` and gets `304 Not Modified` instead of
a retransmission.

Staleness is published as thresholds rather than as a flag, per contributing
word list as well as for the snapshot, so a client resolves it against its own
clock. `/health` is the one endpoint that resolves an age itself, and it is the
one endpoint that is never cacheable.

Configuration is environment only:

```text
ENS_API_ALLOWED_ORIGINS       comma-separated exact browser origins
ENS_API_MAX_BODY_BYTES        bound on the snapshot body
ENS_API_CACHE_SECONDS         max-age on a cacheable response
ENS_API_RETRY_AFTER_SECONDS   Retry-After when nothing valid is published
```

Neither this API nor the subgraph is the registration authority, so every
response carries the scan time and an advisory to confirm availability and price
with ENS before registering.

The full contract is in [docs/read-api.md](docs/read-api.md).

## Development

```powershell
go test ./...
go vet ./...
gofmt -w cmd internal
$env:GOOS = "linux"; $env:GOARCH = "arm64"; go build -o /dev/null ./cmd/scan-lambda
```

The last line only confirms the Lambda still cross-compiles for its runtime, so
its output is discarded. A plain `go build ./cmd/scan-lambda` would instead leave
an 18 MB binary in the working tree, which is a build artifact and never belongs
in a commit. The deployment build above is the one that writes a binary, and it
names it `bootstrap` because that is what the runtime executes.

No test contacts The Graph or AWS. The DynamoDB API and the storage interfaces
are injected, so every path is exercised against local fakes.

The serverless website architecture and delivery phases are documented in
[docs/website-plan.md](docs/website-plan.md).
