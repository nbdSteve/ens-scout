package snapshot

import (
	"context"
	"errors"
	"fmt"
	"time"
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

// Validate rejects a pointer that cannot describe a real snapshot.
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
	if _, err := DeriveScanAgeInput(l.Sources); err != nil {
		return err
	}
	return nil
}

// ChunkStore stores immutable snapshot chunks. Implementations must reject a
// write to a snapshot ID that already exists, because chunks are never revised.
type ChunkStore interface {
	PutChunks(ctx context.Context, snapshotID string, chunks []Chunk) error
	GetChunks(ctx context.Context, snapshotID string) ([]Chunk, error)
	DeleteChunks(ctx context.Context, snapshotID string) error
}

// LatestStore stores the single pointer to the newest valid snapshot.
// GetLatest returns ErrNotFound before anything is published.
type LatestStore interface {
	PutLatest(ctx context.Context, latest Latest) error
	GetLatest(ctx context.Context) (Latest, error)
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
// previous snapshot.
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
