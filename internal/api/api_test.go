package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ens-scrape/internal/snapshot"
)

// scanTime is the preview fixture's scan time, and testNow is one hour later, so
// every resolved age in these tests is fixed.
var (
	scanTime = snapshot.FixtureScannedAt
	testNow  = scanTime.Add(time.Hour)
)

func TestSnapshotServesThePublishedBytes(t *testing.T) {
	store := snapshot.NewMemoryStore()
	latest := publishFixture(t, store, snapshot.FixturePreview)
	handler := newTestHandler(t, store, testNow)

	response := get(handler, http.MethodGet, PathSnapshot, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body %s)", response.Code, http.StatusOK, response.Body)
	}

	// The body must be the published canonical JSON, unchanged. A client that
	// hashes what it received has to arrive at the checksum the pointer carries,
	// so nothing may be added to, reordered in, or re-rendered from the payload.
	digest := sha256.Sum256(response.Body.Bytes())
	if got := hex.EncodeToString(digest[:]); got != latest.Checksum {
		t.Errorf("body checksum = %s, want the published %s", got, latest.Checksum)
	}
	if got := response.Body.Len(); got != latest.RawBytes {
		t.Errorf("body length = %d, want the published %d", got, latest.RawBytes)
	}

	snap, err := snapshot.Fixture(snapshot.FixturePreview)
	if err != nil {
		t.Fatalf("rebuild fixture: %v", err)
	}
	want, err := snapshot.EncodeJSON(snap)
	if err != nil {
		t.Fatalf("re-encode fixture: %v", err)
	}
	if !bytes.Equal(response.Body.Bytes(), want) {
		t.Error("body is not the canonical published JSON")
	}

	header := response.Header()
	if got, want := header.Get("ETag"), `"`+latest.SnapshotID+`"`; got != want {
		t.Errorf("ETag = %q, want %q", got, want)
	}
	if got, want := header.Get("Last-Modified"), latest.ScannedAt.UTC().Format(http.TimeFormat); got != want {
		t.Errorf("Last-Modified = %q, want %q", got, want)
	}
	if got, want := header.Get("Cache-Control"), "public, max-age=60, must-revalidate"; got != want {
		t.Errorf("Cache-Control = %q, want %q", got, want)
	}
	if got, want := header.Get("Content-Type"), contentTypeJSON; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	if got, want := header.Get("Content-Length"), strconv.Itoa(latest.RawBytes); got != want {
		t.Errorf("Content-Length = %q, want %q", got, want)
	}
	// The snapshot body is the published bytes, so the non-authority advisory can
	// only travel in a header.
	if got := header.Get(AdvisoryHeader); got != Advisory {
		t.Errorf("%s = %q, want the advisory", AdvisoryHeader, got)
	}
}

func TestHeadSendsHeadersWithoutABody(t *testing.T) {
	store := snapshot.NewMemoryStore()
	latest := publishFixture(t, store, snapshot.FixturePreview)
	handler := newTestHandler(t, store, testNow)

	for _, path := range []string{PathSnapshot, PathMeta, PathHealth} {
		response := get(handler, http.MethodHead, path, nil)
		if response.Code != http.StatusOK {
			t.Errorf("HEAD %s status = %d, want %d", path, response.Code, http.StatusOK)
		}
		if response.Body.Len() != 0 {
			t.Errorf("HEAD %s returned a body of %d bytes", path, response.Body.Len())
		}
		if response.Header().Get("Content-Length") == "" {
			t.Errorf("HEAD %s did not describe the body length", path)
		}
	}
	if got := get(handler, http.MethodHead, PathSnapshot, nil).Header().Get("Content-Length"); got != strconv.Itoa(latest.RawBytes) {
		t.Errorf("HEAD snapshot Content-Length = %q, want %d", got, latest.RawBytes)
	}
}

// TestIncompleteAndCorruptSnapshotsAreNeverServed covers every way resolving can
// stop, and proves each one is reported as itself. The distinctions matter to an
// operator: nothing published yet is a bootstrap, chunks that have gone means a
// published snapshot vanished, and a payload that does not verify is corruption.
func TestIncompleteAndCorruptSnapshotsAreNeverServed(t *testing.T) {
	tests := []struct {
		name  string
		store func(t *testing.T) snapshot.Reader
		code  string
	}{
		{
			name:  "nothing published",
			store: func(t *testing.T) snapshot.Reader { return snapshot.NewMemoryStore() },
			code:  CodeNoSnapshot,
		},
		{
			name: "pointer resolves but chunks are gone",
			store: func(t *testing.T) snapshot.Reader {
				store := snapshot.NewMemoryStore()
				publishPointerOnly(t, store, snapshot.FixturePreview)
				return store
			},
			code: CodeChunksMissing,
		},
		{
			name: "a stored chunk is corrupt",
			store: func(t *testing.T) snapshot.Reader {
				store := snapshot.NewMemoryStore()
				latest := publishFixture(t, store, snapshot.FixturePreview)
				if err := store.CorruptChunk(latest.SnapshotID, 0); err != nil {
					t.Fatalf("corrupt chunk: %v", err)
				}
				return store
			},
			code: CodeUnreadable,
		},
		{
			name: "the chunk set is incomplete",
			store: func(t *testing.T) snapshot.Reader {
				store := snapshot.NewMemoryStore()
				latest := publishFixture(t, store, snapshot.FixturePreview)
				store.TruncateChunks(latest.SnapshotID, 0, 1)
				return store
			},
			code: CodeUnreadable,
		},
		{
			name: "chunks belong to another snapshot",
			store: func(t *testing.T) snapshot.Reader {
				store := snapshot.NewMemoryStore()
				other := publishFixture(t, store, snapshot.FixtureStale)
				publishFixture(t, store, snapshot.FixturePreview)
				return relabellingStore{inner: store, other: other.SnapshotID}
			},
			code: CodeUnreadable,
		},
		{
			name:  "the store cannot be read",
			store: func(t *testing.T) snapshot.Reader { return leakingStore{} },
			code:  CodeUnavailable,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			handler := newTestHandler(t, test.store(t), testNow)
			for _, path := range []string{PathSnapshot, PathMeta, PathHealth} {
				response := get(handler, http.MethodGet, path, nil)
				if response.Code != http.StatusServiceUnavailable {
					t.Fatalf("%s status = %d, want %d", path, response.Code, http.StatusServiceUnavailable)
				}
				if response.Body.Len() == 0 {
					t.Fatalf("%s returned no diagnosis", path)
				}
				var document errorDocument
				if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
					t.Fatalf("%s body is not JSON: %v", path, err)
				}
				if document.Error.Code != test.code {
					t.Errorf("%s code = %q, want %q", path, document.Error.Code, test.code)
				}
				// A failure must never be cached: the next scheduled scan fixes it,
				// and a shared cache holding a 503 would outlive the fix.
				if got := response.Header().Get("Cache-Control"); got != "no-store" {
					t.Errorf("%s Cache-Control = %q, want no-store", path, got)
				}
				if got := response.Header().Get("Retry-After"); got != strconv.Itoa(DefaultRetrySeconds) {
					t.Errorf("%s Retry-After = %q, want %d", path, got, DefaultRetrySeconds)
				}
				if document.Advisory != Advisory {
					t.Errorf("%s dropped the advisory", path)
				}
			}
		})
	}
}

// TestChunksMissingAgreesWithTheSnapshotContract ties this package's
// classification to snapshot.Read's, so the two cannot drift apart. The contract
// keeps an absent pointer and absent chunks distinct, and the HTTP surface has to
// keep making the same distinction.
func TestChunksMissingAgreesWithTheSnapshotContract(t *testing.T) {
	store := snapshot.NewMemoryStore()
	publishPointerOnly(t, store, snapshot.FixturePreview)

	_, _, err := snapshot.Read(context.Background(), store)
	if !errors.Is(err, snapshot.ErrChunksMissing) {
		t.Fatalf("snapshot.Read error = %v, want a chunks-missing error", err)
	}
	if errors.Is(err, snapshot.ErrNotFound) {
		t.Fatal("snapshot.Read collapsed missing chunks into not-found")
	}

	handler := newTestHandler(t, store, testNow)
	var document errorDocument
	response := get(handler, http.MethodGet, PathSnapshot, nil)
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode failure body: %v", err)
	}
	if document.Error.Code != CodeChunksMissing {
		t.Errorf("code = %q, want %q for the same store", document.Error.Code, CodeChunksMissing)
	}

	empty := newTestHandler(t, snapshot.NewMemoryStore(), testNow)
	response = get(empty, http.MethodGet, PathSnapshot, nil)
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode failure body: %v", err)
	}
	if document.Error.Code != CodeNoSnapshot {
		t.Errorf("empty store code = %q, want %q", document.Error.Code, CodeNoSnapshot)
	}
}

// TestFailureBodiesCarryNoUpstreamText proves the failure path composes its own
// text. The Graph gateway carries THEGRAPH_API_KEY in its request path, so any
// error that quotes a URL would otherwise publish a credential to whoever asked.
func TestFailureBodiesCarryNoUpstreamText(t *testing.T) {
	handler := newTestHandler(t, leakingStore{}, testNow)

	for _, path := range []string{PathSnapshot, PathMeta, PathHealth, "/api/unknown"} {
		response := get(handler, http.MethodGet, path, nil)
		body := response.Body.String()
		for _, forbidden := range []string{leakedSecret, leakedText, "gateway.thegraph.com", "zap.eth"} {
			if strings.Contains(body, forbidden) {
				t.Errorf("%s body leaked %q", path, forbidden)
			}
		}
		for name, values := range response.Header() {
			for _, value := range values {
				if strings.Contains(value, leakedSecret) {
					t.Errorf("%s header %s leaked the credential", path, name)
				}
			}
		}
		// The bound is structural rather than a truncation: every failure body is
		// two fixed literals and the advisory.
		if response.Body.Len() > 512 {
			t.Errorf("%s failure body is %d bytes, want a small fixed document", path, response.Body.Len())
		}
	}
}

func TestConditionalRequestsAvoidRetransmission(t *testing.T) {
	store := snapshot.NewMemoryStore()
	latest := publishFixture(t, store, snapshot.FixturePreview)
	handler := newTestHandler(t, store, testNow)

	etag := `"` + latest.SnapshotID + `"`
	scanned := latest.ScannedAt.UTC().Format(http.TimeFormat)
	before := latest.ScannedAt.Add(-time.Hour).UTC().Format(http.TimeFormat)

	tests := []struct {
		name   string
		header http.Header
		status int
	}{
		{"no validators", nil, http.StatusOK},
		{"matching entity tag", http.Header{"If-None-Match": {etag}}, http.StatusNotModified},
		{"weakly compared entity tag", http.Header{"If-None-Match": {"W/" + etag}}, http.StatusNotModified},
		{"entity tag list", http.Header{"If-None-Match": {`"other", ` + etag}}, http.StatusNotModified},
		{"wildcard", http.Header{"If-None-Match": {"*"}}, http.StatusNotModified},
		{"stale entity tag", http.Header{"If-None-Match": {`"fixture-stale"`}}, http.StatusOK},
		{"same modification time", http.Header{"If-Modified-Since": {scanned}}, http.StatusNotModified},
		{"older copy", http.Header{"If-Modified-Since": {before}}, http.StatusOK},
		{"unparseable date", http.Header{"If-Modified-Since": {"whenever"}}, http.StatusOK},
		// An entity tag is the stronger validator, so a present If-None-Match
		// decides on its own even when the date would have said otherwise.
		{
			name:   "entity tag beats modification time",
			header: http.Header{"If-None-Match": {`"fixture-stale"`}, "If-Modified-Since": {scanned}},
			status: http.StatusOK,
		},
	}

	for _, path := range []string{PathSnapshot, PathMeta} {
		for _, test := range tests {
			response := get(handler, http.MethodGet, path, test.header)
			if response.Code != test.status {
				t.Errorf("%s %s status = %d, want %d", path, test.name, response.Code, test.status)
			}
			// Both validators travel on every response, including a 304, so a
			// client can keep revalidating without a fresh full fetch.
			if response.Header().Get("ETag") != etag {
				t.Errorf("%s %s dropped the entity tag", path, test.name)
			}
			if response.Header().Get("Cache-Control") == "" {
				t.Errorf("%s %s dropped the caching policy", path, test.name)
			}
			if test.status == http.StatusNotModified {
				if response.Body.Len() != 0 {
					t.Errorf("%s %s sent a body with a 304", path, test.name)
				}
				if response.Header().Get("Content-Length") != "" {
					t.Errorf("%s %s described a body it did not send", path, test.name)
				}
			}
		}
	}
}

func TestCacheResolvesOncePerPublication(t *testing.T) {
	inner := snapshot.NewMemoryStore()
	publishFixture(t, inner, snapshot.FixturePreview)
	store := &countingStore{inner: inner}
	handler := newTestHandler(t, store, testNow)

	for i := 0; i < 3; i++ {
		if response := get(handler, http.MethodGet, PathSnapshot, nil); response.Code != http.StatusOK {
			t.Fatalf("request %d status = %d", i, response.Code)
		}
	}
	if response := get(handler, http.MethodGet, PathMeta, nil); response.Code != http.StatusOK {
		t.Fatalf("meta status = %d", response.Code)
	}

	// Every request still reads the pointer, so a publication can never be served
	// past, but the chunks are fetched once for as long as the pointer stands.
	latestCalls, chunkCalls := store.calls()
	if latestCalls != 4 {
		t.Errorf("pointer reads = %d, want one per request", latestCalls)
	}
	if chunkCalls != 1 {
		t.Errorf("chunk fetches = %d, want 1", chunkCalls)
	}
}

// TestConcurrentColdRequestsResolveOnce proves the resolve lock bounds the work a
// burst can cause. Without it, a cold cache under load would fetch and verify the
// whole snapshot once per in-flight request.
func TestConcurrentColdRequestsResolveOnce(t *testing.T) {
	inner := snapshot.NewMemoryStore()
	publishFixture(t, inner, snapshot.FixturePreview)
	store := &countingStore{inner: inner}
	handler := newTestHandler(t, store, testNow)

	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if response := get(handler, http.MethodGet, PathSnapshot, nil); response.Code != http.StatusOK {
				t.Errorf("status = %d", response.Code)
			}
		}()
	}
	group.Wait()

	if _, chunkCalls := store.calls(); chunkCalls != 1 {
		t.Errorf("chunk fetches = %d, want 1 for a burst against a cold cache", chunkCalls)
	}
}

// TestRepublicationIsServedImmediately proves the cache is keyed on the whole
// pointer. A snapshot that has been superseded must not keep serving.
func TestRepublicationIsServedImmediately(t *testing.T) {
	store := snapshot.NewMemoryStore()
	first := publishFixture(t, store, snapshot.FixtureStale)
	handler := newTestHandler(t, store, testNow)

	response := get(handler, http.MethodGet, PathSnapshot, nil)
	if got, want := response.Header().Get("ETag"), `"`+first.SnapshotID+`"`; got != want {
		t.Fatalf("first ETag = %q, want %q", got, want)
	}
	firstBody := response.Body.String()

	second := publishFixture(t, store, snapshot.FixturePreview)
	response = get(handler, http.MethodGet, PathSnapshot, nil)
	if got, want := response.Header().Get("ETag"), `"`+second.SnapshotID+`"`; got != want {
		t.Errorf("second ETag = %q, want %q", got, want)
	}
	if response.Body.String() == firstBody {
		t.Error("the superseded snapshot was served again")
	}
	// The entity tag the client held is now stale, so revalidating it must return
	// the replacement rather than a 304.
	revalidated := get(handler, http.MethodGet, PathSnapshot, http.Header{"If-None-Match": {`"` + first.SnapshotID + `"`}})
	if revalidated.Code != http.StatusOK {
		t.Errorf("revalidation status = %d, want %d", revalidated.Code, http.StatusOK)
	}
}

// TestOversizedSnapshotBoundsTheWork proves the size limit is applied to the
// pointer's declaration, before any chunk is fetched, so an oversized snapshot
// costs one small read rather than a full download.
func TestOversizedSnapshotBoundsTheWork(t *testing.T) {
	inner := snapshot.NewMemoryStore()
	publishFixture(t, inner, snapshot.FixturePreview)
	store := &countingStore{
		inner: inner,
		pointerRewrite: func(latest snapshot.Latest) snapshot.Latest {
			latest.RawBytes = DefaultMaxBodyBytes + 1
			return latest
		},
	}
	handler := newTestHandler(t, store, testNow)

	response := get(handler, http.MethodGet, PathSnapshot, nil)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	var document errorDocument
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode failure body: %v", err)
	}
	if document.Error.Code != CodeTooLarge {
		t.Errorf("code = %q, want %q", document.Error.Code, CodeTooLarge)
	}
	if _, chunkCalls := store.calls(); chunkCalls != 0 {
		t.Errorf("chunk fetches = %d, want none for an oversized snapshot", chunkCalls)
	}
}

func TestMetaSummarisesWithoutTheResults(t *testing.T) {
	store := snapshot.NewMemoryStore()
	latest := publishFixture(t, store, snapshot.FixturePreview)
	handler := newTestHandler(t, store, testNow)

	response := get(handler, http.MethodGet, PathMeta, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	raw := response.Body.Bytes()

	var document metaDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("decode meta: %v", err)
	}
	if document.SnapshotID != latest.SnapshotID {
		t.Errorf("snapshot id = %q, want %q", document.SnapshotID, latest.SnapshotID)
	}
	if document.Checksum != latest.Checksum || document.RawBytes != latest.RawBytes {
		t.Error("meta does not describe the snapshot body a client would download")
	}
	if document.Names != latest.Names || len(document.Counts) != len(latest.Counts) {
		t.Error("meta counts disagree with the published pointer")
	}
	if document.ScanAge != latest.ScanAge {
		t.Errorf("scan age = %+v, want the published %+v", document.ScanAge, latest.ScanAge)
	}
	if document.Advisory != Advisory {
		t.Error("meta dropped the advisory")
	}
	if bytes.Contains(raw, []byte("published_at")) {
		// published_at is excluded from pointer identity, so a retried publication
		// changes it while the snapshot ID does not. Publishing it here would let
		// the document change without its validator changing.
		t.Error("meta carries published_at, which the entity tag does not cover")
	}
	if bytes.Contains(raw, []byte("\"results\"")) {
		t.Error("meta carries the results it exists to avoid")
	}

	// Source-specific thresholds: the three-hourly lists must not inherit the
	// daily list's window just because the snapshot as a whole does.
	wantCadence := map[string]snapshot.Cadence{
		"three-letters": snapshot.CadenceThreeHourly,
		"four-letters":  snapshot.CadenceThreeHourly,
		"five-letters":  snapshot.CadenceDaily,
	}
	if len(document.Sources) != len(wantCadence) {
		t.Fatalf("sources = %d, want %d", len(document.Sources), len(wantCadence))
	}
	for _, source := range document.Sources {
		cadence, known := wantCadence[source.ID]
		if !known {
			t.Errorf("unexpected source %q", source.ID)
			continue
		}
		if source.Cadence != cadence {
			t.Errorf("source %q cadence = %q, want %q", source.ID, source.Cadence, cadence)
		}
		interval, _ := cadence.Interval()
		want := snapshot.ScanAgeInput{
			ExpectedSeconds:   int64(interval / time.Second),
			StaleAfterSeconds: int64(interval/time.Second) * snapshot.StaleFactor,
		}
		if source.ScanAge != want {
			t.Errorf("source %q scan age = %+v, want %+v", source.ID, source.ScanAge, want)
		}
	}

	// The document is a pure function of the snapshot, so the same pointer always
	// produces the same bytes and the entity tag stays a correct validator for it.
	if again := get(handler, http.MethodGet, PathMeta, nil); !bytes.Equal(again.Body.Bytes(), raw) {
		t.Error("meta is not byte-stable for one snapshot")
	}
	snapshotResponse := get(handler, http.MethodGet, PathSnapshot, nil)
	if snapshotResponse.Header().Get("ETag") != response.Header().Get("ETag") {
		t.Error("meta and snapshot disagree about the entity tag for one snapshot")
	}
}

// TestHealthResolvesStalenessAgainstItsOwnClock covers the one response that
// reports a resolved age. It is uncacheable for exactly that reason.
func TestHealthResolvesStalenessAgainstItsOwnClock(t *testing.T) {
	store := snapshot.NewMemoryStore()
	latest := publishFixture(t, store, snapshot.FixturePreview)

	// Seven hours after the scan: past the three-hourly stale threshold of six
	// hours, well inside the daily one of forty-eight. The snapshot as a whole is
	// governed by its slowest list, so it is fresh while its fast lists are not.
	now := scanTime.Add(7 * time.Hour)
	handler := newTestHandler(t, store, now)

	response := get(handler, http.MethodGet, PathHealth, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body %s)", response.Code, http.StatusOK, response.Body)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}

	var document healthDocument
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode health: %v", err)
	}
	if document.Status != statusOK {
		t.Errorf("status = %q, want %q", document.Status, statusOK)
	}
	if document.SnapshotID != latest.SnapshotID {
		t.Errorf("snapshot id = %q, want %q", document.SnapshotID, latest.SnapshotID)
	}
	if !document.CheckedAt.Equal(now) {
		t.Errorf("checked at = %s, want %s", document.CheckedAt, now)
	}
	if document.ScanAge.AgeSeconds != int64(7*time.Hour/time.Second) {
		t.Errorf("age = %ds, want %d", document.ScanAge.AgeSeconds, int64(7*time.Hour/time.Second))
	}
	if document.ScanAge.Stale {
		t.Error("a snapshot inside its slowest list's window was reported stale")
	}

	stalePerSource := map[string]bool{"three-letters": true, "four-letters": true, "five-letters": false}
	for _, source := range document.Sources {
		want, known := stalePerSource[source.ID]
		if !known {
			t.Errorf("unexpected source %q", source.ID)
			continue
		}
		if source.ScanAge.Stale != want {
			t.Errorf("source %q stale = %v, want %v", source.ID, source.ScanAge.Stale, want)
		}
		if source.ScanAge.AgeSeconds != document.ScanAge.AgeSeconds {
			t.Errorf("source %q age = %d, want the shared %d", source.ID, source.ScanAge.AgeSeconds, document.ScanAge.AgeSeconds)
		}
	}
}

// TestHealthStaysHealthyForAStaleSnapshot separates the two alarms. A publisher
// falling behind is not the read path failing, and a complete snapshot is still
// worth serving.
func TestHealthStaysHealthyForAStaleSnapshot(t *testing.T) {
	store := snapshot.NewMemoryStore()
	publishFixture(t, store, snapshot.FixtureStale)
	handler := newTestHandler(t, store, testNow)

	response := get(handler, http.MethodGet, PathHealth, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	var document healthDocument
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode health: %v", err)
	}
	if !document.ScanAge.Stale {
		t.Error("the stale fixture was not reported stale")
	}
	if document.Status != statusOK {
		t.Errorf("status = %q, want %q for a complete snapshot", document.Status, statusOK)
	}
}

// TestClockSkewIsNotFreshness pins the contract's rule: a scan time in the future
// resolves to a zero age rather than to a negative one.
func TestClockSkewIsNotFreshness(t *testing.T) {
	store := snapshot.NewMemoryStore()
	publishFixture(t, store, snapshot.FixturePreview)
	handler := newTestHandler(t, store, scanTime.Add(-time.Hour))

	var document healthDocument
	response := get(handler, http.MethodGet, PathHealth, nil)
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode health: %v", err)
	}
	if document.ScanAge.AgeSeconds != 0 || document.ScanAge.Stale {
		t.Errorf("scan age = %+v, want a zero age and not stale", document.ScanAge)
	}
}

func TestRoutingAndMethods(t *testing.T) {
	store := snapshot.NewMemoryStore()
	publishFixture(t, store, snapshot.FixturePreview)
	handler := newTestHandler(t, store, testNow)

	// An unknown path is a 404 rather than a prefix match, so no path this package
	// has not declared can be reached.
	for _, path := range []string{"/", "/api", "/api/snapshot/", "/api/snapshot/results", "/health/live"} {
		response := get(handler, http.MethodGet, path, nil)
		if response.Code != http.StatusNotFound {
			t.Errorf("GET %s status = %d, want %d", path, response.Code, http.StatusNotFound)
		}
		var document errorDocument
		if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
			t.Fatalf("decode failure body: %v", err)
		}
		if document.Error.Code != CodeNotFound {
			t.Errorf("GET %s code = %q, want %q", path, document.Error.Code, CodeNotFound)
		}
		if response.Header().Get("Retry-After") != "" {
			t.Errorf("GET %s told a client to retry a path that will never exist", path)
		}
	}

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		response := get(handler, method, PathSnapshot, nil)
		if response.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s status = %d, want %d", method, response.Code, http.StatusMethodNotAllowed)
		}
		if got := response.Header().Get("Allow"); got != allowedMethods {
			t.Errorf("%s Allow = %q, want %q", method, got, allowedMethods)
		}
	}

	preflight := get(handler, http.MethodOptions, PathSnapshot, http.Header{"Origin": {testOrigin}})
	if preflight.Code != http.StatusNoContent {
		t.Errorf("OPTIONS status = %d, want %d", preflight.Code, http.StatusNoContent)
	}
	if got := preflight.Header().Get("Allow"); got != allowedMethods {
		t.Errorf("OPTIONS Allow = %q, want %q", got, allowedMethods)
	}
	// A preflight never reaches the store, so an unresolvable snapshot cannot stop
	// a browser from learning which methods are allowed.
	unavailable := newTestHandler(t, leakingStore{}, testNow)
	if got := get(unavailable, http.MethodOptions, PathSnapshot, nil).Code; got != http.StatusNoContent {
		t.Errorf("OPTIONS against a failing store status = %d, want %d", got, http.StatusNoContent)
	}
}

func TestCORSGrantsOnlyConfiguredOrigins(t *testing.T) {
	store := snapshot.NewMemoryStore()
	publishFixture(t, store, snapshot.FixturePreview)
	handler := newTestHandler(t, store, testNow)

	granted := get(handler, http.MethodGet, PathSnapshot, http.Header{"Origin": {testOrigin}})
	if got := granted.Header().Get("Access-Control-Allow-Origin"); got != testOrigin {
		t.Errorf("allowed origin = %q, want %q", got, testOrigin)
	}
	// A browser cannot read ETag unless it is exposed, and without it there is no
	// conditional request and so no cheap revalidation.
	exposed := granted.Header().Get("Access-Control-Expose-Headers")
	for _, name := range []string{"ETag", "Last-Modified", AdvisoryHeader} {
		if !strings.Contains(exposed, name) {
			t.Errorf("Access-Control-Expose-Headers = %q, missing %s", exposed, name)
		}
	}

	for _, origin := range []string{
		"https://evil.example",
		"http://scout.example",
		"https://scout.example.evil.test",
		"https://scout.example:8443",
		"https://SCOUT.example",
	} {
		response := get(handler, http.MethodGet, PathSnapshot, http.Header{"Origin": {origin}})
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("origin %q was granted %q", origin, got)
		}
		if response.Code != http.StatusOK {
			t.Errorf("origin %q changed the status to %d; CORS only ever grants", origin, response.Code)
		}
	}

	// Vary is on every response, granted or not, so a shared cache can never hand
	// one origin's response to another.
	for _, header := range []http.Header{nil, {"Origin": {testOrigin}}, {"Origin": {"https://evil.example"}}} {
		if got := get(handler, http.MethodGet, PathSnapshot, header).Header().Get("Vary"); got != "Origin" {
			t.Errorf("Vary = %q, want Origin", got)
		}
	}
	if got := get(handler, http.MethodGet, PathSnapshot, nil).Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("a request with no Origin was granted %q", got)
	}
}
