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
	"time"
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
//	staging/<snapshot-id>.json
//
// Each chunk file is one JSON-encoded Chunk, including its checksum, so a
// hand-edited file fails verification exactly as a corrupt stored item would.
type FileStore struct {
	root string
}

// FileStore records staged snapshots as well as published ones, so both local
// fakes offer the same surface the real backend does.
var _ StagingStore = (*FileStore)(nil)

const (
	fileStoreLatestName = "latest.json"
	fileStoreChunkDir   = "snapshots"
	fileStoreStagingDir = "staging"
	fileStoreChunkGlob  = "chunk-"
	fileStoreChunkExt   = ".json"
	// fileStoreQuarantinePrefix names a pointer file kept for diagnosis rather
	// than for serving. GetLatest reads only fileStoreLatestName, so a quarantined
	// pointer is never served.
	fileStoreQuarantinePrefix = "latest.invalid-"
	// maxQuarantineAttempts bounds the search for a free quarantine path.
	maxQuarantineAttempts = 100
)

// NewFileStore returns a store rooted at dir. The directory is created on
// first write.
func NewFileStore(dir string) *FileStore {
	return &FileStore{root: dir}
}

// PutChunks writes chunks under a snapshot ID, applying the ChunkStore rule to
// anything already in the directory. It only ever creates chunk files that are
// missing, so a directory holding a prefix of an interrupted write is completed
// and no existing chunk file is rewritten or removed.
//
// A chunk directory that cannot be read is left alone and the read error is
// returned, because a cancelled context or an I/O failure says nothing about what
// is stored and must not be able to destroy a published snapshot.
func (s *FileStore) PutChunks(ctx context.Context, snapshotID string, chunks []Chunk) error {
	if err := ValidatePutChunks(ctx, snapshotID, chunks); err != nil {
		return err
	}
	existing, err := s.GetChunks(ctx, snapshotID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
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

	dir := s.snapshotDir(snapshotID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, chunk := range missing {
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
// An unreadable stored pointer is quarantined rather than overwritten, because it
// is the only evidence of why publication was blocked. Quarantining happens
// before the new pointer is installed and is not best effort: if the old file
// cannot be preserved, the publication fails instead of destroying it.
func (s *FileStore) PutLatest(ctx context.Context, latest Latest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := latest.Validate(); err != nil {
		return err
	}

	stored, quarantine, err := s.orderingPointer()
	if err != nil {
		return err
	}
	write, err := PlanLatestWrite(stored, latest)
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
	if quarantine {
		if err := s.quarantineLatest(latest.PublishedAt); err != nil {
			return err
		}
	}
	return writeFileAtomically(filepath.Join(s.root, fileStoreLatestName), encoded)
}

// orderingPointer returns the stored pointer the ordering rule is applied
// against, or nil when there is nothing to compare scans with. The second return
// value reports that a file is present but unreadable, so it needs quarantining
// before it is replaced.
//
// A pointer file that is missing, unparseable, or invalid under the current
// build, including one carrying an unsupported FormatVersion, yields nil so it
// can be replaced. It cannot say which scan is newer, and treating it as a
// blocker would wedge the directory until someone deleted the file by hand.
// Only a real I/O failure is returned, because that is transient rather than a
// statement about the stored scan. GetLatest still fails closed on any pointer
// this treats as absent, so no reader is ever served one.
func (s *FileStore) orderingPointer() (*Latest, bool, error) {
	encoded, err := os.ReadFile(filepath.Join(s.root, fileStoreLatestName))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	var stored Latest
	if err := json.Unmarshal(encoded, &stored); err != nil {
		return nil, true, nil
	}
	if err := stored.Validate(); err != nil {
		return nil, true, nil
	}
	return &stored, false, nil
}

// quarantineLatest moves the unreadable pointer file aside so it survives as a
// diagnostic artifact. The name is derived from the publication time rather than
// from a fresh clock reading, so it is reproducible, and a counter keeps two
// quarantines at the same instant from colliding.
func (s *FileStore) quarantineLatest(publishedAt time.Time) error {
	current := filepath.Join(s.root, fileStoreLatestName)
	stamp := publishedAt.UTC().Format("20060102T150405Z")
	for attempt := 0; attempt < maxQuarantineAttempts; attempt++ {
		candidate := filepath.Join(s.root, fmt.Sprintf("%s%s", fileStoreQuarantinePrefix, stamp))
		if attempt > 0 {
			candidate = fmt.Sprintf("%s-%d", candidate, attempt)
		}
		candidate += fileStoreChunkExt
		if _, err := os.Stat(candidate); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return err
		}
		if err := os.Rename(current, candidate); err != nil {
			return fmt.Errorf("quarantine the unreadable latest pointer: %w", err)
		}
		return nil
	}
	return fmt.Errorf("quarantine the unreadable latest pointer: no free path after %d attempts", maxQuarantineAttempts)
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

// stagedSnapshot is one staging marker on disk. The expiry is recorded rather than
// acted on: a directory has no TTL, and a real backend expires the item itself.
type stagedSnapshot struct {
	SnapshotID string    `json:"snapshot_id"`
	StagedAt   time.Time `json:"staged_at"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// StageSnapshot writes a snapshot's staging marker, replacing any earlier one so a
// repeated claim refreshes the staging time.
func (s *FileStore) StageSnapshot(ctx context.Context, snapshotID string, stagedAt, expiresAt time.Time) error {
	if err := ValidateStaging(ctx, snapshotID, stagedAt, expiresAt); err != nil {
		return err
	}
	encoded, err := json.Marshal(stagedSnapshot{
		SnapshotID: snapshotID,
		StagedAt:   stagedAt.UTC(),
		ExpiresAt:  expiresAt.UTC(),
	})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(s.root, fileStoreStagingDir), 0o755); err != nil {
		return err
	}
	return writeFileAtomically(s.stagingPath(snapshotID), encoded)
}

// UnstageSnapshot removes a staging marker. Removing one that is not there
// succeeds, so a publisher may unstage without first checking.
func (s *FileStore) UnstageSnapshot(ctx context.Context, snapshotID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return err
	}
	if err := os.Remove(s.stagingPath(snapshotID)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// StagedSnapshots reads every staging marker, in snapshot ID order. It fails closed
// on a marker it cannot read, because a reclaimer decides what to destroy from this
// and must never be handed a partial view.
func (s *FileStore) StagedSnapshots(ctx context.Context) ([]StagedSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(s.root, fileStoreStagingDir))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, fileStoreChunkExt) {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)

	staged := make([]StagedSnapshot, 0, len(names))
	for _, name := range names {
		encoded, err := os.ReadFile(filepath.Join(s.root, fileStoreStagingDir, name))
		if err != nil {
			return nil, err
		}
		var marker stagedSnapshot
		if err := json.Unmarshal(encoded, &marker); err != nil {
			return nil, fmt.Errorf("read staging marker %s: %w", name, err)
		}
		if err := ValidateSnapshotID(marker.SnapshotID); err != nil {
			return nil, err
		}
		if want := marker.SnapshotID + fileStoreChunkExt; name != want {
			return nil, fmt.Errorf("staging marker %s names snapshot %q, want file %s", name, marker.SnapshotID, want)
		}
		staged = append(staged, StagedSnapshot{SnapshotID: marker.SnapshotID, StagedAt: marker.StagedAt.UTC()})
	}
	return staged, nil
}

func (s *FileStore) snapshotDir(snapshotID string) string {
	return filepath.Join(s.root, fileStoreChunkDir, snapshotID)
}

func (s *FileStore) stagingPath(snapshotID string) string {
	return filepath.Join(s.root, fileStoreStagingDir, snapshotID+fileStoreChunkExt)
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
