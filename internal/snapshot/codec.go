package snapshot

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

const (
	// MaxItemBytes is DynamoDB's hard limit on one item, counting attribute
	// names and values. It is stated here as the budget that MaxChunkBytes is
	// derived from; this package never talks to DynamoDB.
	MaxItemBytes = 400 * 1024

	// MaxChunkBytes is the exact size of every chunk except the last one.
	//
	// The safety margin is deliberate. A 192 KiB chunk still fits inside the
	// 400 KiB item limit after a 4/3 base64 expansion (256 KiB), which is the
	// worst case if a storage backend keeps chunk bytes as a string attribute
	// instead of binary. That leaves at least 144 KiB for keys, checksums, the
	// chunk count, and a TTL attribute.
	MaxChunkBytes = 192 * 1024

	// MaxRawBytes bounds decompression so a corrupt or hostile stream cannot
	// exhaust memory. It is far above the largest planned scan: the current
	// three-, four-, and five-letter lists serialize to a few megabytes.
	MaxRawBytes = 64 * 1024 * 1024

	// compressionLevel is fixed so the compressed bytes depend only on the
	// canonical payload.
	compressionLevel = gzip.BestCompression
)

// maxRawBytes holds the effective decompression bound. Tests lower it to prove
// the bound is enforced without allocating MaxRawBytes.
var maxRawBytes = MaxRawBytes

// Payload is the serialized, compressed, and chunked form of a snapshot,
// together with the integrity data needed to reassemble and verify it.
type Payload struct {
	Metadata Metadata
	// Checksum is the SHA-256 of the canonical JSON. It identifies the logical
	// contents of a snapshot and does not change if the compressor changes.
	Checksum string
	// CompressedChecksum is the SHA-256 of the whole gzip stream. It proves
	// that reassembled chunks form the exact stream that was published.
	CompressedChecksum string
	RawBytes           int
	CompressedBytes    int
	Chunks             []Chunk
}

// Chunk is one immutable slice of a compressed snapshot. Chunks are never
// rewritten: a new scan gets a new snapshot ID and a new set of chunks.
type Chunk struct {
	SnapshotID string `json:"snapshot_id"`
	Index      int    `json:"index"`
	Count      int    `json:"count"`
	Checksum   string `json:"checksum"`
	Bytes      []byte `json:"bytes"`
}

// Clone returns a deep copy so callers cannot mutate stored chunk bytes.
func (c Chunk) Clone() Chunk {
	clone := c
	clone.Bytes = append([]byte(nil), c.Bytes...)
	return clone
}

// CloneChunks deep copies a slice of chunks.
func CloneChunks(chunks []Chunk) []Chunk {
	if chunks == nil {
		return nil
	}
	clones := make([]Chunk, 0, len(chunks))
	for _, chunk := range chunks {
		clones = append(clones, chunk.Clone())
	}
	return clones
}

// EncodeJSON returns the canonical JSON encoding of a snapshot. Struct field
// order is fixed by declaration order and map keys are sorted by
// encoding/json, so equal snapshots always produce equal bytes.
func EncodeJSON(snapshot Snapshot) ([]byte, error) {
	if err := snapshot.Validate(); err != nil {
		return nil, err
	}
	return json.Marshal(snapshot)
}

// Encode validates a snapshot, serializes it canonically, compresses it,
// checksums it, and splits it into deterministic chunks.
func Encode(snapshot Snapshot) (Payload, error) {
	raw, err := EncodeJSON(snapshot)
	if err != nil {
		return Payload{}, err
	}

	compressed, err := compress(raw)
	if err != nil {
		return Payload{}, err
	}

	return Payload{
		Metadata:           snapshot.Metadata,
		Checksum:           checksum(raw),
		CompressedChecksum: checksum(compressed),
		RawBytes:           len(raw),
		CompressedBytes:    len(compressed),
		Chunks:             split(snapshot.Metadata.SnapshotID, compressed),
	}, nil
}

// Decode reassembles chunks and returns the snapshot they hold. It fails closed
// on missing, duplicated, reordered, or corrupt chunks, and on any payload that
// is not in canonical form.
func Decode(chunks []Chunk) (Snapshot, error) {
	if len(chunks) == 0 {
		return Snapshot{}, fmt.Errorf("no snapshot chunks supplied")
	}
	compressed, err := Assemble(chunks[0].SnapshotID, chunks)
	if err != nil {
		return Snapshot{}, err
	}
	return decodeCompressed(compressed)
}

// Verify decodes chunks and additionally checks them against a latest pointer,
// so a reader never serves a snapshot that disagrees with what was published.
func Verify(latest Latest, chunks []Chunk) (Snapshot, error) {
	if err := latest.Validate(); err != nil {
		return Snapshot{}, err
	}
	if len(chunks) != latest.ChunkCount {
		return Snapshot{}, fmt.Errorf("snapshot %s expects %d chunks but %d were supplied", latest.SnapshotID, latest.ChunkCount, len(chunks))
	}

	compressed, err := Assemble(latest.SnapshotID, chunks)
	if err != nil {
		return Snapshot{}, err
	}
	if len(compressed) != latest.CompressedBytes {
		return Snapshot{}, fmt.Errorf("snapshot %s expects %d compressed bytes but got %d", latest.SnapshotID, latest.CompressedBytes, len(compressed))
	}
	if got := checksum(compressed); got != latest.CompressedChecksum {
		return Snapshot{}, fmt.Errorf("snapshot %s compressed checksum mismatch: got %s want %s", latest.SnapshotID, got, latest.CompressedChecksum)
	}

	snapshot, err := decodeCompressed(compressed)
	if err != nil {
		return Snapshot{}, err
	}

	raw, err := EncodeJSON(snapshot)
	if err != nil {
		return Snapshot{}, err
	}
	if len(raw) != latest.RawBytes {
		return Snapshot{}, fmt.Errorf("snapshot %s expects %d raw bytes but got %d", latest.SnapshotID, latest.RawBytes, len(raw))
	}
	if got := checksum(raw); got != latest.Checksum {
		return Snapshot{}, fmt.Errorf("snapshot %s checksum mismatch: got %s want %s", latest.SnapshotID, got, latest.Checksum)
	}
	if snapshot.Metadata.SnapshotID != latest.SnapshotID {
		return Snapshot{}, fmt.Errorf("snapshot chunks hold id %q but the pointer names %q", snapshot.Metadata.SnapshotID, latest.SnapshotID)
	}
	if !snapshot.Metadata.ScannedAt.Equal(latest.ScannedAt) {
		return Snapshot{}, fmt.Errorf("snapshot %s scan time disagrees with its pointer", latest.SnapshotID)
	}
	if snapshot.Metadata.Names != latest.Names {
		return Snapshot{}, fmt.Errorf("snapshot %s holds %d names but the pointer reports %d", latest.SnapshotID, snapshot.Metadata.Names, latest.Names)
	}
	return snapshot, nil
}

// Assemble validates chunk identity, ordering, size, and checksums, then
// concatenates them into the compressed stream.
func Assemble(snapshotID string, chunks []Chunk) ([]byte, error) {
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return nil, err
	}
	if len(chunks) == 0 {
		return nil, fmt.Errorf("snapshot %s has no chunks", snapshotID)
	}

	count := chunks[0].Count
	if count != len(chunks) {
		return nil, fmt.Errorf("snapshot %s declares %d chunks but %d were supplied", snapshotID, count, len(chunks))
	}

	var assembled bytes.Buffer
	for position, chunk := range chunks {
		if chunk.SnapshotID != snapshotID {
			return nil, fmt.Errorf("chunk at position %d belongs to snapshot %q, not %q", position, chunk.SnapshotID, snapshotID)
		}
		if chunk.Count != count {
			return nil, fmt.Errorf("chunk %d of snapshot %s declares %d chunks, not %d", chunk.Index, snapshotID, chunk.Count, count)
		}
		// Requiring index to equal position rejects gaps, duplicates, and any
		// reordering instead of silently repairing them.
		if chunk.Index != position {
			return nil, fmt.Errorf("snapshot %s chunk at position %d declares index %d: chunks are missing, duplicated, or out of order", snapshotID, position, chunk.Index)
		}
		if len(chunk.Bytes) > MaxChunkBytes {
			return nil, fmt.Errorf("snapshot %s chunk %d holds %d bytes, above the %d byte limit", snapshotID, chunk.Index, len(chunk.Bytes), MaxChunkBytes)
		}
		if position < count-1 && len(chunk.Bytes) != MaxChunkBytes {
			return nil, fmt.Errorf("snapshot %s chunk %d holds %d bytes: only the final chunk may be short", snapshotID, chunk.Index, len(chunk.Bytes))
		}
		if len(chunk.Bytes) == 0 && count > 1 {
			return nil, fmt.Errorf("snapshot %s chunk %d is empty", snapshotID, chunk.Index)
		}
		if got := checksum(chunk.Bytes); got != chunk.Checksum {
			return nil, fmt.Errorf("snapshot %s chunk %d checksum mismatch: got %s want %s", snapshotID, chunk.Index, got, chunk.Checksum)
		}
		assembled.Write(chunk.Bytes)
	}
	return assembled.Bytes(), nil
}

// Latest builds the pointer that publishes this payload.
func (p Payload) Latest(publishedAt time.Time) Latest {
	return Latest{
		FormatVersion:      FormatVersion,
		SnapshotID:         p.Metadata.SnapshotID,
		ScannedAt:          p.Metadata.ScannedAt,
		PublishedAt:        canonicalTime(publishedAt),
		Checksum:           p.Checksum,
		CompressedChecksum: p.CompressedChecksum,
		RawBytes:           p.RawBytes,
		CompressedBytes:    p.CompressedBytes,
		ChunkCount:         len(p.Chunks),
		Names:              p.Metadata.Names,
		Counts:             p.Metadata.Counts,
		Sources:            p.Metadata.Sources,
		ScanAge:            p.Metadata.ScanAge,
	}
}

func decodeCompressed(compressed []byte) (Snapshot, error) {
	raw, err := decompress(compressed)
	if err != nil {
		return Snapshot{}, err
	}

	var snapshot Snapshot
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&snapshot); err != nil {
		return Snapshot{}, fmt.Errorf("decode snapshot: %w", err)
	}
	if decoder.More() {
		return Snapshot{}, fmt.Errorf("decode snapshot: unexpected trailing data")
	}
	if err := snapshot.Validate(); err != nil {
		return Snapshot{}, err
	}

	// Re-encoding proves the stored bytes were already canonical, so two
	// readers of the same snapshot can never disagree about its checksum.
	canonical, err := json.Marshal(snapshot)
	if err != nil {
		return Snapshot{}, err
	}
	if !bytes.Equal(raw, canonical) {
		return Snapshot{}, fmt.Errorf("snapshot %s payload is not canonically serialized", snapshot.Metadata.SnapshotID)
	}
	return snapshot, nil
}

func compress(raw []byte) ([]byte, error) {
	var buffer bytes.Buffer
	writer, err := gzip.NewWriterLevel(&buffer, compressionLevel)
	if err != nil {
		return nil, err
	}
	// Every header field is set explicitly. A default modification time or
	// operating system byte would make the compressed bytes depend on when and
	// where the scan ran.
	writer.Header = gzip.Header{ModTime: time.Time{}, OS: 255}
	if _, err := writer.Write(raw); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func decompress(compressed []byte) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, fmt.Errorf("read snapshot stream: %w", err)
	}
	defer reader.Close()

	raw, err := io.ReadAll(io.LimitReader(reader, int64(maxRawBytes)+1))
	if err != nil {
		return nil, fmt.Errorf("read snapshot stream: %w", err)
	}
	if len(raw) > maxRawBytes {
		return nil, fmt.Errorf("snapshot payload exceeds the %d byte limit", maxRawBytes)
	}
	return raw, nil
}

// split cuts the compressed stream at fixed offsets, so chunk boundaries depend
// only on the payload and never on how the scan was scheduled.
func split(snapshotID string, compressed []byte) []Chunk {
	count := (len(compressed) + MaxChunkBytes - 1) / MaxChunkBytes
	if count == 0 {
		count = 1
	}

	chunks := make([]Chunk, 0, count)
	for index := 0; index < count; index++ {
		start := index * MaxChunkBytes
		end := start + MaxChunkBytes
		if end > len(compressed) {
			end = len(compressed)
		}
		payload := append([]byte(nil), compressed[start:end]...)
		chunks = append(chunks, Chunk{
			SnapshotID: snapshotID,
			Index:      index,
			Count:      count,
			Checksum:   checksum(payload),
			Bytes:      payload,
		})
	}
	return chunks
}

func checksum(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
