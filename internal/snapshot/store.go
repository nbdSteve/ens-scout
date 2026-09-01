package snapshot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"ens-scrape/internal/ens"
)

// Storage key layout.
//
// The latest pointer and the chunk keys are defined here so every backend
// agrees on them, but this package implements no backend. A DynamoDB table with
// a string partition key and a string sort key can hold the whole model:
//
//	PK                       SK          Attributes
//	SNAPSHOT#<snapshot-id>   CHUNK#00000 bytes, checksum, count, expireAt
//	SNAPSHOT#<snapshot-id>   CHUNK#00001 bytes, checksum, count, expireAt
//	META                     LATEST      the Latest pointer
//
// Chunk sort keys are zero padded so lexical order matches numeric order and a
// single ranged query returns chunks already in index order.
const (
	// LatestPartition and LatestSort address the single latest pointer.
	LatestPartition = "META"
	LatestSort      = "LATEST"

	snapshotPartitionPrefix = "SNAPSHOT#"
	chunkSortPrefix         = "CHUNK#"
	// chunkSortDigits supports 99,999 chunks, about 18 GiB of compressed
	// payload, which is far beyond any planned scan.
	chunkSortDigits = 5
)

// ErrNotFound reports that no snapshot or latest pointer exists yet. A reader
// must treat it as "nothing published" rather than as a transient failure.
var ErrNotFound = errors.New("snapshot not found")

// ErrPointerConflict reports that a pointer write was refused because it would
// move readers to an older scan, or because a different pointer is already
// stored for the same scan time. A publisher must treat it as a lost race, not
// as a transient failure to retry: the snapshot that is already published is
// the one that should keep serving.
var ErrPointerConflict = errors.New("latest snapshot pointer conflict")

// SnapshotPartition returns the partition key that holds one snapshot's chunks.
func SnapshotPartition(snapshotID string) string {
	return snapshotPartitionPrefix + snapshotID
}

// ChunkSort returns the sort key for one chunk index.
func ChunkSort(index int) string {
	return fmt.Sprintf("%s%0*d", chunkSortPrefix, chunkSortDigits, index)
}

// Latest is the pointer to the newest valid snapshot. Readers resolve it first
// and then fetch the chunks it names. A publisher writes it only after every
// chunk is stored and read back successfully, so a failed scan or a partial
// write leaves the previous snapshot serving.
type Latest struct {
	FormatVersion      int          `json:"format_version"`
	SnapshotID         string       `json:"snapshot_id"`
	ScannedAt          time.Time    `json:"scanned_at"`
	PublishedAt        time.Time    `json:"published_at"`
	Checksum           string       `json:"checksum"`
	CompressedChecksum string       `json:"compressed_checksum"`
	RawBytes           int          `json:"raw_bytes"`
	CompressedBytes    int          `json:"compressed_bytes"`
	ChunkCount         int          `json:"chunk_count"`
	Names              int          `json:"names"`
	Counts             Counts       `json:"counts"`
	Sources            []SourceList `json:"sources"`
	ScanAge            ScanAgeInput `json:"scan_age"`
}

// ResolveScanAge reports the staleness of the published snapshot at now.
func (l Latest) ResolveScanAge(now time.Time) ScanAge {
	return l.ScanAge.At(l.ScannedAt, now)
}

// Clone returns a deep copy of a pointer, so a caller cannot reach through the
// counts map or the source slice and change published or stored state.
func (l Latest) Clone() Latest {
	clone := l
	clone.Counts = cloneCounts(l.Counts)
	clone.Sources = cloneSources(l.Sources)
	return clone
}

// Validate rejects a pointer that cannot describe a real snapshot. The summary
// fields a client reads without fetching any chunk - the counts, the source
// lists, and the staleness thresholds - must be internally consistent, because a
// reader that trusts them has nothing else to check them against.
func (l Latest) Validate() error {
	if l.FormatVersion != FormatVersion {
		return fmt.Errorf("unsupported latest pointer format version %d (want %d)", l.FormatVersion, FormatVersion)
	}
	if err := ValidateSnapshotID(l.SnapshotID); err != nil {
		return err
	}
	if l.ScannedAt.IsZero() {
		return fmt.Errorf("latest pointer needs a scan time")
	}
	if l.PublishedAt.IsZero() {
		return fmt.Errorf("latest pointer needs a publication time")
	}
	// Both timestamps are canonical for the same reason the snapshot scan time
	// is: a hand-written pointer must not be able to move the serialized bytes.
	if !l.ScannedAt.Equal(canonicalTime(l.ScannedAt)) || l.ScannedAt.Location() != time.UTC {
		return fmt.Errorf("latest pointer scan time must be UTC with second precision")
	}
	if !l.PublishedAt.Equal(canonicalTime(l.PublishedAt)) || l.PublishedAt.Location() != time.UTC {
		return fmt.Errorf("latest pointer publication time must be UTC with second precision")
	}
	if len(l.Checksum) != 64 || len(l.CompressedChecksum) != 64 {
		return fmt.Errorf("latest pointer needs hex SHA-256 checksums")
	}
	if l.ChunkCount < 1 {
		return fmt.Errorf("latest pointer needs at least one chunk")
	}
	if l.RawBytes < 1 || l.CompressedBytes < 1 {
		return fmt.Errorf("latest pointer needs positive byte counts")
	}
	if l.Names < 0 {
		return fmt.Errorf("latest pointer reports a negative name count")
	}

	expectedSources, err := normalizeSources(l.Sources)
	if err != nil {
		return err
	}
	sourceNames := 0
	for i, source := range l.Sources {
		if source != expectedSources[i] {
			return fmt.Errorf("latest pointer source lists are not sorted by id")
		}
		sourceNames += source.Names
	}
	if sourceNames != l.Names {
		return fmt.Errorf("latest pointer source lists account for %d names but the pointer reports %d", sourceNames, l.Names)
	}

	scanAge, err := DeriveScanAgeInput(l.Sources)
	if err != nil {
		return err
	}
	if l.ScanAge != scanAge {
		return fmt.Errorf("latest pointer scan age thresholds disagree with the source cadences")
	}

	if len(l.Counts) != len(ens.Statuses) {
		return fmt.Errorf("latest pointer counts must list every lifecycle status")
	}
	counted := 0
	for _, status := range ens.Statuses {
		count, ok := l.Counts[status]
		if !ok {
			return fmt.Errorf("latest pointer counts are missing status %q", status)
		}
		if count < 0 {
			return fmt.Errorf("latest pointer reports a negative %q count", status)
		}
		counted += count
	}
	// Every result lands in exactly one status, so the counts always sum to the
	// name total. Checking it here catches an edited summary on the cheap path
	// that reads only the pointer, without fetching and decompressing a chunk.
	if counted != l.Names {
		return fmt.Errorf("latest pointer counts sum to %d but the pointer reports %d names", counted, l.Names)
	}
	return nil
}

// ChunkStore stores immutable snapshot chunks.
//
// A complete stored chunk set is never revised. An incomplete one is not a
// snapshot yet, so it carries no immutability claim: a chunk write can fail part
// way through, and a backend that retries unprocessed batch writes leaves a
// partial set behind as a matter of course. Refusing that retry would strand the
// scan under an ID that can never be published. Implementations must apply this
// rule to a write against an existing snapshot ID:
//
//   - a stored set that assembles and is byte-identical to the incoming chunks
//     succeeds and writes nothing;
//   - a stored set that assembles but differs in bytes, count, order, index, or
//     checksum is rejected, because that would revise a published snapshot;
//   - a stored set that cannot be read, or that reads but does not assemble into
//     a complete self-consistent set, is replaced.
//
// The pointer is written last and names only verified chunks, so a replaceable
// set is one no reader was ever sent to.
type ChunkStore interface {
	PutChunks(ctx context.Context, snapshotID string, chunks []Chunk) error
	GetChunks(ctx context.Context, snapshotID string) ([]Chunk, error)
	DeleteChunks(ctx context.Context, snapshotID string) error
}

// chunkWriteDecision is what PutChunks must do about chunks already stored under
// the snapshot ID it was asked to write.
type chunkWriteDecision int

const (
	// chunkWriteReplace covers a stored set that is unreadable or incomplete.
	chunkWriteReplace chunkWriteDecision = iota
	// chunkWriteSkip is the idempotent no-op for an identical complete set.
	chunkWriteSkip
	// chunkWriteRefuse protects a complete set from being revised.
	chunkWriteRefuse
)

// decideChunkWrite applies the ChunkStore rule. storedErr is whatever the store
// hit reading the existing chunks back, which counts as "cannot be read".
func decideChunkWrite(snapshotID string, stored []Chunk, storedErr error, incoming []Chunk) (chunkWriteDecision, error) {
	if storedErr != nil {
		return chunkWriteReplace, nil
	}
	// Assemble is the definition of a complete self-consistent set: it proves the
	// count, the index order, the sizes, and every chunk checksum.
	if _, err := Assemble(snapshotID, stored); err != nil {
		return chunkWriteReplace, nil
	}
	identical, err := chunksIdentical(stored, incoming)
	if err != nil {
		return chunkWriteRefuse, err
	}
	if identical {
		return chunkWriteSkip, nil
	}
	return chunkWriteRefuse, nil
}

// errChunksImmutable is the refusal for a complete stored set that differs.
func errChunksImmutable(snapshotID string) error {
	return fmt.Errorf("snapshot %s already exists and chunks are immutable", snapshotID)
}

// chunksIdentical reports whether two chunk sets are the same on the wire, which
// is what makes storing them a second time a safe no-op. Comparing the canonical
// JSON of each chunk covers the payload bytes and the whole envelope, so a
// difference in index, count, order, or checksum is never treated as identical.
func chunksIdentical(stored, incoming []Chunk) (bool, error) {
	if len(stored) != len(incoming) {
		return false, nil
	}
	for i := range stored {
		left, err := json.Marshal(stored[i])
		if err != nil {
			return false, err
		}
		right, err := json.Marshal(incoming[i])
		if err != nil {
			return false, err
		}
		if !bytes.Equal(left, right) {
			return false, nil
		}
	}
	return true, nil
}

// LatestStore stores the single pointer to the newest valid snapshot.
// GetLatest returns ErrNotFound before anything is published.
//
// PutLatest only ever moves readers forward. Scans overlap: a slow run can
// finish after the next scheduled run, and a retried run can finish after a
// later one, so an unconditional write would silently serve an older scan.
// Implementations must apply this rule against the stored pointer:
//
//   - an older ScannedAt is rejected with ErrPointerConflict;
//   - the same ScannedAt with an otherwise identical pointer succeeds and stores
//     nothing new, so retrying one publication is safe;
//   - the same ScannedAt with any other difference is rejected with
//     ErrPointerConflict as a same-time conflict;
//   - a newer ScannedAt replaces the stored pointer.
//
// The rule compares scans, so it applies only to a stored pointer that can be
// read and validated. A missing, unparseable, corrupt, or unsupported-version
// pointer says nothing about which scan is newer and must be replaceable, or a
// FormatVersion bump would wedge an existing store with no way to publish into
// it. GetLatest and Read still fail closed on such a pointer and never repair
// one, so this narrowing only ever affects the publication path.
//
// Replacing an unreadable pointer must preserve it. It is the only evidence of
// why publication was blocked, so an implementation moves it to a distinct
// non-colliding location that reads never consult, and only then installs the new
// pointer. Preserving it is not best effort: if the old pointer cannot be kept,
// the write fails rather than destroying it.
//
// A real backend enforces this with a conditional write on ScannedAt rather than
// a read followed by a write, so two concurrent publishers cannot both win.
type LatestStore interface {
	PutLatest(ctx context.Context, latest Latest) error
	GetLatest(ctx context.Context) (Latest, error)
}

// checkPutLatest applies the LatestStore ordering rule. The first return value
// reports whether the caller should store the incoming pointer; false with a nil
// error is the accepted no-op for an identical retry, which leaves the stored
// PublishedAt as the first attempt recorded it.
func checkPutLatest(stored *Latest, incoming Latest) (bool, error) {
	if stored == nil {
		return true, nil
	}
	if incoming.ScannedAt.Before(stored.ScannedAt) {
		return false, fmt.Errorf(
			"%w: snapshot %s was scanned at %s, before the published snapshot %s at %s",
			ErrPointerConflict,
			incoming.SnapshotID, incoming.ScannedAt.Format(time.RFC3339),
			stored.SnapshotID, stored.ScannedAt.Format(time.RFC3339),
		)
	}
	if incoming.ScannedAt.Equal(stored.ScannedAt) {
		identical, err := pointersIdentical(*stored, incoming)
		if err != nil {
			return false, err
		}
		if identical {
			return false, nil
		}
		return false, fmt.Errorf(
			"%w: snapshot %s disagrees with the published snapshot %s at the same scan time %s",
			ErrPointerConflict,
			incoming.SnapshotID, stored.SnapshotID, stored.ScannedAt.Format(time.RFC3339),
		)
	}
	return true, nil
}

// pointersIdentical compares two pointers by their canonical JSON, which is the
// same form a backend stores, so "identical" means identical on the wire.
//
// PublishedAt is excluded because it describes the write and not the scan. A
// retry samples its own publication clock, and refusing it over that one field
// would make the same-scan-time no-op unreachable. Every other field, including
// both checksums and the whole summary, must still match exactly.
func pointersIdentical(left, right Latest) (bool, error) {
	left.PublishedAt = time.Time{}
	right.PublishedAt = time.Time{}
	leftBytes, err := json.Marshal(left)
	if err != nil {
		return false, err
	}
	rightBytes, err := json.Marshal(right)
	if err != nil {
		return false, err
	}
	return bytes.Equal(leftBytes, rightBytes), nil
}

// Store is the full surface a publisher needs. Later AWS code implements this
// interface, and MemoryStore and FileStore implement it locally, so publication
// and read logic is written and tested once.
type Store interface {
	ChunkStore
	LatestStore
}

// Publish writes a snapshot and then makes it visible, in this order:
//
//  1. encode, compress, checksum, and chunk the snapshot;
//  2. write every chunk under the new snapshot ID;
//  3. read the chunks back and verify them against the pointer;
//  4. write the pointer last.
//
// If any step fails the pointer is untouched, so readers keep serving the
// previous snapshot. Step 4 also enforces the LatestStore ordering rule, so a
// scan that finishes out of order is refused with ErrPointerConflict rather than
// moving readers back to an older scan. The refusal is returned to the caller;
// the chunks it already wrote are left for retention to remove.
//
// Publish is safe to retry with the same snapshot after a transient failure, and
// may be called with a freshly sampled publishedAt: step 2 accepts the chunks it
// already stored because they are identical, and step 4 accepts the pointer
// because PublishedAt is not part of pointer identity. A retry that reaches step
// 4 after the pointer was already written returns the pointer it would have
// written, which differs from the stored one only in PublishedAt.
func Publish(ctx context.Context, store Store, snapshot Snapshot, publishedAt time.Time) (Latest, error) {
	if store == nil {
		return Latest{}, fmt.Errorf("snapshot store is required")
	}
	payload, err := Encode(snapshot)
	if err != nil {
		return Latest{}, err
	}
	latest := payload.Latest(publishedAt)
	if err := latest.Validate(); err != nil {
		return Latest{}, err
	}

	if err := store.PutChunks(ctx, latest.SnapshotID, payload.Chunks); err != nil {
		return Latest{}, fmt.Errorf("write snapshot %s chunks: %w", latest.SnapshotID, err)
	}

	stored, err := store.GetChunks(ctx, latest.SnapshotID)
	if err != nil {
		return Latest{}, fmt.Errorf("read back snapshot %s chunks: %w", latest.SnapshotID, err)
	}
	if _, err := Verify(latest, stored); err != nil {
		return Latest{}, fmt.Errorf("verify snapshot %s: %w", latest.SnapshotID, err)
	}

	if err := store.PutLatest(ctx, latest); err != nil {
		return Latest{}, fmt.Errorf("publish snapshot %s: %w", latest.SnapshotID, err)
	}
	return latest, nil
}

// Read resolves the latest pointer and returns the verified snapshot it names.
func Read(ctx context.Context, store Store) (Snapshot, Latest, error) {
	if store == nil {
		return Snapshot{}, Latest{}, fmt.Errorf("snapshot store is required")
	}
	latest, err := store.GetLatest(ctx)
	if err != nil {
		return Snapshot{}, Latest{}, err
	}
	chunks, err := store.GetChunks(ctx, latest.SnapshotID)
	if err != nil {
		return Snapshot{}, Latest{}, fmt.Errorf("read snapshot %s chunks: %w", latest.SnapshotID, err)
	}
	snapshot, err := Verify(latest, chunks)
	if err != nil {
		return Snapshot{}, Latest{}, err
	}
	return snapshot, latest, nil
}
