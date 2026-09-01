package snapshot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// FileStore is a local-directory Store. It exists so the scanner, the read API,
// and the frontend can be developed against a real publish-and-read cycle
// without AWS credentials, and so fixtures can be inspected by hand.
//
// Layout under the root directory:
//
//	latest.json
//	snapshots/<snapshot-id>/chunk-00000.json
//	snapshots/<snapshot-id>/chunk-00001.json
//
// Each chunk file is one JSON-encoded Chunk, including its checksum, so a
// hand-edited file fails verification exactly as a corrupt stored item would.
type FileStore struct {
	root string
}

const (
	fileStoreLatestName = "latest.json"
	fileStoreChunkDir   = "snapshots"
	fileStoreChunkGlob  = "chunk-"
	fileStoreChunkExt   = ".json"
)

// NewFileStore returns a store rooted at dir. The directory is created on
// first write.
func NewFileStore(dir string) *FileStore {
	return &FileStore{root: dir}
}

// PutChunks writes chunks for a snapshot that does not exist yet.
func (s *FileStore) PutChunks(ctx context.Context, snapshotID string, chunks []Chunk) error {
	if err := checkPutChunks(ctx, snapshotID, chunks); err != nil {
		return err
	}
	dir := s.snapshotDir(snapshotID)
	if _, err := os.Stat(dir); err == nil {
		return fmt.Errorf("snapshot %s already exists and chunks are immutable", snapshotID)
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, chunk := range chunks {
		encoded, err := json.Marshal(chunk)
		if err != nil {
			return err
		}
		name := fmt.Sprintf("%s%0*d%s", fileStoreChunkGlob, chunkSortDigits, chunk.Index, fileStoreChunkExt)
		if err := writeFileAtomically(filepath.Join(dir, name), encoded); err != nil {
			return err
		}
	}
	return nil
}

// GetChunks reads a snapshot's chunk files in index order.
func (s *FileStore) GetChunks(ctx context.Context, snapshotID string) ([]Chunk, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.snapshotDir(snapshotID))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("chunks for snapshot %s: %w", snapshotID, ErrNotFound)
		}
		return nil, err
	}

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, fileStoreChunkGlob) || !strings.HasSuffix(name, fileStoreChunkExt) {
			continue
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("chunks for snapshot %s: %w", snapshotID, ErrNotFound)
	}
	// Chunk file names are zero padded, so sorting them yields index order.
	sort.Strings(names)

	chunks := make([]Chunk, 0, len(names))
	for _, name := range names {
		encoded, err := os.ReadFile(filepath.Join(s.snapshotDir(snapshotID), name))
		if err != nil {
			return nil, err
		}
		var chunk Chunk
		if err := json.Unmarshal(encoded, &chunk); err != nil {
			return nil, fmt.Errorf("read snapshot %s chunk file %s: %w", snapshotID, name, err)
		}
		chunks = append(chunks, chunk)
	}
	return chunks, nil
}

// DeleteChunks removes a snapshot directory, standing in for the TTL that a real
// backend applies to superseded snapshots.
func (s *FileStore) DeleteChunks(ctx context.Context, snapshotID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return err
	}
	return os.RemoveAll(s.snapshotDir(snapshotID))
}

// PutLatest replaces the pointer file, applying the LatestStore ordering rule.
// The write is atomic, so a reader never observes a half-written pointer.
//
// The stored pointer must still be readable and valid: this store never
// overwrites a pointer it cannot understand, because that pointer may be the
// only record of what readers are currently served.
func (s *FileStore) PutLatest(ctx context.Context, latest Latest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := latest.Validate(); err != nil {
		return err
	}

	var stored *Latest
	current, err := s.GetLatest(ctx)
	if err == nil {
		stored = &current
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	write, err := checkPutLatest(stored, latest)
	if err != nil {
		return err
	}
	if !write {
		return nil
	}

	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return err
	}
	encoded, err := json.Marshal(latest)
	if err != nil {
		return err
	}
	return writeFileAtomically(filepath.Join(s.root, fileStoreLatestName), encoded)
}

// GetLatest reads the pointer file, or reports ErrNotFound before publication.
func (s *FileStore) GetLatest(ctx context.Context) (Latest, error) {
	if err := ctx.Err(); err != nil {
		return Latest{}, err
	}
	encoded, err := os.ReadFile(filepath.Join(s.root, fileStoreLatestName))
	if err != nil {
		if os.IsNotExist(err) {
			return Latest{}, fmt.Errorf("latest snapshot pointer: %w", ErrNotFound)
		}
		return Latest{}, err
	}
	var latest Latest
	if err := json.Unmarshal(encoded, &latest); err != nil {
		return Latest{}, fmt.Errorf("read latest snapshot pointer: %w", err)
	}
	if err := latest.Validate(); err != nil {
		return Latest{}, err
	}
	return latest, nil
}

func (s *FileStore) snapshotDir(snapshotID string) string {
	return filepath.Join(s.root, fileStoreChunkDir, snapshotID)
}

func writeFileAtomically(path string, payload []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".tmp-"+filepath.Base(path))
	if err != nil {
		return err
	}
	temporary := file.Name()
	if _, err := file.Write(payload); err != nil {
		file.Close()
		os.Remove(temporary)
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		os.Remove(temporary)
		return err
	}
	return nil
}
