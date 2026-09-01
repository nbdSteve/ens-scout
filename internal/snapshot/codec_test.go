package snapshot

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"math/rand"
	"strings"
	"testing"
	"time"

	"ens-scrape/internal/ens"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	payload, err := Encode(snapshot)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if payload.CompressedBytes >= payload.RawBytes {
		t.Errorf("compression did not shrink the payload: %d compressed, %d raw", payload.CompressedBytes, payload.RawBytes)
	}

	decoded, err := Decode(snapshot.Metadata.SnapshotID, payload.Chunks)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	reEncoded, err := Encode(decoded)
	if err != nil {
		t.Fatalf("Encode decoded snapshot: %v", err)
	}
	assertSamePayload(t, payload, reEncoded)

	latest := payload.Latest(fixedNow.Add(time.Minute))
	verified, err := Verify(latest, payload.Chunks)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if verified.Metadata.SnapshotID != snapshot.Metadata.SnapshotID {
		t.Errorf("verified snapshot id is %q, want %q", verified.Metadata.SnapshotID, snapshot.Metadata.SnapshotID)
	}
	if latest.ChunkCount != len(payload.Chunks) {
		t.Errorf("pointer reports %d chunks, want %d", latest.ChunkCount, len(payload.Chunks))
	}
}

func TestEncodeIsStableAcrossRepeatedCalls(t *testing.T) {
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	first, err := Encode(snapshot)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	for attempt := 0; attempt < 5; attempt++ {
		next, err := Encode(snapshot)
		if err != nil {
			t.Fatalf("Encode attempt %d: %v", attempt, err)
		}
		assertSamePayload(t, first, next)
		if !bytes.Equal(assembleChunks(t, next), assembleChunks(t, first)) {
			t.Fatalf("compressed bytes differ between encodes")
		}
	}
}

// chunkTestResults is the number of results used by the chunking tests. It is
// chosen so the compressed payload spans several chunks with room to spare, and
// so the tests stay meaningful if a Go release changes gzip output slightly.
const chunkTestResults = 40000

// largeSnapshot builds a snapshot big enough to require several chunks. Labels
// and expiry offsets come from a fixed seed, so the payload is large, only
// moderately compressible, and identical on every run.
func largeSnapshot(t *testing.T, count int) Snapshot {
	t.Helper()
	random := rand.New(rand.NewSource(7))
	results := make([]ens.Result, 0, count)
	seen := make(map[string]struct{}, count)
	for len(results) < count {
		label := make([]byte, 8)
		for i := range label {
			label[i] = byte('a' + random.Intn(26))
		}
		name := string(label)
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}

		lookup := ens.Lookup{Name: name, Found: random.Intn(10) > 0}
		if lookup.Found && random.Intn(10) > 0 {
			expiry := fixedNow.Add(time.Duration(random.Intn(400*24*3600)-200*24*3600) * time.Second)
			lookup.Expiry = &expiry
		}
		results = append(results, ens.Classify(lookup, fixedNow, testSoon))
	}

	snapshot, err := Build("large-snapshot", fixedNow, testSources(len(results)), results)
	if err != nil {
		t.Fatalf("Build large snapshot: %v", err)
	}
	return snapshot
}

func TestChunkBoundariesAreDeterministicAndSafe(t *testing.T) {
	payload, err := Encode(largeSnapshot(t, chunkTestResults))
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if len(payload.Chunks) < 3 {
		t.Fatalf("test payload produced %d chunks, want at least 3", len(payload.Chunks))
	}

	wantCount := (payload.CompressedBytes + MaxChunkBytes - 1) / MaxChunkBytes
	if len(payload.Chunks) != wantCount {
		t.Fatalf("chunk count is %d, want %d for %d compressed bytes", len(payload.Chunks), wantCount, payload.CompressedBytes)
	}

	total := 0
	for i, chunk := range payload.Chunks {
		if chunk.Index != i {
			t.Fatalf("chunk at position %d declares index %d", i, chunk.Index)
		}
		if chunk.Count != len(payload.Chunks) {
			t.Fatalf("chunk %d declares %d chunks, want %d", i, chunk.Count, len(payload.Chunks))
		}
		if i < len(payload.Chunks)-1 && len(chunk.Bytes) != MaxChunkBytes {
			t.Fatalf("chunk %d holds %d bytes, want exactly %d", i, len(chunk.Bytes), MaxChunkBytes)
		}
		if len(chunk.Bytes) == 0 || len(chunk.Bytes) > MaxChunkBytes {
			t.Fatalf("chunk %d holds %d bytes, outside 1..%d", i, len(chunk.Bytes), MaxChunkBytes)
		}
		total += len(chunk.Bytes)
	}
	if total != payload.CompressedBytes {
		t.Fatalf("chunks hold %d bytes, want %d", total, payload.CompressedBytes)
	}

	// The documented safety margin: a chunk fits the 400 KB item limit even if a
	// backend stores it base64 encoded rather than as binary.
	encoded := base64.StdEncoding.EncodedLen(MaxChunkBytes)
	if encoded >= MaxItemBytes {
		t.Fatalf("a base64 encoded chunk is %d bytes, at or above the %d byte item limit", encoded, MaxItemBytes)
	}
	if margin := MaxItemBytes - encoded; margin < 144*1024 {
		t.Fatalf("base64 headroom is %d bytes, want at least %d", margin, 144*1024)
	}
}

func TestChunkBoundariesIgnoreInputOrder(t *testing.T) {
	snapshot := largeSnapshot(t, chunkTestResults)
	reference, err := Encode(snapshot)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	shuffled := append([]ens.Result(nil), snapshot.Results...)
	random := rand.New(rand.NewSource(99))
	random.Shuffle(len(shuffled), func(i, j int) {
		shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
	})
	rebuilt, err := Build(snapshot.Metadata.SnapshotID, snapshot.Metadata.ScannedAt, snapshot.Metadata.Sources, shuffled)
	if err != nil {
		t.Fatalf("Build shuffled: %v", err)
	}
	payload, err := Encode(rebuilt)
	if err != nil {
		t.Fatalf("Encode shuffled: %v", err)
	}
	assertSamePayload(t, reference, payload)
}

func TestDecodeFailsClosed(t *testing.T) {
	snapshot := largeSnapshot(t, chunkTestResults)
	payload, err := Encode(snapshot)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	if len(payload.Chunks) < 3 {
		t.Fatalf("test payload produced %d chunks, want at least 3", len(payload.Chunks))
	}

	tests := []struct {
		name   string
		mutate func([]Chunk) []Chunk
		want   string
	}{
		{
			name:   "missing final chunk",
			mutate: func(chunks []Chunk) []Chunk { return chunks[:len(chunks)-1] },
			want:   "were supplied",
		},
		{
			name:   "missing middle chunk",
			mutate: func(chunks []Chunk) []Chunk { return append(chunks[:1], chunks[2:]...) },
			want:   "were supplied",
		},
		{
			name: "duplicated chunk",
			mutate: func(chunks []Chunk) []Chunk {
				return append(CloneChunks(chunks), chunks[0].Clone())
			},
			want: "were supplied",
		},
		{
			name: "duplicated chunk replacing another",
			mutate: func(chunks []Chunk) []Chunk {
				chunks[1] = chunks[0].Clone()
				return chunks
			},
			want: "missing, duplicated, or out of order",
		},
		{
			name: "reordered chunks",
			mutate: func(chunks []Chunk) []Chunk {
				chunks[0], chunks[1] = chunks[1], chunks[0]
				return chunks
			},
			want: "missing, duplicated, or out of order",
		},
		{
			name: "corrupt chunk bytes",
			mutate: func(chunks []Chunk) []Chunk {
				chunks[1].Bytes[17] ^= 0xff
				return chunks
			},
			want: "checksum mismatch",
		},
		{
			name: "corrupt chunk checksum",
			mutate: func(chunks []Chunk) []Chunk {
				chunks[0].Checksum = strings.Repeat("0", 64)
				return chunks
			},
			want: "checksum mismatch",
		},
		{
			name: "wrong chunk count",
			mutate: func(chunks []Chunk) []Chunk {
				for i := range chunks {
					chunks[i].Count = len(chunks) + 1
				}
				return chunks
			},
			want: "were supplied",
		},
		{
			name: "foreign chunk",
			mutate: func(chunks []Chunk) []Chunk {
				chunks[2].SnapshotID = "other-snapshot"
				return chunks
			},
			want: "belongs to snapshot",
		},
		{
			name: "short interior chunk",
			mutate: func(chunks []Chunk) []Chunk {
				chunks[1].Bytes = chunks[1].Bytes[:100]
				chunks[1].Checksum = checksum(chunks[1].Bytes)
				return chunks
			},
			want: "only the final chunk may be short",
		},
		{
			name: "truncated stream",
			mutate: func(chunks []Chunk) []Chunk {
				last := len(chunks) - 1
				chunks[last].Bytes = chunks[last].Bytes[:len(chunks[last].Bytes)-32]
				chunks[last].Checksum = checksum(chunks[last].Bytes)
				return chunks
			},
			want: "read snapshot stream",
		},
		{
			name:   "no chunks",
			mutate: func([]Chunk) []Chunk { return nil },
			want:   "no snapshot chunks supplied",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			chunks := test.mutate(CloneChunks(payload.Chunks))
			_, err := Decode(snapshot.Metadata.SnapshotID, chunks)
			if err == nil {
				t.Fatalf("Decode accepted damaged chunks")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}
		})
	}
}

func TestVerifyFailsClosedAgainstPointer(t *testing.T) {
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	payload, err := Encode(snapshot)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	valid := payload.Latest(fixedNow.Add(time.Minute))

	tests := []struct {
		name   string
		mutate func(*Latest)
		want   string
	}{
		{
			name:   "format version",
			mutate: func(l *Latest) { l.FormatVersion = FormatVersion + 1 },
			want:   "unsupported latest pointer format version",
		},
		{
			name:   "checksum",
			mutate: func(l *Latest) { l.Checksum = strings.Repeat("a", 64) },
			want:   "checksum mismatch",
		},
		{
			name:   "compressed checksum",
			mutate: func(l *Latest) { l.CompressedChecksum = strings.Repeat("b", 64) },
			want:   "compressed checksum mismatch",
		},
		{
			name:   "raw bytes",
			mutate: func(l *Latest) { l.RawBytes++ },
			want:   "raw bytes",
		},
		{
			name:   "compressed bytes",
			mutate: func(l *Latest) { l.CompressedBytes++ },
			want:   "compressed bytes",
		},
		{
			name:   "chunk count",
			mutate: func(l *Latest) { l.ChunkCount++ },
			want:   "chunks but 1 were supplied",
		},
		{
			name:   "snapshot id",
			mutate: func(l *Latest) { l.SnapshotID = "other-snapshot" },
			want:   "belongs to snapshot",
		},
		{
			name:   "scan time",
			mutate: func(l *Latest) { l.ScannedAt = l.ScannedAt.Add(time.Hour) },
			want:   "scan time disagrees",
		},
		{
			// The whole summary is moved together, so it stays internally
			// consistent and only the chunks can contradict it.
			name: "name count",
			mutate: func(l *Latest) {
				l.Names++
				l.Counts[ens.StatusAvailable]++
				l.Sources[0].Names++
			},
			want: "the pointer reports",
		},
		{
			name:   "missing sources",
			mutate: func(l *Latest) { l.Sources = nil },
			want:   "at least one source list is required",
		},
		{
			name:   "sub-second scan time",
			mutate: func(l *Latest) { l.ScannedAt = l.ScannedAt.Add(500 * time.Millisecond) },
			want:   "scan time must be UTC with second precision",
		},
		{
			name:   "sub-second publication time",
			mutate: func(l *Latest) { l.PublishedAt = l.PublishedAt.Add(500 * time.Millisecond) },
			want:   "publication time must be UTC with second precision",
		},
		{
			name:   "non-UTC publication time",
			mutate: func(l *Latest) { l.PublishedAt = l.PublishedAt.In(time.FixedZone("UTC+1", 3600)) },
			want:   "publication time must be UTC with second precision",
		},
		{
			// A widened threshold would make a client call a stale snapshot fresh.
			name:   "stale threshold widened",
			mutate: func(l *Latest) { l.ScanAge.StaleAfterSeconds = 8640000 },
			want:   "scan age thresholds disagree with the source cadences",
		},
		{
			name:   "expected interval narrowed",
			mutate: func(l *Latest) { l.ScanAge.ExpectedSeconds /= 2 },
			want:   "scan age thresholds disagree with the source cadences",
		},
		{
			name:   "missing counts",
			mutate: func(l *Latest) { l.Counts = nil },
			want:   "counts must list every lifecycle status",
		},
		{
			name:   "dropped status in counts",
			mutate: func(l *Latest) { delete(l.Counts, ens.StatusUnknown) },
			want:   "counts must list every lifecycle status",
		},
		{
			// Moving a name between statuses keeps the counts summing to the name
			// total, so only the comparison with the chunks can catch it.
			name: "count moved between statuses",
			mutate: func(l *Latest) {
				l.Counts[ens.StatusAvailable]++
				l.Counts[ens.StatusUnknown]--
			},
			want: `results but the pointer reports`,
		},
		{
			name:   "counts sum past the name total",
			mutate: func(l *Latest) { l.Counts[ens.StatusAvailable] = 99 },
			want:   "counts sum to 105 but the pointer reports 8 names",
		},
		{
			name:   "source name total edited",
			mutate: func(l *Latest) { l.Sources[0].Names = 99 },
			want:   "source lists account for 99 names but the pointer reports 8",
		},
		{
			name:   "source path edited",
			mutate: func(l *Latest) { l.Sources[0].Path = "data/words/other.txt" },
			want:   "disagrees with its pointer",
		},
		{
			name: "unsorted sources",
			mutate: func(l *Latest) {
				l.Sources = []SourceList{
					{ID: "b", Path: "b.txt", Cadence: CadenceThreeHourly, Names: 8},
					{ID: "a", Path: "a.txt", Cadence: CadenceThreeHourly, Names: 0},
				}
			},
			want: "source lists are not sorted by id",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			latest := valid.Clone()
			test.mutate(&latest)
			if _, err := Verify(latest, CloneChunks(payload.Chunks)); err == nil {
				t.Fatalf("Verify accepted a pointer that disagrees with the chunks")
			} else if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}
		})
	}
}

func TestDecodeRejectsNonCanonicalPayload(t *testing.T) {
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	raw, err := EncodeJSON(snapshot)
	if err != nil {
		t.Fatalf("EncodeJSON: %v", err)
	}

	tests := []struct {
		name string
		raw  []byte
		want string
	}{
		{
			name: "indented payload",
			raw:  indent(t, raw),
			want: "not canonically serialized",
		},
		{
			name: "unknown field",
			raw:  append(append([]byte(nil), raw[:len(raw)-1]...), []byte(`,"extra":1}`)...),
			want: "unknown field",
		},
		{
			name: "trailing data",
			raw:  append(append([]byte(nil), raw...), []byte(`{}`)...),
			want: "trailing data",
		},
		{
			name: "not json",
			raw:  []byte("not a snapshot"),
			want: "decode snapshot",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			chunks := chunkRaw(t, snapshot.Metadata.SnapshotID, test.raw)
			if _, err := Decode(snapshot.Metadata.SnapshotID, chunks); err == nil {
				t.Fatalf("Decode accepted a non-canonical payload")
			} else if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}
		})
	}
}

// TestDecodeAnchorsOnTheRequestedSnapshotID covers the relabelled-chunk case: a
// chunk checksum covers only the payload bytes, so a copy of one snapshot's
// chunks with the envelope rewritten to another ID is internally consistent.
// Decode must reject it rather than hand back a snapshot the caller did not ask
// for.
func TestDecodeAnchorsOnTheRequestedSnapshotID(t *testing.T) {
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	payload, err := Encode(snapshot)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	// Relabel every chunk and refresh each checksum, exactly as copying a stored
	// snapshot directory under a new ID and editing the envelope would.
	relabelled := CloneChunks(payload.Chunks)
	for i := range relabelled {
		relabelled[i].SnapshotID = "other-snapshot"
		relabelled[i].Checksum = checksum(relabelled[i].Bytes)
	}

	tests := []struct {
		name       string
		snapshotID string
		chunks     []Chunk
		want       string
	}{
		{
			name:       "relabelled chunks under the id they claim",
			snapshotID: "other-snapshot",
			chunks:     relabelled,
			want:       `hold id "test-snapshot" but "other-snapshot" was requested`,
		},
		{
			name:       "relabelled chunks under the id they came from",
			snapshotID: snapshot.Metadata.SnapshotID,
			chunks:     relabelled,
			want:       "belongs to snapshot",
		},
		{
			name:       "genuine chunks under a foreign id",
			snapshotID: "other-snapshot",
			chunks:     CloneChunks(payload.Chunks),
			want:       "belongs to snapshot",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Decode(test.snapshotID, test.chunks); err == nil {
				t.Fatal("Decode returned a snapshot the caller did not ask for")
			} else if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}
		})
	}

	// The same chunks still decode under their own id, so the anchor rejects only
	// the mismatch and not the snapshot itself.
	if _, err := Decode(snapshot.Metadata.SnapshotID, payload.Chunks); err != nil {
		t.Fatalf("Decode rejected the snapshot under its own id: %v", err)
	}
}

func TestDecodeRejectsUnreadableStream(t *testing.T) {
	chunks := split("test-snapshot", []byte("this is not a gzip stream"))
	if _, err := Decode("test-snapshot", chunks); err == nil {
		t.Fatal("Decode accepted a stream that is not gzip")
	} else if !strings.Contains(err.Error(), "read snapshot stream") {
		t.Fatalf("error %q does not mention the snapshot stream", err)
	}
}

func TestDecodeBoundsDecompression(t *testing.T) {
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	raw, err := EncodeJSON(snapshot)
	if err != nil {
		t.Fatalf("EncodeJSON: %v", err)
	}

	previous := maxRawBytes
	maxRawBytes = len(raw) - 1
	defer func() { maxRawBytes = previous }()

	if _, err := Decode(snapshot.Metadata.SnapshotID, chunkRaw(t, snapshot.Metadata.SnapshotID, raw)); err == nil {
		t.Fatal("Decode accepted a payload above the decompression bound")
	} else if !strings.Contains(err.Error(), "exceeds the") {
		t.Fatalf("error %q does not mention the payload limit", err)
	}
}

// TestLatestDoesNotAliasSnapshotMetadata proves a published pointer owns its
// counts map and source slice. Sharing them would let a client that edits the
// pointer it was handed change the snapshot metadata the pointer was built from.
func TestLatestDoesNotAliasSnapshotMetadata(t *testing.T) {
	snapshot := mustBuild(t, lifecycleResults(t, fixedNow))
	payload, err := Encode(snapshot)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	wantAvailable := snapshot.Metadata.Counts[ens.StatusAvailable]
	wantNames := snapshot.Metadata.Sources[0].Names

	latest := payload.Latest(fixedNow.Add(time.Minute))
	latest.Counts[ens.StatusAvailable] = 0
	latest.Sources[0].Names = 0

	if got := snapshot.Metadata.Counts[ens.StatusAvailable]; got != wantAvailable {
		t.Errorf("editing the pointer changed the snapshot available count to %d, want %d", got, wantAvailable)
	}
	if got := snapshot.Metadata.Sources[0].Names; got != wantNames {
		t.Errorf("editing the pointer changed the snapshot source name total to %d, want %d", got, wantNames)
	}

	// A second pointer from the same payload is unaffected too.
	second := payload.Latest(fixedNow.Add(time.Minute))
	if got := second.Counts[ens.StatusAvailable]; got != wantAvailable {
		t.Errorf("a second pointer reports %d available names, want %d", got, wantAvailable)
	}
	if got := second.Sources[0].Names; got != wantNames {
		t.Errorf("a second pointer reports %d source names, want %d", got, wantNames)
	}
}

func TestChunkCloneIsIndependent(t *testing.T) {
	chunk := Chunk{SnapshotID: "test-snapshot", Index: 0, Count: 1, Bytes: []byte{1, 2, 3}}
	chunk.Checksum = checksum(chunk.Bytes)
	clone := chunk.Clone()
	clone.Bytes[0] = 9
	if chunk.Bytes[0] != 1 {
		t.Fatal("mutating a clone changed the original chunk")
	}
}

func TestStorageKeysAreOrdered(t *testing.T) {
	if got := SnapshotPartition("fixture-preview"); got != "SNAPSHOT#fixture-preview" {
		t.Errorf("partition key is %q", got)
	}
	if got := ChunkSort(7); got != "CHUNK#00007" {
		t.Errorf("chunk sort key is %q, want CHUNK#00007", got)
	}
	// Zero padding must keep lexical order equal to numeric order.
	if ChunkSort(2) >= ChunkSort(10) {
		t.Errorf("chunk keys %q and %q sort out of numeric order", ChunkSort(2), ChunkSort(10))
	}
}

func assembleChunks(t *testing.T, payload Payload) []byte {
	t.Helper()
	assembled, err := Assemble(payload.Metadata.SnapshotID, payload.Chunks)
	if err != nil {
		t.Fatalf("Assemble: %v", err)
	}
	return assembled
}

func indent(t *testing.T, raw []byte) []byte {
	t.Helper()
	var indented bytes.Buffer
	if err := json.Indent(&indented, raw, "", "  "); err != nil {
		t.Fatalf("json.Indent: %v", err)
	}
	return indented.Bytes()
}

// chunkRaw compresses arbitrary payload bytes and chunks them, so tests can feed
// payloads that Encode would have refused to produce.
func chunkRaw(t *testing.T, snapshotID string, raw []byte) []Chunk {
	t.Helper()
	compressed, err := compress(raw)
	if err != nil {
		t.Fatalf("compress: %v", err)
	}
	return split(snapshotID, compressed)
}

func TestCompressionHeaderIsFixed(t *testing.T) {
	compressed, err := compress([]byte("payload"))
	if err != nil {
		t.Fatalf("compress: %v", err)
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer reader.Close()
	if !reader.Header.ModTime.IsZero() {
		t.Errorf("gzip modification time is %s, want zero", reader.Header.ModTime)
	}
	if reader.Header.OS != 255 {
		t.Errorf("gzip OS byte is %d, want 255", reader.Header.OS)
	}
	if reader.Header.Name != "" || reader.Header.Comment != "" {
		t.Error("gzip header carries a name or comment")
	}
}
