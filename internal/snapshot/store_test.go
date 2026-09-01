package snapshot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ens-scrape/internal/ens"
)

// Both fakes must satisfy the interface that later AWS code will implement, so
// publication and read logic is written once.
var (
	_ Store = (*MemoryStore)(nil)
	_ Store = (*FileStore)(nil)
)

func newStores(t *testing.T) map[string]Store {
	t.Helper()
	return map[string]Store{
		"memory": NewMemoryStore(),
		"file":   NewFileStore(t.TempDir()),
	}
}

func TestPublishAndReadThroughStores(t *testing.T) {
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	payload, err := Encode(snapshot)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	publishedAt := fixedNow.Add(2 * time.Minute)

	for name, store := range newStores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()

			if _, _, err := Read(ctx, store); !errors.Is(err, ErrNotFound) {
				t.Fatalf("Read before publication returned %v, want ErrNotFound", err)
			}

			latest, err := Publish(ctx, store, snapshot, publishedAt)
			if err != nil {
				t.Fatalf("Publish: %v", err)
			}
			if latest.Checksum != payload.Checksum {
				t.Errorf("published checksum is %s, want %s", latest.Checksum, payload.Checksum)
			}
			if !latest.PublishedAt.Equal(publishedAt) {
				t.Errorf("published time is %s, want %s", latest.PublishedAt, publishedAt)
			}

			readSnapshot, readLatest, err := Read(ctx, store)
			if err != nil {
				t.Fatalf("Read: %v", err)
			}
			if readLatest.SnapshotID != snapshot.Metadata.SnapshotID {
				t.Errorf("read pointer names %q, want %q", readLatest.SnapshotID, snapshot.Metadata.SnapshotID)
			}
			roundTripped, err := Encode(readSnapshot)
			if err != nil {
				t.Fatalf("Encode read snapshot: %v", err)
			}
			assertSamePayload(t, payload, roundTripped)

		})
	}
}

// TestPutChunksIsIdempotentButNeverRevises drives the ChunkStore immutability
// rule through both fakes. Storing the identical chunks again is the no-op a
// retried publication depends on; any real difference under a stored ID is still
// refused.
func TestPutChunksIsIdempotentButNeverRevises(t *testing.T) {
	ctx := context.Background()
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	payload, err := Encode(snapshot)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if len(payload.Chunks) != 1 {
		t.Fatalf("this test assumes a single chunk, got %d", len(payload.Chunks))
	}

	// A second snapshot at the same scan time, so its chunks are valid on their
	// own but hold different bytes under the same id.
	otherResults := lifecycleResults(t, fixedNow)
	otherResults = otherResults[:len(otherResults)-1]
	other, err := Build(snapshot.Metadata.SnapshotID, fixedNow, testSources(len(otherResults)), otherResults)
	if err != nil {
		t.Fatalf("Build the other snapshot: %v", err)
	}
	otherPayload, err := Encode(other)
	if err != nil {
		t.Fatalf("Encode the other snapshot: %v", err)
	}

	relabelChecksum := func(chunks []Chunk) []Chunk {
		chunks[0].Checksum = checksum(chunks[0].Bytes)
		return chunks
	}

	tests := []struct {
		name    string
		write   func() []Chunk
		wantErr bool
	}{
		{
			name:  "identical chunks are a no-op",
			write: func() []Chunk { return CloneChunks(payload.Chunks) },
		},
		{
			name:    "different bytes are refused",
			write:   func() []Chunk { return CloneChunks(otherPayload.Chunks) },
			wantErr: true,
		},
		{
			name: "a truncated final chunk is refused",
			write: func() []Chunk {
				chunks := CloneChunks(payload.Chunks)
				chunks[0].Bytes = chunks[0].Bytes[:len(chunks[0].Bytes)-1]
				return relabelChecksum(chunks)
			},
			wantErr: true,
		},
		{
			name: "a different declared count is refused",
			write: func() []Chunk {
				chunks := CloneChunks(payload.Chunks)
				chunks = append(chunks, chunks[0].Clone())
				chunks[0].Count = 2
				chunks[1].Count = 2
				chunks[1].Index = 1
				chunks[0].Bytes = make([]byte, MaxChunkBytes)
				return relabelChecksum(chunks)
			},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for name, store := range newStores(t) {
				t.Run(name, func(t *testing.T) {
					if err := store.PutChunks(ctx, snapshot.Metadata.SnapshotID, payload.Chunks); err != nil {
						t.Fatalf("PutChunks of the first copy: %v", err)
					}

					err := store.PutChunks(ctx, snapshot.Metadata.SnapshotID, test.write())
					if test.wantErr {
						if err == nil {
							t.Fatal("PutChunks revised a stored snapshot")
						}
					} else if err != nil {
						t.Fatalf("PutChunks refused identical chunks: %v", err)
					}

					// Either way the stored chunks are the ones first written.
					stored, err := store.GetChunks(ctx, snapshot.Metadata.SnapshotID)
					if err != nil {
						t.Fatalf("GetChunks: %v", err)
					}
					identical, err := chunksIdentical(payload.Chunks, stored)
					if err != nil {
						t.Fatalf("chunksIdentical: %v", err)
					}
					if !identical {
						t.Fatal("the stored chunks are no longer the ones first written")
					}
				})
			}
		})
	}
}

// TestPublishRetriesAfterAFailedPointerWrite is the sequence the idempotent rules
// exist for: the chunks are stored and verified, the pointer write fails
// transiently, and the publisher calls Publish again with the same snapshot and a
// freshly sampled publication time. The retry must publish.
func TestPublishRetriesAfterAFailedPointerWrite(t *testing.T) {
	ctx := context.Background()
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))

	firstAttempt := fixedNow.Add(time.Minute)
	// The retry samples its own clock, so it never matches the first attempt.
	retryAttempt := fixedNow.Add(4 * time.Minute)

	for name, store := range newStores(t) {
		t.Run(name, func(t *testing.T) {
			if _, err := Publish(ctx, failingLatestStore{Store: store}, snapshot, firstAttempt); err == nil {
				t.Fatal("Publish succeeded despite a failing pointer write")
			}
			if _, err := store.GetLatest(ctx); !errors.Is(err, ErrNotFound) {
				t.Fatalf("GetLatest after the failed attempt returned %v, want ErrNotFound", err)
			}

			published, err := Publish(ctx, store, snapshot, retryAttempt)
			if err != nil {
				t.Fatalf("the retry could not publish an already stored scan: %v", err)
			}
			if !published.PublishedAt.Equal(retryAttempt) {
				t.Errorf("the retry published at %s, want %s", published.PublishedAt, retryAttempt)
			}

			readSnapshot, readLatest, err := Read(ctx, store)
			if err != nil {
				t.Fatalf("Read after the retry: %v", err)
			}
			if readLatest.SnapshotID != snapshot.Metadata.SnapshotID {
				t.Fatalf("the pointer names %q, want %q", readLatest.SnapshotID, snapshot.Metadata.SnapshotID)
			}
			if readSnapshot.Metadata.Names != snapshot.Metadata.Names {
				t.Fatalf("readers see %d names, want %d", readSnapshot.Metadata.Names, snapshot.Metadata.Names)
			}

			// Retrying once more, after the pointer is already published, is still
			// accepted and leaves the published pointer alone.
			thirdAttempt := fixedNow.Add(9 * time.Minute)
			if _, err := Publish(ctx, store, snapshot, thirdAttempt); err != nil {
				t.Fatalf("a second retry was refused: %v", err)
			}
			served, err := store.GetLatest(ctx)
			if err != nil {
				t.Fatalf("GetLatest: %v", err)
			}
			if !served.PublishedAt.Equal(retryAttempt) {
				t.Errorf("the no-op retry moved the stored publication time to %s, want %s", served.PublishedAt, retryAttempt)
			}
		})
	}
}

func TestPublishRefusesInconsistentSnapshot(t *testing.T) {
	ctx := context.Background()
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	snapshot.Metadata.Names++

	for name, store := range newStores(t) {
		t.Run(name, func(t *testing.T) {
			if _, err := Publish(ctx, store, snapshot, fixedNow); err == nil {
				t.Fatal("Publish accepted an inconsistent snapshot")
			}
			if _, err := store.GetLatest(ctx); !errors.Is(err, ErrNotFound) {
				t.Fatalf("GetLatest returned %v, want ErrNotFound", err)
			}
		})
	}
}

// failingLatestStore accepts chunks but refuses to move the pointer, standing in
// for a publication that dies between writing chunks and publishing them.
type failingLatestStore struct {
	Store
}

func (s failingLatestStore) PutLatest(context.Context, Latest) error {
	return errors.New("pointer write rejected")
}

// corruptingStore returns chunks that no longer match what was written.
type corruptingStore struct {
	Store
}

func (s corruptingStore) GetChunks(ctx context.Context, snapshotID string) ([]Chunk, error) {
	chunks, err := s.Store.GetChunks(ctx, snapshotID)
	if err != nil {
		return nil, err
	}
	if len(chunks) > 0 && len(chunks[0].Bytes) > 0 {
		chunks[0].Bytes[0] ^= 0xff
	}
	return chunks, nil
}

func TestFailedPublicationKeepsThePreviousSnapshot(t *testing.T) {
	ctx := context.Background()
	first := mustBuild(t, lifecycleResults(t, fixedNow))

	later := fixedNow.Add(3 * time.Hour)
	secondResults := lifecycleResults(t, later)
	second, err := Build("second-snapshot", later, testSources(len(secondResults)), secondResults)
	if err != nil {
		t.Fatalf("Build second snapshot: %v", err)
	}

	tests := []struct {
		name string
		wrap func(Store) Store
		want string
	}{
		{
			name: "pointer write fails",
			wrap: func(store Store) Store { return failingLatestStore{Store: store} },
			want: "publish snapshot",
		},
		{
			name: "read back is corrupt",
			wrap: func(store Store) Store { return corruptingStore{Store: store} },
			want: "verify snapshot",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := NewMemoryStore()
			if _, err := Publish(ctx, store, first, fixedNow); err != nil {
				t.Fatalf("Publish first snapshot: %v", err)
			}

			if _, err := Publish(ctx, test.wrap(store), second, later); err == nil {
				t.Fatal("Publish succeeded despite a failure")
			} else if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}

			readSnapshot, readLatest, err := Read(ctx, store)
			if err != nil {
				t.Fatalf("Read after a failed publication: %v", err)
			}
			if readLatest.SnapshotID != first.Metadata.SnapshotID {
				t.Fatalf("pointer moved to %q after a failed publication", readLatest.SnapshotID)
			}
			if readSnapshot.Metadata.SnapshotID != first.Metadata.SnapshotID {
				t.Fatalf("readers see snapshot %q, want %q", readSnapshot.Metadata.SnapshotID, first.Metadata.SnapshotID)
			}
		})
	}
}

func TestSupersededSnapshotsAreRemovableAfterPublication(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()

	first := mustBuild(t, lifecycleResults(t, fixedNow))
	if _, err := Publish(ctx, store, first, fixedNow); err != nil {
		t.Fatalf("Publish first snapshot: %v", err)
	}

	later := fixedNow.Add(3 * time.Hour)
	secondResults := lifecycleResults(t, later)
	second, err := Build("second-snapshot", later, testSources(len(secondResults)), secondResults)
	if err != nil {
		t.Fatalf("Build second snapshot: %v", err)
	}
	if _, err := Publish(ctx, store, second, later); err != nil {
		t.Fatalf("Publish second snapshot: %v", err)
	}
	if got := len(store.SnapshotIDs()); got != 2 {
		t.Fatalf("store holds %d snapshots, want 2", got)
	}

	// Retention keeps only the latest snapshot plus a recovery window, so the
	// superseded snapshot is removable without disturbing readers.
	if err := store.DeleteChunks(ctx, first.Metadata.SnapshotID); err != nil {
		t.Fatalf("DeleteChunks: %v", err)
	}
	readSnapshot, readLatest, err := Read(ctx, store)
	if err != nil {
		t.Fatalf("Read after retention cleanup: %v", err)
	}
	if readLatest.SnapshotID != second.Metadata.SnapshotID || readSnapshot.Metadata.SnapshotID != second.Metadata.SnapshotID {
		t.Fatalf("readers see %q, want %q", readLatest.SnapshotID, second.Metadata.SnapshotID)
	}
}

// TestStoresKeepThePointerMonotonic drives the LatestStore ordering rule through
// both fakes: an older scan is refused, an identical retry succeeds without
// changing anything, and a different pointer at the same scan time is refused.
func TestStoresKeepThePointerMonotonic(t *testing.T) {
	ctx := context.Background()

	published := mustPointer(t, mustBuild(t, lifecycleResults(t, fixedNow)), fixedNow.Add(time.Minute))

	earlier := fixedNow.Add(-3 * time.Hour)
	earlierResults := lifecycleResults(t, earlier)
	earlierSnapshot, err := Build("earlier-snapshot", earlier, testSources(len(earlierResults)), earlierResults)
	if err != nil {
		t.Fatalf("Build earlier snapshot: %v", err)
	}
	older := mustPointer(t, earlierSnapshot, earlier.Add(time.Minute))

	later := fixedNow.Add(3 * time.Hour)
	laterResults := lifecycleResults(t, later)
	laterSnapshot, err := Build("later-snapshot", later, testSources(len(laterResults)), laterResults)
	if err != nil {
		t.Fatalf("Build later snapshot: %v", err)
	}
	newer := mustPointer(t, laterSnapshot, later.Add(time.Minute))

	// A second scan of the same instant under a different id: the same-time
	// conflict a real backend has to refuse.
	rivalResults := lifecycleResults(t, fixedNow)
	rivalSnapshot, err := Build("rival-snapshot", fixedNow, testSources(len(rivalResults)), rivalResults)
	if err != nil {
		t.Fatalf("Build the rival snapshot: %v", err)
	}
	rival := mustPointer(t, rivalSnapshot, fixedNow.Add(time.Minute))

	// The same scan and the same chunks, published a minute later. PublishedAt
	// describes the write rather than the scan, so this is the same pointer.
	retried := mustPointer(t, mustBuild(t, lifecycleResults(t, fixedNow)), fixedNow.Add(2*time.Minute))

	tests := []struct {
		name       string
		write      Latest
		wantErr    bool
		wantServed Latest
	}{
		{
			name:       "older scan time is refused",
			write:      older,
			wantErr:    true,
			wantServed: published,
		},
		{
			name:       "identical pointer is an accepted no-op",
			write:      published,
			wantServed: published,
		},
		{
			name:       "a re-sampled publication time is still the same pointer",
			write:      retried,
			wantServed: published,
		},
		{
			name:       "same scan time with a different snapshot is refused",
			write:      rival,
			wantErr:    true,
			wantServed: published,
		},
		{
			name:       "newer scan time moves the pointer",
			write:      newer,
			wantServed: newer,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for name, store := range newStores(t) {
				t.Run(name, func(t *testing.T) {
					if err := store.PutLatest(ctx, published); err != nil {
						t.Fatalf("PutLatest of the first pointer: %v", err)
					}

					err := store.PutLatest(ctx, test.write)
					if test.wantErr {
						if err == nil {
							t.Fatalf("PutLatest accepted a pointer that moves readers backwards")
						}
						if !errors.Is(err, ErrPointerConflict) {
							t.Fatalf("error %q is not an ErrPointerConflict", err)
						}
					} else if err != nil {
						t.Fatalf("PutLatest: %v", err)
					}

					served, err := store.GetLatest(ctx)
					if err != nil {
						t.Fatalf("GetLatest: %v", err)
					}
					if served.SnapshotID != test.wantServed.SnapshotID {
						t.Fatalf("readers see %q, want %q", served.SnapshotID, test.wantServed.SnapshotID)
					}
					if !bytes.Equal(mustMarshal(t, served), mustMarshal(t, test.wantServed)) {
						t.Fatalf("the stored pointer is not byte-identical to the one that should be serving")
					}
				})
			}
		})
	}
}

// TestPublishRefusesAnOutOfOrderScan is the end-to-end version of the ordering
// rule: a slow scan that finishes after a later one must not move readers back.
func TestPublishRefusesAnOutOfOrderScan(t *testing.T) {
	ctx := context.Background()

	newer := mustBuild(t, lifecycleResults(t, fixedNow))

	earlier := fixedNow.Add(-3 * time.Hour)
	earlierResults := lifecycleResults(t, earlier)
	older, err := Build("earlier-snapshot", earlier, testSources(len(earlierResults)), earlierResults)
	if err != nil {
		t.Fatalf("Build the earlier snapshot: %v", err)
	}

	for name, store := range newStores(t) {
		t.Run(name, func(t *testing.T) {
			if _, err := Publish(ctx, store, newer, fixedNow); err != nil {
				t.Fatalf("Publish the newer snapshot: %v", err)
			}

			if _, err := Publish(ctx, store, older, fixedNow.Add(time.Minute)); err == nil {
				t.Fatal("Publish moved readers back to an older scan")
			} else if !errors.Is(err, ErrPointerConflict) {
				t.Fatalf("error %q is not an ErrPointerConflict", err)
			}

			readSnapshot, readLatest, err := Read(ctx, store)
			if err != nil {
				t.Fatalf("Read after a refused publication: %v", err)
			}
			if readLatest.SnapshotID != newer.Metadata.SnapshotID {
				t.Fatalf("the pointer names %q, want %q", readLatest.SnapshotID, newer.Metadata.SnapshotID)
			}
			if !readSnapshot.Metadata.ScannedAt.Equal(newer.Metadata.ScannedAt) {
				t.Fatalf("readers see a scan at %s, want %s", readSnapshot.Metadata.ScannedAt, newer.Metadata.ScannedAt)
			}
		})
	}
}

// TestPutLatestRejectsAnInconsistentSummary proves both fakes refuse to store a
// pointer whose summary contradicts itself, so a client that reads only the
// pointer is never handed totals that do not add up.
func TestPutLatestRejectsAnInconsistentSummary(t *testing.T) {
	ctx := context.Background()
	valid := mustPointer(t, mustBuild(t, lifecycleResults(t, fixedNow)), fixedNow.Add(time.Minute))

	tests := []struct {
		name   string
		mutate func(*Latest)
		want   string
	}{
		{
			name:   "counts sum above the name total",
			mutate: func(l *Latest) { l.Counts[ens.StatusAvailable] += 3 },
			want:   "counts sum to 11 but the pointer reports 8 names",
		},
		{
			name:   "counts sum below the name total",
			mutate: func(l *Latest) { l.Counts[ens.StatusAvailable] = 0 },
			want:   "counts sum to 6 but the pointer reports 8 names",
		},
		{
			name:   "source totals above the name total",
			mutate: func(l *Latest) { l.Sources[0].Names += 2 },
			want:   "source lists account for 10 names but the pointer reports 8",
		},
		{
			name:   "source totals below the name total",
			mutate: func(l *Latest) { l.Sources[0].Names = 0 },
			want:   "source lists account for 0 names but the pointer reports 8",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			latest := valid.Clone()
			test.mutate(&latest)
			for name, store := range newStores(t) {
				t.Run(name, func(t *testing.T) {
					err := store.PutLatest(ctx, latest)
					if err == nil {
						t.Fatalf("PutLatest stored an inconsistent summary")
					}
					if !strings.Contains(err.Error(), test.want) {
						t.Fatalf("error %q does not contain %q", err, test.want)
					}
					if _, err := store.GetLatest(ctx); !errors.Is(err, ErrNotFound) {
						t.Fatalf("GetLatest returned %v, want ErrNotFound", err)
					}
				})
			}
		})
	}
}

func mustPointer(t *testing.T, snapshot Snapshot, publishedAt time.Time) Latest {
	t.Helper()
	payload, err := Encode(snapshot)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	return payload.Latest(publishedAt)
}

// TestStoresIsolateStoredPointerState proves both fakes enforce the immutability a
// real backend gives for free: a reader that edits the pointer it was handed must
// not be able to change what the next reader sees.
func TestStoresIsolateStoredPointerState(t *testing.T) {
	ctx := context.Background()
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))

	for name, store := range newStores(t) {
		t.Run(name, func(t *testing.T) {
			if _, err := Publish(ctx, store, snapshot, fixedNow); err != nil {
				t.Fatalf("Publish: %v", err)
			}
			wantAvailable := snapshot.Metadata.Counts[ens.StatusAvailable]
			wantNames := snapshot.Metadata.Sources[0].Names

			first, err := store.GetLatest(ctx)
			if err != nil {
				t.Fatalf("GetLatest: %v", err)
			}
			first.Counts[ens.StatusAvailable] = 0
			first.Sources[0].Names = 0

			second, err := store.GetLatest(ctx)
			if err != nil {
				t.Fatalf("GetLatest after editing the first pointer: %v", err)
			}
			if got := second.Counts[ens.StatusAvailable]; got != wantAvailable {
				t.Errorf("a second read reports %d available names, want %d", got, wantAvailable)
			}
			if got := second.Sources[0].Names; got != wantNames {
				t.Errorf("a second read reports %d source names, want %d", got, wantNames)
			}
			if got := snapshot.Metadata.Counts[ens.StatusAvailable]; got != wantAvailable {
				t.Errorf("editing a read pointer changed the source snapshot count to %d, want %d", got, wantAvailable)
			}

			// The store still serves the snapshot, so nothing was corrupted.
			if _, _, err := Read(ctx, store); err != nil {
				t.Fatalf("Read after editing a returned pointer: %v", err)
			}
		})
	}
}

func TestMemoryStoreCorruptionFailsClosed(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	if _, err := Publish(ctx, store, snapshot, fixedNow); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if err := store.CorruptChunk(snapshot.Metadata.SnapshotID, 0); err != nil {
		t.Fatalf("CorruptChunk: %v", err)
	}
	if _, _, err := Read(ctx, store); err == nil {
		t.Fatal("Read served a corrupt snapshot")
	} else if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("error %q does not mention a checksum mismatch", err)
	}
}

func TestFileStoreDetectsTamperedFiles(t *testing.T) {
	ctx := context.Background()
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))

	tests := []struct {
		name   string
		damage func(t *testing.T, dir, snapshotID string)
		want   string
	}{
		{
			name: "chunk file removed",
			damage: func(t *testing.T, dir, snapshotID string) {
				if err := os.Remove(chunkPath(dir, snapshotID, 0)); err != nil {
					t.Fatalf("remove chunk: %v", err)
				}
			},
			want: "not found",
		},
		{
			name: "chunk bytes edited",
			damage: func(t *testing.T, dir, snapshotID string) {
				// The chunk file keeps its original checksum, exactly as a
				// corrupt stored item would.
				path := chunkPath(dir, snapshotID, 0)
				encoded, err := os.ReadFile(path)
				if err != nil {
					t.Fatalf("read chunk: %v", err)
				}
				var chunk Chunk
				if err := json.Unmarshal(encoded, &chunk); err != nil {
					t.Fatalf("decode chunk: %v", err)
				}
				chunk.Bytes[0] ^= 0xff
				edited, err := json.Marshal(chunk)
				if err != nil {
					t.Fatalf("encode chunk: %v", err)
				}
				if err := os.WriteFile(path, edited, 0o644); err != nil {
					t.Fatalf("write chunk: %v", err)
				}
			},
			want: "checksum mismatch",
		},
		{
			name:   "pointer file edited",
			damage: editLatestFile(`"format_version":1`, `"format_version":99`),
			want:   "unsupported latest pointer format version",
		},
		{
			// A widened threshold would make a client call a two-day-old snapshot
			// fresh, and the pointer is the only thing a status read looks at.
			name:   "pointer staleness threshold widened",
			damage: editLatestFile(`"stale_after_seconds":21600`, `"stale_after_seconds":8640000`),
			want:   "scan age thresholds disagree with the source cadences",
		},
		{
			name:   "pointer counts removed",
			damage: editLatestFile(`"counts":{"available":2,"expiring-soon":1,"grace-ending-soon":1,"grace-period":1,"premium":1,"registered":1,"unknown":1},`, ""),
			want:   "counts must list every lifecycle status",
		},
		{
			// An edited count is caught by the pointer alone, without fetching or
			// decompressing a chunk, which is the work a status read exists to skip.
			name:   "pointer count edited",
			damage: editLatestFile(`"available":2`, `"available":99`),
			want:   "counts sum to 105 but the pointer reports 8 names",
		},
		{
			name:   "pointer source name total edited",
			damage: editLatestFile(`"names":8}]`, `"names":99}]`),
			want:   "source lists account for 99 names but the pointer reports 8",
		},
		{
			// The counts still sum to the name total, so only the comparison with
			// the decoded snapshot can catch this one.
			name:   "pointer count moved between statuses",
			damage: editLatestFile(`"available":2,"expiring-soon":1`, `"available":3,"expiring-soon":0`),
			want:   "results but the pointer reports",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			store := NewFileStore(dir)
			if _, err := Publish(ctx, store, snapshot, fixedNow); err != nil {
				t.Fatalf("Publish: %v", err)
			}
			test.damage(t, dir, snapshot.Metadata.SnapshotID)
			if _, _, err := Read(ctx, store); err == nil {
				t.Fatal("Read served a tampered snapshot")
			} else if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}
		})
	}
}

func TestStoresRejectUnsafeSnapshotIDs(t *testing.T) {
	ctx := context.Background()
	for name, store := range newStores(t) {
		t.Run(name, func(t *testing.T) {
			if _, err := store.GetChunks(ctx, "../escape"); err == nil {
				t.Fatal("GetChunks accepted an unsafe snapshot id")
			}
			if err := store.DeleteChunks(ctx, "../escape"); err == nil {
				t.Fatal("DeleteChunks accepted an unsafe snapshot id")
			}
		})
	}
}

func TestStoresRejectCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))

	for name, store := range newStores(t) {
		t.Run(name, func(t *testing.T) {
			if _, err := Publish(ctx, store, snapshot, fixedNow); !errors.Is(err, context.Canceled) {
				t.Fatalf("Publish returned %v, want context.Canceled", err)
			}
		})
	}
}

// editLatestFile rewrites part of the committed pointer file, standing in for a
// pointer item that was edited in place. It fails the test when the target text is
// absent, so a serialization change cannot quietly turn the case into a no-op.
// TestFileStorePutLatestReplacesAnUnreadablePointer covers the publication side of
// the ordering rule. The rule compares scans, so a stored pointer that says
// nothing about a scan must not block a publication: otherwise a FormatVersion
// bump would wedge an existing directory with no way to publish into it. Reads
// still fail closed on the same pointer, which the second half asserts.
func TestFileStorePutLatestReplacesAnUnreadablePointer(t *testing.T) {
	ctx := context.Background()
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	publishedAt := fixedNow.Add(time.Minute)

	tests := []struct {
		name     string
		contents string
		wantRead string
	}{
		{
			name:     "not json at all",
			contents: "this is not a pointer",
			wantRead: "read latest snapshot pointer",
		},
		{
			name:     "truncated json",
			contents: `{"format_version":1,"snapshot_id":"test-sna`,
			wantRead: "read latest snapshot pointer",
		},
		{
			name:     "empty file",
			contents: "",
			wantRead: "read latest snapshot pointer",
		},
		{
			name:     "an unsupported format version",
			contents: `{"format_version":99,"snapshot_id":"old-snapshot"}`,
			wantRead: "unsupported latest pointer format version",
		},
		{
			name:     "a valid version that fails validation",
			contents: `{"format_version":1,"snapshot_id":"old-snapshot"}`,
			wantRead: "latest pointer needs a scan time",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			store := NewFileStore(dir)
			path := filepath.Join(dir, fileStoreLatestName)
			if err := os.WriteFile(path, []byte(test.contents), 0o644); err != nil {
				t.Fatalf("write the stored pointer: %v", err)
			}

			// A reader must never be handed this pointer.
			if _, err := store.GetLatest(ctx); err == nil {
				t.Fatal("GetLatest served an unreadable pointer")
			} else if !strings.Contains(err.Error(), test.wantRead) {
				t.Fatalf("error %q does not contain %q", err, test.wantRead)
			}
			if _, _, err := Read(ctx, store); err == nil {
				t.Fatal("Read served an unreadable pointer")
			}

			// A publisher must be able to replace it.
			if _, err := Publish(ctx, store, snapshot, publishedAt); err != nil {
				t.Fatalf("Publish could not replace an unreadable pointer: %v", err)
			}
			served, err := store.GetLatest(ctx)
			if err != nil {
				t.Fatalf("GetLatest after replacing the pointer: %v", err)
			}
			if served.SnapshotID != snapshot.Metadata.SnapshotID {
				t.Fatalf("the pointer names %q, want %q", served.SnapshotID, snapshot.Metadata.SnapshotID)
			}
			if _, _, err := Read(ctx, store); err != nil {
				t.Fatalf("Read after replacing the pointer: %v", err)
			}
		})
	}
}

// TestFileStorePutLatestStillRefusesAnOlderReadablePointer is the other half of
// the narrowing: a stored pointer that does parse keeps its ordering authority.
func TestFileStorePutLatestStillRefusesAnOlderReadablePointer(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store := NewFileStore(dir)

	newer := mustBuild(t, lifecycleResults(t, fixedNow))
	if _, err := Publish(ctx, store, newer, fixedNow.Add(time.Minute)); err != nil {
		t.Fatalf("Publish the newer snapshot: %v", err)
	}

	earlier := fixedNow.Add(-3 * time.Hour)
	earlierResults := lifecycleResults(t, earlier)
	older, err := Build("earlier-snapshot", earlier, testSources(len(earlierResults)), earlierResults)
	if err != nil {
		t.Fatalf("Build the earlier snapshot: %v", err)
	}
	if _, err := Publish(ctx, store, older, fixedNow.Add(2*time.Minute)); !errors.Is(err, ErrPointerConflict) {
		t.Fatalf("Publish returned %v, want ErrPointerConflict", err)
	}

	served, err := store.GetLatest(ctx)
	if err != nil {
		t.Fatalf("GetLatest: %v", err)
	}
	if served.SnapshotID != newer.Metadata.SnapshotID {
		t.Fatalf("the pointer names %q, want %q", served.SnapshotID, newer.Metadata.SnapshotID)
	}
}

func editLatestFile(from, to string) func(t *testing.T, dir, snapshotID string) {
	return func(t *testing.T, dir, snapshotID string) {
		t.Helper()
		path := filepath.Join(dir, fileStoreLatestName)
		encoded, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read pointer: %v", err)
		}
		if !strings.Contains(string(encoded), from) {
			t.Fatalf("pointer file does not contain %q: %s", from, encoded)
		}
		edited := strings.Replace(string(encoded), from, to, 1)
		if err := os.WriteFile(path, []byte(edited), 0o644); err != nil {
			t.Fatalf("write pointer: %v", err)
		}
	}
}

func chunkPath(dir, snapshotID string, index int) string {
	name := fmt.Sprintf("%s%0*d%s", fileStoreChunkGlob, chunkSortDigits, index, fileStoreChunkExt)
	return filepath.Join(dir, fileStoreChunkDir, snapshotID, name)
}
