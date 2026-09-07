# ENS Scout Read API

`internal/api` serves the published snapshot over HTTP.
It is the read half of the website: a browser fetches one snapshot, keeps it locally, and does every filter, sort, and countdown itself, so ordinary browsing never reaches DynamoDB or The Graph.

This document is the contract the frontend, the local preview, and any monitor can rely on.
The package itself holds the reasons behind each rule; this file holds the wire surface.

## Scope

The read half does two things.
It resolves the snapshot the latest pointer names, and it answers conditionally so an unchanged snapshot is never retransmitted.

`POST /api/check` is the one path that leaves the process.
It reads the ENS subgraph index now for a few labels, so a visitor can act on something newer than the last scan, and it is therefore the only path with a spending limit.
A deployment that configures no upstream client does not serve it at all, and the path is then a `404` like any other path this API does not serve.

It adds no ENS logic.
Lifecycle classification, chunk assembly, checksums, and canonical serialization are all `internal/snapshot`, and a fresh check classifies through the same `ens.Classify` by way of `checker.Run`.
There is no second classifier anywhere.

It is not an availability authority.
The subgraph is an index rather than the registration authority, so every response this package composes carries an advisory, a snapshot response carries the scan time, and a check response carries the instant it read the index at.
A name the index does not hold may still fail to register.

It depends on no AWS package.
The store is `snapshot.Reader`, the read half of the storage contract, and the upstream is `checker.Client`, the same seam the scheduled publisher injects, so the whole surface is exercised against `snapshot.MemoryStore` and local fakes with no network and no credentials.

## Endpoints

```text
GET  /api/snapshot          the published snapshot, byte for byte
HEAD /api/snapshot          the same headers with no body
GET  /api/snapshot/meta     the snapshot summary without its results
HEAD /api/snapshot/meta     the same headers with no body
GET  /health                whether a complete snapshot is being served
HEAD /health                the same headers with no body
POST /api/check             one live read of the ENS index for a few labels
OPTIONS <any path>          CORS preflight, 204 No Content
```

Routing is exact.
An unknown path is `404` rather than a prefix match, so no future path can be reached by accident.
Any other method is `405` with an `Allow` header.

`/api/check` serves `POST` and `OPTIONS` only, and it exists only where a deployment configured an upstream client.
It is a `POST` deliberately rather than a `GET`: a `GET` is cacheable and shareable by URL, so a shared cache or a copied link would hand a later visitor a verification instant nothing verified for them.
Where the path is not served it is a `404` rather than a `405`, because a `405` would say the endpoint exists and was merely addressed with the wrong method.

### GET /api/snapshot

The body is the published canonical JSON, unchanged.
Nothing is added to it, so its SHA-256 is the checksum the latest pointer carries and a client can verify what it received.

Because the body cannot be wrapped in an envelope, the advisory travels in a header:

```text
X-Snapshot-Advisory: The ENS subgraph is an index and not the registration
                     authority. Confirm availability and price with ENS before
                     registering.
```

The snapshot format, including the result fields and the `scan_age` thresholds, is defined by `internal/snapshot` and is the same format `data/fixtures/` holds.

### GET /api/snapshot/meta

This is what a client polls to decide whether to download a replacement.

```json
{
  "format_version": 3,
  "snapshot_id": "...",
  "scanned_at": "2026-03-01T12:00:00Z",
  "checksum": "...",
  "raw_bytes": 12345,
  "names": 100,
  "counts": {
    "registered": 72,
    "expiring-soon": 6,
    "grace-period": 4,
    "grace-ending-soon": 2,
    "premium": 3,
    "available": 12,
    "unknown": 1
  },
  "sources": [
    {
      "id": "three-letters",
      "path": "data/words/3-letters.txt",
      "cadence": "three-hourly",
      "names": 20,
      "last_scanned_at": "2026-03-01T12:00:00Z",
      "scan_age": { "expected_interval_seconds": 10800, "stale_after_seconds": 21600 }
    },
    {
      "id": "four-letters",
      "path": "data/words/4-letters.txt",
      "cadence": "three-hourly",
      "names": 30,
      "last_scanned_at": "2026-03-01T12:00:00Z",
      "scan_age": { "expected_interval_seconds": 10800, "stale_after_seconds": 21600 }
    },
    {
      "id": "five-letters",
      "path": "data/words/5-letters.txt",
      "cadence": "daily",
      "names": 50,
      "last_scanned_at": "2026-02-28T16:00:00Z",
      "scan_age": { "expected_interval_seconds": 86400, "stale_after_seconds": 172800 }
    }
  ],
  "scan_age": { "expected_interval_seconds": 86400, "stale_after_seconds": 172800 },
  "advisory": "..."
}
```

`counts` holds every lifecycle status in `ens.Statuses`, including the ones with no results, so a client never has to distinguish an absent status from a zero.
The counts sum to `names`, and so do the per-source `names`, because every result is in exactly one status and comes from exactly one list.

`checksum` and `raw_bytes` describe the `/api/snapshot` body, so a client can verify a download against a summary it fetched separately and can decide whether to fetch it at all.
That affordance is unavailable in exactly one case: a snapshot larger than `ENS_API_MAX_BODY_BYTES` fails this endpoint too, with `snapshot_too_large`, because the declared size is checked before the payload is resolved and this document is built from the payload rather than from the pointer.

Every field is fixed by the snapshot ID.
That is what makes the entity tag a correct validator for this document as well as for the snapshot body.

Two things are therefore absent, and both are on `/health` instead.

There is no `published_at`.
A retried publication rewrites only that field, and the snapshot contract excludes it from pointer identity, so including it would let this document change while its validator did not.

There is no resolved age and no stale flag.
A resolved age is wrong the moment a cache keeps it, which is the same reason the snapshot contract publishes thresholds rather than a flag.

### GET /health

`200` means a complete checksum-verified snapshot really is available, not merely that the process is running.
It resolves exactly what `/api/snapshot` resolves, through the same call and the same in-process cache, so a healthy answer costs no chunk fetch once the snapshot is cached.

```json
{
  "status": "ok",
  "snapshot_id": "...",
  "scanned_at": "2026-03-01T12:00:00Z",
  "published_at": "2026-03-01T12:00:05Z",
  "checked_at": "2026-03-01T19:00:00Z",
  "scan_age": {
    "age_seconds": 25200,
    "expected_interval_seconds": 86400,
    "stale_after_seconds": 172800,
    "stale": false
  },
  "sources": [
    {
      "id": "three-letters",
      "cadence": "three-hourly",
      "names": 20,
      "last_scanned_at": "2026-03-01T12:00:00Z",
      "scan_age": {
        "age_seconds": 25200,
        "expected_interval_seconds": 10800,
        "stale_after_seconds": 21600,
        "stale": true
      }
    },
    {
      "id": "four-letters",
      "cadence": "three-hourly",
      "names": 30,
      "last_scanned_at": "2026-03-01T12:00:00Z",
      "scan_age": {
        "age_seconds": 25200,
        "expected_interval_seconds": 10800,
        "stale_after_seconds": 21600,
        "stale": true
      }
    },
    {
      "id": "five-letters",
      "cadence": "daily",
      "names": 50,
      "last_scanned_at": "2026-02-28T16:00:00Z",
      "scan_age": {
        "age_seconds": 97200,
        "expected_interval_seconds": 86400,
        "stale_after_seconds": 172800,
        "stale": false
      }
    }
  ],
  "names": 100,
  "advisory": "..."
}
```

This is the one place a resolved age and a stale flag appear, and it is the one response that is never cacheable.
`checked_at` is the instant the ages were resolved against, so a reader can tell an old answer from a fresh one.

A stale but complete snapshot is still `200`.
Staleness means the publisher is behind, which is a separate alarm from the read path being unable to serve, and the fields above say which lists are overdue.

Per-list staleness is why the sources are reported separately.
Each source age resolves against that source's own `last_scanned_at`, which is the last time that list was really queried against the subgraph, and not against the snapshot-wide `scanned_at`.
The example above is seven hours after the snapshot-wide scan: the snapshot is not stale, because the daily list governs the snapshot-wide window, while both three-hourly lists are already past their own.
The daily list in that example was carried forward from an earlier scan, so its own age is 27 hours rather than 7 hours, and it is still inside its own two-day window.

A source instant advances only when that source is scanned.
A publisher merging forward re-derives the other group's results at the fresh scan's instant, but it carries each unscanned list's own instant unchanged, so one stopped schedule trips its own stale flag on its own threshold while the other group keeps publishing.
The total-outage case behaves the same way: no instant advances, and each list trips its own threshold on its own schedule.

The snapshot-wide `scan_age` still resolves against `scanned_at` and the slowest cadence any source declares.
It answers how old the snapshot is, so a client that wants to know whether a particular list is overdue must read that list's own `scan_age`.

`status` has one value.
A run that cannot serve a snapshot answers with a failure code instead, so there is no degraded state to name here.

### POST /api/check

This is one live read of the ENS subgraph index, for a few labels, at one instant.
It exists because a snapshot is a record of a scan and a visitor about to register a name needs something newer than that.

The request body is a closed document.

```json
{ "names": ["zap.eth", "flux"] }
```

`names` is the only field, and an unknown field is `malformed_request` rather than something to ignore.
That is what keeps a client from selecting the endpoint, the query shape, the retry policy, or the authorization: none of them are named in the request at all, and the upstream client is injected at cold start rather than parsed from anything a request carries.
`Content-Type` must declare `application/json`; an absent or different type is `415` rather than a sniffed body.

An entry may be a bare label or a fully-qualified `.eth` name, and `names.Normalize` is the one definition of a valid label, exactly as it is for the CLI and the publisher.
A request naming anything that is not a second-level `.eth` label is refused whole, with `invalid_name`.
Dropping the bad entry and answering about the rest would make the answer cover a set the client never asked for and cannot see.
Duplicates are removed after the count bound is charged, so a thousand copies of one label is `too_many_names` rather than a request that expands past the limit and then shrinks back inside it.

The success body is a closed versioned document.

```json
{
  "format_version": 1,
  "source": "ens-subgraph-index",
  "authority": "ens-registry",
  "checked_at": "2026-03-01T19:00:00Z",
  "expires_at": "2026-03-01T19:01:00Z",
  "names": ["flux.eth", "zap.eth"],
  "results": [
    { "name": "flux.eth", "status": "available" },
    {
      "name": "zap.eth",
      "status": "registered",
      "expiry": "2027-01-01T00:00:00Z",
      "grace_ends": "2027-04-01T00:00:00Z",
      "premium_ends": "2027-04-22T00:00:00Z"
    }
  ],
  "advisory": "..."
}
```

Three different things are named separately, and a client that conflates them will tell somebody a name is theirs when it is not.
`source` says what produced these statuses, which is one live read of the index.
`authority` says what actually decides registration, which is neither this API nor the index.
A result the index does not hold is not a promise that registration will succeed, and the advisory says so in the body of every response including the failures.

`checked_at` is the instant every status here was classified against, sampled once before the first lookup and truncated to the second.
Truncation moves it earlier, so a client treats the answer as very slightly older than it is rather than newer.
`expires_at` is `checked_at` plus `ENS_API_CHECK_CACHE_SECONDS`, and it is when this stops counting as a fresh check.
A client must refuse its own expired copy rather than keep presenting it as verified.

`names` is the exact set of normalized, fully-qualified names the result covers, in the same order as `results`.
A client asked about labels it wrote itself, and this is what was really queried, so it is the only set the statuses say anything about.
The order is by fully-qualified name, which is what `checker.Run` sorts its results by, and the answer is refused outright when it does not cover exactly that set.
A truncated, padded, or substituted upstream answer is not evidence about any name in it.

`results` holds `ens.Result`, the same shape and the same statuses the snapshot carries, so a fresh status is directly comparable to the snapshot status beside it.
`ENS_API_CHECK_SOON_DAYS` matches the publisher's window for the same reason: a different one here would make the two disagree for a name near a boundary.

The response is `no-store` and carries no validator.
Its whole value is the instant in its body, and a cache would keep answering with an instant that has moved on.
The `Retry-After` on a refusal is the one header a client needs from this path, and CORS exposes it already.

Every allowance is charged before the work it bounds, cheapest refusal first.

```text
1  Content-Type                     415 unsupported_media_type
2  declared Content-Length          413 request_too_large
3  client identity                  503 client_unidentified
4  per-client allowance             429 client_throttled / 503 check_store_unavailable
5  body read and decode             413 request_too_large / 400 malformed_request
6  name count, then normalization   400 no_names_requested / too_many_names / invalid_name
7  result cache                     a hit answers here, with its original checked_at
8  upstream concurrency slot        503 upstream_busy
9  deployment-wide upstream budget  503 upstream_budget_exhausted / check_store_unavailable
10 the upstream calls               504 check_timed_out / 502 upstream_unavailable
```

A flooding client is refused before its body is read, and no request reaches the index before both its own identity's allowance and the deployment's shared allowance have paid for the call.
The budget is charged in upstream calls rather than in requests, so a request that will cost several batches pays for several.
The concurrency slot is taken before the budget is charged, so a refused slot cannot have spent budget it then has no way to use.

Steps 4, 7, and 9 are charged against a shared durable store rather than against process memory, so they are the deployment's answer and not one instance's.
Step 8 is the exception and really is per instance: a request in flight cannot be counted anywhere but in the process holding it.
A store that cannot be reached is `check_store_unavailable` and the request is refused, because an allowance nothing recorded is not an allowance.

The whole request, retries and backoff included, runs under `ENS_API_CHECK_TIMEOUT_SECONDS`.
A cancelled request context, this API's own expired deadline, and an upstream failure are three separate codes, and the classification asks in that order.
A client that went away is not evidence about the index, and an expired deadline is a timeout whoever owns it.

## Failures

Every failure body is the same shape.

```json
{
  "error": { "code": "no_snapshot_published", "message": "No snapshot has been published yet." },
  "advisory": "..."
}
```

The snapshot paths fail in these ways.

| Status | Code                     | Retry | Meaning                                                             |
| ------ | ------------------------ | ----- | ------------------------------------------------------------------- |
| 503    | `no_snapshot_published`  | yes   | The store holds no latest pointer. Nothing has been published yet.  |
| 503    | `snapshot_chunks_missing`| yes   | The pointer resolved and the chunks it names are gone.              |
| 503    | `snapshot_unreadable`    | yes   | The stored payload did not verify.                                  |
| 503    | `snapshot_too_large`     | no    | The published snapshot is larger than this endpoint serves.         |
| 503    | `snapshot_unavailable`   | yes   | The store could not be read.                                        |
| 405    | `method_not_allowed`     | no    | The endpoint accepts GET, HEAD, and OPTIONS.                        |
| 404    | `not_found`              | no    | No such endpoint, or a check endpoint this deployment does not have.|

`POST /api/check` fails in these ways, and carries `CheckAdvisory` rather than the snapshot advisory.

| Status | Code                       | Retry | Meaning                                                                |
| ------ | -------------------------- | ----- | ---------------------------------------------------------------------- |
| 415    | `unsupported_media_type`   | no    | The request did not declare a JSON body.                               |
| 413    | `request_too_large`        | no    | The body is over `ENS_API_CHECK_MAX_REQUEST_BYTES`.                    |
| 400    | `malformed_request`        | no    | Not the closed document: bad JSON, an unknown field, or trailing data. |
| 400    | `no_names_requested`       | no    | The request named nothing to check.                                    |
| 400    | `too_many_names`           | no    | More labels than `ENS_API_CHECK_MAX_NAMES`, counted before dedupe.     |
| 400    | `invalid_name`             | no    | At least one entry is not a second-level `.eth` label.                 |
| 503    | `client_unidentified`      | no    | The request carries no trusted identity to throttle against.           |
| 429    | `client_throttled`         | yes   | This client has spent its allowance across the whole deployment.       |
| 503    | `check_store_unavailable`  | yes   | The shared store holding the allowances could not be reached.          |
| 503    | `upstream_busy`            | yes   | This instance already has as many checks in the index as it allows.    |
| 503    | `upstream_budget_exhausted`| yes   | The deployment has spent its index allowance across every client.      |
| 504    | `check_timed_out`          | yes   | No answer arrived inside this endpoint's deadline.                     |
| 502    | `upstream_unavailable`     | yes   | No fresh answer was obtained. Nothing was verified.                    |
| 503    | `check_cancelled`          | no    | The request ended before the check finished.                           |
| 405    | `method_not_allowed`       | no    | This endpoint accepts POST and OPTIONS.                                |

`upstream_unavailable` is one code for every way the index can fail to answer: a transport error, a rate-limited or challenged response, a truncated or oversized body, a GraphQL error document, and an answer that did not cover the names asked about.
They are deliberately not separated, because the only honest thing to say about all of them is that no fresh answer was obtained, and separating them would mean describing what the upstream sent.

`client_unidentified` fails closed rather than pooling every unidentifiable caller into one shared allowance, which an attacker could then empty on everybody else's behalf.
It is not retryable, because waiting cannot add an address to a request.
`check_cancelled` is not retryable either: the client already decided, there is nobody left to advise, and the record that matters is the log line rather than the response.
Its `503` is only because there is no status for a client that hung up.

`check_store_unavailable` and `client_throttled` are kept apart because they need different operators.
A spent allowance is the endpoint working; an unreachable store is the table throttled, misconfigured, or unreachable, and nothing was bounded at all.
It fails closed, and nothing about the store reaches the client: not the table, not the key, not the wrapped message.
It is retryable because the usual cause is a throttled write that the next request may well get past.

The retryable check failures advertise their own wait rather than the scan cadence.
A spent allowance advertises the end of the window that refused it, a busy instance advertises one request deadline, an unreachable store advertises one request deadline, and a snapshot that is not published yet advertises `ENS_API_RETRY_AFTER_SECONDS`.
Telling a throttled client to wait a scan cadence would be a wait far longer than the one it is really serving.

Nothing partial or unverified is ever served.
`snapshot.Verify` is the only judge of a payload, and a chunk set that is missing, duplicated, reordered, corrupt, checksum-mismatched, non-canonical, relabelled from another snapshot, or in disagreement with the pointer that names it fails there rather than reaching a client.

`no_snapshot_published` and `snapshot_chunks_missing` are kept apart deliberately.
The first is a store with nothing in it, which is an ordinary bootstrap; the second is a published snapshot that vanished under the pointer, which is an operational alarm.

`snapshot_unavailable` says less on purpose.
A failed read is not evidence of an empty store and not evidence of corruption, so the code claims neither.
A cancelled or expired request context is reported the same way, because it says nothing about what is stored.

A pointer that cannot be read fails closed, even when a verified snapshot is already in the in-process cache.
The cached entry is not served, because a reader that cannot read the pointer cannot tell a live pointer from one that has since been superseded, and every endpoint answers `snapshot_unavailable` while the store is unreachable.
The entry itself is kept, so a transient throttle costs one refused request rather than a full chunk re-download once the pointer reads again and compares equal.
`/health` reports that outage rather than reporting `ok` from memory, so a monitor sees the read path's real dependency state instead of a healthy answer that outlives the store.
Serving a last-known-good snapshot past a failed pointer read is a separate resilience feature, not this one: it needs its own grace bound on how long a snapshot may be served unvalidated, and its own decision about what `/health` then claims.

Both the code and the message are fixed literals.
No part of a failure response is derived from an upstream error, so no store detail, no endpoint, no candidate name, and no credential can reach a client through one, and the body is bounded by construction rather than by truncation.
This matters because the Graph gateway carries `THEGRAPH_API_KEY` in its request path, so any text that quotes a URL can leak the credential.

A check failure never repeats what the request sent, either.
A refused entry is described rather than quoted, because reflecting a value is how a payload somebody else wrote reaches a third party's screen.
The bounds the messages refer to live in this document rather than being interpolated into a body, so a response cannot vary with configuration.
The same rule holds in the log group: a check record carries counts, an HTTP status, and one of the fixed codes above, and no error text at all.
`internal/ens` folds the request URL and a slice of the gateway's response body into its errors, and that URL carries the credential, so the text that described a failure is exactly the part that cannot be written down.
The cost is that an upstream failure is reported as its code and nothing more; `internal/scanner` queries the same gateway with the same credential and is where a diagnosable rendering of that failure belongs.

A failure is never cacheable.
Every one carries `Cache-Control: no-store`.

Retryability is declared per failure rather than inferred from the status, and `Retry-After` is the only thing that separates two failures sharing one.
On the snapshot paths every `503` except `snapshot_too_large` is transient, because the next scheduled scan republishes.
`snapshot_too_large` carries no wait: no scan can shrink a published snapshot below the limit a deployment chose, so that code persists until an operator raises `ENS_API_MAX_BODY_BYTES`, and advertising a delay would have a client poll a condition it cannot clear.
`client_unidentified` and `check_cancelled` are the same case on the check path, for the reasons above.
The status, the `no-store`, and the fixed literals are the same either way.
An oversized snapshot fails `/api/snapshot/meta` too, for the reason given under that endpoint: the declared size is checked before the payload is resolved, so the `raw_bytes` affordance described there is unavailable in exactly that case.

## Caching

Both validators are deterministic functions of the snapshot.

```text
ETag: "<snapshot-id>"
Last-Modified: <scanned_at, RFC 1123>
Cache-Control: public, max-age=<ENS_API_CACHE_SECONDS>, must-revalidate
```

The entity tag is strong.
A snapshot ID is lowercase letters, digits, and inner dashes, so it needs no escaping and can hold no quote, comma, or space that would change how a client parses the header.

`If-None-Match` wins whenever it is present, as RFC 7232 requires, and `If-Modified-Since` is honored only in its absence, so a client that has only the weaker validator still avoids downloading a snapshot it already holds.
The date comparison has one limitation, which is inherent to a date validator rather than to this API: a rollback to a snapshot whose scan time is older than the one a date-only client holds answers `304`, so that client keeps a snapshot that is no longer published until the next scan moves the time forward.
That is why `ETag` is exposed through CORS, and why a browser revalidates on the strong validator instead, where a rolled-back pointer is a plain entity-tag mismatch and therefore a full response.
Comparison is weak, so a client's `W/"id"` matches the `"id"` this API sent, and `*` matches because the resource exists by that point.
An unparseable `If-Modified-Since` is ignored rather than guessed at, which costs one full response and never serves a snapshot the client does not have.

A `304` carries the validators and the caching policy and nothing that describes a body.
`Last-Modified` is the scan time, which is UTC with second precision, so it is exact rather than rounded.

`must-revalidate` keeps a shared cache from serving a stale snapshot without asking, which is what makes a short `max-age` safe rather than a guess.
The default window is 60 seconds, which is short next to the three-hourly cadence on purpose: a client revalidates cheaply and gets a `304`, so the window costs one conditional request rather than a retransmitted snapshot.

`/health` is `no-store`, because the resolved ages in it are correct only at `checked_at`.
`POST /api/check` is `no-store` for the same kind of reason, and it carries no validator at all.

### The in-process cache

A handler holds one verified snapshot.
That is the bound: there is one latest pointer, so one entry is everything a reader can be serving.

Every request still reads the pointer, and the entry is used only when the pointer is byte-for-byte the one the entry was verified against.
A publication therefore cannot be served past, and a rolled-back pointer cannot be served from a stale entry.

The resolve lock is held across the store reads.
That bounds concurrent chunk fetches to one per instance, so a burst against a cold cache costs one read of the snapshot rather than one per request.

The declared raw size is checked against `ENS_API_MAX_BODY_BYTES` before a single chunk is fetched, so an oversized snapshot bounds the work and not just the response.

### The check throttle and result cache

The per-client allowance, the upstream budget, and the result cache are all held in one shared durable store, and that store is the authority.
`internal/checkstore` is the contract, `internal/dynamo` is the DynamoDB backend, and `checkstore.MemoryStore` is the local fake.

The alternative was tried and is wrong.
A Lambda deployment runs as many instances as it is given concurrency for, and each one starts empty, so a per-instance allowance is really that allowance times however many instances a caller reaches, and a per-instance cache is a cache a caller misses by being routed somewhere else.
Neither is a bound a deployment can state.
A shared store makes the allowance one allowance: a replaced instance finds it already spent, and two instances serving the same client at the same moment admit exactly the allowance between them.

Each allowance is a fixed counting window rather than a token bucket.
A bucket that refills has to be read, adjusted, and written back, which against a shared store is a compare-and-swap loop on the hottest key in the system, so the moment the limit starts working is the moment every attempt starts contending with every other.
A fixed window is one atomic conditional increment whatever the concurrency, with no loop, no retry budget of its own, and no stored version.
The cost is at a boundary: a client that spends its whole allowance at the end of one window and again at the start of the next has made twice the allowance in close succession.
That is bounded, it is the same bound every instance sees, and it is written down here rather than smoothed over.

The window is derived from the clock rather than from when a key was first seen, and the window start is part of the stored key.
That is what makes two instances agree, and it is also why a counter whose TTL has not yet swept it is harmless: it belongs to a window nothing live addresses.
A refused charge advertises the end of the window that refused it.

The result cache holds rendered response bytes, keyed on a SHA-256 digest of the deduplicated, sorted, fully-qualified names.
Caching the bytes rather than the results is the point: a hit returns the `checked_at` the miss returned, so a client polling a cached answer is told when the answer was really taken and not when it asked.
That holds across instances too, because the bytes one instance stored are the bytes any other serves.
Two requests naming the same labels in any order, with any repetition, produce one key.
An expired entry is a miss on both the store's own expiry judgement and its TTL, so a stale answer is never served under a fresh instant.

A process-local copy layer sits in front of the shared cache, and it is only an optimization.
It holds bytes that came from the shared store, under the expiry the shared store set, so it can save a store read on a warm instance and it can do nothing else.
It is never the reason an answer exists, and an answer the shared store refused to keep is not kept locally either: that would be the per-instance cache all over again.
`ENS_API_CHECK_LOCAL_CACHE_ENTRIES` bounds it.

A store that cannot be reached is `check_store_unavailable` and the request is refused, including when it is the cache read that failed: a store that could not be read is not evidence that a set is uncached, and treating it as a miss would charge the index for it.
The one exception is the cache write after a successful check, which is logged and never returned.
The answer was already obtained honestly, so refusing then would throw away a verification that really happened because a cache could not keep it; the cost is that the next identical request reads the index again.

The upstream concurrency slot is the one refusal here that really is per instance, because a request in flight cannot be counted anywhere but in the process holding it.
Bounding the number of instances is the function's reserved concurrency, which belongs to `infra/` rather than to anything here.

There is deliberately no request coalescing.
Two concurrent requests naming the same set both reach the index, and the second stores over the first's entry with its own instant.
Coalescing would mean serving one request an instant it did not obtain, which is the one thing this path exists to avoid, and the concurrency slot and the upstream budget already bound what the duplication can cost.

There is also no injected sleeper, because nothing in this package sleeps.
The clock covers the cache and both allowance windows, the retry backoff belongs to the injected `checker.Client`, and `ENS_API_CHECK_TIMEOUT_SECONDS` bounds the whole of it either way.
`ENS_API_CHECK_RETRIES` is parsed and bounded here so a mistyped value fails at cold start in tested code, but it states the deployment's intent for that client rather than a policy this package applies.

### The client identity

The identity a request is throttled against comes from the trusted transport context and never from anything on the wire.
`DefaultClientKey` prefers an identity a gateway adapter attached through `WithClientIdentity`, which is an unexported context key, and falls back to the transport peer with its port dropped.
`X-Forwarded-For` and every other forwarding header are ignored, because a caller chooses a header and a client that can choose its identity can mint a fresh one per request.
A request with neither is `client_unidentified` and is refused.

The identity is never stored, logged, or returned.
It is keyed with HMAC-SHA256 under `ENS_API_CHECK_CLIENT_SECRET`, a stable deployment secret of at least 32 bytes, and only the hex digest reaches the store or a log line.
HMAC rather than a bare digest is what makes it irreversible: an unkeyed digest of an address is undone by hashing the address space.

The secret has to be stable across instances, and that is the whole reason it is a configured secret rather than a value minted at cold start.
A per-process key would give one visitor a different identity on every instance and after every replacement, which is a throttle that cannot bound anything, and it would make every stored digest unreachable the moment the process was replaced.
A deployment that cannot supply it, or supplies one shorter than 32 bytes, fails at cold start rather than falling back to an unkeyed, fixed, or per-process key.
The refusal names the variable and never the value or any prefix of it.

## CORS

`Vary: Origin` is on every response, including the ones that carry no CORS headers, so a shared cache can never hand an origin-specific response to another origin.

Matching is exact.
There is no wildcard, no suffix rule, and `*` is refused at startup rather than normalized, because `*` on a response this API can serve would grant every site on the internet read access to it.
An unconfigured origin gets no grant at all.

A granted origin receives:

```text
Access-Control-Allow-Origin: <the request origin>
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Access-Control-Allow-Headers: If-None-Match, If-Modified-Since
Access-Control-Expose-Headers: ETag, Last-Modified, Retry-After, X-Snapshot-Advisory
Access-Control-Max-Age: 600
```

`ETag` must be exposed explicitly or a browser cannot read it, and a browser that cannot read it cannot revalidate.

Where `POST /api/check` is served, the two request-facing lines widen to exactly what that path needs:

```text
Access-Control-Allow-Methods: GET, HEAD, OPTIONS, POST
Access-Control-Allow-Headers: If-None-Match, If-Modified-Since, Content-Type
```

A browser sending a JSON body needs `Content-Type` through the preflight and `POST` among the methods.
Both are advertised only where the path exists, so a deployment serving the snapshot alone does not describe a surface it does not have.
The exposed headers do not change: `Retry-After` is already there, and it is the only one a check response carries.

A preflight from a disallowed origin still gets `204` and simply carries no grant, which is what the browser needs to refuse the real request.
Saying more would only tell an unknown origin which origins are configured.
A preflight for a path this API does not serve is a `404` rather than a `204`, so a browser cannot discover a future endpoint, or a check endpoint this deployment does not have, before it exists.

## Configuration

Configuration is environment only, read once at cold start.

```text
ENS_API_ALLOWED_ORIGINS       comma-separated exact origins, default none
ENS_API_MAX_BODY_BYTES        bound on the snapshot body, default 16777216
ENS_API_CACHE_SECONDS         max-age on a cacheable response, default 60
ENS_API_RETRY_AFTER_SECONDS   Retry-After on a 503, default 60
```

Every setting has a ceiling as well as a floor, because a mistyped environment variable must not be able to turn a bounded response into an unbounded one.
A rejected setting names the variable, so an operator does not have to guess which one was refused.

An empty origin list means no browser origin is accepted, which is the safe default: a deployment has to name its frontend before a browser can read the snapshot.
A non-browser client is unaffected, because CORS only ever grants access it would otherwise deny.

The store is supplied by the caller rather than parsed, and it is a `snapshot.Reader` rather than a `snapshot.Store`, so a serving path cannot write a chunk, remove one, or move the pointer even by mistake.

### The check path

Every one of these is a bound except the client secret, and every bound has a ceiling as well as a floor.

```text
ENS_API_CHECK_MAX_REQUEST_BYTES        request body bound, default 8192, 256 to 1048576
ENS_API_CHECK_MAX_NAMES                labels per request before dedupe, default 25, 1 to 100
ENS_API_CHECK_MAX_LABEL_BYTES          bound on one normalized label, default 64, 1 to 255
ENS_API_CHECK_BATCH_SIZE               labels per upstream call, default 25, 1 to 1000
ENS_API_CHECK_WORKERS                  concurrent upstream calls per request, default 2, 1 to 8
ENS_API_CHECK_RETRIES                  transient-failure retries, default 2, 0 to 5
ENS_API_CHECK_TIMEOUT_SECONDS          bound on one whole request, default 10, 1 to 60
ENS_API_CHECK_SOON_DAYS                expiring-soon window, default 30, 0 to 365
ENS_API_CHECK_CACHE_SECONDS            how long an answer stays fresh, default 60, 1 to 600
ENS_API_CHECK_LOCAL_CACHE_ENTRIES      process-local copies of shared entries, default 512, 1 to 65536
ENS_API_CHECK_CLIENT_LIMIT             one client's allowance per window, default 5, 1 to 100
ENS_API_CHECK_CLIENT_WINDOW_SECONDS    the window it is counted over, default 60, 1 to 3600
ENS_API_CHECK_CLIENT_SECRET            the identity keying secret, no default, at least 32 bytes
ENS_API_CHECK_UPSTREAM_LIMIT           deployment-wide upstream calls, default 60, 1 to 10000
ENS_API_CHECK_UPSTREAM_WINDOW_SECONDS  the window it is counted over, default 60, 1 to 3600
ENS_API_CHECK_UPSTREAM_CONCURRENCY     checks in the index at once per instance, default 2, 1 to 16
```

None of these enable the path.
The upstream client and the shared store are supplied by the caller rather than parsed, and a deployment that supplies either none does not serve `/api/check` at all.
That is also what keeps the Graph credential out of this package: no setting here holds it, nothing here reads `THEGRAPH_API_KEY` or an endpoint, and a package that never receives a credential cannot expose one.
`ENS_API_CHECK_CLIENT_SECRET` is the one secret this package does read, it is not the Graph credential, and it never appears in a log line, an error, a response, or a stored item.
A configured check path with no upstream client, no store, or no usable secret is refused at cold start rather than answering every request with a failure.

`ENS_API_CHECK_CLIENT_SECRET` is the only setting with no default, deliberately.
Every other value degrades to something sensible; a keying secret has no sensible default, because a fixed one is public and a generated one is per process.

`ENS_API_CHECK_MAX_NAMES` at its default is one upstream call at the default batch size, which is what makes a request's Graph cost predictable.
`ENS_API_CHECK_UPSTREAM_LIMIT` must cover the upstream calls one request at `ENS_API_CHECK_MAX_NAMES` and `ENS_API_CHECK_BATCH_SIZE` needs, or every request would be refused; that cross-check is applied at cold start too.
`ENS_API_CHECK_WORKERS` is per request; the per-instance bound is `ENS_API_CHECK_UPSTREAM_CONCURRENCY`, and the deployment-wide one is `ENS_API_CHECK_UPSTREAM_LIMIT`.
`ENS_API_CHECK_SOON_DAYS` matches the publisher's window, so a fresh status and a snapshot status agree for a name near a boundary.

`The client identity` above says where an identity comes from and how it is keyed.

## Local development

Everything here runs on a laptop with no credentials.

```powershell
go test ./internal/api ./internal/checkstore
go test -race ./internal/api ./internal/checkstore
```

The tests publish `internal/snapshot` fixtures into a `snapshot.MemoryStore` the way a publisher would, chunks first and pointer last, so the API is exercised against snapshots built by `ens.Classify` and serialized by the real wire format.
The local fakes cover the states a store cannot be asked to produce: a read that leaks credential-shaped text, a chunk set relabelled from another snapshot, and a pointer that changes between requests.

The check path is exercised the same way, through the real HTTP adapter against an injected clock, an injected `checker.Client`, and a `checkstore.MemoryStore`.
That store is shared between handlers rather than built per handler, which is what makes the durable behaviour testable without AWS: a second handler over one store is exactly what a replaced or an additional Lambda instance is.
A cold instance is shown to find the allowance already spent and the cache already warm, and four handlers charging one client at once are shown to admit exactly the allowance between them.
Nothing sleeps and nothing is raced: a window is proved to roll over and a cache entry to expire by moving the clock, and the concurrency bound by a fake that reports it has entered the lookup and then waits to be let go.
The store can also be told to fail a charge, a cache read, a cache write, or everything, which is how the fail-closed path and the one failure that must not fail closed are both proved.
The fake answers from a small registration table, so `ens.Classify` produces the statuses rather than a test asserting them, and it can be told to fail, to hold until the request context ends, to drop a name from its answer, or to answer about a set other than the one it was asked about - which is how the truncated and substituted cases reach the code that refuses them.
The bounds a test runs under are far smaller than a deployment's, so a limit is reached with a handful of bytes rather than with a realistic flood, and nothing in that configuration is switched off.

No test in this package reaches AWS, The Graph, or any network.
