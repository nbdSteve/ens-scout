# ENS Scout Website Plan

## Goal

Turn the existing `ens-scrape` engine into a public website where visitors can
browse candidate `.eth` names by lifecycle status, see when names may become
registerable, and perform a fresh verification before opening the ENS app.

The website is a discovery tool. The ENS subgraph is an index rather than the
registration authority, so every actionable result must display its scan time
and provide a link for final confirmation in the ENS app.

## Proposed architecture

```text
EventBridge Scheduler
        |
        v
Scanner Lambda -----> ENS subgraph
        |
        v
Versioned snapshot in DynamoDB
        |
        v
Read Lambda / HTTPS endpoint
        |
        v
Static frontend cached by CloudFront
```

An optional lookup endpoint will recheck a small set of names on demand. The
scheduled scanner and lookup endpoint reuse the existing `internal/ens`,
`internal/checker`, and `internal/names` packages.

## Repository layout

```text
cmd/ens-scrape/       existing CLI
cmd/scan-lambda/      scheduled snapshot publisher
cmd/api-lambda/       snapshot reads and live verification
internal/snapshot/    snapshot model, chunking, and publication
web/                  static frontend application
infra/template.yaml   AWS SAM infrastructure
```

The Lambda binaries will target Linux on the AWS `provided.al2023` runtime.
Adding them will deliberately introduce the official AWS Lambda Go library and
AWS SDK for Go v2; dependency versions and `go.sum` must be committed.

## Snapshot design

Store immutable, compressed snapshot chunks instead of one item per result.
Keep each item comfortably below DynamoDB's 400 KB item limit.

```text
PK                       SK          Attributes
SNAPSHOT#<snapshot-id>   CHUNK#000   data, checksum, expireAt
SNAPSHOT#<snapshot-id>   CHUNK#001   data, checksum, expireAt
META                     LATEST      snapshotId, scannedAt, counts, checksum
```

Publication is atomic from a reader's perspective:

1. Generate a unique snapshot ID and scan all configured lists.
2. Serialize, compress, and checksum the complete result set.
3. Write chunks under the new snapshot ID, retrying unprocessed batch writes.
4. Read the chunks back and validate their count and checksum.
5. Update `META/LATEST` only after validation succeeds.
6. Assign old snapshot chunks a TTL so DynamoDB removes them later.

If scanning or publication fails, `META/LATEST` remains unchanged and the
website continues serving the previous valid snapshot.

## Read API

Initial endpoints:

```text
GET  /api/snapshot          latest published snapshot
GET  /api/snapshot/meta     scan time, counts, and snapshot ID
POST /api/check             fresh check for a bounded list of labels
GET  /health                deployment and snapshot health
```

`GET /api/snapshot` returns the snapshot ID as an `ETag` and honors
`If-None-Match` with `304 Not Modified`. Responses include a useful
`Cache-Control` policy and CORS is restricted to the deployed frontend origin.
The browser stores the last snapshot locally and only downloads a replacement
when the ID changes.

The live-check endpoint must normalize and deduplicate labels, limit request
size, use bounded concurrency, and apply rate limiting. It must never expose
the Graph API key or upstream endpoint.

## Frontend scope

The first polished release should include:

- summary counts and a visible "last scanned" timestamp;
- search, status, length, and word-list filters;
- sorting by name, expiry, grace end, and premium end;
- distinct views for available, premium, expiring, and grace-period names;
- live countdowns calculated from snapshot timestamps;
- memorable-word and acronym collections;
- responsive, accessible layouts with shareable filter URLs;
- a fresh-check action and a final link to the ENS app;
- explicit wording that grace-period names may be renewed and premium names
  may be registered by someone else at any time.

Filtering and pagination happen in the browser after the snapshot is loaded,
so ordinary browsing does not invoke Lambda or query The Graph.

## Scheduling and query budget

The current three- and four-letter word lists contain 6,573 unique candidates
and require 66 GraphQL requests with a batch size of 100. An hourly schedule is
approximately 47,520 requests per 30-day month before live checks.

The five-letter list should initially run daily or on a separate, less-frequent
schedule. Exhaustively scanning all letter combinations is outside the first
release:

- 26^3 = 17,576 three-letter combinations, or 176 batched requests;
- 26^4 = 456,976 four-letter combinations, or 4,570 batched requests.

Revisit exhaustive scanning only after measuring query usage, Lambda duration,
DynamoDB costs, and actual visitor demand.

## Security and operations

- Regenerate the Graph API key before deployment because the development key
  was shared outside a secret manager.
- Store the replacement in AWS Secrets Manager or an encrypted Lambda setting;
  never include it in frontend code, source, logs, or error responses.
- Give each Lambda a least-privilege IAM role.
- Set reserved concurrency and request limits on the public API.
- Emit structured CloudWatch logs without candidate payloads or credentials.
- Alarm when a scheduled scan fails or the latest snapshot becomes stale.
- Use DynamoDB on-demand capacity for the initial workload and enable TTL for
  old snapshot chunks.
- Keep the previous valid snapshot available during upstream outages.

## Delivery phases

### Phase 1: snapshot publisher

- Add shared snapshot types and deterministic serialization tests.
- Add the scheduled Lambda and DynamoDB publisher.
- Add AWS SAM infrastructure for DynamoDB, IAM, Lambda, Scheduler, and secrets.
- Verify atomic publication and failure recovery with local fakes.

### Phase 2: read API and frontend

- Add snapshot metadata and body endpoints with ETag support.
- Build the responsive browse, filter, sort, and countdown experience.
- Deploy static assets behind CloudFront and restrict CORS to that origin.

### Phase 3: live verification and operations

- Add bounded on-demand name checks with throttling and caching.
- Add stale-snapshot indicators, alarms, dashboards, and deployment checks.
- Load-test the public endpoint and document rollback procedures.

### Phase 4: expansion

- Add curated acronym and memorable-word lists.
- Decide whether to include five-letter names more frequently.
- Evaluate historical status tracking, notifications, and exhaustive scans.

## Definition of done for the first public release

- A failed scheduled scan cannot replace the last good snapshot.
- Snapshot contents are deterministic, checksummed, and timestamped.
- The frontend makes no direct request to The Graph or DynamoDB.
- The Graph API key is absent from frontend bundles, logs, and repository data.
- Available and lifecycle-boundary results match the CLI for a fixed timestamp.
- Every name can be freshly rechecked before linking to ENS.
- Automated tests use local fakes and never call the real ENS endpoint.
- Formatting, unit tests, vetting, Lambda builds, and frontend checks pass in CI.

## Decisions to make before implementation

- Confirm the public product and repository name; `ens-scout` is the current
  recommendation while the existing CLI remains `ens-scrape`.
- Choose the frontend stack and visual direction.
- Choose hourly versus daily refresh for each candidate list.
- Choose a deployment region and public domain.
- Decide whether snapshot history is retained beyond the TTL recovery window.
