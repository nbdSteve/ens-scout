package dynamo

// This file is the end-to-end test of one scheduled publication: internal/scanner
// driving this package's real Store, over the real word lists, against a local HTTP
// stand-in for the Graph gateway. Everything else in the repository tests one layer
// against local fakes, so nothing else proves that the scanner's rules and this
// backend's item layout, condition expressions, and TTL writes agree.
//
// It lives in package dynamo because the DynamoDB API fake is here: a test outside
// this package cannot reach it, and a second fake would be a second definition of
// what the service accepts. Nothing here reaches AWS, the real ENS subgraph, or the
// network beyond a loopback httptest server, and nothing writes into the repository.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"ens-scrape/internal/ens"
	"ens-scrape/internal/names"
	"ens-scrape/internal/scanner"
	"ens-scrape/internal/snapshot"
)

// e2eAPIKey stands in for THEGRAPH_API_KEY. It is configured so the run's redactor
// is the configuration-aware one, and the transcript can be checked for it.
const e2eAPIKey = "e2e-not-a-real-graph-key"

// wordListDir is the repository's real input directory, read only.
var wordListDir = filepath.Join("..", "..", "data", "words")

// opRecorder records the DynamoDB operations one publication issues, in order, so a
// test can prove the pointer write is the last thing that happens.
type opRecorder struct {
	mu  sync.Mutex
	ops []string

	// failPointer fails the pointer write, which is the failure that abandons a
	// complete chunk set: every chunk is stored and verified and nothing names it.
	failPointer bool

	// holdChunkBatch reports the next chunk batch's items as unprocessed, once,
	// which is how a throttled table answers a write it accepted nothing of.
	holdChunkBatch bool
}

func (r *opRecorder) add(op string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ops = append(r.ops, op)
}

func (r *opRecorder) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ops = nil
}

func (r *opRecorder) recorded() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.ops...)
}

// attach installs the recorder's hooks on a fake.
func (r *opRecorder) attach(fake *fakeDynamo) {
	fake.onBatchWrite = func(call int, requests []types.WriteRequest) ([]types.WriteRequest, error) {
		// The kind matters: a batch that puts chunks and a batch that deletes a
		// staging marker are both batch writes, and only the first one may precede
		// the pointer write.
		kind := batchKind(requests)
		r.add(fmt.Sprintf("BatchWriteItem[%s, %d items]", kind, len(requests)))
		r.mu.Lock()
		hold := r.holdChunkBatch && strings.HasPrefix(kind, "put CHUNK")
		if hold {
			r.holdChunkBatch = false
		}
		r.mu.Unlock()
		if hold {
			return requests, nil
		}
		return nil, nil
	}
	fake.onQuery = func(call int) error {
		r.add("Query")
		return nil
	}
	fake.onGetItem = func(call int) error {
		r.add("GetItem")
		return nil
	}
	fake.onUpdateItem = func(call int) error {
		r.add("UpdateItem")
		return nil
	}
	fake.onPutItem = func(call int, item map[string]types.AttributeValue) error {
		sort, err := stringAttribute(item, attrSort)
		if err != nil {
			return err
		}
		r.add("PutItem[" + sort + "]")
		r.mu.Lock()
		fail := r.failPointer && sort == snapshot.LatestSort
		r.mu.Unlock()
		if fail {
			return fmt.Errorf("injected: the latest pointer write failed")
		}
		return nil
	}
}

// batchKind names what one batch write does, from its first request.
func batchKind(requests []types.WriteRequest) string {
	if len(requests) == 0 {
		return "empty"
	}
	var (
		verb string
		item map[string]types.AttributeValue
	)
	switch {
	case requests[0].PutRequest != nil:
		verb, item = "put", requests[0].PutRequest.Item
	case requests[0].DeleteRequest != nil:
		verb, item = "delete", requests[0].DeleteRequest.Key
	default:
		return "unknown"
	}
	sort, err := stringAttribute(item, attrSort)
	if err != nil {
		return verb + " unknown"
	}
	if index := strings.IndexByte(sort, '#'); index >= 0 {
		sort = sort[:index]
	}
	return verb + " " + sort
}

// graphStub answers the scanner's real ens.Client over HTTP with a deterministic
// registration table, so a run produces every lifecycle status without contacting
// the real subgraph.
//
// The status of a label is a function of the label alone, so batching, worker count,
// and request order cannot change what a scan finds.
func newGraphStub(t *testing.T, base time.Time) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Query     string `json:"query"`
			Variables struct {
				Names []string `json:"names"`
				First int      `json:"first"`
			} `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if !strings.Contains(request.Query, "name_in") {
			http.Error(w, "the scanner must filter with name_in", http.StatusBadRequest)
			return
		}

		type registration struct {
			ExpiryDate string `json:"expiryDate"`
			Domain     struct {
				Name string `json:"name"`
			} `json:"domain"`
		}
		registrations := make([]registration, 0, len(request.Variables.Names))
		for _, name := range request.Variables.Names {
			expiry, registered := stubExpiry(name, base)
			if !registered {
				continue
			}
			entry := registration{ExpiryDate: strconv.FormatInt(expiry.Unix(), 10)}
			entry.Domain.Name = name
			registrations = append(registrations, entry)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"data": map[string]interface{}{"registrations": registrations},
		})
	}))
	t.Cleanup(server.Close)
	return server
}

// stubExpiry decides one name's registration deterministically: a quarter of the
// names are unregistered, and the rest land well inside the active, grace, and
// premium windows so a few hours of clock movement cannot reclassify them.
func stubExpiry(name string, base time.Time) (time.Time, bool) {
	sum := 0
	for _, b := range []byte(name) {
		sum += int(b)
	}
	switch sum % 4 {
	case 0:
		return time.Time{}, false
	case 1:
		return base.Add(200 * 24 * time.Hour), true
	case 2:
		return base.Add(-30 * 24 * time.Hour), true
	default:
		return base.Add(-95 * 24 * time.Hour), true
	}
}

// TestScheduledPublisherEndToEnd runs four scheduled invocations against one table
// and proves what an operator would see: a bootstrap publication, an independent
// schedule merging the other group forward, a failed publication that leaves the
// previous snapshot serving and its own chunk set findable, and a later run that
// publishes and reclaims what the failed one abandoned.
func TestScheduledPublisherEndToEnd(t *testing.T) {
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	store, fake, _ := newTestStore(t, Options{})
	recorder := &opRecorder{}
	recorder.attach(fake)
	graph := newGraphStub(t, base)

	client, err := ens.NewClient(graph.URL, &http.Client{Timeout: 5 * time.Second}, 2)
	if err != nil {
		t.Fatalf("ens.NewClient: %v", err)
	}

	shortLabels := loadLabels(t, "3-letters.txt", "4-letters.txt")
	allLabels := loadLabels(t, "3-letters.txt", "4-letters.txt", "5-letters.txt")
	longLabels := len(allLabels) - len(shortLabels)

	now := base
	var transcript strings.Builder
	run := func(group scanner.Group, at time.Time) (scanner.Result, string, error) {
		now = at
		recorder.reset()
		var logs strings.Builder
		deps := scanner.Dependencies{
			Config: scanner.Config{
				Table:                fake.table,
				Endpoint:             graph.URL,
				APIKey:               e2eAPIKey,
				WordListDir:          wordListDir,
				Workers:              4,
				BatchSize:            250,
				Retries:              2,
				Soon:                 30 * 24 * time.Hour,
				RequestTimeout:       5 * time.Second,
				ScanBudget:           60 * time.Second,
				PreviousReadAttempts: 3,
			},
			Store:  store,
			Client: client,
			Logger: scanner.NewLogger(&logs, func() time.Time { return now }),
			Now:    func() time.Time { return now },
			Sleep:  func(ctx context.Context, delay time.Duration) error { return ctx.Err() },
		}
		result, err := scanner.Run(context.Background(), deps, scanner.Event{Group: group})
		return result, logs.String(), err
	}

	// Phase 1: the three/four-letter schedule fires into an empty table.
	first, logs, err := run(scanner.GroupShort, base)
	if err != nil {
		t.Fatalf("bootstrap run: %v", err)
	}
	if first.Scanned != len(shortLabels) || first.Carried != 0 {
		t.Fatalf("bootstrap scanned %d and carried %d, want %d scanned and none carried",
			first.Scanned, first.Carried, len(shortLabels))
	}
	if first.Latest.Names != len(shortLabels) {
		t.Fatalf("bootstrap published %d names, want %d", first.Latest.Names, len(shortLabels))
	}
	assertChunkCount(t, first.Latest)
	assertPointerWrittenLast(t, recorder.recorded())
	assertReadable(t, store, first.Latest.SnapshotID, len(shortLabels))
	if staged := stagedIDs(t, store); len(staged) != 0 {
		t.Fatalf("a published run left staging markers %v", staged)
	}
	transcript.WriteString(phase("1. bootstrap: the three/four-letter schedule fires into an empty table",
		logs, first, fake, store))

	// Phase 2: the five-letter schedule fires independently and merges forward.
	second, logs, err := run(scanner.GroupLong, base.Add(time.Hour))
	if err != nil {
		t.Fatalf("five-letter run: %v", err)
	}
	if second.Scanned != longLabels || second.Carried != len(shortLabels) {
		t.Fatalf("five-letter run scanned %d and carried %d, want %d and %d",
			second.Scanned, second.Carried, longLabels, len(shortLabels))
	}
	if second.Latest.Names != len(allLabels) {
		t.Fatalf("five-letter run published %d names, want every list's %d", second.Latest.Names, len(allLabels))
	}
	if second.Previous != first.Latest.SnapshotID {
		t.Fatalf("five-letter run superseded %q, want the bootstrap snapshot %q", second.Previous, first.Latest.SnapshotID)
	}
	if len(second.Latest.Sources) != 3 {
		t.Fatalf("merged snapshot lists %d sources, want all three lists", len(second.Latest.Sources))
	}
	assertReadable(t, store, second.Latest.SnapshotID, len(allLabels))
	// The superseded snapshot keeps a recovery window measured from this publication.
	wantExpiry := second.Latest.PublishedAt.Add(time.Duration(first.Latest.ScanAge.StaleAfterSeconds) * time.Second)
	assertChunksExpireAt(t, fake, first.Latest.SnapshotID, first.Latest.ChunkCount, wantExpiry)
	assertChunksUnexpiring(t, fake, second.Latest.SnapshotID, second.Latest.ChunkCount)
	transcript.WriteString(phase("2. merge forward: the five-letter schedule scans its own list and carries the other group",
		logs, second, fake, store))

	// Phase 3: the pointer write fails. Every chunk is stored and verified, so this
	// is the failure that abandons a complete set.
	recorder.mu.Lock()
	recorder.failPointer = true
	recorder.mu.Unlock()
	failed, logs, err := run(scanner.GroupShort, base.Add(2*time.Hour))
	if err == nil {
		t.Fatalf("the run whose pointer write failed reported success: %+v", failed)
	}
	if strings.Contains(err.Error(), e2eAPIKey) || strings.Contains(err.Error(), graph.URL) {
		t.Fatalf("the returned error quotes a credential or the endpoint: %v", err)
	}
	abandonedID := abandonedSnapshotID(t, store, second.Latest.SnapshotID)
	// The previous snapshot is still what a reader resolves, byte for byte.
	assertServing(t, store, second.Latest, len(allLabels))
	if got := stagedIDs(t, store); len(got) != 1 || got[0] != abandonedID {
		t.Fatalf("staging registry holds %v, want only the abandoned snapshot %q", got, abandonedID)
	}
	transcript.WriteString(phase("3. injected pointer-write failure: the previous snapshot keeps serving",
		logs, scanner.Result{}, fake, store))

	// Phase 4: the next three-hourly run publishes and reclaims the abandoned set.
	// Its first chunk batch comes back wholly unprocessed, as a throttled table
	// answers, so this also proves the publication completes on the bounded retry of
	// exactly the items DynamoDB did not accept.
	recorder.mu.Lock()
	recorder.failPointer = false
	recorder.holdChunkBatch = true
	recorder.mu.Unlock()
	fourth, logs, err := run(scanner.GroupShort, base.Add(5*time.Hour))
	if err != nil {
		t.Fatalf("recovery run: %v", err)
	}
	if fourth.Latest.Names != len(allLabels) {
		t.Fatalf("recovery run published %d names, want %d", fourth.Latest.Names, len(allLabels))
	}
	if fourth.Previous != second.Latest.SnapshotID {
		t.Fatalf("recovery run superseded %q, want %q", fourth.Previous, second.Latest.SnapshotID)
	}
	assertReadable(t, store, fourth.Latest.SnapshotID, len(allLabels))
	assertChunksUnexpiring(t, fake, fourth.Latest.SnapshotID, fourth.Latest.ChunkCount)
	fourthOps := recorder.recorded()
	assertPointerWrittenLast(t, fourthOps)
	if writes := chunkWrites(fourthOps); writes < 2 {
		t.Fatalf("the held chunk batch was not retried: %d chunk write(s) in %v", writes, fourthOps)
	}
	assertChunksExpireAt(t, fake, abandonedID, first.Latest.ChunkCount,
		base.Add(5*time.Hour).Add(24*time.Hour))
	if staged := stagedIDs(t, store); len(staged) != 0 {
		t.Fatalf("staging markers %v survived the reclaim pass", staged)
	}
	transcript.WriteString(phase("4. recovery: the next run publishes and reclaims the abandoned chunk set",
		logs, fourth, fake, store))

	// Nothing any run logged may carry a candidate label, the endpoint, or the key.
	full := transcript.String()
	for _, forbidden := range []string{e2eAPIKey, graph.URL, ".eth"} {
		if strings.Contains(full, forbidden) {
			t.Fatalf("the run's log output contains %q", forbidden)
		}
	}

	t.Logf("scheduled publisher transcript\n\n%s", full)
}

// loadLabels counts the labels the named lists contribute, resolving duplicates the
// way the scanner does, so an expectation is derived from the real input files.
func loadLabels(t *testing.T, files ...string) []string {
	t.Helper()
	paths := make([]string, 0, len(files))
	for _, file := range files {
		paths = append(paths, filepath.Join(wordListDir, file))
	}
	labels, err := names.Load(paths, nil)
	if err != nil {
		t.Fatalf("names.Load(%v): %v", paths, err)
	}
	if len(labels) == 0 {
		t.Fatalf("no labels loaded from %v", paths)
	}
	return labels
}

// assertChunkCount proves the published pointer names as many chunks as its own
// compressed size implies, so a set that lost or gained one cannot go unnoticed.
func assertChunkCount(t *testing.T, latest snapshot.Latest) {
	t.Helper()
	want := (latest.CompressedBytes + snapshot.MaxChunkBytes - 1) / snapshot.MaxChunkBytes
	if latest.ChunkCount != want {
		t.Fatalf("snapshot %s reports %d chunk(s) for %d compressed bytes, want %d",
			latest.SnapshotID, latest.ChunkCount, latest.CompressedBytes, want)
	}
}

// assertPointerWrittenLast proves the pointer moved only after every chunk was
// written and read back.
func assertPointerWrittenLast(t *testing.T, ops []string) {
	t.Helper()
	pointer, lastWrite := -1, -1
	for i, op := range ops {
		switch {
		case op == "PutItem["+snapshot.LatestSort+"]":
			pointer = i
		case strings.HasPrefix(op, "BatchWriteItem[put CHUNK"):
			lastWrite = i
		}
	}
	if pointer < 0 || lastWrite < 0 {
		t.Fatalf("the run issued no pointer write or no chunk write: %v", ops)
	}
	if pointer < lastWrite {
		t.Fatalf("the pointer was written at %d, before the last chunk write at %d: %v", pointer, lastWrite, ops)
	}
	readbacks := 0
	for _, op := range ops[lastWrite+1 : pointer] {
		if op == "Query" {
			readbacks++
		}
	}
	if readbacks == 0 {
		t.Fatalf("no chunk read back between the last chunk write and the pointer write: %v", ops)
	}
}

// chunkWrites counts the batch writes that stored chunks.
func chunkWrites(ops []string) int {
	count := 0
	for _, op := range ops {
		if strings.HasPrefix(op, "BatchWriteItem[put CHUNK") {
			count++
		}
	}
	return count
}

// assertReadable resolves the published snapshot the way a reader will and checks
// what it holds. snapshot.Read verifies the chunk count, index order, format
// version, snapshot ID, and checksum, so a corrupt or incomplete set fails here.
func assertReadable(t *testing.T, store *Store, snapshotID string, names int) {
	t.Helper()
	read, latest, err := snapshot.Read(context.Background(), store)
	if err != nil {
		t.Fatalf("snapshot.Read: %v", err)
	}
	if latest.SnapshotID != snapshotID {
		t.Fatalf("the pointer names %q, want %q", latest.SnapshotID, snapshotID)
	}
	if len(read.Results) != names {
		t.Fatalf("the published snapshot holds %d results, want %d", len(read.Results), names)
	}
	if err := read.Validate(); err != nil {
		t.Fatalf("the published snapshot does not validate: %v", err)
	}
}

// assertServing proves a failed publication left the previous pointer and its
// payload exactly as they were.
func assertServing(t *testing.T, store *Store, want snapshot.Latest, names int) {
	t.Helper()
	read, latest, err := snapshot.Read(context.Background(), store)
	if err != nil {
		t.Fatalf("snapshot.Read after a failed publication: %v", err)
	}
	if latest.SnapshotID != want.SnapshotID || latest.Checksum != want.Checksum {
		t.Fatalf("the pointer now names %q/%s, want %q/%s",
			latest.SnapshotID, latest.Checksum, want.SnapshotID, want.Checksum)
	}
	if len(read.Results) != names {
		t.Fatalf("the serving snapshot holds %d results, want %d", len(read.Results), names)
	}
}

// abandonedSnapshotID is the one staged snapshot that is not the published one.
func abandonedSnapshotID(t *testing.T, store *Store, published string) string {
	t.Helper()
	var found []string
	for _, id := range stagedIDs(t, store) {
		if id != published {
			found = append(found, id)
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly one abandoned staged snapshot, got %v", found)
	}
	return found[0]
}

func stagedIDs(t *testing.T, store *Store) []string {
	t.Helper()
	staged, err := store.StagedSnapshots(context.Background())
	if err != nil {
		t.Fatalf("StagedSnapshots: %v", err)
	}
	ids := make([]string, 0, len(staged))
	for _, entry := range staged {
		ids = append(ids, entry.SnapshotID)
	}
	return ids
}

// assertChunksExpireAt checks every chunk of a snapshot carries the same TTL.
func assertChunksExpireAt(t *testing.T, fake *fakeDynamo, snapshotID string, count int, want time.Time) {
	t.Helper()
	wantUnix := want.UTC().Truncate(time.Second).Unix()
	for index := 0; index < count; index++ {
		ttl, ok := chunkExpiry(fake, snapshotID, index)
		if !ok {
			t.Fatalf("chunk %d of snapshot %s carries no TTL", index, snapshotID)
		}
		if ttl != wantUnix {
			t.Fatalf("chunk %d of snapshot %s expires at %d, want %d", index, snapshotID, ttl, wantUnix)
		}
	}
}

// assertChunksUnexpiring proves the live snapshot carries no expiry at all.
func assertChunksUnexpiring(t *testing.T, fake *fakeDynamo, snapshotID string, count int) {
	t.Helper()
	for index := 0; index < count; index++ {
		if ttl, ok := chunkExpiry(fake, snapshotID, index); ok {
			t.Fatalf("chunk %d of the published snapshot %s carries a TTL of %d", index, snapshotID, ttl)
		}
	}
}

func chunkExpiry(fake *fakeDynamo, snapshotID string, index int) (int64, bool) {
	item := fake.stored(snapshot.SnapshotPartition(snapshotID), snapshot.ChunkSort(index))
	if item == nil {
		return 0, false
	}
	value, ok := item[attrExpiresAt].(*types.AttributeValueMemberN)
	if !ok {
		return 0, false
	}
	seconds, err := strconv.ParseInt(value.Value, 10, 64)
	if err != nil {
		return 0, false
	}
	return seconds, true
}

// phase renders one invocation for the transcript: the JSON lines the Lambda writes
// to its log group, what the invocation reported, and the table it left behind.
func phase(title, logs string, result scanner.Result, fake *fakeDynamo, store *Store) string {
	var out strings.Builder
	fmt.Fprintf(&out, "=== %s ===\n\n", title)
	out.WriteString("structured log records, as CloudWatch Logs receives them:\n")
	for _, line := range strings.Split(strings.TrimSpace(logs), "\n") {
		fmt.Fprintf(&out, "  %s\n", line)
	}
	if result.Latest.SnapshotID != "" {
		fmt.Fprintf(&out, "\ninvocation reported: group=%s snapshot=%s names=%d scanned=%d carried=%d chunks=%d superseded=%q\n",
			result.Group, result.Latest.SnapshotID, result.Latest.Names, result.Scanned,
			result.Carried, result.Latest.ChunkCount, result.Previous)
		fmt.Fprintf(&out, "published counts:")
		for _, status := range ens.Statuses {
			fmt.Fprintf(&out, " %s=%d", status, result.Latest.Counts[status])
		}
		out.WriteString("\nsources:")
		for _, source := range result.Latest.Sources {
			fmt.Fprintf(&out, " %s(%s, %d names)", source.ID, source.Cadence, source.Names)
		}
		fmt.Fprintf(&out, "\nstaleness: expected every %ds, stale after %ds\n",
			result.Latest.ScanAge.ExpectedSeconds, result.Latest.ScanAge.StaleAfterSeconds)
	}
	out.WriteString("\ntable contents:\n")
	out.WriteString(tableDump(fake))
	if latest, err := store.GetLatest(context.Background()); err == nil {
		fmt.Fprintf(&out, "\nwhat a reader resolves now: %s scanned at %s\n",
			latest.SnapshotID, latest.ScannedAt.Format(time.RFC3339))
	}
	out.WriteString("\n")
	return out.String()
}

// tableDump renders the table the way a console reader would see it, collapsing a
// snapshot's chunks into one line because they differ only by index and payload.
func tableDump(fake *fakeDynamo) string {
	type group struct {
		chunks  int
		bytes   int
		expires string
	}
	chunkGroups := make(map[string]*group)
	var order []string
	var other []string

	for _, key := range fake.keys() {
		parts := strings.SplitN(key, " ", 2)
		partition, sortKey := parts[0], parts[1]
		item := fake.stored(partition, sortKey)
		if !strings.HasPrefix(sortKey, snapshot.ChunkSortPrefix) {
			ttl := "-"
			if value, ok := item[attrExpiresAt].(*types.AttributeValueMemberN); ok {
				ttl = value.Value
			}
			other = append(other, fmt.Sprintf("  %-8s %-46s ttl=%s", partition, sortKey, ttl))
			continue
		}
		entry, seen := chunkGroups[partition]
		if !seen {
			entry = &group{expires: "-"}
			chunkGroups[partition] = entry
			order = append(order, partition)
		}
		entry.chunks++
		if payload, ok := item[attrPayload].(*types.AttributeValueMemberB); ok {
			entry.bytes += len(payload.Value)
		}
		if value, ok := item[attrExpiresAt].(*types.AttributeValueMemberN); ok {
			entry.expires = value.Value
		}
	}

	var out strings.Builder
	for _, line := range other {
		out.WriteString(line + "\n")
	}
	for _, partition := range order {
		entry := chunkGroups[partition]
		fmt.Fprintf(&out, "  %-55s %d chunk(s), %d payload bytes, ttl=%s\n",
			partition, entry.chunks, entry.bytes, entry.expires)
	}
	return out.String()
}
