package snapshot

import (
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

			// Chunks are immutable: a snapshot ID is never rewritten.
			if err := store.PutChunks(ctx, snapshot.Metadata.SnapshotID, payload.Chunks); err == nil {
				t.Error("PutChunks overwrote an existing snapshot")
			} else if !strings.Contains(err.Error(), "immutable") {
				t.Errorf("error %q does not mention immutability", err)
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
			name:   "pointer count edited",
			damage: editLatestFile(`"available":2`, `"available":99`),
			want:   `results but the pointer reports 99`,
		},
		{
			name:   "pointer source name total edited",
			damage: editLatestFile(`"names":8}]`, `"names":99}]`),
			want:   "disagrees with its pointer",
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
