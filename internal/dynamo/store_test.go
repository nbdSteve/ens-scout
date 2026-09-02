package dynamo

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"ens-scrape/internal/ens"
	"ens-scrape/internal/snapshot"
)

// fixedNow is the scan instant every fixture is classified at, so no test depends
// on the wall clock.
var fixedNow = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

const testSoon = 7 * 24 * time.Hour

// errInjected is the transport failure the tests inject. It is deliberately not an
// AWS error type: this package must not treat an arbitrary failure as anything but
// a failure.
var errInjected = errors.New("injected storage failure")

func testSources(names int) []snapshot.SourceList {
	return []snapshot.SourceList{{
		ID:      "test-list",
		Path:    "data/words/test.txt",
		Cadence: snapshot.CadenceThreeHourly,
		Names:   names,
	}}
}

// testSnapshot builds a small snapshot spanning several lifecycle statuses.
func testSnapshot(t *testing.T, id string, scannedAt time.Time, labels ...string) snapshot.Snapshot {
	t.Helper()
	results := make([]ens.Result, 0, len(labels))
	for i, label := range labels {
		lookup := ens.Lookup{Name: label + snapshot.NameSuffix}
		if i%3 != 0 {
			expiry := scannedAt.Add(time.Duration(200+i) * 24 * time.Hour)
			lookup.Found = true
			lookup.Expiry = &expiry
		}
		results = append(results, ens.Classify(lookup, scannedAt, testSoon))
	}
	built, err := snapshot.Build(id, scannedAt, testSources(len(results)), results)
	if err != nil {
		t.Fatalf("Build %s: %v", id, err)
	}
	return built
}

// largeSnapshot builds a snapshot whose compressed payload needs several chunks, so
// the batching, pagination, and per-chunk resume paths are exercised on real chunk
// boundaries rather than a hand-made single chunk.
func largeSnapshot(t *testing.T, id string, scannedAt time.Time) snapshot.Snapshot {
	t.Helper()
	const count = 40000
	random := rand.New(rand.NewSource(11))
	results := make([]ens.Result, 0, count)
	seen := make(map[string]struct{}, count)
	for len(results) < count {
		label := make([]byte, 8)
		for i := range label {
			label[i] = byte('a' + random.Intn(26))
		}
		name := string(label) + snapshot.NameSuffix
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}

		lookup := ens.Lookup{Name: name, Found: random.Intn(10) > 0}
		if lookup.Found && random.Intn(10) > 0 {
			expiry := scannedAt.Add(time.Duration(random.Intn(400*24*3600)-200*24*3600) * time.Second)
			lookup.Expiry = &expiry
		}
		results = append(results, ens.Classify(lookup, scannedAt, testSoon))
	}
	built, err := snapshot.Build(id, scannedAt, testSources(len(results)), results)
	if err != nil {
		t.Fatalf("Build %s: %v", id, err)
	}
	return built
}

// publish stores a snapshot and fails the test if publication does not succeed.
func publish(t *testing.T, store *Store, built snapshot.Snapshot, publishedAt time.Time) snapshot.Latest {
	t.Helper()
	latest, _, err := snapshot.Publish(context.Background(), store, built, publishedAt)
	if err != nil {
		t.Fatalf("Publish %s: %v", built.Metadata.SnapshotID, err)
	}
	return latest
}

// assertReadsSnapshot proves the store serves exactly one snapshot, by ID, through
// the same verified read path a client uses.
func assertReadsSnapshot(t *testing.T, store *Store, wantID string) {
	t.Helper()
	read, latest, err := snapshot.Read(context.Background(), store)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if latest.SnapshotID != wantID {
		t.Errorf("the pointer names snapshot %q, want %q", latest.SnapshotID, wantID)
	}
	if read.Metadata.SnapshotID != wantID {
		t.Errorf("the stored snapshot is %q, want %q", read.Metadata.SnapshotID, wantID)
	}
}

func TestNewRejectsIncompleteOptions(t *testing.T) {
	if _, err := New(nil, Options{Table: "t"}); err == nil {
		t.Errorf("New accepted a nil API")
	}
	if _, err := New(newFake("t"), Options{}); err == nil {
		t.Errorf("New accepted an empty table name")
	}
}

// TestPublishAndReadRoundTrip is the whole contract over this backend: a published
// snapshot reads back byte-identically through the verified path.
func TestPublishAndReadRoundTrip(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	built := testSnapshot(t, "scan-one", fixedNow, "zap", "orb", "helm", "amber")

	latest := publish(t, store, built, fixedNow)
	read, storedLatest, err := snapshot.Read(context.Background(), store)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if read.Metadata.SnapshotID != built.Metadata.SnapshotID || !read.Metadata.ScannedAt.Equal(built.Metadata.ScannedAt) {
		t.Errorf("read metadata %+v, want %+v", read.Metadata, built.Metadata)
	}
	if storedLatest.Checksum != latest.Checksum {
		t.Errorf("stored checksum %q differs from the published one %q", storedLatest.Checksum, latest.Checksum)
	}
	if len(read.Results) != len(built.Results) {
		t.Fatalf("read %d results, want %d", len(read.Results), len(built.Results))
	}
	for i := range built.Results {
		if read.Results[i].Name != built.Results[i].Name || read.Results[i].Status != built.Results[i].Status {
			t.Errorf("result %d is %+v, want %+v", i, read.Results[i], built.Results[i])
		}
	}

	// A single-chunk snapshot must occupy exactly the two documented keys.
	want := []string{
		"META LATEST",
		"SNAPSHOT#scan-one CHUNK#00000",
	}
	got := fake.keys()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("stored keys are %v, want %v", got, want)
	}
}

// TestPublishSpansManyChunks proves the batching and pagination paths agree with the
// chunking the contract produces.
func TestPublishSpansManyChunks(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	// One chunk per query page, so every extra chunk needs another round trip.
	fake.pageSize = 1
	built := largeSnapshot(t, "scan-large", fixedNow)

	latest := publish(t, store, built, fixedNow)
	if latest.ChunkCount < 3 {
		t.Fatalf("the fixture produced %d chunks, want at least 3", latest.ChunkCount)
	}
	stored, err := store.GetChunks(context.Background(), latest.SnapshotID)
	if err != nil {
		t.Fatalf("GetChunks: %v", err)
	}
	if len(stored) != latest.ChunkCount {
		t.Fatalf("read %d chunks, want %d", len(stored), latest.ChunkCount)
	}
	for i, chunk := range stored {
		if chunk.Index != i {
			t.Fatalf("chunk at position %d declares index %d, so pagination lost the order", i, chunk.Index)
		}
	}
	assertReadsSnapshot(t, store, "scan-large")
}

// TestPutChunksIsIdempotent covers the retry that re-writes a set already stored.
func TestPutChunksIsIdempotent(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	built := largeSnapshot(t, "scan-retry", fixedNow)
	payload, err := snapshot.Encode(built)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	if err := store.PutChunks(context.Background(), "scan-retry", payload.Chunks); err != nil {
		t.Fatalf("PutChunks: %v", err)
	}
	writes := fake.callCount("BatchWriteItem")
	written := fake.writtenKeys()

	if err := store.PutChunks(context.Background(), "scan-retry", snapshot.CloneChunks(payload.Chunks)); err != nil {
		t.Fatalf("PutChunks retry: %v", err)
	}
	if fake.callCount("BatchWriteItem") != writes {
		t.Errorf("a retry of an identical set issued %d batch writes, want %d",
			fake.callCount("BatchWriteItem")-writes, 0)
	}
	if len(fake.writtenKeys()) != len(written) {
		t.Errorf("a retry of an identical set wrote %d more items, want 0",
			len(fake.writtenKeys())-len(written))
	}
}

// TestPutChunksResumesAnInterruptedWrite is the per-chunk resume rule: the retry
// fills only the indices the interrupted write never stored, and rewrites none.
func TestPutChunksResumesAnInterruptedWrite(t *testing.T) {
	// Retries disabled, so the held-back chunk is lost rather than re-sent.
	store, fake, _ := newTestStore(t, Options{UnprocessedRetries: -1})
	built := largeSnapshot(t, "scan-resume", fixedNow)
	payload, err := snapshot.Encode(built)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if len(payload.Chunks) < 3 {
		t.Fatalf("the fixture produced %d chunks, want at least 3", len(payload.Chunks))
	}

	// The last chunk never lands.
	fake.onBatchWrite = func(call int, requests []types.WriteRequest) ([]types.WriteRequest, error) {
		return requests[len(requests)-1:], nil
	}
	if err := store.PutChunks(context.Background(), "scan-resume", payload.Chunks); err == nil {
		t.Fatalf("PutChunks reported success after abandoning a chunk")
	}

	stored, err := store.GetChunks(context.Background(), "scan-resume")
	if err != nil {
		t.Fatalf("GetChunks after the interrupted write: %v", err)
	}
	if len(stored) != len(payload.Chunks)-1 {
		t.Fatalf("the interrupted write stored %d chunks, want %d", len(stored), len(payload.Chunks)-1)
	}
	// An incomplete set must not be servable, whatever a pointer might claim.
	if _, err := snapshot.Assemble("scan-resume", stored); err == nil {
		t.Errorf("an incomplete chunk set assembled, so a partial snapshot is readable")
	}

	fake.onBatchWrite = nil
	before := len(fake.writtenKeys())
	if err := store.PutChunks(context.Background(), "scan-resume", snapshot.CloneChunks(payload.Chunks)); err != nil {
		t.Fatalf("PutChunks resume: %v", err)
	}
	resumed := fake.writtenKeys()[before:]
	wantKey := fmt.Sprintf("%s %s", snapshot.SnapshotPartition("scan-resume"), snapshot.ChunkSort(len(payload.Chunks)-1))
	if len(resumed) != 1 || resumed[0] != wantKey {
		t.Errorf("the resume wrote %v, want only %q", resumed, wantKey)
	}
	if _, err := snapshot.Verify(payload.Latest(fixedNow), mustGetChunks(t, store, "scan-resume")); err != nil {
		t.Errorf("the resumed set does not verify: %v", err)
	}
}

func mustGetChunks(t *testing.T, store *Store, snapshotID string) []snapshot.Chunk {
	t.Helper()
	chunks, err := store.GetChunks(context.Background(), snapshotID)
	if err != nil {
		t.Fatalf("GetChunks %s: %v", snapshotID, err)
	}
	return chunks
}

// TestPutChunksRefusesAConflictingPayload keeps a stored snapshot from being revised
// under its own ID.
func TestPutChunksRefusesAConflictingPayload(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	first := testSnapshot(t, "scan-conflict", fixedNow, "zap", "orb")
	publish(t, store, first, fixedNow)

	// A different scan that reuses the ID. Sharing an ID is what makes this a
	// conflict rather than a new snapshot.
	second := testSnapshot(t, "scan-conflict", fixedNow, "zap", "orb", "helm")
	payload, err := snapshot.Encode(second)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	writes := fake.callCount("BatchWriteItem")

	err = store.PutChunks(context.Background(), "scan-conflict", payload.Chunks)
	if !errors.Is(err, snapshot.ErrChunksImmutable) {
		t.Fatalf("PutChunks returned %v, want ErrChunksImmutable", err)
	}
	if fake.callCount("BatchWriteItem") != writes {
		t.Errorf("a refused write still issued %d batch writes", fake.callCount("BatchWriteItem")-writes)
	}
	assertReadsSnapshot(t, store, "scan-conflict")
	// The stored payload is still the first one.
	read, _, err := snapshot.Read(context.Background(), store)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(read.Results) != len(first.Results) {
		t.Errorf("the stored snapshot holds %d results, want the original %d", len(read.Results), len(first.Results))
	}
}

// TestPutChunksReturnsAReadFailureRatherThanOverwriting is why an unreadable set is
// not treated as an empty one: a throttled read must not authorize a write that
// replaces the snapshot the pointer names.
func TestPutChunksReturnsAReadFailureRatherThanOverwriting(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	first := testSnapshot(t, "scan-unreadable", fixedNow, "zap", "orb")
	publish(t, store, first, fixedNow)

	second := testSnapshot(t, "scan-unreadable", fixedNow, "zap", "orb", "helm")
	payload, err := snapshot.Encode(second)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	writes := fake.callCount("BatchWriteItem")
	fake.onQuery = func(call int) error { return errInjected }

	err = store.PutChunks(context.Background(), "scan-unreadable", payload.Chunks)
	if !errors.Is(err, errInjected) {
		t.Fatalf("PutChunks returned %v, want the injected read failure", err)
	}
	if fake.callCount("BatchWriteItem") != writes {
		t.Errorf("PutChunks wrote after failing to read the stored set")
	}
	fake.onQuery = nil
	assertReadsSnapshot(t, store, "scan-unreadable")
}

// TestPutChunksRetriesOnlyUnprocessedItems proves the one retried signal is the
// unprocessed set, and that only the shed items are re-sent.
func TestPutChunksRetriesOnlyUnprocessedItems(t *testing.T) {
	store, fake, slept := newTestStore(t, Options{})
	built := largeSnapshot(t, "scan-unprocessed", fixedNow)
	payload, err := snapshot.Encode(built)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	var batchSizes []int
	fake.onBatchWrite = func(call int, requests []types.WriteRequest) ([]types.WriteRequest, error) {
		batchSizes = append(batchSizes, len(requests))
		if call == 1 {
			return requests[len(requests)-1:], nil
		}
		return nil, nil
	}
	if err := store.PutChunks(context.Background(), "scan-unprocessed", payload.Chunks); err != nil {
		t.Fatalf("PutChunks: %v", err)
	}
	if len(batchSizes) != 2 {
		t.Fatalf("batch write was called %d times, want 2", len(batchSizes))
	}
	if batchSizes[0] != len(payload.Chunks) {
		t.Errorf("the first batch held %d items, want %d", batchSizes[0], len(payload.Chunks))
	}
	if batchSizes[1] != 1 {
		t.Errorf("the retry held %d items, want only the shed one", batchSizes[1])
	}
	if len(*slept) != 1 || (*slept)[0] != baseRetryDelay {
		t.Errorf("the retry backoff was %v, want one wait of %v", *slept, baseRetryDelay)
	}
	if _, err := snapshot.Verify(payload.Latest(fixedNow), mustGetChunks(t, store, "scan-unprocessed")); err != nil {
		t.Errorf("the completed set does not verify: %v", err)
	}
}

// TestPutChunksBoundsUnprocessedRetries keeps a table that never accepts a write
// from turning one publication into unbounded work.
func TestPutChunksBoundsUnprocessedRetries(t *testing.T) {
	const retries = 3
	store, fake, slept := newTestStore(t, Options{UnprocessedRetries: retries})
	built := testSnapshot(t, "scan-shed", fixedNow, "zap", "orb")
	payload, err := snapshot.Encode(built)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	fake.onBatchWrite = func(call int, requests []types.WriteRequest) ([]types.WriteRequest, error) {
		return requests, nil
	}

	err = store.PutChunks(context.Background(), "scan-shed", payload.Chunks)
	if err == nil {
		t.Fatalf("PutChunks reported success while every item was shed")
	}
	if !strings.Contains(err.Error(), "unprocessed") {
		t.Errorf("error is %v, want one naming the unprocessed items", err)
	}
	if got := fake.callCount("BatchWriteItem"); got != retries+1 {
		t.Errorf("batch write was attempted %d times, want %d", got, retries+1)
	}
	if len(*slept) != retries {
		t.Errorf("waited %d times, want %d", len(*slept), retries)
	}
	// The backoff grows and is capped, so a long retry run cannot stall a Lambda.
	for i, delay := range *slept {
		if delay > maxRetryDelay {
			t.Errorf("wait %d was %v, above the %v cap", i, delay, maxRetryDelay)
		}
	}
	if _, err := store.GetChunks(context.Background(), "scan-shed"); !errors.Is(err, snapshot.ErrNotFound) {
		t.Errorf("GetChunks returned %v, want ErrNotFound after every item was shed", err)
	}
}

// TestPutChunksDoesNotRetryAReturnedError separates the two failure kinds: a shed
// item is retried, a failed request is not.
func TestPutChunksDoesNotRetryAReturnedError(t *testing.T) {
	store, fake, slept := newTestStore(t, Options{})
	built := testSnapshot(t, "scan-error", fixedNow, "zap", "orb")
	payload, err := snapshot.Encode(built)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	fake.onBatchWrite = func(call int, requests []types.WriteRequest) ([]types.WriteRequest, error) {
		return nil, errInjected
	}

	if err := store.PutChunks(context.Background(), "scan-error", payload.Chunks); !errors.Is(err, errInjected) {
		t.Fatalf("PutChunks returned %v, want the injected failure", err)
	}
	if got := fake.callCount("BatchWriteItem"); got != 1 {
		t.Errorf("batch write was attempted %d times, want 1", got)
	}
	if len(*slept) != 0 {
		t.Errorf("waited %v before giving up on a returned error", *slept)
	}
}

// TestPutChunksRejectsAGrowingUnprocessedSet guards the retry loop against a
// response that would otherwise make it re-send more than it sent.
func TestPutChunksRejectsAGrowingUnprocessedSet(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	built := testSnapshot(t, "scan-growing", fixedNow, "zap", "orb")
	payload, err := snapshot.Encode(built)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	fake.onBatchWrite = func(call int, requests []types.WriteRequest) ([]types.WriteRequest, error) {
		return append(append([]types.WriteRequest(nil), requests...), requests...), nil
	}
	err = store.PutChunks(context.Background(), "scan-growing", payload.Chunks)
	if err == nil || !strings.Contains(err.Error(), "unprocessed items from a batch of") {
		t.Fatalf("PutChunks returned %v, want a refusal of the oversized unprocessed set", err)
	}
}

// TestPutChunksHonoursCancellation keeps a Lambda deadline from being ignored.
func TestPutChunksHonoursCancellation(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	built := testSnapshot(t, "scan-cancel", fixedNow, "zap", "orb")
	payload, err := snapshot.Encode(built)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := store.PutChunks(ctx, "scan-cancel", payload.Chunks); !errors.Is(err, context.Canceled) {
		t.Fatalf("PutChunks returned %v, want context.Canceled", err)
	}
	if fake.callCount("BatchWriteItem") != 0 || fake.callCount("Query") != 0 {
		t.Errorf("a cancelled PutChunks still called the API")
	}
}

// TestGetChunksFailsClosedOnAnUnaccountableItem covers the item-level checks that
// stop a mislabelled or unknown-version chunk from being assembled.
func TestGetChunksFailsClosedOnAnUnaccountableItem(t *testing.T) {
	tests := []struct {
		name    string
		corrupt func(item map[string]types.AttributeValue)
		wantIn  string
	}{
		{
			name:    "another snapshot's chunk",
			corrupt: func(item map[string]types.AttributeValue) { item[attrSnapshotID] = stringValue("scan-other") },
			wantIn:  "labelled snapshot",
		},
		{
			name:    "an unknown format version",
			corrupt: func(item map[string]types.AttributeValue) { item[attrFormatVersion] = numberValue(9999) },
			wantIn:  "format version",
		},
		{
			name:    "an index that disagrees with the sort key",
			corrupt: func(item map[string]types.AttributeValue) { item[attrChunkIndex] = numberValue(7) },
			wantIn:  "is keyed",
		},
		{
			name:    "a missing checksum",
			corrupt: func(item map[string]types.AttributeValue) { delete(item, attrChecksum) },
			wantIn:  "missing attribute",
		},
		{
			name:    "a payload stored as a string",
			corrupt: func(item map[string]types.AttributeValue) { item[attrPayload] = stringValue("not binary") },
			wantIn:  "not binary",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, fake, _ := newTestStore(t, Options{})
			built := testSnapshot(t, "scan-bad-item", fixedNow, "zap", "orb")
			publish(t, store, built, fixedNow)

			item := fake.stored(snapshot.SnapshotPartition("scan-bad-item"), snapshot.ChunkSort(0))
			if item == nil {
				t.Fatalf("the published chunk is missing")
			}
			test.corrupt(item)
			fake.put(item)

			_, err := store.GetChunks(context.Background(), "scan-bad-item")
			if err == nil {
				t.Fatalf("GetChunks accepted an item it cannot account for")
			}
			if !strings.Contains(err.Error(), test.wantIn) {
				t.Errorf("error is %v, want one mentioning %q", err, test.wantIn)
			}
		})
	}
}

func TestGetChunksReportsNotFound(t *testing.T) {
	store, _, _ := newTestStore(t, Options{})
	if _, err := store.GetChunks(context.Background(), "scan-absent"); !errors.Is(err, snapshot.ErrNotFound) {
		t.Errorf("GetChunks returned %v, want ErrNotFound", err)
	}
}

func TestGetLatestReportsNotFound(t *testing.T) {
	store, _, _ := newTestStore(t, Options{})
	if _, err := store.GetLatest(context.Background()); !errors.Is(err, snapshot.ErrNotFound) {
		t.Errorf("GetLatest returned %v, want ErrNotFound", err)
	}
}

// TestGetLatestRefusesAnUnusablePointer keeps the read path from guessing at a
// pointer it cannot validate.
func TestGetLatestRefusesAnUnusablePointer(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	built := testSnapshot(t, "scan-pointer", fixedNow, "zap", "orb")
	publish(t, store, built, fixedNow)

	item := fake.stored(snapshot.LatestPartition, snapshot.LatestSort)
	item[attrPointer] = stringValue("{not json")
	fake.put(item)

	if _, err := store.GetLatest(context.Background()); err == nil {
		t.Fatalf("GetLatest accepted a pointer it could not parse")
	} else if errors.Is(err, snapshot.ErrNotFound) {
		t.Errorf("GetLatest reported ErrNotFound for a corrupt pointer, which hides it")
	}
	if _, _, err := snapshot.Read(context.Background(), store); err == nil {
		t.Errorf("Read served a snapshot through a corrupt pointer")
	}
}

// TestPutLatestKeepsThePointerMonotonic covers the ordering rule end to end over
// this backend, including the retry that must be accepted.
func TestPutLatestKeepsThePointerMonotonic(t *testing.T) {
	store, _, _ := newTestStore(t, Options{})
	first := testSnapshot(t, "scan-t1", fixedNow, "zap", "orb")
	published := publish(t, store, first, fixedNow)

	// An older scan is refused.
	older := testSnapshot(t, "scan-t0", fixedNow.Add(-time.Hour), "zap", "orb")
	if _, _, err := snapshot.Publish(context.Background(), store, older, fixedNow); !errors.Is(err, snapshot.ErrPointerConflict) {
		t.Errorf("publishing an older scan returned %v, want ErrPointerConflict", err)
	}
	assertReadsSnapshot(t, store, "scan-t1")

	// The same scan published again is a no-op, and leaves the recorded write time
	// as the first attempt set it.
	retry := publish(t, store, first, fixedNow.Add(time.Minute))
	if !retry.PublishedAt.Equal(fixedNow.Add(time.Minute)) {
		t.Errorf("the retry reported PublishedAt %v, want the time it was called with", retry.PublishedAt)
	}
	stored, err := store.GetLatest(context.Background())
	if err != nil {
		t.Fatalf("GetLatest: %v", err)
	}
	if !stored.PublishedAt.Equal(published.PublishedAt) {
		t.Errorf("the retry moved PublishedAt to %v, want the original %v", stored.PublishedAt, published.PublishedAt)
	}

	// A retry superseded nothing: the snapshot that was already serving still is, so
	// nothing may be given a retention window on its behalf.
	if _, retryReplaced, err := snapshot.Publish(context.Background(), store, first, fixedNow.Add(2*time.Minute)); err != nil {
		t.Fatalf("Publish the same scan again: %v", err)
	} else if retryReplaced.Previous != nil || retryReplaced.Unusable {
		t.Errorf("an accepted retry reported replacing %+v, want nothing", retryReplaced)
	}

	// A different snapshot at the same scan time is a real conflict.
	overlap := testSnapshot(t, "scan-t1-other", fixedNow, "zap", "orb", "helm")
	if _, _, err := snapshot.Publish(context.Background(), store, overlap, fixedNow); !errors.Is(err, snapshot.ErrPointerConflict) {
		t.Errorf("publishing a different snapshot at the same scan time returned %v, want ErrPointerConflict", err)
	}
	assertReadsSnapshot(t, store, "scan-t1")

	// A newer scan moves the pointer, and reports the pointer it moved off.
	newer := testSnapshot(t, "scan-t2", fixedNow.Add(3*time.Hour), "zap", "orb", "helm")
	_, replaced, err := snapshot.Publish(context.Background(), store, newer, fixedNow.Add(3*time.Hour))
	if err != nil {
		t.Fatalf("Publish a newer scan: %v", err)
	}
	assertReadsSnapshot(t, store, "scan-t2")
	if replaced.Previous == nil || replaced.Previous.SnapshotID != "scan-t1" {
		t.Errorf("Publish reported replacing %+v, want snapshot scan-t1", replaced)
	}
}

// TestPutLatestRePlansAfterLosingTheRace proves the pointer is a compare-and-swap
// and not a read followed by a blind write: a publisher whose read went stale
// re-reads and submits its scan to the ordering rule again.
func TestPutLatestRePlansAfterLosingTheRace(t *testing.T) {
	t.Run("wins on the second attempt", func(t *testing.T) {
		store, fake, _ := newTestStore(t, Options{})
		competitor := testSnapshot(t, "scan-competitor", fixedNow.Add(time.Hour), "zap")
		mine := testSnapshot(t, "scan-mine", fixedNow.Add(2*time.Hour), "zap", "orb")

		// The competitor's chunks and pointer land between my read and my write.
		installed := false
		fake.onPutItem = func(call int, item map[string]types.AttributeValue) error {
			if installed {
				return nil
			}
			installed = true
			competitorItem, err := latestItem(mustEncode(t, competitor).Latest(fixedNow))
			if err != nil {
				return err
			}
			fake.putUnlocked(competitorItem)
			return nil
		}
		_, replaced, err := snapshot.Publish(context.Background(), store, mine, fixedNow.Add(2*time.Hour))
		if err != nil {
			t.Fatalf("Publish: %v", err)
		}
		if got := fake.callCount("PutItem"); got != 2 {
			t.Errorf("PutItem was called %d times, want 2: one lost race and one win", got)
		}
		stored, err := store.GetLatest(context.Background())
		if err != nil {
			t.Fatalf("GetLatest: %v", err)
		}
		if stored.SnapshotID != "scan-mine" {
			t.Errorf("the pointer names %q, want the newer scan %q", stored.SnapshotID, "scan-mine")
		}
		// The first attempt read an empty store and the second read the competitor,
		// so the competitor is what this publication superseded. A publisher that was
		// told about the read that lost would put its retention window on the wrong
		// snapshot and leave the competitor's chunks with none at all.
		if replaced.Previous == nil {
			t.Fatalf("Publish reported replacing nothing, want the competitor it overwrote")
		}
		if replaced.Previous.SnapshotID != "scan-competitor" {
			t.Errorf("Publish reports it replaced %q, want %q",
				replaced.Previous.SnapshotID, "scan-competitor")
		}
	})

	t.Run("yields to a newer scan", func(t *testing.T) {
		store, fake, _ := newTestStore(t, Options{})
		mine := testSnapshot(t, "scan-mine", fixedNow.Add(time.Hour), "zap", "orb")
		winner := testSnapshot(t, "scan-winner", fixedNow.Add(2*time.Hour), "zap")
		winnerLatest := mustEncode(t, winner).Latest(fixedNow)

		installed := false
		fake.onPutItem = func(call int, item map[string]types.AttributeValue) error {
			if installed {
				return nil
			}
			installed = true
			winnerItem, err := latestItem(winnerLatest)
			if err != nil {
				return err
			}
			fake.putUnlocked(winnerItem)
			return nil
		}
		_, _, err := snapshot.Publish(context.Background(), store, mine, fixedNow.Add(time.Hour))
		if !errors.Is(err, snapshot.ErrPointerConflict) {
			t.Fatalf("Publish returned %v, want ErrPointerConflict", err)
		}
		stored, err := store.GetLatest(context.Background())
		if err != nil {
			t.Fatalf("GetLatest: %v", err)
		}
		if stored.SnapshotID != "scan-winner" {
			t.Errorf("the pointer names %q, want the winner %q", stored.SnapshotID, "scan-winner")
		}
	})
}

func mustEncode(t *testing.T, built snapshot.Snapshot) snapshot.Payload {
	t.Helper()
	payload, err := snapshot.Encode(built)
	if err != nil {
		t.Fatalf("Encode %s: %v", built.Metadata.SnapshotID, err)
	}
	return payload
}

// TestPutLatestBoundsTheCompareAndSwapLoop keeps a publisher that keeps losing from
// spinning inside a Lambda.
func TestPutLatestBoundsTheCompareAndSwapLoop(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	mine := testSnapshot(t, "scan-mine", fixedNow.Add(time.Hour), "zap", "orb")
	minePayload := mustEncode(t, mine)

	// A fresh competitor lands between every read and its write. Each one is older
	// than my scan, so the ordering rule keeps saying to write and the only thing
	// stopping the write is the compare-and-swap, which is what has to be bounded.
	attempt := 0
	fake.onPutItem = func(call int, item map[string]types.AttributeValue) error {
		attempt++
		competitor := testSnapshot(t, fmt.Sprintf("scan-rival-%d", attempt), fixedNow, "zap")
		competitorItem, err := latestItem(mustEncode(t, competitor).Latest(fixedNow))
		if err != nil {
			return err
		}
		fake.putUnlocked(competitorItem)
		return nil
	}
	_, err := store.PutLatest(context.Background(), minePayload.Latest(fixedNow))
	if !errors.Is(err, snapshot.ErrPointerConflict) {
		t.Fatalf("PutLatest returned %v, want ErrPointerConflict", err)
	}
	if attempt != maxPointerAttempts {
		t.Errorf("PutLatest attempted %d writes, want the %d attempt bound", attempt, maxPointerAttempts)
	}
}

// TestPutLatestQuarantinesAnUnusablePointer proves an unreadable pointer is
// preserved rather than destroyed, and that reads never see the preserved copy.
func TestPutLatestQuarantinesAnUnusablePointer(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	first := testSnapshot(t, "scan-first", fixedNow, "zap", "orb")
	publish(t, store, first, fixedNow)

	corrupt := fake.stored(snapshot.LatestPartition, snapshot.LatestSort)
	corrupt[attrPointer] = stringValue(`{"format_version":1,"snapshot_id":""}`)
	fake.put(corrupt)

	newer := testSnapshot(t, "scan-second", fixedNow.Add(3*time.Hour), "zap", "orb", "helm")
	_, replaced, err := snapshot.Publish(context.Background(), store, newer, fixedNow.Add(3*time.Hour))
	if err != nil {
		t.Fatalf("Publish over an unusable pointer: %v", err)
	}
	assertReadsSnapshot(t, store, "scan-second")

	// The publication replaced a real chunk set it cannot name. Reporting nothing
	// would read as an empty store, and reporting the snapshot ID out of a pointer
	// that failed validation would aim a retention window on that pointer's word.
	if !replaced.Unusable {
		t.Errorf("replacing an unusable pointer reported %+v, want an unusable replacement", replaced)
	}
	if replaced.Previous != nil {
		t.Errorf("Publish named snapshot %q from a pointer that failed validation",
			replaced.Previous.SnapshotID)
	}

	preserved := fake.stored(snapshot.LatestPartition, quarantineSort(0))
	if preserved == nil {
		t.Fatalf("the unusable pointer was replaced without being preserved")
	}
	document, err := stringAttribute(preserved, attrPointer)
	if err != nil {
		t.Fatalf("the preserved item has no pointer document: %v", err)
	}
	if document != `{"format_version":1,"snapshot_id":""}` {
		t.Errorf("the preserved document is %q, want the corrupt one verbatim", document)
	}

	// A second unusable pointer accumulates rather than erasing the first.
	corrupt = fake.stored(snapshot.LatestPartition, snapshot.LatestSort)
	corrupt[attrPointer] = stringValue("{also not a pointer")
	fake.put(corrupt)
	third := testSnapshot(t, "scan-third", fixedNow.Add(6*time.Hour), "zap")
	publish(t, store, third, fixedNow.Add(6*time.Hour))
	if fake.stored(snapshot.LatestPartition, quarantineSort(1)) == nil {
		t.Errorf("the second unusable pointer overwrote the first quarantine slot")
	}
	assertReadsSnapshot(t, store, "scan-third")
}

// TestPutLatestReplacesAWronglyTypedPointer covers the unusable pointer that is not
// merely unparseable: the document is present with the wrong attribute type. A guard
// on that attribute's absence is a precondition the item that was read already
// contradicts, so every attempt would fail its condition, each one would burn a
// quarantine key, and publication would never recover from the very state the
// quarantine path exists to escape from.
func TestPutLatestReplacesAWronglyTypedPointer(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	first := testSnapshot(t, "scan-first", fixedNow, "zap", "orb")
	publish(t, store, first, fixedNow)

	// A hand-edited table, a foreign writer, or a half-applied migration leaves the
	// document stored as a number rather than as a string.
	corrupt := fake.stored(snapshot.LatestPartition, snapshot.LatestSort)
	corrupt[attrPointer] = numberValue(7)
	fake.put(corrupt)
	if _, err := store.GetLatest(context.Background()); err == nil {
		t.Fatalf("GetLatest accepted a pointer whose document is not a string")
	}

	newer := testSnapshot(t, "scan-second", fixedNow.Add(3*time.Hour), "zap", "orb", "helm")
	_, replaced, err := snapshot.Publish(context.Background(), store, newer, fixedNow.Add(3*time.Hour))
	if err != nil {
		t.Fatalf("Publish over a wrongly typed pointer: %v", err)
	}
	assertReadsSnapshot(t, store, "scan-second")
	if !replaced.Unusable || replaced.Previous != nil {
		t.Errorf("replacing a wrongly typed pointer reported %+v, want an unusable replacement", replaced)
	}

	// The evidence is still preserved where no read addresses it, and one unusable
	// pointer costs exactly one quarantine key rather than one per attempt.
	preserved := fake.stored(snapshot.LatestPartition, quarantineSort(0))
	if preserved == nil {
		t.Fatalf("the wrongly typed pointer was replaced without being preserved")
	}
	if _, ok := preserved[attrPointer].(*types.AttributeValueMemberN); !ok {
		t.Errorf("the preserved item holds %T, want the stored number verbatim", preserved[attrPointer])
	}
	if fake.stored(snapshot.LatestPartition, quarantineSort(1)) != nil {
		t.Errorf("a second quarantine key was burned on one unusable pointer")
	}
}

// TestPutLatestStillDetectsARaceOverAWronglyTypedPointer keeps the relaxed guard a
// compare-and-swap. It has to hold for the item that was read, and it still has to
// refuse the write once another publisher has replaced that item.
func TestPutLatestStillDetectsARaceOverAWronglyTypedPointer(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	first := testSnapshot(t, "scan-first", fixedNow, "zap", "orb")
	publish(t, store, first, fixedNow)

	corrupt := fake.stored(snapshot.LatestPartition, snapshot.LatestSort)
	corrupt[attrPointer] = numberValue(7)
	fake.put(corrupt)

	// A competitor publishes a newer scan between my read and my guarded write.
	winner := testSnapshot(t, "scan-winner", fixedNow.Add(6*time.Hour), "zap")
	winnerLatest := mustEncode(t, winner).Latest(fixedNow.Add(6 * time.Hour))
	installed := false
	fake.onPutItem = func(call int, item map[string]types.AttributeValue) error {
		sort, err := stringAttribute(item, attrSort)
		if err != nil {
			return err
		}
		if installed || strings.HasPrefix(sort, quarantineSortPrefix) {
			return nil
		}
		installed = true
		winnerItem, err := latestItem(winnerLatest)
		if err != nil {
			return err
		}
		fake.putUnlocked(winnerItem)
		return nil
	}

	mine := testSnapshot(t, "scan-mine", fixedNow.Add(3*time.Hour), "zap", "orb", "helm")
	_, _, err := snapshot.Publish(context.Background(), store, mine, fixedNow.Add(3*time.Hour))
	if !errors.Is(err, snapshot.ErrPointerConflict) {
		t.Fatalf("Publish returned %v, want ErrPointerConflict: the guard did not see the competitor", err)
	}
	stored, err := store.GetLatest(context.Background())
	if err != nil {
		t.Fatalf("GetLatest: %v", err)
	}
	if stored.SnapshotID != "scan-winner" {
		t.Errorf("the pointer names %q, want the competitor's %q", stored.SnapshotID, "scan-winner")
	}
}

// TestPutLatestFailsRatherThanDestroyEvidence is the other half of the quarantine
// rule: if the evidence cannot be preserved, the publication fails and the unusable
// pointer stays exactly where an operator will find it.
func TestPutLatestFailsRatherThanDestroyEvidence(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	first := testSnapshot(t, "scan-first", fixedNow, "zap", "orb")
	publish(t, store, first, fixedNow)

	corrupt := fake.stored(snapshot.LatestPartition, snapshot.LatestSort)
	corrupt[attrPointer] = stringValue("{not a pointer")
	fake.put(corrupt)

	fake.onPutItem = func(call int, item map[string]types.AttributeValue) error {
		sort, err := stringAttribute(item, attrSort)
		if err != nil {
			return err
		}
		if strings.HasPrefix(sort, quarantineSortPrefix) {
			return errInjected
		}
		return nil
	}
	newer := testSnapshot(t, "scan-second", fixedNow.Add(3*time.Hour), "zap", "orb", "helm")
	_, _, err := snapshot.Publish(context.Background(), store, newer, fixedNow.Add(3*time.Hour))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Publish returned %v, want the injected quarantine failure", err)
	}
	stored, err := stringAttribute(fake.stored(snapshot.LatestPartition, snapshot.LatestSort), attrPointer)
	if err != nil {
		t.Fatalf("the pointer item lost its document: %v", err)
	}
	if stored != "{not a pointer" {
		t.Errorf("the pointer document is now %q, want the unusable one left in place", stored)
	}
}

// TestPublicationBecomesVisibleOnlyWithACompleteChunkSet is the atomicity promise:
// until every chunk is stored and verified, there is nothing for a reader to see.
func TestPublicationBecomesVisibleOnlyWithACompleteChunkSet(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{UnprocessedRetries: -1})
	built := largeSnapshot(t, "scan-atomic", fixedNow)

	fake.onBatchWrite = func(call int, requests []types.WriteRequest) ([]types.WriteRequest, error) {
		return requests[len(requests)-1:], nil
	}
	if _, _, err := snapshot.Publish(context.Background(), store, built, fixedNow); err == nil {
		t.Fatalf("Publish succeeded without storing every chunk")
	}
	if _, err := store.GetLatest(context.Background()); !errors.Is(err, snapshot.ErrNotFound) {
		t.Errorf("GetLatest returned %v, want ErrNotFound while the chunk set is incomplete", err)
	}
	if _, _, err := snapshot.Read(context.Background(), store); !errors.Is(err, snapshot.ErrNotFound) {
		t.Errorf("Read returned %v, want ErrNotFound while the chunk set is incomplete", err)
	}

	fake.onBatchWrite = nil
	publish(t, store, built, fixedNow)
	assertReadsSnapshot(t, store, "scan-atomic")
}

// TestEveryInjectedFailureLeavesThePreviousSnapshotServing is the headline
// invariant of the publisher: whatever goes wrong, the pointer still names a
// snapshot whose complete, checksum-verified chunk set is present.
func TestEveryInjectedFailureLeavesThePreviousSnapshotServing(t *testing.T) {
	tests := []struct {
		name   string
		inject func(t *testing.T, fake *fakeDynamo, ctx context.Context) (context.Context, func())
	}{
		{
			name: "the chunk write fails",
			inject: func(t *testing.T, fake *fakeDynamo, ctx context.Context) (context.Context, func()) {
				fake.onBatchWrite = func(int, []types.WriteRequest) ([]types.WriteRequest, error) {
					return nil, errInjected
				}
				return ctx, func() { fake.onBatchWrite = nil }
			},
		},
		{
			name: "every chunk write is shed",
			inject: func(t *testing.T, fake *fakeDynamo, ctx context.Context) (context.Context, func()) {
				fake.onBatchWrite = func(call int, requests []types.WriteRequest) ([]types.WriteRequest, error) {
					return requests, nil
				}
				return ctx, func() { fake.onBatchWrite = nil }
			},
		},
		{
			name: "the readback fails",
			inject: func(t *testing.T, fake *fakeDynamo, ctx context.Context) (context.Context, func()) {
				// A publication reads the stored set before writing and reads it
				// back afterwards, so the second query from here is the readback.
				readback := fake.callCount("Query") + 2
				fake.onQuery = func(call int) error {
					if call == readback {
						return errInjected
					}
					return nil
				}
				return ctx, func() { fake.onQuery = nil }
			},
		},
		{
			name: "the readback returns a corrupt chunk",
			inject: func(t *testing.T, fake *fakeDynamo, ctx context.Context) (context.Context, func()) {
				// Storage returns a chunk that no longer matches its checksum,
				// which is the failure a readback exists to catch.
				readback := fake.callCount("Query") + 2
				fake.onQuery = func(call int) error {
					if call == readback {
						fake.corruptChunkUnlocked(snapshot.SnapshotPartition("scan-second"), snapshot.ChunkSort(0))
					}
					return nil
				}
				return ctx, func() { fake.onQuery = nil }
			},
		},
		{
			name: "the pointer write fails",
			inject: func(t *testing.T, fake *fakeDynamo, ctx context.Context) (context.Context, func()) {
				fake.onPutItem = func(int, map[string]types.AttributeValue) error { return errInjected }
				return ctx, func() { fake.onPutItem = nil }
			},
		},
		{
			name: "the pointer read fails",
			inject: func(t *testing.T, fake *fakeDynamo, ctx context.Context) (context.Context, func()) {
				fake.onGetItem = func(int) error { return errInjected }
				return ctx, func() { fake.onGetItem = nil }
			},
		},
		{
			name: "the context is cancelled",
			inject: func(t *testing.T, fake *fakeDynamo, ctx context.Context) (context.Context, func()) {
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				return cancelled, func() {}
			},
		},
		{
			name: "the deadline has passed",
			inject: func(t *testing.T, fake *fakeDynamo, ctx context.Context) (context.Context, func()) {
				expired, cancel := context.WithDeadline(ctx, time.Now().Add(-time.Second))
				return expired, cancel
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, fake, _ := newTestStore(t, Options{UnprocessedRetries: 1})
			previous := testSnapshot(t, "scan-first", fixedNow, "zap", "orb", "helm")
			publish(t, store, previous, fixedNow)
			previousKeys := fake.keys()

			next := testSnapshot(t, "scan-second", fixedNow.Add(3*time.Hour), "zap", "orb", "helm", "amber")
			ctx, restore := test.inject(t, fake, context.Background())
			if _, _, err := snapshot.Publish(ctx, store, next, fixedNow.Add(3*time.Hour)); err == nil {
				t.Fatalf("Publish succeeded despite the injected failure")
			}
			restore()

			// The previous snapshot is still what a reader gets, and it still
			// verifies, so the failure did not damage what was already published.
			assertReadsSnapshot(t, store, "scan-first")
			for _, key := range previousKeys {
				if !containsKey(fake.keys(), key) {
					t.Errorf("the failed publication removed %q", key)
				}
			}
		})
	}
}

func containsKey(keys []string, want string) bool {
	for _, key := range keys {
		if key == want {
			return true
		}
	}
	return false
}

// TestConcurrentPublishersLeaveOneCoherentSnapshot covers overlapping schedule runs:
// whichever publisher wins, exactly one pointer survives, it names the newest scan
// that got through, and its chunk set verifies.
func TestConcurrentPublishersLeaveOneCoherentSnapshot(t *testing.T) {
	store, _, _ := newTestStore(t, Options{})
	scans := []snapshot.Snapshot{
		testSnapshot(t, "scan-a", fixedNow, "zap", "orb"),
		testSnapshot(t, "scan-b", fixedNow.Add(time.Hour), "zap", "orb", "helm"),
		testSnapshot(t, "scan-c", fixedNow.Add(2*time.Hour), "zap", "orb", "helm", "amber"),
	}

	var wait sync.WaitGroup
	errs := make([]error, len(scans))
	for i := range scans {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			_, _, errs[i] = snapshot.Publish(context.Background(), store, scans[i], scans[i].Metadata.ScannedAt)
		}(i)
	}
	wait.Wait()

	for i, err := range errs {
		if err != nil && !errors.Is(err, snapshot.ErrPointerConflict) {
			t.Errorf("publishing %s failed with %v, want success or ErrPointerConflict",
				scans[i].Metadata.SnapshotID, err)
		}
	}
	// The newest scan always wins: it is either written last or it refuses to be
	// replaced by anything older.
	assertReadsSnapshot(t, store, "scan-c")
}

// TestExpireChunksAppliesTheTTLToASupersededSnapshot covers the recovery window.
func TestExpireChunksAppliesTheTTLToASupersededSnapshot(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	first := testSnapshot(t, "scan-first", fixedNow, "zap", "orb")
	firstLatest := publish(t, store, first, fixedNow)
	second := testSnapshot(t, "scan-second", fixedNow.Add(3*time.Hour), "zap", "orb", "helm")
	publish(t, store, second, fixedNow.Add(3*time.Hour))

	// The window a superseded snapshot survives is how long it could still have
	// been served as fresh, which the pointer already publishes.
	expiresAt := fixedNow.Add(time.Duration(firstLatest.ScanAge.StaleAfterSeconds) * time.Second)
	if err := store.ExpireChunks(context.Background(), "scan-first", expiresAt); err != nil {
		t.Fatalf("ExpireChunks: %v", err)
	}

	item := fake.stored(snapshot.SnapshotPartition("scan-first"), snapshot.ChunkSort(0))
	ttl, err := numberAttribute(item, attrExpiresAt)
	if err != nil {
		t.Fatalf("the superseded chunk has no TTL: %v", err)
	}
	if ttl != expiresAt.Unix() {
		t.Errorf("the TTL is %d, want %d", ttl, expiresAt.Unix())
	}

	// The live snapshot keeps no TTL, and stays readable.
	live := fake.stored(snapshot.SnapshotPartition("scan-second"), snapshot.ChunkSort(0))
	if _, exists := live[attrExpiresAt]; exists {
		t.Errorf("the live snapshot's chunk carries a TTL")
	}
	assertReadsSnapshot(t, store, "scan-second")

	// Until DynamoDB reclaims them, the superseded chunks are still readable, which
	// is what makes the window a recovery window rather than a deletion.
	if _, err := store.GetChunks(context.Background(), "scan-first"); err != nil {
		t.Errorf("the superseded chunks became unreadable as soon as they were expired: %v", err)
	}
}

// TestExpireChunksRefusesWithoutProofTheSnapshotIsSuperseded is the guard that keeps
// a TTL from emptying the table under readers.
func TestExpireChunksRefusesWithoutProofTheSnapshotIsSuperseded(t *testing.T) {
	expiry := fixedNow.Add(48 * time.Hour)

	t.Run("the pointer still names it", func(t *testing.T) {
		store, fake, _ := newTestStore(t, Options{})
		built := testSnapshot(t, "scan-live", fixedNow, "zap", "orb")
		publish(t, store, built, fixedNow)

		err := store.ExpireChunks(context.Background(), "scan-live", expiry)
		if err == nil || !strings.Contains(err.Error(), "still names it") {
			t.Fatalf("ExpireChunks returned %v, want a refusal to expire the live snapshot", err)
		}
		item := fake.stored(snapshot.SnapshotPartition("scan-live"), snapshot.ChunkSort(0))
		if _, exists := item[attrExpiresAt]; exists {
			t.Errorf("the live snapshot's chunk was given a TTL anyway")
		}
		assertReadsSnapshot(t, store, "scan-live")
	})

	// An absent pointer is the one case that is not a lack of proof. Nothing is
	// published, so no reader can be resolving any snapshot, and a chunk set
	// abandoned before the first successful publication has to stay reclaimable or a
	// bootstrap that keeps failing grows the table on every attempt.
	t.Run("there is no pointer at all", func(t *testing.T) {
		store, fake, _ := newTestStore(t, Options{})
		built := testSnapshot(t, "scan-orphan", fixedNow, "zap", "orb")
		payload := mustEncode(t, built)
		if err := store.PutChunks(context.Background(), "scan-orphan", payload.Chunks); err != nil {
			t.Fatalf("PutChunks: %v", err)
		}
		if err := store.ExpireChunks(context.Background(), "scan-orphan", expiry); err != nil {
			t.Fatalf("ExpireChunks returned %v, want an expiry with nothing published", err)
		}
		item := fake.stored(snapshot.SnapshotPartition("scan-orphan"), snapshot.ChunkSort(0))
		ttl, err := numberAttribute(item, attrExpiresAt)
		if err != nil {
			t.Fatalf("the abandoned chunk has no TTL: %v", err)
		}
		if ttl != expiry.Unix() {
			t.Errorf("the TTL is %d, want %d", ttl, expiry.Unix())
		}
	})

	t.Run("the pointer is unusable", func(t *testing.T) {
		store, fake, _ := newTestStore(t, Options{})
		first := testSnapshot(t, "scan-first", fixedNow, "zap", "orb")
		publish(t, store, first, fixedNow)
		second := testSnapshot(t, "scan-second", fixedNow.Add(3*time.Hour), "zap", "orb", "helm")
		publish(t, store, second, fixedNow.Add(3*time.Hour))

		corrupt := fake.stored(snapshot.LatestPartition, snapshot.LatestSort)
		corrupt[attrPointer] = stringValue("{not a pointer")
		fake.put(corrupt)

		if err := store.ExpireChunks(context.Background(), "scan-first", expiry); err == nil {
			t.Fatalf("ExpireChunks expired a snapshot without a usable pointer to judge it against")
		}
		item := fake.stored(snapshot.SnapshotPartition("scan-first"), snapshot.ChunkSort(0))
		if _, exists := item[attrExpiresAt]; exists {
			t.Errorf("a chunk was given a TTL on the strength of an unreadable pointer")
		}
	})

	t.Run("the snapshot has no chunks", func(t *testing.T) {
		store, _, _ := newTestStore(t, Options{})
		built := testSnapshot(t, "scan-live", fixedNow, "zap", "orb")
		publish(t, store, built, fixedNow)
		if err := store.ExpireChunks(context.Background(), "scan-gone", expiry); !errors.Is(err, snapshot.ErrNotFound) {
			t.Errorf("ExpireChunks returned %v, want ErrNotFound for a snapshot with no chunks", err)
		}
	})

	t.Run("no expiry time was given", func(t *testing.T) {
		store, _, _ := newTestStore(t, Options{})
		built := testSnapshot(t, "scan-live", fixedNow, "zap", "orb")
		publish(t, store, built, fixedNow)
		if err := store.ExpireChunks(context.Background(), "scan-other", time.Time{}); err == nil {
			t.Errorf("ExpireChunks accepted a zero expiry time")
		}
	})
}

// TestDeleteChunksRemovesOnlyTheNamedSnapshot covers the immediate cleanup path.
func TestDeleteChunksRemovesOnlyTheNamedSnapshot(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	first := largeSnapshot(t, "scan-first", fixedNow)
	publish(t, store, first, fixedNow)
	second := testSnapshot(t, "scan-second", fixedNow.Add(3*time.Hour), "zap", "orb")
	publish(t, store, second, fixedNow.Add(3*time.Hour))

	if err := store.DeleteChunks(context.Background(), "scan-first"); err != nil {
		t.Fatalf("DeleteChunks: %v", err)
	}
	if _, err := store.GetChunks(context.Background(), "scan-first"); !errors.Is(err, snapshot.ErrNotFound) {
		t.Errorf("GetChunks returned %v after the chunks were deleted, want ErrNotFound", err)
	}
	assertReadsSnapshot(t, store, "scan-second")

	// Deleting a snapshot that has no chunks is a no-op, so cleanup is retryable.
	if err := store.DeleteChunks(context.Background(), "scan-first"); err != nil {
		t.Errorf("a repeated DeleteChunks failed: %v", err)
	}
	if fake.stored(snapshot.LatestPartition, snapshot.LatestSort) == nil {
		t.Errorf("DeleteChunks removed the latest pointer")
	}
}

// TestStagingRegistryTracksUnpublishedSnapshots covers the registry a publisher
// uses so a chunk set it abandons stays findable: chunks live in their own
// partition and only the pointer names one, so without a marker an abandoned set is
// unreachable.
func TestStagingRegistryTracksUnpublishedSnapshots(t *testing.T) {
	store, fake, _ := newTestStore(t, Options{})
	ctx := context.Background()
	expires := fixedNow.Add(30 * 24 * time.Hour)

	if staged, err := store.StagedSnapshots(ctx); err != nil || len(staged) != 0 {
		t.Fatalf("StagedSnapshots on an empty table returned %v, %v", staged, err)
	}

	if err := store.StageSnapshot(ctx, "scan-second", fixedNow.Add(time.Hour), expires); err != nil {
		t.Fatalf("StageSnapshot: %v", err)
	}
	if err := store.StageSnapshot(ctx, "scan-first", fixedNow, expires); err != nil {
		t.Fatalf("StageSnapshot: %v", err)
	}

	staged, err := store.StagedSnapshots(ctx)
	if err != nil {
		t.Fatalf("StagedSnapshots: %v", err)
	}
	want := []snapshot.StagedSnapshot{
		{SnapshotID: "scan-first", StagedAt: fixedNow},
		{SnapshotID: "scan-second", StagedAt: fixedNow.Add(time.Hour)},
	}
	if len(staged) != len(want) {
		t.Fatalf("StagedSnapshots returned %v, want %v", staged, want)
	}
	for i, entry := range staged {
		if entry.SnapshotID != want[i].SnapshotID || !entry.StagedAt.Equal(want[i].StagedAt) {
			t.Errorf("marker %d is %+v, want %+v", i, entry, want[i])
		}
	}

	// A marker carries its own TTL from the moment it is written, so a marker whose
	// chunks are already reclaimed cannot accumulate.
	item := fake.stored(snapshot.LatestPartition, snapshot.StagingSort("scan-first"))
	// The marker is versioned on its own, so bumping the snapshot wire format cannot
	// strand the chunk sets the stored markers name.
	if version, err := numberAttribute(item, attrFormatVersion); err != nil || version != stagingFormatVersion {
		t.Errorf("the marker declares version %d (err %v), want %d", version, err, stagingFormatVersion)
	}
	ttl, err := numberAttribute(item, attrExpiresAt)
	if err != nil {
		t.Fatalf("the staging marker has no TTL: %v", err)
	}
	if ttl != expires.Unix() {
		t.Errorf("the marker TTL is %d, want %d", ttl, expires.Unix())
	}

	// Claiming the same snapshot again refreshes the staging time, which is what
	// renews the grace period a reclaimer waits out.
	refreshed := fixedNow.Add(4 * time.Hour)
	if err := store.StageSnapshot(ctx, "scan-first", refreshed, expires); err != nil {
		t.Fatalf("restaging: %v", err)
	}
	staged, err = store.StagedSnapshots(ctx)
	if err != nil {
		t.Fatalf("StagedSnapshots: %v", err)
	}
	if len(staged) != 2 || !staged[0].StagedAt.Equal(refreshed) {
		t.Fatalf("restaging left %v, want scan-first staged at %s", staged, refreshed)
	}

	if err := store.UnstageSnapshot(ctx, "scan-first"); err != nil {
		t.Fatalf("UnstageSnapshot: %v", err)
	}
	// Unstaging is idempotent, so a publisher may unstage without reading first.
	if err := store.UnstageSnapshot(ctx, "scan-first"); err != nil {
		t.Errorf("a repeated UnstageSnapshot failed: %v", err)
	}
	staged, err = store.StagedSnapshots(ctx)
	if err != nil {
		t.Fatalf("StagedSnapshots: %v", err)
	}
	if len(staged) != 1 || staged[0].SnapshotID != "scan-second" {
		t.Errorf("StagedSnapshots returned %v, want only scan-second", staged)
	}

	if err := store.StageSnapshot(ctx, "scan-first", fixedNow, fixedNow); err == nil {
		t.Errorf("StageSnapshot accepted a marker that expires when it was staged")
	}
	if err := store.StageSnapshot(ctx, "../escape", fixedNow, expires); err == nil {
		t.Errorf("StageSnapshot accepted an unsafe snapshot id")
	}
}

// TestStagingMarkersAreInvisibleToEveryOtherRead proves the markers share the
// pointer's partition without reaching any other read path.
func TestStagingMarkersAreInvisibleToEveryOtherRead(t *testing.T) {
	store, _, _ := newTestStore(t, Options{})
	ctx := context.Background()
	built := testSnapshot(t, "scan-live", fixedNow, "zap", "orb")
	publish(t, store, built, fixedNow)

	if err := store.StageSnapshot(ctx, "scan-live", fixedNow, fixedNow.Add(time.Hour)); err != nil {
		t.Fatalf("StageSnapshot: %v", err)
	}
	if err := store.StageSnapshot(ctx, "scan-next", fixedNow, fixedNow.Add(time.Hour)); err != nil {
		t.Fatalf("StageSnapshot: %v", err)
	}

	assertReadsSnapshot(t, store, "scan-live")
	if _, err := store.GetChunks(ctx, "scan-live"); err != nil {
		t.Errorf("GetChunks was disturbed by a staging marker: %v", err)
	}
	if _, err := store.GetChunks(ctx, "scan-next"); !errors.Is(err, snapshot.ErrNotFound) {
		t.Errorf("GetChunks returned %v for a staged snapshot with no chunks, want ErrNotFound", err)
	}
}

// TestStagedSnapshotsSkipsAMarkerItCannotInterpret covers the one thing that must
// not happen when a marker is unreadable: the whole pass stopping. An unreadable
// marker is never returned, so nothing can be expired against it, but every other
// abandoned chunk set is still reported and so still reclaimable.
func TestStagedSnapshotsSkipsAMarkerItCannotInterpret(t *testing.T) {
	tests := []struct {
		name    string
		corrupt func(item map[string]types.AttributeValue)
	}{
		{
			// A marker version this build does not know. It is stamped independently
			// of snapshot.FormatVersion, so a wire change cannot produce this, but an
			// intentional marker change could.
			name: "an unknown marker version",
			corrupt: func(item map[string]types.AttributeValue) {
				item[attrFormatVersion] = numberValue(stagingFormatVersion + 1)
			},
		},
		{
			name: "a missing staging time",
			corrupt: func(item map[string]types.AttributeValue) {
				delete(item, attrStagedAt)
			},
		},
		{
			name: "an unreadable staging time",
			corrupt: func(item map[string]types.AttributeValue) {
				item[attrStagedAt] = stringValue("yesterday")
			},
		},
		{
			// A marker keyed under one snapshot but naming another would aim a
			// reclaim at the wrong chunks.
			name: "a snapshot id that disagrees with the key",
			corrupt: func(item map[string]types.AttributeValue) {
				item[attrSnapshotID] = stringValue("scan-other")
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			store, fake, _ := newTestStore(t, Options{})
			ctx := context.Background()
			for _, id := range []string{"scan-first", "scan-second"} {
				if err := store.StageSnapshot(ctx, id, fixedNow, fixedNow.Add(time.Hour)); err != nil {
					t.Fatalf("StageSnapshot %s: %v", id, err)
				}
			}
			item := fake.stored(snapshot.LatestPartition, snapshot.StagingSort("scan-first"))
			test.corrupt(item)
			fake.put(item)

			staged, err := store.StagedSnapshots(ctx)
			var unreadable *snapshot.StagingUnreadableError
			if !errors.As(err, &unreadable) {
				t.Fatalf("StagedSnapshots returned %v, want a StagingUnreadableError", err)
			}
			if unreadable.Skipped != 1 {
				t.Errorf("reported %d skipped markers, want 1", unreadable.Skipped)
			}
			// The readable marker is still reported, so its chunk set is still
			// reclaimable, and the unreadable one is not reported at all, so nothing
			// can be expired against it.
			if len(staged) != 1 || staged[0].SnapshotID != "scan-second" {
				t.Fatalf("StagedSnapshots returned %v, want only scan-second", staged)
			}
		})
	}
}

// TestSplitWriteRequestsRespectsBothBatchLimits covers the batching arithmetic
// directly, because a real table rejects a batch that breaks either limit and no
// fake can prove the request was accepted in production.
func TestSplitWriteRequestsRespectsBothBatchLimits(t *testing.T) {
	t.Run("the item count", func(t *testing.T) {
		requests := make([]types.WriteRequest, 0, 60)
		for i := 0; i < 60; i++ {
			requests = append(requests, types.WriteRequest{
				DeleteRequest: &types.DeleteRequest{Key: map[string]types.AttributeValue{
					attrPartition: stringValue("SNAPSHOT#x"),
					attrSort:      stringValue(snapshot.ChunkSort(i)),
				}},
			})
		}
		batches := splitWriteRequests(requests)
		if len(batches) != 3 {
			t.Fatalf("60 small items split into %d batches, want 3", len(batches))
		}
		total := 0
		for i, batch := range batches {
			if len(batch) > maxBatchItems {
				t.Errorf("batch %d holds %d items, above the %d limit", i, len(batch), maxBatchItems)
			}
			total += len(batch)
		}
		if total != len(requests) {
			t.Errorf("the batches hold %d items, want %d", total, len(requests))
		}
	})

	t.Run("the request size", func(t *testing.T) {
		// Items large enough that three of them exceed the byte cap.
		big := make([]byte, maxBatchBytes/2)
		requests := make([]types.WriteRequest, 0, 4)
		for i := 0; i < 4; i++ {
			requests = append(requests, types.WriteRequest{
				PutRequest: &types.PutRequest{Item: map[string]types.AttributeValue{
					attrPartition: stringValue("SNAPSHOT#x"),
					attrSort:      stringValue(snapshot.ChunkSort(i)),
					attrPayload:   &types.AttributeValueMemberB{Value: big},
				}},
			})
		}
		batches := splitWriteRequests(requests)
		if len(batches) < 4 {
			t.Fatalf("oversized items split into %d batches, want at least 4", len(batches))
		}
		for i, batch := range batches {
			size := 0
			for _, request := range batch {
				size += writeRequestBytes(request)
			}
			if len(batch) > 1 && size > maxBatchBytes {
				t.Errorf("batch %d is %d bytes, above the %d cap", i, size, maxBatchBytes)
			}
		}
	})

	t.Run("nothing to write", func(t *testing.T) {
		if batches := splitWriteRequests(nil); len(batches) != 0 {
			t.Errorf("an empty request list split into %d batches, want 0", len(batches))
		}
	})
}

// TestRetryDelayIsBoundedAndGrows keeps the backoff from either hammering the table
// or waiting past a Lambda deadline.
func TestRetryDelayIsBoundedAndGrows(t *testing.T) {
	previous := time.Duration(0)
	for attempt := 0; attempt < 20; attempt++ {
		delay := retryDelay(attempt)
		if delay < baseRetryDelay || delay > maxRetryDelay {
			t.Fatalf("attempt %d waits %v, outside %v..%v", attempt, delay, baseRetryDelay, maxRetryDelay)
		}
		if delay < previous {
			t.Fatalf("attempt %d waits %v, less than the previous %v", attempt, delay, previous)
		}
		previous = delay
	}
	if retryDelay(19) != maxRetryDelay {
		t.Errorf("the backoff never reaches its %v cap", maxRetryDelay)
	}
}

// TestAttributeTypeCodeNamesTheDynamoDescriptors pins the operand pointerGuard binds
// into attribute_type against the descriptors the service actually accepts. Nothing
// else can: a fake that resolved the condition through this same mapping would compare
// it against itself, and a descriptor the service rejects would answer every real
// attempt with a ValidationException, putting publication back in the wedged state the
// guard exists to escape from.
func TestAttributeTypeCodeNamesTheDynamoDescriptors(t *testing.T) {
	tests := []struct {
		name  string
		value types.AttributeValue
		want  string
	}{
		{"string", &types.AttributeValueMemberS{Value: "zap"}, "S"},
		{"number", &types.AttributeValueMemberN{Value: "7"}, "N"},
		{"binary", &types.AttributeValueMemberB{Value: []byte{1, 2}}, "B"},
		{"string set", &types.AttributeValueMemberSS{Value: []string{"zap"}}, "SS"},
		{"number set", &types.AttributeValueMemberNS{Value: []string{"7"}}, "NS"},
		{"binary set", &types.AttributeValueMemberBS{Value: [][]byte{{1}}}, "BS"},
		{"boolean", &types.AttributeValueMemberBOOL{Value: true}, "BOOL"},
		{"null", &types.AttributeValueMemberNULL{Value: true}, "NULL"},
		{"list", &types.AttributeValueMemberL{Value: []types.AttributeValue{stringValue("zap")}}, "L"},
		{"map", &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{"a": stringValue("zap")}}, "M"},
		// A union member this SDK version does not model has no descriptor to name, and
		// pointerGuard falls back to asserting the attribute's presence instead.
		{"unmodelled", &types.UnknownUnionMember{Tag: "XX"}, ""},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			if got := attributeTypeCode(test.value); got != test.want {
				t.Errorf("attributeTypeCode(%T) = %q, want %q", test.value, got, test.want)
			}
		})
	}
}

func TestItemBytesCountsBinaryAsItTravels(t *testing.T) {
	item := map[string]types.AttributeValue{
		attrPayload: &types.AttributeValueMemberB{Value: make([]byte, 300)},
	}
	// Base64 grows three bytes into four, which is the size the request limit sees.
	if got, want := itemBytes(item), len(attrPayload)+400; got != want {
		t.Errorf("itemBytes reported %d, want %d", got, want)
	}
}
