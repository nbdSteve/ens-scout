# ENS Scout Read API

`internal/api` serves the published snapshot over HTTP.
It is the read half of the website: a browser fetches one snapshot, keeps it locally, and does every filter, sort, and countdown itself, so ordinary browsing never reaches DynamoDB or The Graph.

This document is the contract the frontend, the local preview, and any monitor can rely on.
The package itself holds the reasons behind each rule; this file holds the wire surface.

## Scope

The package does two things.
It resolves the snapshot the latest pointer names, and it answers conditionally so an unchanged snapshot is never retransmitted.

It adds no ENS logic.
Lifecycle classification, chunk assembly, checksums, and canonical serialization are all `internal/snapshot`, and there is no second classifier.

It is not an availability authority.
The subgraph is an index rather than the registration authority, and a snapshot is one scan of that index at one instant, so every response this package composes carries an advisory and every response carries the scan time.

It depends on no AWS package and on no outbound HTTP client.
The store is `snapshot.Reader`, the read half of the storage contract, so the whole surface is exercised against `snapshot.MemoryStore` with no network and no credentials.

The live-check endpoint in [docs/website-plan.md](website-plan.md) is not part of this package.
It queries The Graph, so it belongs to the phase that adds live verification.

## Endpoints

```text
GET  /api/snapshot          the published snapshot, byte for byte
HEAD /api/snapshot          the same headers with no body
GET  /api/snapshot/meta     the snapshot summary without its results
HEAD /api/snapshot/meta     the same headers with no body
GET  /health                whether a complete snapshot is being served
HEAD /health                the same headers with no body
OPTIONS <any path>          CORS preflight, 204 No Content
```

Routing is exact.
An unknown path is `404` rather than a prefix match, so no future path can be reached by accident.
Any other method is `405` with an `Allow` header.

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
  "format_version": 2,
  "snapshot_id": "...",
  "scanned_at": "2026-03-01T12:00:00Z",
  "checksum": "...",
  "raw_bytes": 12345,
  "names": 100,
  "counts": { "available": 10, "premium": 2, "registered": 80, "unknown": 0 },
  "sources": [
    {
      "id": "three-letters",
      "path": "data/words/3-letters.txt",
      "cadence": "three-hourly",
      "names": 40,
      "scan_age": { "expected_interval_seconds": 10800, "stale_after_seconds": 21600 }
    }
  ],
  "scan_age": { "expected_interval_seconds": 86400, "stale_after_seconds": 172800 },
  "advisory": "..."
}
```

`counts` holds every lifecycle status in `ens.Statuses`, including the ones with no results, so a client never has to distinguish an absent status from a zero.

`checksum` and `raw_bytes` describe the `/api/snapshot` body, so a client can verify a download against a summary it fetched separately and can decide whether to fetch it at all.

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
      "names": 40,
      "scan_age": {
        "age_seconds": 25200,
        "expected_interval_seconds": 10800,
        "stale_after_seconds": 21600,
        "stale": true
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
The example above is seven hours after a scan: the snapshot is not stale, because the daily list governs the snapshot-wide window, while both three-hourly lists are already past their own.

`status` has one value.
A run that cannot serve a snapshot answers with a failure code instead, so there is no degraded state to name here.

## Failures

Every failure body is the same shape.

```json
{
  "error": { "code": "no_snapshot_published", "message": "No snapshot has been published yet." },
  "advisory": "..."
}
```

| Status | Code                     | Meaning                                                                  |
| ------ | ------------------------ | ------------------------------------------------------------------------ |
| 503    | `no_snapshot_published`  | The store holds no latest pointer. Nothing has been published yet.       |
| 503    | `snapshot_chunks_missing`| The pointer resolved and the chunks it names are gone.                   |
| 503    | `snapshot_unreadable`    | The stored payload did not verify.                                       |
| 503    | `snapshot_too_large`     | The published snapshot is larger than this endpoint serves.              |
| 503    | `snapshot_unavailable`   | The store could not be read.                                             |
| 405    | `method_not_allowed`     | The endpoint accepts GET, HEAD, and OPTIONS.                             |
| 404    | `not_found`              | No such endpoint.                                                        |

Nothing partial or unverified is ever served.
`snapshot.Verify` is the only judge of a payload, and a chunk set that is missing, duplicated, reordered, corrupt, checksum-mismatched, non-canonical, relabelled from another snapshot, or in disagreement with the pointer that names it fails there rather than reaching a client.

`no_snapshot_published` and `snapshot_chunks_missing` are kept apart deliberately.
The first is a store with nothing in it, which is an ordinary bootstrap; the second is a published snapshot that vanished under the pointer, which is an operational alarm.

`snapshot_unavailable` says less on purpose.
A failed read is not evidence of an empty store and not evidence of corruption, so the code claims neither.
A cancelled or expired request context is reported the same way, because it says nothing about what is stored.

A pointer that cannot be read fails closed, even when a verified snapshot is already in the in-process cache.
The cached entry is dropped rather than served, because a reader that cannot read the pointer cannot tell a live pointer from one that has since been superseded, and every endpoint answers `snapshot_unavailable` while the store is unreachable.
`/health` reports that outage rather than reporting `ok` from memory, so a monitor sees the read path's real dependency state instead of a healthy answer that outlives the store.
Serving a last-known-good snapshot past a failed pointer read is a separate resilience feature, not this one: it needs its own grace bound on how long a snapshot may be served unvalidated, and its own decision about what `/health` then claims.

Both the code and the message are fixed literals.
No part of a failure response is derived from an upstream error, so no store detail, no endpoint, no candidate name, and no credential can reach a client through one, and the body is bounded by construction rather than by truncation.
This matters because the Graph gateway carries `THEGRAPH_API_KEY` in its request path, so any text that quotes a URL can leak the credential.

A failure is never cacheable.
Every one carries `Cache-Control: no-store`, and every `503` carries `Retry-After`, because each of those failures is transient from a client's point of view: the next scheduled scan republishes.

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
Comparison is weak, so a client's `W/"id"` matches the `"id"` this API sent, and `*` matches because the resource exists by that point.
An unparseable `If-Modified-Since` is ignored rather than guessed at, which costs one full response and never serves a snapshot the client does not have.

A `304` carries the validators and the caching policy and nothing that describes a body.
`Last-Modified` is the scan time, which is UTC with second precision, so it is exact rather than rounded.

`must-revalidate` keeps a shared cache from serving a stale snapshot without asking, which is what makes a short `max-age` safe rather than a guess.
The default window is 60 seconds, which is short next to the three-hourly cadence on purpose: a client revalidates cheaply and gets a `304`, so the window costs one conditional request rather than a retransmitted snapshot.

`/health` is `no-store`, because the resolved ages in it are correct only at `checked_at`.

### The in-process cache

A handler holds one verified snapshot.
That is the bound: there is one latest pointer, so one entry is everything a reader can be serving.

Every request still reads the pointer, and the entry is used only when the pointer is byte-for-byte the one the entry was verified against.
A publication therefore cannot be served past, and a rolled-back pointer cannot be served from a stale entry.

The resolve lock is held across the store reads.
That bounds concurrent chunk fetches to one per instance, so a burst against a cold cache costs one read of the snapshot rather than one per request.

The declared raw size is checked against `ENS_API_MAX_BODY_BYTES` before a single chunk is fetched, so an oversized snapshot bounds the work and not just the response.

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

A preflight from a disallowed origin still gets `204` and simply carries no grant, which is what the browser needs to refuse the real request.
Saying more would only tell an unknown origin which origins are configured.

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

## Local development

Everything here runs on a laptop with no credentials.

```powershell
go test ./internal/api
go test -race ./internal/api
```

The tests publish `internal/snapshot` fixtures into a `snapshot.MemoryStore` the way a publisher would, chunks first and pointer last, so the API is exercised against snapshots built by `ens.Classify` and serialized by the real wire format.
The local fakes cover the states a store cannot be asked to produce: a read that leaks credential-shaped text, a chunk set relabelled from another snapshot, and a pointer that changes between requests.

No test in this package reaches AWS, The Graph, or any network.
