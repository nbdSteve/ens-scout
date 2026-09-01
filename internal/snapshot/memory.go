package snapshot

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// MemoryStore records staged snapshots as well as published ones.
var _ StagingStore = (*MemoryStore)(nil)

// MemoryStore is an in-memory Store for tests and local runs. It deep copies
// chunk bytes and pointers on the way in and out, so a caller cannot reach into
// stored state, and it applies the same ChunkStore and LatestStore rules a real
// backend must: a new scan gets a new snapshot ID, a stored chunk is never mutated
// in place, a write whose chunks are all stored already is an idempotent no-op, a
// conflicting write is refused, and only a chunk index missing from an interrupted
// write is filled in. FileStore gets the copying for free because it serializes to
// JSON.
type MemoryStore struct {
	mutex     sync.RWMutex
	chunks    map[string][]Chunk
	staged    map[string]StagedSnapshot
	latest    *Latest
	published bool
}

// NewMemoryStore returns an empty store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		chunks: make(map[string][]Chunk),
		staged: make(map[string]StagedSnapshot),
	}
}

// PutChunks stores chunks under a snapshot ID, applying the ChunkStore rule to
// anything already stored there. Only missing indices are added, and the stored
// chunks keep the exact bytes they already held.
func (s *MemoryStore) PutChunks(ctx context.Context, snapshotID string, chunks []Chunk) error {
	if err := ValidatePutChunks(ctx, snapshotID, chunks); err != nil {
		return err
	}
	s.mutex.Lock()
	defer s.mutex.Unlock()
	existing := s.chunks[snapshotID]
	decision, missing, err := PlanChunkWrite(existing, chunks)
	if err != nil {
		return err
	}
	switch decision {
	case ChunkWriteSkip:
		return nil
	case ChunkWriteRefuse:
		return errChunksImmutable(snapshotID)
	}
	s.chunks[snapshotID] = mergeStoredChunks(existing, missing)
	return nil
}

// mergeStoredChunks adds clones of the missing chunks to the stored ones and
// returns them in index order. The stored entries are carried across by value, so
// their payload bytes are the same arrays the store already held.
func mergeStoredChunks(stored, missing []Chunk) []Chunk {
	merged := make([]Chunk, 0, len(stored)+len(missing))
	merged = append(merged, stored...)
	merged = append(merged, CloneChunks(missing)...)
	sort.Slice(merged, func(i, j int) bool {
		return merged[i].Index < merged[j].Index
	})
	return merged
}

// GetChunks returns the stored chunks in index order.
func (s *MemoryStore) GetChunks(ctx context.Context, snapshotID string) ([]Chunk, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return nil, err
	}
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	chunks, exists := s.chunks[snapshotID]
	if !exists {
		return nil, fmt.Errorf("chunks for snapshot %s: %w", snapshotID, ErrNotFound)
	}
	return CloneChunks(chunks), nil
}

// DeleteChunks removes a snapshot's chunks, standing in for the TTL that a real
// backend applies to superseded snapshots.
func (s *MemoryStore) DeleteChunks(ctx context.Context, snapshotID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return err
	}
	s.mutex.Lock()
	defer s.mutex.Unlock()
	delete(s.chunks, snapshotID)
	return nil
}

// PutLatest moves the pointer forward, applying the LatestStore ordering rule.
// Holding the write lock across the comparison and the write stands in for the
// conditional write a real backend uses. This store only ever holds a pointer it
// already validated, so it has no unreadable-pointer case to narrow around.
func (s *MemoryStore) PutLatest(ctx context.Context, latest Latest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := latest.Validate(); err != nil {
		return err
	}
	s.mutex.Lock()
	defer s.mutex.Unlock()
	write, err := PlanLatestWrite(s.latest, latest)
	if err != nil {
		return err
	}
	if !write {
		return nil
	}
	stored := latest.Clone()
	s.latest = &stored
	s.published = true
	return nil
}

// GetLatest returns the pointer, or ErrNotFound before anything is published.
func (s *MemoryStore) GetLatest(ctx context.Context) (Latest, error) {
	if err := ctx.Err(); err != nil {
		return Latest{}, err
	}
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	if !s.published {
		return Latest{}, fmt.Errorf("latest snapshot pointer: %w", ErrNotFound)
	}
	return s.latest.Clone(), nil
}

// StageSnapshot records that a publisher is about to write a snapshot's chunks,
// refreshing the staging time when the same ID is claimed again.
//
// The expiry is validated and then discarded: this store has no clock to expire a
// marker against, and no test outlives one. A real backend stores it as the item's
// TTL, which is what keeps markers from accumulating there.
func (s *MemoryStore) StageSnapshot(ctx context.Context, snapshotID string, stagedAt, expiresAt time.Time) error {
	if err := ValidateStaging(ctx, snapshotID, stagedAt, expiresAt); err != nil {
		return err
	}
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.staged[snapshotID] = StagedSnapshot{SnapshotID: snapshotID, StagedAt: stagedAt.UTC()}
	return nil
}

// UnstageSnapshot removes a staging marker. Removing one that is not there
// succeeds, so a publisher may unstage without first checking.
func (s *MemoryStore) UnstageSnapshot(ctx context.Context, snapshotID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return err
	}
	s.mutex.Lock()
	defer s.mutex.Unlock()
	delete(s.staged, snapshotID)
	return nil
}

// StagedSnapshots returns every staging marker, sorted by snapshot ID. A real
// backend returns them in sort-key order, which is the same order, so a caller
// cannot come to depend on one store's iteration order.
func (s *MemoryStore) StagedSnapshots(ctx context.Context) ([]StagedSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	staged := make([]StagedSnapshot, 0, len(s.staged))
	for _, entry := range s.staged {
		staged = append(staged, entry)
	}
	sort.Slice(staged, func(i, j int) bool {
		return staged[i].SnapshotID < staged[j].SnapshotID
	})
	return staged, nil
}

// SnapshotIDs returns the stored snapshot IDs in no particular order. It exists
// so tests can assert retention behavior.
func (s *MemoryStore) SnapshotIDs() []string {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	ids := make([]string, 0, len(s.chunks))
	for id := range s.chunks {
		ids = append(ids, id)
	}
	return ids
}

// CorruptChunk overwrites one byte of a stored chunk without updating its
// checksum, so tests can prove that readers fail closed on corruption.
func (s *MemoryStore) CorruptChunk(snapshotID string, index int) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	chunks, exists := s.chunks[snapshotID]
	if !exists {
		return fmt.Errorf("chunks for snapshot %s: %w", snapshotID, ErrNotFound)
	}
	if index < 0 || index >= len(chunks) {
		return fmt.Errorf("snapshot %s has no chunk %d", snapshotID, index)
	}
	if len(chunks[index].Bytes) == 0 {
		return fmt.Errorf("snapshot %s chunk %d is empty", snapshotID, index)
	}
	chunks[index].Bytes[0] ^= 0xff
	return nil
}

// TruncateChunks drops the stored chunks in [from, to), standing in for a chunk
// write that stopped part way through, so tests can prove an incomplete set does
// not lock the snapshot ID.
func (s *MemoryStore) TruncateChunks(snapshotID string, from, to int) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	chunks, exists := s.chunks[snapshotID]
	if !exists {
		return
	}
	if from < 0 {
		from = 0
	}
	if to > len(chunks) {
		to = len(chunks)
	}
	if from >= to {
		return
	}
	kept := make([]Chunk, 0, len(chunks)-(to-from))
	kept = append(kept, chunks[:from]...)
	kept = append(kept, chunks[to:]...)
	s.chunks[snapshotID] = kept
}
