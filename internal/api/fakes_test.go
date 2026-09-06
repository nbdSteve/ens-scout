package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"ens-scrape/internal/snapshot"
)

// testOrigin is the one allowed browser origin in these tests.
const testOrigin = "https://scout.example"

// publishFixture stores a bundled fixture in a MemoryStore exactly as a
// publisher would: chunks first, pointer last. It returns the published pointer.
//
// The fixtures come from internal/snapshot, so the API is exercised against
// snapshots built by ens.Classify rather than by hand written ones, and no test
// here can drift away from the real lifecycle rules or the real wire format.
func publishFixture(t *testing.T, store *snapshot.MemoryStore, name string) snapshot.Latest {
	t.Helper()
	ctx := context.Background()

	snap, err := snapshot.Fixture(name)
	if err != nil {
		t.Fatalf("build fixture %s: %v", name, err)
	}
	payload, err := snapshot.Encode(snap)
	if err != nil {
		t.Fatalf("encode fixture %s: %v", name, err)
	}
	latest, err := snapshot.FixtureLatest(name)
	if err != nil {
		t.Fatalf("build fixture %s pointer: %v", name, err)
	}
	if err := store.PutChunks(ctx, latest.SnapshotID, payload.Chunks); err != nil {
		t.Fatalf("store fixture %s chunks: %v", name, err)
	}
	if _, err := store.PutLatest(ctx, latest); err != nil {
		t.Fatalf("publish fixture %s: %v", name, err)
	}
	return latest
}

// publishWithSourceScan publishes the preview fixture's results under a snapshot
// that says one named list was last scanned at the given instant, leaving every
// other list and the snapshot-wide scan time exactly as the fixture has them.
//
// It exists so a test can vary one list's own instant and nothing else. Two
// publications that differ only there must be reported differently, and anything
// that resolved a list's age from the snapshot would report them identically.
func publishWithSourceScan(
	t *testing.T,
	store *snapshot.MemoryStore,
	sourceID string,
	lastScannedAt time.Time,
) snapshot.Latest {
	t.Helper()
	ctx := context.Background()

	base, err := snapshot.Fixture(snapshot.FixturePreview)
	if err != nil {
		t.Fatalf("build the preview fixture: %v", err)
	}
	sources := append([]snapshot.SourceList(nil), base.Metadata.Sources...)
	edited := false
	for i := range sources {
		if sources[i].ID == sourceID {
			sources[i].LastScannedAt = lastScannedAt
			edited = true
		}
	}
	if !edited {
		t.Fatalf("the preview fixture has no source %q", sourceID)
	}

	// The scan time and the results are the fixture's, so the only thing that
	// varies between calls is the one instant this helper was given.
	id := fmt.Sprintf("source-scan-%s-%d", sourceID, lastScannedAt.UTC().Unix())
	snap, err := snapshot.Build(id, base.Metadata.ScannedAt, sources, base.Results)
	if err != nil {
		t.Fatalf("build a snapshot with %q last scanned at %s: %v", sourceID, lastScannedAt, err)
	}
	payload, err := snapshot.Encode(snap)
	if err != nil {
		t.Fatalf("encode the snapshot: %v", err)
	}
	latest := payload.Latest(snap.Metadata.ScannedAt.Add(time.Minute))
	if err := store.PutChunks(ctx, latest.SnapshotID, payload.Chunks); err != nil {
		t.Fatalf("store the chunks: %v", err)
	}
	if _, err := store.PutLatest(ctx, latest); err != nil {
		t.Fatalf("publish the pointer: %v", err)
	}
	return latest
}

// publishPointerOnly stores a fixture's pointer and none of its chunks, which is
// the state a reader sees when a published snapshot's chunks have gone.
func publishPointerOnly(t *testing.T, store *snapshot.MemoryStore, name string) snapshot.Latest {
	t.Helper()
	latest, err := snapshot.FixtureLatest(name)
	if err != nil {
		t.Fatalf("build fixture %s pointer: %v", name, err)
	}
	if _, err := store.PutLatest(context.Background(), latest); err != nil {
		t.Fatalf("publish fixture %s pointer: %v", name, err)
	}
	return latest
}

// testConfig is the configuration these tests use, with a fixed clock so the
// resolved ages on /health are deterministic.
func testConfig(store snapshot.Reader, now time.Time) Config {
	return Config{
		Store:          store,
		AllowedOrigins: []string{testOrigin},
		MaxBodyBytes:   DefaultMaxBodyBytes,
		CacheSeconds:   DefaultCacheSeconds,
		RetrySeconds:   DefaultRetrySeconds,
		Now:            func() time.Time { return now },
	}
}

func newTestHandler(t *testing.T, store snapshot.Reader, now time.Time) *Handler {
	t.Helper()
	handler, err := New(testConfig(store, now))
	if err != nil {
		t.Fatalf("build handler: %v", err)
	}
	return handler
}

// get issues one request against a handler and returns the recorded response.
func get(handler *Handler, method, path string, header http.Header) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, nil)
	for name, values := range header {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// healthOf fetches and decodes PathHealth, failing the test on any status but 200.
func healthOf(t *testing.T, handler *Handler) healthDocument {
	t.Helper()
	response := get(handler, http.MethodGet, PathHealth, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("health status = %d, want %d (body %s)", response.Code, http.StatusOK, response.Body)
	}
	var document healthDocument
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode health: %v", err)
	}
	return document
}

// sourceNamed returns one reported list, failing the test when it is absent. A
// missing list would otherwise make an assertion about it vacuous.
func sourceNamed(t *testing.T, document healthDocument, id string) healthSource {
	t.Helper()
	for _, source := range document.Sources {
		if source.ID == id {
			return source
		}
	}
	t.Fatalf("health reports no source %q", id)
	return healthSource{}
}

// leakedSecret stands in for THEGRAPH_API_KEY. It is a fabricated literal: these
// tests prove a real one could not reach a client, so they must not carry one.
const leakedSecret = "not-a-real-key-0123456789abcdef"

// leakedText is what a store error might quote: the gateway URL that carries the
// credential in its path, and a candidate label.
var leakedText = fmt.Sprintf(
	"get https://gateway.thegraph.com/api/%s/subgraphs/id/abc: reading zap.eth failed",
	leakedSecret,
)

// leakingStore fails every read with an error whose text holds a credential, an
// endpoint, and a candidate name. The API composes failure bodies from fixed
// literals rather than from upstream errors, and these tests prove it by asserting
// none of that text is in a response.
type leakingStore struct{}

func (leakingStore) GetLatest(ctx context.Context) (snapshot.Latest, error) {
	return snapshot.Latest{}, fmt.Errorf("%s", leakedText)
}

func (leakingStore) GetChunks(ctx context.Context, snapshotID string) ([]snapshot.Chunk, error) {
	return nil, fmt.Errorf("%s", leakedText)
}

// countingStore wraps a reader and counts the calls that reach it, so a test can
// prove the cache stops a second request from refetching a snapshot.
type countingStore struct {
	inner snapshot.Reader

	mutex       sync.Mutex
	latestCalls int
	chunksCalls int
	// pointerRewrite adjusts the pointer a read returns, so a test can present a
	// pointer the store itself would never hold.
	pointerRewrite func(snapshot.Latest) snapshot.Latest
}

func (s *countingStore) GetLatest(ctx context.Context) (snapshot.Latest, error) {
	s.mutex.Lock()
	s.latestCalls++
	rewrite := s.pointerRewrite
	s.mutex.Unlock()

	latest, err := s.inner.GetLatest(ctx)
	if err != nil || rewrite == nil {
		return latest, err
	}
	return rewrite(latest), nil
}

func (s *countingStore) GetChunks(ctx context.Context, snapshotID string) ([]snapshot.Chunk, error) {
	s.mutex.Lock()
	s.chunksCalls++
	s.mutex.Unlock()

	return s.inner.GetChunks(ctx, snapshotID)
}

func (s *countingStore) calls() (latest, chunks int) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.latestCalls, s.chunksCalls
}

// failingPointerStore reads normally until it is switched to failing every
// pointer read, so a test can present a store that goes unreachable after a
// snapshot has already been verified and cached.
//
// Chunk reads keep working. That is deliberate: a test using this store proves
// the refusal comes from the failed pointer read alone, and that the entry the
// handler kept is reused rather than refetched once the pointer reads again.
type failingPointerStore struct {
	inner snapshot.Reader

	mutex       sync.Mutex
	failing     bool
	chunksCalls int
}

func (s *failingPointerStore) setFailing(failing bool) {
	s.mutex.Lock()
	s.failing = failing
	s.mutex.Unlock()
}

func (s *failingPointerStore) chunkCalls() int {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.chunksCalls
}

func (s *failingPointerStore) GetLatest(ctx context.Context) (snapshot.Latest, error) {
	s.mutex.Lock()
	failing := s.failing
	s.mutex.Unlock()
	if failing {
		// A throttled table is the ordinary shape of this: the read failed and says
		// nothing at all about what is stored.
		return snapshot.Latest{}, fmt.Errorf("get latest pointer: throughput exceeded")
	}
	return s.inner.GetLatest(ctx)
}

func (s *failingPointerStore) GetChunks(ctx context.Context, snapshotID string) ([]snapshot.Chunk, error) {
	s.mutex.Lock()
	s.chunksCalls++
	s.mutex.Unlock()

	return s.inner.GetChunks(ctx, snapshotID)
}

// abandoningStore resolves the pointer normally and then loses the request: the
// chunk fetch cancels the request context and fails with an error that wraps
// snapshot.ErrNotFound, which is the one combination where the two possible
// readings of a failure disagree. Read as evidence about the store it says the
// chunks are gone; read as evidence about the request it says nothing at all.
//
// A cancelled context is never evidence about what is stored, so the second
// reading has to win. This fake proves it does: without that rule the response
// would claim a published snapshot had vanished because a client hung up.
type abandoningStore struct {
	inner  snapshot.Reader
	cancel context.CancelFunc
}

func (s abandoningStore) GetLatest(ctx context.Context) (snapshot.Latest, error) {
	return s.inner.GetLatest(ctx)
}

func (s abandoningStore) GetChunks(ctx context.Context, snapshotID string) ([]snapshot.Chunk, error) {
	s.cancel()
	return nil, fmt.Errorf("get chunks for %s: %w", snapshotID, snapshot.ErrNotFound)
}

// relabellingStore answers a chunk fetch with another snapshot's chunks
// relabelled to the requested ID, which is what a reader would see if a chunk
// partition were mixed across two publications. A chunk checksum covers only its
// payload bytes, so every relabelled chunk still checksums correctly on its own.
type relabellingStore struct {
	inner snapshot.Reader
	other string
}

func (s relabellingStore) GetLatest(ctx context.Context) (snapshot.Latest, error) {
	return s.inner.GetLatest(ctx)
}

func (s relabellingStore) GetChunks(ctx context.Context, snapshotID string) ([]snapshot.Chunk, error) {
	chunks, err := s.inner.GetChunks(ctx, s.other)
	if err != nil {
		return nil, err
	}
	relabelled := snapshot.CloneChunks(chunks)
	for i := range relabelled {
		relabelled[i].SnapshotID = snapshotID
	}
	return relabelled, nil
}
