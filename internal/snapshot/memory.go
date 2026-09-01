package snapshot

import (
	"context"
	"fmt"
	"sync"
)

// MemoryStore is an in-memory Store for tests and local runs. It deep copies
// chunk bytes and pointers on the way in and out, and it refuses to overwrite an
// existing snapshot ID, so it enforces the same immutability rule a real backend
// must. FileStore gets that for free because it serializes to JSON.
type MemoryStore struct {
	mutex     sync.RWMutex
	chunks    map[string][]Chunk
	latest    *Latest
	published bool
}

// NewMemoryStore returns an empty store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{chunks: make(map[string][]Chunk)}
}

// PutChunks stores chunks for a snapshot that does not exist yet.
func (s *MemoryStore) PutChunks(ctx context.Context, snapshotID string, chunks []Chunk) error {
	if err := checkPutChunks(ctx, snapshotID, chunks); err != nil {
		return err
	}
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if _, exists := s.chunks[snapshotID]; exists {
		return fmt.Errorf("snapshot %s already exists and chunks are immutable", snapshotID)
	}
	s.chunks[snapshotID] = CloneChunks(chunks)
	return nil
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

// PutLatest replaces the pointer.
func (s *MemoryStore) PutLatest(ctx context.Context, latest Latest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := latest.Validate(); err != nil {
		return err
	}
	s.mutex.Lock()
	defer s.mutex.Unlock()
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

func checkPutChunks(ctx context.Context, snapshotID string, chunks []Chunk) error {
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
