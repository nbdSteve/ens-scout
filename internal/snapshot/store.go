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
//	PK                       SK                   Attributes
//	SNAPSHOT#<snapshot-id>   CHUNK#00000          payload, checksum, index, count, TTL
//	SNAPSHOT#<snapshot-id>   CHUNK#00001          payload, checksum, index, count, TTL
//	META                     LATEST               the Latest pointer
//	META                     STAGING#<snapshot-id> a staged snapshot, staged time, TTL
//
// Chunk sort keys are zero padded so lexical order matches numeric order and a
// single ranged query returns chunks already in index order. The staging markers
// share the pointer's partition so one prefix query finds every snapshot a
// publisher has begun writing.
const (
	// LatestPartition and LatestSort address the single latest pointer.
	LatestPartition = "META"
	LatestSort      = "LATEST"

	// ChunkSortPrefix begins every chunk sort key, so a backend can address one
	// snapshot's chunks and nothing else with a single prefix query.
	ChunkSortPrefix = "CHUNK#"

	// StagingSortPrefix begins every staging marker's sort key, so one prefix
	// query over LatestPartition lists them and nothing else.
	StagingSortPrefix = "STAGING#"

	snapshotPartitionPrefix = "SNAPSHOT#"
	// chunkSortDigits supports 99,999 chunks, about 18 GiB of compressed
	// payload, which is far beyond any planned scan.
	chunkSortDigits = 5
)

// ErrNotFound reports that no snapshot or latest pointer exists yet. A reader
// must treat it as "nothing published" rather than as a transient failure.
var ErrNotFound = errors.New("snapshot not found")

// ErrChunksMissing reports that the latest pointer resolved but the chunks it
// names are not stored.
//
// It is deliberately not ErrNotFound. An absent pointer means nothing has been
// published, which is an ordinary bootstrap; a pointer whose chunks are gone means
// a published snapshot disappeared under it, which is an anomaly worth reporting.
// A publisher that merges the previous snapshot forward has to tell them apart, or
// losing a whole group looks exactly like a first run.
var ErrChunksMissing = errors.New("the chunks the latest pointer names are missing")

// ChunksMissingError is ErrChunksMissing carrying the snapshot the pointer named,
// so a caller can report which snapshot disappeared without parsing a message.
type ChunksMissingError struct {
	SnapshotID string

	// Cause is the read error, kept for the message alone. It is deliberately not
	// unwrapped: it wraps ErrNotFound, and exposing that through this error would
	// make a vanished snapshot indistinguishable from an empty store again.
	Cause error
}

func (e *ChunksMissingError) Error() string {
	return fmt.Sprintf("snapshot %s is named by the latest pointer but its chunks are missing: %v",
		e.SnapshotID, e.Cause)
}

// Unwrap reports ErrChunksMissing and stops there, for the reason Cause documents.
func (e *ChunksMissingError) Unwrap() error { return ErrChunksMissing }

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
	return fmt.Sprintf("%s%0*d", ChunkSortPrefix, chunkSortDigits, index)
}

// StagingSort returns the sort key of one snapshot's staging marker.
func StagingSort(snapshotID string) string {
	return StagingSortPrefix + snapshotID
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
// A new scan gets a new snapshot ID, and a stored chunk is never mutated in place
// and never removed to make a write fit. A chunk write can still fail part way
// through, and a backend that retries unprocessed batch writes leaves a partial
// set behind as a matter of course, so a write against an existing snapshot ID
// resumes that interrupted write rather than replacing it. Implementations
// compare the stored chunks with the incoming ones index by index and must apply
// this rule:
//
//   - a stored chunk that is byte-identical to the incoming chunk at the same
//     index is left exactly as it is, so agreeing immutable data is never
//     rewritten;
//   - a write whose every incoming chunk is already stored succeeds and stores
//     nothing;
//   - only the incoming chunks whose index is not stored yet are written;
//   - the whole write is refused with the immutable-set error when a stored chunk
//     conflicts with the incoming chunk at its index, when one index is stored
//     twice, or when a stored index falls outside the incoming set. An incomplete
//     stored set earns no exemption from this: the incoming set is always
//     complete, so any of those means a different payload holds the same ID.
//
// Chunks that cannot be read are evidence of nothing. A read failure is returned
// to the caller to retry, and must never select a write, a removal, or a
// truncation, because a transient error would then destroy a published snapshot.
type ChunkStore interface {
	PutChunks(ctx context.Context, snapshotID string, chunks []Chunk) error
	GetChunks(ctx context.Context, snapshotID string) ([]Chunk, error)
	DeleteChunks(ctx context.Context, snapshotID string) error
}

// StagedSnapshot records that a publisher began writing one snapshot's chunks.
// StagedAt is when it last claimed that snapshot ID.
type StagedSnapshot struct {
	SnapshotID string    `json:"snapshot_id"`
	StagedAt   time.Time `json:"staged_at"`
}

// StagingStore records which snapshot IDs a publisher has begun writing, so a
// chunk set that never became the published snapshot can still be found and
// reclaimed.
//
// Chunks live in their own partition and only the latest pointer names one, so a
// publication that writes every chunk and then fails to move the pointer leaves a
// full chunk set that nothing references and no query can find. A publisher
// therefore writes a marker before the first chunk and removes it once the pointer
// has moved. The marker is durable by the time anything can go wrong, which is what
// makes this survive the failures that abandon a chunk set in the first place: a
// killed function, an expired context, a hard timeout, and a lost pointer race are
// exactly the cases that skip a deferred cleanup.
//
// Implementations must apply these rules:
//
//   - StageSnapshot overwrites any marker for the same snapshot ID and refreshes
//     StagedAt. A publisher that claims an ID again renews the grace period a
//     reclaimer waits out, which is what keeps a reclaimer from ever expiring
//     chunks another publisher is still writing.
//   - UnstageSnapshot is idempotent, so removing a marker that is not there
//     succeeds. A leftover marker costs one wasted reclaim attempt; a marker
//     removed too eagerly costs a chunk set nothing can find.
//   - StagedSnapshots returns every stored marker and never reports an empty set
//     from a read it could not complete. A reclaimer decides what to destroy from
//     it, so a failed read must be a failed read.
//
// A marker carries its own expiry, so a marker whose chunks are already reclaimed
// cannot accumulate. The expiry has to be far longer than the interval between
// reclaim passes: a marker that expires before its chunks are reclaimed leaves
// them unreachable again, which is the state this interface exists to prevent.
//
// Reclaiming is not part of this interface. Whether an expiry may be placed on a
// snapshot's chunks is LatestStore's business, because only the pointer says which
// snapshot readers are being served.
type StagingStore interface {
	StageSnapshot(ctx context.Context, snapshotID string, stagedAt, expiresAt time.Time) error
	UnstageSnapshot(ctx context.Context, snapshotID string) error
	StagedSnapshots(ctx context.Context) ([]StagedSnapshot, error)
}

// ValidateStaging is the check every StageSnapshot implementation runs on its
// arguments: a live context, a usable snapshot ID, and an expiry that outlives the
// moment the snapshot was staged. A marker that expires at or before its own
// staging time would vanish before any reclaim pass could act on it.
func ValidateStaging(ctx context.Context, snapshotID string, stagedAt, expiresAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return err
	}
	if stagedAt.IsZero() {
		return fmt.Errorf("staging snapshot %s needs the time it was staged", snapshotID)
	}
	if !expiresAt.After(stagedAt) {
		return fmt.Errorf("staging snapshot %s needs an expiry after its staging time", snapshotID)
	}
	return nil
}

// ChunkWriteDecision is what PutChunks must do about chunks already stored under
// the snapshot ID it was asked to write.
type ChunkWriteDecision int

const (
	// ChunkWriteRefuse protects stored chunks from being revised. It is the zero
	// value so a decision that is never set cannot authorize a write.
	ChunkWriteRefuse ChunkWriteDecision = iota
	// ChunkWriteSkip is the idempotent no-op for a set that is already stored.
	ChunkWriteSkip
	// ChunkWriteResume writes the chunks an interrupted write did not store.
	ChunkWriteResume
)

// ErrChunksImmutable reports that a chunk write was refused because it would
// revise a stored snapshot. A publisher must treat it as a permanent conflict
// rather than a transient failure: the stored chunks are the published ones.
var ErrChunksImmutable = errors.New("snapshot chunks are immutable")

// ValidatePutChunks is the check every PutChunks implementation runs on its
// arguments before it touches storage: a live context, a usable snapshot ID, and a
// chunk set that assembles into a complete, in-order, checksum-clean payload for
// that ID. Rejecting an incomplete or mislabelled set here is what lets
// PlanChunkWrite treat the incoming set as whole, which is how a stored index
// outside it proves a different payload holds the same ID.
func ValidatePutChunks(ctx context.Context, snapshotID string, chunks []Chunk) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return err
	}
	if _, err := Assemble(snapshotID, chunks); err != nil {
		return err
	}
	return nil
}

// ChunkConflictError builds the refusal every backend returns for a conflicting
// chunk write, so callers can match one error against every store.
func ChunkConflictError(snapshotID string) error {
	return errChunksImmutable(snapshotID)
}

// PlanChunkWrite applies the ChunkStore rule to chunks already stored under the
// snapshot ID. On ChunkWriteResume the second return value is the subset of
// incoming chunks that are missing and may be written; every other stored chunk
// stays untouched.
//
// It is exported so a real storage backend decides exactly as MemoryStore and
// FileStore do. The rule is part of the contract, so no backend restates it.
//
// A caller that could not read the stored chunks must not call this: an
// unreadable set is not a statement about what is stored, so it can neither
// authorize a write nor prove a conflict.
func PlanChunkWrite(stored, incoming []Chunk) (ChunkWriteDecision, []Chunk, error) {
	if len(stored) == 0 {
		return ChunkWriteResume, incoming, nil
	}

	storedByIndex := make(map[int]Chunk, len(stored))
	for _, chunk := range stored {
		if _, exists := storedByIndex[chunk.Index]; exists {
			return ChunkWriteRefuse, nil, nil
		}
		storedByIndex[chunk.Index] = chunk
	}
	// ValidatePutChunks assembled the incoming set first, so its length is the
	// whole chunk count. A stored index outside it belongs to some other payload.
	for index := range storedByIndex {
		if index < 0 || index >= len(incoming) {
			return ChunkWriteRefuse, nil, nil
		}
	}

	missing := make([]Chunk, 0, len(incoming))
	for _, want := range incoming {
		have, exists := storedByIndex[want.Index]
		if !exists {
			missing = append(missing, want)
			continue
		}
		identical, err := chunkIdentical(have, want)
		if err != nil {
			return ChunkWriteRefuse, nil, err
		}
		if !identical {
			return ChunkWriteRefuse, nil, nil
		}
	}
	if len(missing) == 0 {
		return ChunkWriteSkip, nil, nil
	}
	return ChunkWriteResume, missing, nil
}

// errChunksImmutable is the refusal for a stored set that differs.
func errChunksImmutable(snapshotID string) error {
	return fmt.Errorf("snapshot %s already exists and chunks are immutable: %w", snapshotID, ErrChunksImmutable)
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
		identical, err := chunkIdentical(stored[i], incoming[i])
		if err != nil {
			return false, err
		}
		if !identical {
			return false, nil
		}
	}
	return true, nil
}

// chunkIdentical compares one chunk with another by canonical JSON, so the whole
// envelope counts and not just the payload bytes: a difference in index, count, or
// checksum is never treated as identical.
func chunkIdentical(stored, incoming Chunk) (bool, error) {
	left, err := json.Marshal(stored)
	if err != nil {
		return false, err
	}
	right, err := json.Marshal(incoming)
	if err != nil {
		return false, err
	}
	return bytes.Equal(left, right), nil
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

// PlanLatestWrite applies the LatestStore ordering rule against the pointer a
// backend read, and reports whether the incoming pointer should be stored. False
// with a nil error is the accepted no-op for an identical retry, which leaves the
// stored PublishedAt as the first attempt recorded it.
//
// stored is nil when there is nothing to compare scans with, which covers both an
// absent pointer and one the backend could not read or validate. LatestStore
// documents why an unreadable pointer must be replaceable, and why replacing one
// has to preserve it first.
//
// It is exported for the same reason PlanChunkWrite is: a real storage backend
// decides exactly as MemoryStore and FileStore do, and no backend restates the
// rule. A backend that enforces the same ordering with a conditional write still
// calls this first, so the two can never disagree about what is a conflict.
func PlanLatestWrite(stored *Latest, incoming Latest) (bool, error) {
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
// moving readers back to an older scan. The refusal is returned to the caller,
// which leaves a complete chunk set no pointer names. Publish does not reclaim it:
// a caller that may fail this way stages the snapshot ID through StagingStore
// first, so the abandoned set stays findable after the process is gone.
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
//
// ErrNotFound means nothing is published. A pointer that resolves but whose chunks
// are absent reports ChunksMissingError instead, so a caller can tell a bootstrap
// from a published snapshot that disappeared.
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
		if errors.Is(err, ErrNotFound) {
			return Snapshot{}, Latest{}, &ChunksMissingError{SnapshotID: latest.SnapshotID, Cause: err}
		}
		return Snapshot{}, Latest{}, fmt.Errorf("read snapshot %s chunks: %w", latest.SnapshotID, err)
	}
	snapshot, err := Verify(latest, chunks)
	if err != nil {
		return Snapshot{}, Latest{}, err
	}
	return snapshot, latest, nil
}
