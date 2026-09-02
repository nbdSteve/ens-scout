package scanner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"ens-scrape/internal/ens"
	"ens-scrape/internal/snapshot"
)

// No test here reaches the network, the real ENS subgraph, AWS, or the repository's
// own data directories. The word lists are written into a temporary directory and
// storage is a local fake, so a run is fully determined by its inputs and its clock.

var fixedNow = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

var errInjected = errors.New("injected failure")

// fakeGraph answers lookups from a table of registrations and records what it was
// asked, which is how a test proves a schedule scanned only its own group.
type fakeGraph struct {
	mu         sync.Mutex
	registered map[string]time.Time
	requested  []string
	calls      int

	// err fails every lookup, and onLookup runs before the first answer so a test
	// can cancel the run from inside the scan.
	err      error
	onLookup func()
}

func newFakeGraph(registered map[string]time.Time) *fakeGraph {
	return &fakeGraph{registered: registered}
}

func (g *fakeGraph) Lookup(ctx context.Context, labels []string) ([]ens.Lookup, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	g.mu.Lock()
	g.calls++
	first := g.calls == 1
	hook := g.onLookup
	g.requested = append(g.requested, labels...)
	g.mu.Unlock()

	if first && hook != nil {
		hook()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if g.err != nil {
		return nil, g.err
	}

	lookups := make([]ens.Lookup, 0, len(labels))
	for _, label := range labels {
		lookup := ens.Lookup{Name: label + ".eth"}
		if expiry, found := g.registered[label]; found {
			expiryCopy := expiry
			lookup.Found = true
			lookup.Expiry = &expiryCopy
		}
		lookups = append(lookups, lookup)
	}
	return lookups, nil
}

func (g *fakeGraph) asked() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	asked := append([]string(nil), g.requested...)
	sort.Strings(asked)
	return asked
}

// fakeStore is a local Store: the contract's in-memory backend plus the staging
// registry and the retention call, with injectable failures for each publication
// step.
//
// ExpireChunks repeats the DynamoDB backend's guard rather than trusting the
// caller, so a test that expired a live snapshot would fail here too.
type fakeStore struct {
	*snapshot.MemoryStore

	mu       sync.Mutex
	expired  map[string]time.Time
	attempts []string

	putChunksErr error
	getChunksErr error
	putLatestErr error
	getLatestErr error
	expireErr    error
	stageErr     error
	stagedErr    error
	unstageErr   error

	// getLatestFailures fails that many pointer reads before the first success, which
	// models a transient burst rather than a permanently broken table: the pointer
	// itself stays perfectly readable, so a run can exhaust its previous-read attempts
	// and still have its own pointer write replace the real stored pointer.
	getLatestFailures int

	// putLatestUnusable makes a successful pointer write report that it replaced a
	// pointer it could not interpret, as the real backend does when it quarantines one.
	putLatestUnusable bool

	// unstageFailures fails that many marker removals before the first success, which
	// is how a publisher ends up holding the marker of the snapshot it just published.
	unstageFailures int

	// stagedSkipped makes StagedSnapshots report markers it could not interpret
	// alongside the ones it could, which is what a real registry does with a corrupt
	// or unknown-version item.
	stagedSkipped int

	// onPutChunks runs before the chunk write, so a test can end a run at the one
	// point where a complete chunk set exists and no pointer names it.
	onPutChunks func()

	// onExpire runs before each retention call and is given the snapshot it targets,
	// so a test can end the run's deadline from inside the reclaim pass and prove
	// which retention action the run had already completed.
	onExpire func(snapshotID string)
}

func newFakeStore() *fakeStore {
	return &fakeStore{MemoryStore: snapshot.NewMemoryStore(), expired: make(map[string]time.Time)}
}

func (s *fakeStore) PutChunks(ctx context.Context, snapshotID string, chunks []snapshot.Chunk) error {
	if s.onPutChunks != nil {
		s.onPutChunks()
	}
	if s.putChunksErr != nil {
		return s.putChunksErr
	}
	return s.MemoryStore.PutChunks(ctx, snapshotID, chunks)
}

func (s *fakeStore) StageSnapshot(ctx context.Context, snapshotID string, stagedAt, expiresAt time.Time) error {
	if s.stageErr != nil {
		return s.stageErr
	}
	return s.MemoryStore.StageSnapshot(ctx, snapshotID, stagedAt, expiresAt)
}

func (s *fakeStore) UnstageSnapshot(ctx context.Context, snapshotID string) error {
	s.mu.Lock()
	transient := s.unstageFailures > 0
	if transient {
		s.unstageFailures--
	}
	s.mu.Unlock()
	if transient {
		return errInjected
	}
	if s.unstageErr != nil {
		return s.unstageErr
	}
	return s.MemoryStore.UnstageSnapshot(ctx, snapshotID)
}

func (s *fakeStore) StagedSnapshots(ctx context.Context) ([]snapshot.StagedSnapshot, error) {
	if s.stagedErr != nil {
		return nil, s.stagedErr
	}
	staged, err := s.MemoryStore.StagedSnapshots(ctx)
	if err == nil && s.stagedSkipped > 0 {
		return staged, &snapshot.StagingUnreadableError{Skipped: s.stagedSkipped, Cause: errInjected}
	}
	return staged, err
}

func (s *fakeStore) GetChunks(ctx context.Context, snapshotID string) ([]snapshot.Chunk, error) {
	if s.getChunksErr != nil {
		return nil, s.getChunksErr
	}
	return s.MemoryStore.GetChunks(ctx, snapshotID)
}

func (s *fakeStore) PutLatest(ctx context.Context, latest snapshot.Latest) (snapshot.PointerReplacement, error) {
	if s.putLatestErr != nil {
		return snapshot.PointerReplacement{}, s.putLatestErr
	}
	replaced, err := s.MemoryStore.PutLatest(ctx, latest)
	if err == nil && s.putLatestUnusable {
		// The real backend replaces a stored pointer it cannot interpret, quarantines
		// it, and publishes past it. There is no snapshot ID to report then, so the
		// replacement says only that something unnameable was superseded.
		return snapshot.PointerReplacement{Unusable: true}, nil
	}
	return replaced, err
}

func (s *fakeStore) GetLatest(ctx context.Context) (snapshot.Latest, error) {
	s.mu.Lock()
	transient := s.getLatestFailures > 0
	if transient {
		s.getLatestFailures--
	}
	s.mu.Unlock()
	if transient {
		return snapshot.Latest{}, errInjected
	}
	if s.getLatestErr != nil {
		return snapshot.Latest{}, s.getLatestErr
	}
	return s.MemoryStore.GetLatest(ctx)
}

func (s *fakeStore) ExpireChunks(ctx context.Context, snapshotID string, expiresAt time.Time) error {
	s.mu.Lock()
	s.attempts = append(s.attempts, snapshotID)
	hook := s.onExpire
	s.mu.Unlock()
	if hook != nil {
		hook(snapshotID)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.expireErr != nil {
		return s.expireErr
	}
	// The pointer decides what may be expired, exactly as the DynamoDB backend has
	// it: the live snapshot is refused, an unreadable pointer is refused because it
	// proves nothing, and an absent pointer means nothing is live at all.
	published, err := s.GetLatest(ctx)
	switch {
	case err == nil:
		if published.SnapshotID == snapshotID {
			return fmt.Errorf("refusing to expire snapshot %s because the latest pointer still names it", snapshotID)
		}
	case errors.Is(err, snapshot.ErrNotFound):
	default:
		return err
	}
	if _, err := s.MemoryStore.GetChunks(ctx, snapshotID); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expired[snapshotID] = expiresAt
	return nil
}

func (s *fakeStore) expiry(snapshotID string) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, found := s.expired[snapshotID]
	return expiry, found
}

// expireAttempts counts the expiry calls made against any of the given snapshots,
// which is the work a reclaim pass spent whether the table accepted it or not.
func (s *fakeStore) expireAttempts(snapshotIDs ...string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, attempt := range s.attempts {
		if containsString(snapshotIDs, attempt) {
			count++
		}
	}
	return count
}

// logRecord is one decoded line of the logger's JSON Lines output. That output is
// this package's own emitted record format and the interface an operator queries, so
// a test decodes it rather than searching the buffer for loose substrings: a level
// found somewhere in the output says nothing about which record carries it.
type logRecord struct {
	Level      string `json:"level"`
	Event      string `json:"event"`
	SnapshotID string `json:"snapshot_id"`
	PreviousID string `json:"previous_snapshot_id"`
	Staged     int    `json:"staged"`
	Attempted  int    `json:"attempted"`
	Reclaimed  int    `json:"reclaimed"`
	Skipped    int    `json:"skipped"`
	Error      string `json:"error"`
}

func logRecords(t *testing.T, run *testRun) []logRecord {
	t.Helper()
	var records []logRecord
	for _, line := range strings.Split(strings.TrimSpace(run.logs.String()), "\n") {
		if line == "" {
			continue
		}
		var record logRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("log line %q is not a JSON record: %v", line, err)
		}
		records = append(records, record)
	}
	return records
}

// requireRecord returns the first record for an event and fails when there is none,
// so an assertion about a level or an ID is bound to the record that carries it.
func requireRecord(t *testing.T, run *testRun, event string) logRecord {
	t.Helper()
	for _, record := range logRecords(t, run) {
		if record.Event == event {
			return record
		}
	}
	t.Fatalf("no %q record in the log: %s", event, run.logs.String())
	return logRecord{}
}

// requireRecordAt is requireRecord with the level the event must be reported at.
func requireRecordAt(t *testing.T, run *testRun, event string, level Level) logRecord {
	t.Helper()
	record := requireRecord(t, run, event)
	if record.Level != string(level) {
		t.Errorf("the %q record is at level %q, want %q", event, record.Level, level)
	}
	return record
}

func hasRecord(t *testing.T, run *testRun, event string) bool {
	t.Helper()
	for _, record := range logRecords(t, run) {
		if record.Event == event {
			return true
		}
	}
	return false
}

// stagedIDs is every snapshot ID with a staging marker, in ID order.
func stagedIDs(t *testing.T, store *fakeStore) []string {
	t.Helper()
	staged, err := store.MemoryStore.StagedSnapshots(context.Background())
	if err != nil {
		t.Fatalf("StagedSnapshots: %v", err)
	}
	ids := make([]string, 0, len(staged))
	for _, entry := range staged {
		ids = append(ids, entry.SnapshotID)
	}
	return ids
}

func isStaged(t *testing.T, store *fakeStore, snapshotID string) bool {
	t.Helper()
	for _, id := range stagedIDs(t, store) {
		if id == snapshotID {
			return true
		}
	}
	return false
}

// otherSnapshotID is the one stored snapshot ID that is none of the given ones,
// which is how a test names the snapshot a failed publication abandoned.
func otherSnapshotID(t *testing.T, store *fakeStore, known ...string) string {
	t.Helper()
	var found []string
	for _, id := range store.SnapshotIDs() {
		if !containsString(known, id) {
			found = append(found, id)
		}
	}
	if len(found) != 1 {
		t.Fatalf("store holds %d snapshots other than %v, want 1", len(found), known)
	}
	return found[0]
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

var (
	shortLabels = []string{"zap", "orb", "elm", "helm", "dune", "kite"}
	longLabels  = []string{"amber", "stone", "flint"}
)

// writeLists writes the declared word lists into a temporary directory.
func writeLists(t *testing.T, three, four, five []string) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string][]string{
		"3-letters.txt": three,
		"4-letters.txt": four,
		"5-letters.txt": five,
	}
	for name, labels := range files {
		body := "# generated for tests\n" + strings.Join(labels, "\n") + "\n"
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

func defaultLists(t *testing.T) string {
	t.Helper()
	return writeLists(t, shortLabels[:3], shortLabels[3:], longLabels)
}

func testConfig(dir string) Config {
	return Config{
		Table:                "ens-snapshots",
		Endpoint:             "https://subgraph.test/ens",
		WordListDir:          dir,
		Workers:              2,
		BatchSize:            2,
		Retries:              0,
		Soon:                 0,
		RequestTimeout:       5 * time.Second,
		ScanBudget:           time.Minute,
		PreviousReadAttempts: 3,
	}
}

// testRun is one configured run, with an injectable clock and a captured log.
type testRun struct {
	deps  Dependencies
	logs  *bytes.Buffer
	clock *time.Time
	slept []time.Duration
}

func newTestRun(t *testing.T, dir string, graph *fakeGraph, store *fakeStore) *testRun {
	t.Helper()
	clock := fixedNow
	run := &testRun{logs: &bytes.Buffer{}, clock: &clock}
	run.deps = Dependencies{
		Config: testConfig(dir),
		Store:  store,
		Client: graph,
		Logger: NewLogger(run.logs, func() time.Time { return *run.clock }),
		Now:    func() time.Time { return *run.clock },
		Sleep: func(ctx context.Context, delay time.Duration) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			run.slept = append(run.slept, delay)
			return nil
		},
	}
	return run
}

func (r *testRun) at(when time.Time) *testRun {
	*r.clock = when
	return r
}

// statuses reports the published status of every name, so a test can assert what a
// carried result was reclassified as.
func statuses(t *testing.T, store *fakeStore) map[string]ens.Status {
	t.Helper()
	published, _, err := snapshot.Read(context.Background(), store)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	byName := make(map[string]ens.Status, len(published.Results))
	for _, result := range published.Results {
		byName[result.Name] = result.Status
	}
	return byName
}

func publishedNames(t *testing.T, store *fakeStore) []string {
	t.Helper()
	published, _, err := snapshot.Read(context.Background(), store)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	names := make([]string, 0, len(published.Results))
	for _, result := range published.Results {
		names = append(names, result.Name)
	}
	sort.Strings(names)
	return names
}

func sourceIDs(latest snapshot.Latest) []string {
	ids := make([]string, 0, len(latest.Sources))
	for _, source := range latest.Sources {
		ids = append(ids, source.ID)
	}
	sort.Strings(ids)
	return ids
}

func qualify(labels []string) []string {
	names := make([]string, 0, len(labels))
	for _, label := range labels {
		names = append(names, label+".eth")
	}
	sort.Strings(names)
	return names
}

func TestLoadConfig(t *testing.T) {
	base := map[string]string{
		EnvTable:       "ens-snapshots",
		EnvSubgraphURL: "https://subgraph.test/ens",
	}
	withBase := func(extra map[string]string) map[string]string {
		merged := make(map[string]string, len(base)+len(extra))
		for name, value := range base {
			merged[name] = value
		}
		for name, value := range extra {
			merged[name] = value
		}
		return merged
	}

	tests := []struct {
		name  string
		env   map[string]string
		check func(t *testing.T, config Config, err error)
	}{
		{
			name: "an explicit endpoint and the documented defaults",
			env:  withBase(nil),
			check: func(t *testing.T, config Config, err error) {
				if err != nil {
					t.Fatalf("LoadConfig: %v", err)
				}
				want := Config{
					Table:                "ens-snapshots",
					Endpoint:             "https://subgraph.test/ens",
					WordListDir:          defaultWordListDir,
					Workers:              defaultWorkers,
					BatchSize:            defaultBatchSize,
					Retries:              defaultRetries,
					Soon:                 defaultSoonDays * 24 * time.Hour,
					RequestTimeout:       defaultRequestSecs * time.Second,
					ScanBudget:           defaultScanSecs * time.Second,
					PreviousReadAttempts: defaultPreviousRead,
				}
				if config != want {
					t.Errorf("config %+v, want %+v", config, want)
				}
			},
		},
		{
			name: "an API key and a subgraph id select the gateway",
			env: map[string]string{
				EnvTable:      "ens-snapshots",
				EnvAPIKey:     "secret-key",
				EnvSubgraphID: "subgraph-id",
			},
			check: func(t *testing.T, config Config, err error) {
				if err != nil {
					t.Fatalf("LoadConfig: %v", err)
				}
				want := fmt.Sprintf(gatewayTemplate, "secret-key", "subgraph-id")
				if config.Endpoint != want {
					t.Errorf("endpoint %q, want %q", config.Endpoint, want)
				}
			},
		},
		{
			name:  "a missing table is refused",
			env:   map[string]string{EnvSubgraphURL: "https://subgraph.test/ens"},
			check: expectConfigError(EnvTable),
		},
		{
			name:  "no endpoint setting at all is refused rather than defaulted",
			env:   map[string]string{EnvTable: "ens-snapshots"},
			check: expectConfigError(EnvSubgraphURL),
		},
		{
			name: "an API key without a subgraph id is refused",
			env: map[string]string{
				EnvTable:  "ens-snapshots",
				EnvAPIKey: "secret-key",
			},
			check: expectConfigError(EnvSubgraphID),
		},
		{
			name: "a separator in a path segment is refused",
			env: map[string]string{
				EnvTable:      "ens-snapshots",
				EnvAPIKey:     "secret-key",
				EnvSubgraphID: "subgraph-id/../elsewhere",
			},
			check: func(t *testing.T, config Config, err error) {
				if err == nil {
					t.Fatalf("LoadConfig accepted a subgraph id containing a separator")
				}
				if strings.Contains(err.Error(), "secret-key") {
					t.Errorf("LoadConfig quoted the API key back: %v", err)
				}
			},
		},
		{
			name:  "a non-numeric setting is refused",
			env:   withBase(map[string]string{EnvWorkers: "many"}),
			check: expectConfigError(EnvWorkers),
		},
		{
			name:  "a setting above its ceiling is refused",
			env:   withBase(map[string]string{EnvBatchSize: "5000"}),
			check: expectConfigError(EnvBatchSize),
		},
		{
			name:  "a setting below its floor is refused",
			env:   withBase(map[string]string{EnvWorkers: "0"}),
			check: expectConfigError(EnvWorkers),
		},
		{
			name: "overrides are applied",
			env: withBase(map[string]string{
				EnvWordListDir:    "/var/task/words",
				EnvWorkers:        "8",
				EnvBatchSize:      "250",
				EnvRetries:        "5",
				EnvSoonDays:       "14",
				EnvRequestSeconds: "45",
				EnvScanSeconds:    "900",
				EnvPreviousReads:  "2",
			}),
			check: func(t *testing.T, config Config, err error) {
				if err != nil {
					t.Fatalf("LoadConfig: %v", err)
				}
				if config.WordListDir != "/var/task/words" || config.Workers != 8 || config.BatchSize != 250 ||
					config.Retries != 5 || config.Soon != 14*24*time.Hour ||
					config.RequestTimeout != 45*time.Second || config.ScanBudget != 900*time.Second ||
					config.PreviousReadAttempts != 2 {
					t.Errorf("overrides were not applied: %+v", config)
				}
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			config, err := LoadConfig(func(name string) string { return test.env[name] })
			test.check(t, config, err)
		})
	}
}

func expectConfigError(mention string) func(t *testing.T, config Config, err error) {
	return func(t *testing.T, config Config, err error) {
		if err == nil {
			t.Fatalf("LoadConfig accepted the configuration, want an error mentioning %s", mention)
		}
		if !strings.Contains(err.Error(), mention) {
			t.Errorf("error %q does not mention %s", err, mention)
		}
	}
}

// TestConfigRejectsAKeyTooShortToRedact closes the redaction promise at
// configuration time rather than leaving it length-dependent. A Redactor only strips
// a configured literal that is long enough to be a credential, so a shorter key would
// silently fall back to the URL pattern alone - and the one case the literal exists
// for is a bare key echoed in a gateway response body, where there is no URL to match.
// A credential that cannot be protected fails at startup, like every other unusable
// credential here.
//
// Nothing in this test asserts on a real credential, and nothing asserted may narrow
// the configured value: the rejection and the log must not quote it or any part of it.
func TestConfigRejectsAKeyTooShortToRedact(t *testing.T) {
	// Invented here, not a credential, and deliberately below the redactor's minimum.
	const shortKey = "k9t2xq"

	// The value must not be recoverable from what a rejection emits, so every prefix
	// long enough to narrow it has to be absent as well as the whole thing.
	assertHidesKey := func(t *testing.T, what, output string) {
		t.Helper()
		for length := 2; length <= len(shortKey); length++ {
			if strings.Contains(output, shortKey[:length]) {
				t.Fatalf("the %s quotes %d characters of the configured key: %s", what, length, output)
			}
		}
	}

	_, err := LoadConfig(func(name string) string {
		switch name {
		case EnvTable:
			return "ens-snapshots"
		case EnvAPIKey:
			return shortKey
		case EnvSubgraphID:
			return "ens-subgraph"
		}
		return ""
	})
	if err == nil {
		t.Fatalf("LoadConfig accepted a key too short to redact")
	}
	assertHidesKey(t, "rejection", err.Error())
	if !strings.Contains(err.Error(), EnvAPIKey) {
		t.Errorf("the rejection %q does not name the variable to fix", err)
	}

	// A run refuses it too, so a Dependencies built by hand cannot bypass the gate,
	// and the refusal reaches the log without the key.
	store := newFakeStore()
	run := newTestRun(t, defaultLists(t), newFakeGraph(nil), store)
	run.deps.Config.APIKey = shortKey
	if _, err := Run(context.Background(), run.deps, Event{Group: GroupShort}); err == nil {
		t.Fatalf("Run started with a key too short to redact")
	}
	requireRecordAt(t, run, "scan_rejected", LevelError)
	assertHidesKey(t, "log", run.logs.String())
	if _, err := store.GetLatest(context.Background()); !errors.Is(err, snapshot.ErrNotFound) {
		t.Errorf("a rejected run published something: %v", err)
	}

	// A key long enough to be stripped as a literal is still accepted, so the gate
	// rejects an unusable credential and not a usable one.
	config := testConfig(t.TempDir())
	config.APIKey = testAPIKey
	if err := config.Validate(); err != nil {
		t.Errorf("Validate rejected a key of usable length: %v", err)
	}
}

func TestLoadConfigRejectsAMissingLookup(t *testing.T) {
	if _, err := LoadConfig(nil); err == nil {
		t.Fatalf("LoadConfig accepted a nil lookup")
	}
}

func TestSnapshotIDIsValidForEveryGroup(t *testing.T) {
	for _, group := range Groups {
		id := snapshotID(group, fixedNow)
		if err := snapshot.ValidateSnapshotID(id); err != nil {
			t.Errorf("snapshot id %q for group %q is invalid: %v", id, group, err)
		}
	}
}

func TestRunRejectsAnUnknownGroup(t *testing.T) {
	store := newFakeStore()
	run := newTestRun(t, defaultLists(t), newFakeGraph(nil), store)

	if _, err := Run(context.Background(), run.deps, Event{Group: "every-letter"}); err == nil {
		t.Fatalf("Run accepted an unknown group")
	}
	if _, err := store.GetLatest(context.Background()); !errors.Is(err, snapshot.ErrNotFound) {
		t.Errorf("a rejected event published something: %v", err)
	}
	if strings.Contains(run.logs.String(), "every-letter") {
		t.Errorf("the log reflected the unvalidated group back: %s", run.logs.String())
	}
}

func TestRunBootstrapsWithOnlyTheScannedGroup(t *testing.T) {
	store := newFakeStore()
	graph := newFakeGraph(map[string]time.Time{"zap": fixedNow.Add(48 * time.Hour)})
	run := newTestRun(t, defaultLists(t), graph, store)

	result, err := Run(context.Background(), run.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	if got, want := result.Scanned, len(shortLabels); got != want {
		t.Errorf("scanned %d names, want %d", got, want)
	}
	if result.Carried != 0 {
		t.Errorf("carried %d results with no previous snapshot", result.Carried)
	}
	if got, want := graph.asked(), append([]string(nil), shortLabels...); !equalStrings(got, sortedCopy(want)) {
		t.Errorf("asked the subgraph about %v, want %v", got, sortedCopy(want))
	}
	if got, want := publishedNames(t, store), qualify(shortLabels); !equalStrings(got, want) {
		t.Errorf("published %v, want %v", got, want)
	}
	if got, want := sourceIDs(result.Latest), []string{"3-letters", "4-letters"}; !equalStrings(got, want) {
		t.Errorf("sources %v, want %v", got, want)
	}
	// The daily list contributed nothing, so the snapshot must advertise the
	// three-hourly threshold rather than the slower one.
	if got, want := result.Latest.ScanAge.StaleAfterSeconds, int64(2*3*3600); got != want {
		t.Errorf("stale-after %d seconds, want %d", got, want)
	}
	if got := statuses(t, store)["zap.eth"]; got != ens.StatusRegistered {
		t.Errorf("zap.eth is %q, want %q", got, ens.StatusRegistered)
	}
	total := 0
	for _, source := range result.Latest.Sources {
		total += source.Names
	}
	if total != result.Latest.Names {
		t.Errorf("source counts sum to %d, want %d", total, result.Latest.Names)
	}
}

func TestRunCarriesTheOtherGroupForward(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)
	graph := newFakeGraph(nil)

	first := newTestRun(t, dir, graph, store)
	if _, err := Run(context.Background(), first.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("first Run: %v", err)
	}

	longGraph := newFakeGraph(nil)
	second := newTestRun(t, dir, longGraph, store).at(fixedNow.Add(3 * time.Hour))
	result, err := Run(context.Background(), second.deps, Event{Group: GroupLong})
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}

	if got, want := longGraph.asked(), qualifyLess(longLabels); !equalStrings(got, want) {
		t.Errorf("the daily schedule asked about %v, want only %v", got, want)
	}
	if got, want := result.Scanned, len(longLabels); got != want {
		t.Errorf("scanned %d names, want %d", got, want)
	}
	if got, want := result.Carried, len(shortLabels); got != want {
		t.Errorf("carried %d results, want %d", got, want)
	}
	if got, want := publishedNames(t, store), qualify(append(append([]string(nil), shortLabels...), longLabels...)); !equalStrings(got, want) {
		t.Errorf("published %v, want %v", got, want)
	}
	if got, want := sourceIDs(result.Latest), []string{"3-letters", "4-letters", "5-letters"}; !equalStrings(got, want) {
		t.Errorf("sources %v, want %v", got, want)
	}
	// Now that the daily list contributes, the slowest cadence governs.
	if got, want := result.Latest.ScanAge.StaleAfterSeconds, int64(2*24*3600); got != want {
		t.Errorf("stale-after %d seconds, want %d", got, want)
	}
	if result.Previous == "" || result.Previous == result.Latest.SnapshotID {
		t.Errorf("the run did not report the snapshot it superseded: %+v", result)
	}
}

func TestRunReclassifiesCarriedNamesAtTheNewScanTime(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)
	expiry := fixedNow.Add(time.Hour)

	first := newTestRun(t, dir, newFakeGraph(map[string]time.Time{"zap": expiry}), store)
	if _, err := Run(context.Background(), first.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("first Run: %v", err)
	}
	if got := statuses(t, store)["zap.eth"]; got != ens.StatusRegistered {
		t.Fatalf("zap.eth is %q before its expiry, want %q", got, ens.StatusRegistered)
	}

	// The daily schedule runs after the expiry passes. It never asks about zap.eth,
	// but the status it publishes for it must still be honest at the new instant:
	// the carried registration data is reclassified, not copied.
	longGraph := newFakeGraph(nil)
	second := newTestRun(t, dir, longGraph, store).at(expiry.Add(time.Hour))
	if _, err := Run(context.Background(), second.deps, Event{Group: GroupLong}); err != nil {
		t.Fatalf("second Run: %v", err)
	}

	for _, label := range longGraph.asked() {
		if label == "zap" {
			t.Fatalf("the daily schedule rescanned a carried name")
		}
	}
	if got := statuses(t, store)["zap.eth"]; got != ens.StatusGracePeriod {
		t.Errorf("zap.eth is %q after its expiry, want %q", got, ens.StatusGracePeriod)
	}
}

func TestRunDropsCarriedNamesRemovedFromTheirList(t *testing.T) {
	store := newFakeStore()
	dir := writeLists(t, shortLabels[:3], shortLabels[3:], longLabels)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	if _, err := Run(context.Background(), first.deps, Event{Group: GroupLong}); err != nil {
		t.Fatalf("first Run: %v", err)
	}

	// The daily list loses a label. The next short scan carries the daily group
	// forward, and a label the list no longer declares must not survive.
	body := "# generated for tests\n" + strings.Join(longLabels[:2], "\n") + "\n"
	if err := os.WriteFile(filepath.Join(dir, "5-letters.txt"), []byte(body), 0o600); err != nil {
		t.Fatalf("rewrite 5-letters.txt: %v", err)
	}

	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(3 * time.Hour))
	result, err := Run(context.Background(), second.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if got, want := result.Carried, len(longLabels)-1; got != want {
		t.Errorf("carried %d results, want %d", got, want)
	}
	published := statuses(t, store)
	if _, found := published[longLabels[2]+".eth"]; found {
		t.Errorf("a label removed from its list is still published")
	}
}

func TestEveryFailureLeavesThePreviousSnapshotServing(t *testing.T) {
	tests := []struct {
		name   string
		inject func(t *testing.T, run *testRun, graph *fakeGraph, store *fakeStore, cancel context.CancelFunc)
	}{
		{
			name: "the subgraph fails",
			inject: func(t *testing.T, run *testRun, graph *fakeGraph, store *fakeStore, cancel context.CancelFunc) {
				graph.err = errInjected
			},
		},
		{
			name: "the chunk write fails",
			inject: func(t *testing.T, run *testRun, graph *fakeGraph, store *fakeStore, cancel context.CancelFunc) {
				store.putChunksErr = errInjected
			},
		},
		{
			name: "the readback fails",
			inject: func(t *testing.T, run *testRun, graph *fakeGraph, store *fakeStore, cancel context.CancelFunc) {
				store.getChunksErr = errInjected
			},
		},
		{
			name: "the pointer write fails",
			inject: func(t *testing.T, run *testRun, graph *fakeGraph, store *fakeStore, cancel context.CancelFunc) {
				store.putLatestErr = errInjected
			},
		},
		{
			name: "the run is cancelled mid-scan",
			inject: func(t *testing.T, run *testRun, graph *fakeGraph, store *fakeStore, cancel context.CancelFunc) {
				graph.onLookup = cancel
			},
		},
		{
			name: "the scan budget runs out",
			inject: func(t *testing.T, run *testRun, graph *fakeGraph, store *fakeStore, cancel context.CancelFunc) {
				run.deps.Config.ScanBudget = time.Nanosecond
				graph.onLookup = func() { time.Sleep(5 * time.Millisecond) }
			},
		},
		{
			name: "the configuration is invalid",
			inject: func(t *testing.T, run *testRun, graph *fakeGraph, store *fakeStore, cancel context.CancelFunc) {
				run.deps.Config.Soon = -1
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			store := newFakeStore()
			dir := defaultLists(t)

			first := newTestRun(t, dir, newFakeGraph(nil), store)
			previous, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
			if err != nil {
				t.Fatalf("first Run: %v", err)
			}

			graph := newFakeGraph(nil)
			second := newTestRun(t, dir, graph, store).at(fixedNow.Add(3 * time.Hour))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			test.inject(t, second, graph, store, cancel)

			if _, err := Run(ctx, second.deps, Event{Group: GroupLong}); err == nil {
				t.Fatalf("Run succeeded despite the injected failure")
			}

			// Readers must still see the complete, verified snapshot the previous
			// run published, through a context the failure did not touch.
			store.putChunksErr = nil
			store.getChunksErr = nil
			store.putLatestErr = nil
			published, latest, err := snapshot.Read(context.Background(), store)
			if err != nil {
				t.Fatalf("the failed run left no readable snapshot: %v", err)
			}
			if latest.SnapshotID != previous.Latest.SnapshotID {
				t.Errorf("the pointer moved to %q, want %q", latest.SnapshotID, previous.Latest.SnapshotID)
			}
			if got, want := len(published.Results), len(shortLabels); got != want {
				t.Errorf("the served snapshot holds %d results, want %d", got, want)
			}
		})
	}
}

func TestRunPublishesWhenThePreviousPointerIsUnreadable(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)
	store.getLatestErr = errInjected

	run := newTestRun(t, dir, newFakeGraph(nil), store)
	result, err := Run(context.Background(), run.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(run.slept) != run.deps.Config.PreviousReadAttempts-1 {
		t.Errorf("waited %d times between %d attempts", len(run.slept), run.deps.Config.PreviousReadAttempts)
	}
	requireRecordAt(t, run, "previous_snapshot_unreadable", LevelWarn)
	if result.Carried != 0 || result.Previous != "" {
		t.Errorf("a run that could not read the previous snapshot carried state anyway: %+v", result)
	}

	store.getLatestErr = nil
	if got, want := publishedNames(t, store), qualify(shortLabels); !equalStrings(got, want) {
		t.Errorf("published %v, want %v", got, want)
	}
}

func TestRunFailsWhenTheContextEndsBeforeTheScan(t *testing.T) {
	store := newFakeStore()
	run := newTestRun(t, defaultLists(t), newFakeGraph(nil), store)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := Run(ctx, run.deps, Event{Group: GroupShort}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run error %v, want a cancellation", err)
	}
	if _, err := store.GetLatest(context.Background()); !errors.Is(err, snapshot.ErrNotFound) {
		// A cancelled read says nothing about what is stored, so it must not be
		// mistaken for an empty store and published over.
		t.Errorf("a cancelled run published something: %v", err)
	}
}

func TestRunExpiresTheSupersededSnapshot(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	previous, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}

	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(3 * time.Hour))
	current, err := Run(context.Background(), second.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}

	expiry, found := store.expiry(previous.Latest.SnapshotID)
	if !found {
		t.Fatalf("the superseded snapshot was not given a TTL")
	}
	window := time.Duration(previous.Latest.ScanAge.StaleAfterSeconds) * time.Second
	if want := current.Latest.PublishedAt.Add(window); !expiry.Equal(want) {
		t.Errorf("TTL %s, want %s", expiry, want)
	}
	if _, found := store.expiry(current.Latest.SnapshotID); found {
		t.Errorf("the published snapshot was given a TTL")
	}
	requireRecordAt(t, second, "superseded_chunks_expired", LevelInfo)
}

func TestRunSucceedsWhenTheTTLCannotBeApplied(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	previous, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}

	store.expireErr = errInjected
	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(3 * time.Hour))
	current, err := Run(context.Background(), second.deps, Event{Group: GroupShort})
	if err != nil {
		// The snapshot is already published and verified. Reporting a retention
		// failure as a run failure would invite a retry with nothing left to do.
		t.Fatalf("a retention failure failed the whole run: %v", err)
	}
	if current.Latest.SnapshotID == previous.Latest.SnapshotID {
		t.Fatalf("the second run did not publish a new snapshot")
	}
	requireRecordAt(t, second, "superseded_chunks_expire_failed", LevelWarn)
	if _, _, err := snapshot.Read(context.Background(), store); err != nil {
		t.Errorf("the published snapshot is not readable: %v", err)
	}
}

// TestRunExpiresThePointerItReplacedAfterAFailedPreviousRead is the case that needs
// no concurrency at all: one burst of throttled pointer reads exhausts the
// previous-snapshot attempts, so the run publishes past a snapshot it never read.
// The pointer write still replaces that snapshot, and its chunks are what has to
// carry the retention window. A run that expired what the read returned instead
// would expire nothing here, and the replaced set would keep neither a TTL nor a
// staging marker - its own publisher removed the marker when it succeeded - so
// nothing in the store could ever find it again.
func TestRunExpiresThePointerItReplacedAfterAFailedPreviousRead(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	previous, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}

	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(3 * time.Hour))
	// Every previous-read attempt fails and nothing after them does, which is what a
	// throttling burst looks like from inside one invocation.
	store.getLatestFailures = second.deps.Config.PreviousReadAttempts
	current, err := Run(context.Background(), second.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	requireRecordAt(t, second, "previous_snapshot_unreadable", LevelWarn)

	expiry, found := store.expiry(previous.Latest.SnapshotID)
	if !found {
		t.Fatalf("the snapshot this publication replaced was left with no TTL: %s", second.logs.String())
	}
	window := time.Duration(previous.Latest.ScanAge.StaleAfterSeconds) * time.Second
	if want := current.Latest.PublishedAt.Add(window); !expiry.Equal(want) {
		t.Errorf("TTL %s, want %s", expiry, want)
	}
	if record := requireRecordAt(t, second, "superseded_chunks_expired", LevelInfo); record.PreviousID != previous.Latest.SnapshotID {
		t.Errorf("the retention record names %q, want the replaced snapshot %q",
			record.PreviousID, previous.Latest.SnapshotID)
	}
	if _, found := store.expiry(current.Latest.SnapshotID); found {
		t.Errorf("the published snapshot was given a TTL")
	}
	if _, _, err := snapshot.Read(context.Background(), store); err != nil {
		t.Errorf("the published snapshot is not readable: %v", err)
	}
}

// TestRunExpiresThePointerAnotherRunLeftBehind is the concurrent case. The other
// group publishes after this run has read the previous snapshot and before this run
// writes its own pointer, so the snapshot this run supersedes is not the one it read.
// Retention has to follow the pointer write, or the snapshot published in between is
// replaced with nothing naming it and nothing expiring it.
func TestRunExpiresThePointerAnotherRunLeftBehind(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	if _, err := Run(context.Background(), first.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("first Run: %v", err)
	}

	// The daily run reads the previous snapshot and is then overtaken: the three-hourly
	// schedule publishes while it is writing its chunks. Its own scan time is the newer
	// one, so its pointer still wins, and what it replaces is the overtaking snapshot.
	long := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(2 * time.Hour))
	var overtaking string
	store.onPutChunks = func() {
		store.onPutChunks = nil
		concurrent := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(time.Hour))
		result, err := Run(context.Background(), concurrent.deps, Event{Group: GroupShort})
		if err != nil {
			t.Errorf("the overtaking short run failed: %v", err)
			return
		}
		overtaking = result.Latest.SnapshotID
	}

	current, err := Run(context.Background(), long.deps, Event{Group: GroupLong})
	if err != nil {
		t.Fatalf("daily Run: %v", err)
	}
	if overtaking == "" {
		t.Fatalf("the overtaking run did not publish")
	}
	if current.Previous != overtaking {
		t.Fatalf("the run reports superseding %q, want the snapshot it replaced, %q",
			current.Previous, overtaking)
	}
	if _, found := store.expiry(overtaking); !found {
		t.Errorf("the snapshot this run replaced was left with no TTL: %s", long.logs.String())
	}
	if _, found := store.expiry(current.Latest.SnapshotID); found {
		t.Errorf("the published snapshot was given a TTL")
	}
	if _, latest, err := snapshot.Read(context.Background(), store); err != nil || latest.SnapshotID != current.Latest.SnapshotID {
		t.Errorf("readers do not see %q: %v", current.Latest.SnapshotID, err)
	}
}

// TestRunReportsASupersededSnapshotItCannotName covers the third way the replaced
// pointer is not the one that was read: the stored pointer did not read at all, so
// the backend quarantined it and published past it. Which snapshot it named is
// unknowable, so nothing may be expired on its word, and an operator has to be told
// that a chunk set was superseded without being named.
func TestRunReportsASupersededSnapshotItCannotName(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	store.putLatestUnusable = true
	run := newTestRun(t, dir, newFakeGraph(nil), store)
	result, err := Run(context.Background(), run.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Previous != "" {
		t.Errorf("the run named %q as superseded from a pointer that could not be read", result.Previous)
	}
	requireRecordAt(t, run, "superseded_snapshot_unknown", LevelWarn)
	if got := store.expireAttempts(result.Latest.SnapshotID); got != 0 {
		t.Errorf("the run attempted %d expiries against a pointer it could not interpret", got)
	}
	if _, _, err := snapshot.Read(context.Background(), store); err != nil {
		t.Errorf("the published snapshot is not readable: %v", err)
	}
}

// TestReclaimRemovesTheMarkerOfTheSnapshotItPublished covers the marker a publisher
// leaves behind when its own unstage fails after the pointer has moved. Only the
// marker is stale, so the pass removes it and leaves the chunks alone. Skipping it
// because it happens to name this run's own snapshot would leave it for a later run
// to find as neither live nor its own, and that run would report a snapshot it is
// serving as an abandoned chunk set and hand it a retention window.
func TestReclaimRemovesTheMarkerOfTheSnapshotItPublished(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	if _, err := Run(context.Background(), first.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("first Run: %v", err)
	}

	// The unstage that follows the pointer write fails once, so the published
	// snapshot keeps its own marker into the reclaim pass.
	store.unstageFailures = 1
	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(3 * time.Hour))
	current, err := Run(context.Background(), second.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	requireRecordAt(t, second, "staging_marker_kept", LevelWarn)

	if isStaged(t, store, current.Latest.SnapshotID) {
		t.Errorf("the marker of the snapshot the run published was kept: %v", stagedIDs(t, store))
	}
	if _, found := store.expiry(current.Latest.SnapshotID); found {
		t.Errorf("the published snapshot was given a TTL")
	}
	if hasRecord(t, second, "abandoned_chunks_expired") {
		t.Errorf("the run reported its own published snapshot as abandoned: %s", second.logs.String())
	}
	if _, latest, err := snapshot.Read(context.Background(), store); err != nil || latest.SnapshotID != current.Latest.SnapshotID {
		t.Errorf("readers do not see %q: %v", current.Latest.SnapshotID, err)
	}
}

// TestSupersededTTLIsAppliedBeforeTheReclaimPass covers the one retention action no
// later run can repeat. The superseded snapshot's own publisher removed its staging
// marker when it succeeded, and the reclaim pass iterates nothing but markers, so a
// run that skips this expiry leaves a chunk set nothing in the store can ever find
// again. Every action the reclaim pass takes is driven off a durable marker and is
// retried on the next schedule, so it must not be able to spend the invocation's
// remaining deadline ahead of the work that gets one attempt.
func TestSupersededTTLIsAppliedBeforeTheReclaimPass(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	previous, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}

	// A backlog of chunk sets earlier invocations abandoned, all well past their grace
	// period, is what the reclaim pass has to work through.
	abandoned := stageAbandoned(t, store, fixedNow.Add(-2*abandonedAfter), maxReclaimsPerRun)

	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(3 * time.Hour))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// The invocation's remaining deadline expires on the first reclaim, which is what a
	// throttled table looks like from inside one pass.
	store.onExpire = func(snapshotID string) {
		if containsString(abandoned, snapshotID) {
			cancel()
		}
	}

	current, err := Run(ctx, second.deps, Event{Group: GroupShort})
	if err != nil {
		// The snapshot was published and verified before the pass began, so a pass that
		// ran out of time must not turn a successful publication into a failure.
		t.Fatalf("second Run: %v", err)
	}
	// The pass really did end early, which is the condition this test is about.
	if !hasRecord(t, second, "abandoned_chunks_expire_failed") {
		t.Fatalf("the reclaim pass was never cut short: %s", second.logs.String())
	}

	expiry, found := store.expiry(previous.Latest.SnapshotID)
	if !found {
		t.Fatalf("the superseded snapshot was left with no TTL and no marker: %s", second.logs.String())
	}
	window := time.Duration(previous.Latest.ScanAge.StaleAfterSeconds) * time.Second
	if want := current.Latest.PublishedAt.Add(window); !expiry.Equal(want) {
		t.Errorf("TTL %s, want %s", expiry, want)
	}
	requireRecordAt(t, second, "superseded_chunks_expired", LevelInfo)
	if _, found := store.expiry(current.Latest.SnapshotID); found {
		t.Errorf("the published snapshot was given a TTL")
	}
	if _, latest, err := snapshot.Read(context.Background(), store); err != nil || latest.SnapshotID != current.Latest.SnapshotID {
		t.Errorf("readers do not see %q: %v", current.Latest.SnapshotID, err)
	}
}

// TestReclaimNeverReportsTheSnapshotItSupersededAsAbandoned is the one-run-later form
// of reporting a served snapshot as abandoned. A marker for a snapshot that was
// published and has since been superseded is neither the live one nor this run's own,
// and once it is older than the grace period the pass would otherwise expire it with
// the crude abandoned window and raise the warning that means an earlier publication
// wrote a whole snapshot and never published it.
func TestReclaimNeverReportsTheSnapshotItSupersededAsAbandoned(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	// The first run's post-publish unstage fails, and so does the retry its own reclaim
	// pass makes, so the snapshot it published keeps its marker past the end of the run.
	store.unstageErr = errInjected
	first := newTestRun(t, dir, newFakeGraph(nil), store)
	previous, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}
	store.unstageErr = nil
	if !isStaged(t, store, previous.Latest.SnapshotID) {
		t.Fatalf("the published snapshot kept no marker, so there is nothing to misreport")
	}

	// Three hours on, the marker is older than the grace period and the snapshot it
	// names is no longer the live one.
	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(3 * time.Hour))
	current, err := Run(context.Background(), second.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if current.Previous != previous.Latest.SnapshotID {
		t.Fatalf("the run reports superseding %q, want the pointer it replaced, %q",
			current.Previous, previous.Latest.SnapshotID)
	}

	if hasRecord(t, second, "abandoned_chunks_expired") {
		t.Errorf("a published-then-superseded snapshot was reported as abandoned: %s", second.logs.String())
	}
	// One expiry, aimed by the retention rule, and not repeated by the pass with the
	// abandoned window that would overwrite it.
	if got := store.expireAttempts(previous.Latest.SnapshotID); got != 1 {
		t.Errorf("the run made %d expiry calls against the snapshot it superseded, want 1", got)
	}
	expiry, found := store.expiry(previous.Latest.SnapshotID)
	if !found {
		t.Fatalf("the superseded snapshot was left with no TTL")
	}
	window := time.Duration(previous.Latest.ScanAge.StaleAfterSeconds) * time.Second
	if want := current.Latest.PublishedAt.Add(window); !expiry.Equal(want) {
		t.Errorf("TTL %s, want the superseded snapshot's own stale-after window, %s", expiry, want)
	}
	// The stale marker is still cleared, so a later pass does not rediscover it.
	if isStaged(t, store, previous.Latest.SnapshotID) {
		t.Errorf("the stale marker of the superseded snapshot was kept: %v", stagedIDs(t, store))
	}
	if _, latest, err := snapshot.Read(context.Background(), store); err != nil || latest.SnapshotID != current.Latest.SnapshotID {
		t.Errorf("readers do not see %q: %v", current.Latest.SnapshotID, err)
	}
}

// TestSupersededMarkerSurvivesAFailedTTLWrite is the other half of the exclusion. The
// reclaim pass may only skip the snapshot this run superseded once that snapshot's
// retention has actually settled: the expiry is best effort, and a chunk set whose
// expiry failed has its staging marker as the last thing in the store that can find
// it. Removing that marker anyway leaves the set with no TTL, no pointer, and no
// record, which is the permanent leak the exclusion was added to close.
func TestSupersededMarkerSurvivesAFailedTTLWrite(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	// The first run's own unstage fails, and so does the retry its reclaim pass makes,
	// so the snapshot it published keeps its marker past the end of the run.
	store.unstageErr = errInjected
	first := newTestRun(t, dir, newFakeGraph(nil), store)
	previous, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}
	store.unstageErr = nil
	if !isStaged(t, store, previous.Latest.SnapshotID) {
		t.Fatalf("the published snapshot kept no marker, so there is nothing to lose")
	}

	// The next run supersedes it, and every retention write it attempts is refused.
	store.expireErr = errInjected
	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(3 * time.Hour))
	current, err := Run(context.Background(), second.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("a retention failure failed the whole run: %v", err)
	}
	if current.Previous != previous.Latest.SnapshotID {
		t.Fatalf("the run reports superseding %q, want the pointer it replaced, %q",
			current.Previous, previous.Latest.SnapshotID)
	}
	requireRecordAt(t, second, "superseded_chunks_expire_failed", LevelWarn)

	if _, found := store.expiry(previous.Latest.SnapshotID); found {
		t.Fatalf("the refused expiry was recorded anyway, so this proves nothing")
	}
	if !isStaged(t, store, previous.Latest.SnapshotID) {
		t.Errorf("the marker of a superseded snapshot with no TTL was removed, so nothing can find its chunks: %s",
			second.logs.String())
	}
	if !containsString(store.SnapshotIDs(), previous.Latest.SnapshotID) {
		t.Errorf("the superseded snapshot's chunks are already gone")
	}

	// Because the marker survived, a later pass still bounds the set, under the cruder
	// abandoned window. That report is accurate here: the retention it was owed never
	// landed, so what it should have been is genuinely unknown.
	store.expireErr = nil
	reclaimAt := fixedNow.Add(6 * time.Hour)
	third := newTestRun(t, dir, newFakeGraph(nil), store).at(reclaimAt)
	latestRun, err := Run(context.Background(), third.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("third Run: %v", err)
	}
	expiry, found := store.expiry(previous.Latest.SnapshotID)
	if !found {
		t.Fatalf("a later pass could not bound the set the failed expiry left behind: %s", third.logs.String())
	}
	if want := reclaimAt.Add(abandonedRetention); !expiry.Equal(want) {
		t.Errorf("TTL %s, want the abandoned window %s", expiry, want)
	}
	if record := requireRecordAt(t, third, "abandoned_chunks_expired", LevelWarn); record.SnapshotID != previous.Latest.SnapshotID {
		t.Errorf("the reclaim record names %q, want %q", record.SnapshotID, previous.Latest.SnapshotID)
	}
	if isStaged(t, store, previous.Latest.SnapshotID) {
		t.Errorf("the marker of a bounded set was kept: %v", stagedIDs(t, store))
	}
	if _, found := store.expiry(latestRun.Latest.SnapshotID); found {
		t.Errorf("the published snapshot was given a TTL")
	}
	if _, latest, err := snapshot.Read(context.Background(), store); err != nil || latest.SnapshotID != latestRun.Latest.SnapshotID {
		t.Errorf("readers do not see %q: %v", latestRun.Latest.SnapshotID, err)
	}
}

func TestRunCarriesTheSnapshotPublishedDuringItsScan(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	// The three- and four-letter lists are published first, with zap.eth unregistered.
	first := newTestRun(t, dir, newFakeGraph(nil), store)
	if _, err := Run(context.Background(), first.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("first Run: %v", err)
	}
	if got := statuses(t, store)["zap.eth"]; got != ens.StatusAvailable {
		t.Fatalf("zap.eth is %q before it is registered, want %q", got, ens.StatusAvailable)
	}

	// The daily scan starts an hour later and runs long enough for the three-hourly
	// schedule to publish a fresher result for zap.eth while it is still scanning.
	longGraph := newFakeGraph(nil)
	long := newTestRun(t, dir, longGraph, store).at(fixedNow.Add(time.Hour))
	longGraph.onLookup = func() {
		registered := map[string]time.Time{"zap": fixedNow.Add(48 * time.Hour)}
		concurrent := newTestRun(t, dir, newFakeGraph(registered), store).at(fixedNow.Add(30 * time.Minute))
		if _, err := Run(context.Background(), concurrent.deps, Event{Group: GroupShort}); err != nil {
			t.Errorf("the concurrent short run failed: %v", err)
		}
	}

	result, err := Run(context.Background(), long.deps, Event{Group: GroupLong})
	if err != nil {
		t.Fatalf("daily Run: %v", err)
	}

	// The daily run never asks about zap.eth, and its own scan time is the newer one,
	// so its pointer wins. The only honest thing for it to carry forward is what was
	// published while it was scanning.
	if got := statuses(t, store)["zap.eth"]; got != ens.StatusRegistered {
		t.Errorf("zap.eth is %q, want %q: the run carried a snapshot older than its own scan",
			got, ens.StatusRegistered)
	}
	if got, want := result.Carried, len(shortLabels); got != want {
		t.Errorf("carried %d results, want %d", got, want)
	}
	_, latest, err := snapshot.Read(context.Background(), store)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if latest.SnapshotID != result.Latest.SnapshotID {
		t.Errorf("the pointer names %q, want the daily run's %q", latest.SnapshotID, result.Latest.SnapshotID)
	}
}

func TestRunWarnsWhenThePreviousSnapshotChunksAreMissing(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	previous, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}
	// The pointer still resolves, but the snapshot it names is gone: an operator
	// rolled the pointer back to a snapshot whose recovery window had passed.
	if err := store.MemoryStore.DeleteChunks(context.Background(), previous.Latest.SnapshotID); err != nil {
		t.Fatalf("DeleteChunks: %v", err)
	}

	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(3 * time.Hour))
	result, err := Run(context.Background(), second.deps, Event{Group: GroupLong})
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}

	// An operator must never lose a whole group with nothing above INFO, so the level
	// is asserted on the record that reports the loss and not on the buffer.
	record := requireRecordAt(t, second, "previous_snapshot_chunks_missing", LevelWarn)
	if record.PreviousID != previous.Latest.SnapshotID {
		t.Errorf("the record names %q, want the snapshot that vanished, %q",
			record.PreviousID, previous.Latest.SnapshotID)
	}
	// Losing a whole group must not look like a first run, and a strongly consistent
	// read that found no chunk will not find one on a retry either.
	if hasRecord(t, second, "previous_snapshot_absent") {
		t.Errorf("a vanished snapshot was reported as a bootstrap: %s", second.logs.String())
	}
	if len(second.slept) != 0 {
		t.Errorf("waited %d times for chunks that are definitively absent", len(second.slept))
	}
	if result.Carried != 0 {
		t.Errorf("a run that could not read the previous snapshot carried %d results", result.Carried)
	}
	// The read gave up, but the pointer write still replaced the pointer that read
	// could not resolve, so that is the snapshot this publication superseded. Its
	// chunks are already gone, which is nothing left to expire rather than a failure.
	if result.Previous != previous.Latest.SnapshotID {
		t.Errorf("the run reports superseding %q, want the pointer it replaced, %q",
			result.Previous, previous.Latest.SnapshotID)
	}
	requireRecordAt(t, second, "superseded_chunks_absent", LevelInfo)
	if got, want := publishedNames(t, store), qualify(longLabels); !equalStrings(got, want) {
		t.Errorf("published %v, want %v", got, want)
	}
}

// TestAbandonedChunksAreReclaimedAfterAFailedPublication drives the whole staging
// mechanism: a publication that ends between the chunk write and the pointer write
// leaves a chunk set nothing names, and the next run finds and expires it.
//
// Nothing here relies on the failed run cleaning up after itself. Both cases end the
// run at a point a killed function would reach the same way, and the recovery
// happens in a later run reading durable state.
func TestAbandonedChunksAreReclaimedAfterAFailedPublication(t *testing.T) {
	tests := []struct {
		name        string
		inject      func(store *fakeStore, cancel context.CancelFunc)
		chunksExist bool
	}{
		{
			name: "the pointer write fails once every chunk is stored",
			inject: func(store *fakeStore, cancel context.CancelFunc) {
				store.putLatestErr = errInjected
			},
			chunksExist: true,
		},
		{
			name: "the run is cancelled with the chunk write in flight",
			inject: func(store *fakeStore, cancel context.CancelFunc) {
				store.onPutChunks = cancel
			},
			chunksExist: false,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			store := newFakeStore()
			dir := defaultLists(t)

			first := newTestRun(t, dir, newFakeGraph(nil), store)
			live, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
			if err != nil {
				t.Fatalf("first Run: %v", err)
			}

			abandonedAt := fixedNow.Add(time.Hour)
			second := newTestRun(t, dir, newFakeGraph(nil), store).at(abandonedAt)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			test.inject(store, cancel)
			if _, err := Run(ctx, second.deps, Event{Group: GroupLong}); err == nil {
				t.Fatalf("the second run published despite the injected failure")
			}
			store.putLatestErr = nil
			store.onPutChunks = nil

			staged := stagedIDs(t, store)
			if len(staged) != 1 {
				t.Fatalf("staged snapshots are %v, want exactly the abandoned one", staged)
			}
			abandoned := staged[0]
			if abandoned == live.Latest.SnapshotID {
				t.Fatalf("the published snapshot %q is still staged", abandoned)
			}
			if got := containsString(store.SnapshotIDs(), abandoned); got != test.chunksExist {
				t.Fatalf("chunks stored for the abandoned snapshot = %v, want %v", got, test.chunksExist)
			}

			reclaimAt := abandonedAt.Add(abandonedAfter + time.Minute)
			third := newTestRun(t, dir, newFakeGraph(nil), store).at(reclaimAt)
			current, err := Run(context.Background(), third.deps, Event{Group: GroupShort})
			if err != nil {
				t.Fatalf("third Run: %v", err)
			}

			if isStaged(t, store, abandoned) {
				t.Errorf("the abandoned snapshot %q is still staged after a reclaim pass", abandoned)
			}
			expiry, found := store.expiry(abandoned)
			if found != test.chunksExist {
				t.Fatalf("the abandoned snapshot has an expiry = %v, want %v", found, test.chunksExist)
			}
			if test.chunksExist {
				if want := reclaimAt.Add(abandonedRetention); !expiry.Equal(want) {
					t.Errorf("TTL %s, want %s", expiry, want)
				}
				if record := requireRecordAt(t, third, "abandoned_chunks_expired", LevelWarn); record.SnapshotID != abandoned {
					t.Errorf("the reclaim record names %q, want %q", record.SnapshotID, abandoned)
				}
			}

			// A reclaim pass must never reach what this run published.
			if _, found := store.expiry(current.Latest.SnapshotID); found {
				t.Errorf("the published snapshot was given a TTL")
			}
			published, latest, err := snapshot.Read(context.Background(), store)
			if err != nil {
				t.Fatalf("the reclaim pass left no readable snapshot: %v", err)
			}
			if latest.SnapshotID != current.Latest.SnapshotID || len(published.Results) != latest.Names {
				t.Errorf("readers see %q with %d of %d results", latest.SnapshotID, len(published.Results), latest.Names)
			}
		})
	}
}

func TestAbandonedChunksSurviveUntilTheGracePeriodPasses(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	if _, err := Run(context.Background(), first.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("first Run: %v", err)
	}

	abandonedAt := fixedNow.Add(time.Hour)
	store.putLatestErr = errInjected
	second := newTestRun(t, dir, newFakeGraph(nil), store).at(abandonedAt)
	if _, err := Run(context.Background(), second.deps, Event{Group: GroupLong}); err == nil {
		t.Fatalf("the second run published despite the injected failure")
	}
	store.putLatestErr = nil
	staged := stagedIDs(t, store)
	if len(staged) != 1 {
		t.Fatalf("staged snapshots are %v, want exactly the abandoned one", staged)
	}
	abandoned := staged[0]

	// A publisher may still be writing a set this young, so nothing may expire it.
	// Staging refreshes the marker, so a publisher that keeps working keeps its grace.
	third := newTestRun(t, dir, newFakeGraph(nil), store).at(abandonedAt.Add(abandonedAfter - time.Minute))
	if _, err := Run(context.Background(), third.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("third Run: %v", err)
	}
	if _, found := store.expiry(abandoned); found {
		t.Errorf("a snapshot staged less than %s ago was expired", abandonedAfter)
	}
	if !isStaged(t, store, abandoned) {
		t.Errorf("the marker of a snapshot still inside its grace period was removed")
	}
	if !containsString(store.SnapshotIDs(), abandoned) {
		t.Errorf("the chunks of a snapshot still inside its grace period were removed")
	}
}

func TestReclaimNeverExpiresTheLiveSnapshot(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	live, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}

	// A publisher interrupted after its pointer write leaves the live snapshot's own
	// marker behind, and it is old enough for any grace period to have passed.
	stagedAt := fixedNow.Add(-2 * abandonedAfter)
	if err := store.StageSnapshot(context.Background(), live.Latest.SnapshotID, stagedAt, stagedAt.Add(stagingRetention)); err != nil {
		t.Fatalf("StageSnapshot: %v", err)
	}

	// The next run fails to publish, so nothing but the reclaim pass could put a TTL
	// on the snapshot readers are being served.
	store.putLatestErr = errInjected
	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(time.Hour))
	if _, err := Run(context.Background(), second.deps, Event{Group: GroupLong}); err == nil {
		t.Fatalf("the second run published despite the injected failure")
	}

	if expiry, found := store.expiry(live.Latest.SnapshotID); found {
		t.Fatalf("the snapshot the pointer names was given a TTL of %s", expiry)
	}
	if isStaged(t, store, live.Latest.SnapshotID) {
		t.Errorf("the published snapshot's stale marker was kept")
	}
	if _, latest, err := snapshot.Read(context.Background(), store); err != nil || latest.SnapshotID != live.Latest.SnapshotID {
		t.Errorf("readers no longer see %q: %v", live.Latest.SnapshotID, err)
	}
}

// stageAbandoned stages markers for snapshots no run will publish, as an earlier
// invocation that died between its chunk write and its pointer write would leave.
func stageAbandoned(t *testing.T, store *fakeStore, stagedAt time.Time, count int) []string {
	t.Helper()
	ids := make([]string, 0, count)
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("abandoned-%02d", i)
		if err := store.StageSnapshot(context.Background(), id, stagedAt, stagedAt.Add(stagingRetention)); err != nil {
			t.Fatalf("StageSnapshot %s: %v", id, err)
		}
		ids = append(ids, id)
	}
	return ids
}

// TestReclaimBudgetBoundsTheWorkOneRunAttempts covers the budget on the path that
// matters: a table that refuses every expiry. A budget that only counted successes
// would never trip there, so every later run would do work proportional to the whole
// registry, and the pass that exists to bound the table would grow with it.
func TestReclaimBudgetBoundsTheWorkOneRunAttempts(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	live, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}

	abandoned := stageAbandoned(t, store, fixedNow.Add(-2*abandonedAfter), maxReclaimsPerRun+3)
	store.expireErr = errInjected

	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(time.Hour))
	current, err := Run(context.Background(), second.deps, Event{Group: GroupShort})
	if err != nil {
		// Cleanup is best effort. A publication that already succeeded must not be
		// reported as a failure because the reclaim pass could not finish.
		t.Fatalf("a failing reclaim pass failed the run: %v", err)
	}
	if current.Latest.SnapshotID == live.Latest.SnapshotID {
		t.Fatalf("the second run did not publish a new snapshot")
	}

	if got := store.expireAttempts(abandoned...); got != maxReclaimsPerRun {
		t.Errorf("the pass attempted %d expiries, want its budget of %d", got, maxReclaimsPerRun)
	}
	// An exhausted budget is the backlog draining as designed, so it must not be
	// reported as the anomalies an unreadable pointer or registry are.
	record := requireRecordAt(t, second, "abandoned_chunks_budget_reached", LevelInfo)
	if record.Attempted != maxReclaimsPerRun || record.Reclaimed != 0 {
		t.Errorf("the deferred record reports %d attempted and %d reclaimed, want %d and 0",
			record.Attempted, record.Reclaimed, maxReclaimsPerRun)
	}
	// Nothing was expired and nothing was forgotten, so the next pass still finds
	// every marker this one could not get to.
	if got, want := len(stagedIDs(t, store)), len(abandoned); got != want {
		t.Errorf("%d markers remain, want all %d", got, want)
	}
	if _, _, err := snapshot.Read(context.Background(), store); err != nil {
		t.Errorf("the published snapshot is not readable: %v", err)
	}
}

// TestReclaimContinuesPastAMarkerItCannotInterpret proves one unreadable marker does
// not stop the pass. Stopping would leave every other abandoned chunk set unreclaimed
// until its marker's own TTL fired, which is the unbounded growth staging prevents.
func TestReclaimContinuesPastAMarkerItCannotInterpret(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	if _, err := Run(context.Background(), first.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("first Run: %v", err)
	}

	abandonedAt := fixedNow.Add(time.Hour)
	store.putLatestErr = errInjected
	second := newTestRun(t, dir, newFakeGraph(nil), store).at(abandonedAt)
	if _, err := Run(context.Background(), second.deps, Event{Group: GroupLong}); err == nil {
		t.Fatalf("the second run published despite the injected failure")
	}
	store.putLatestErr = nil
	staged := stagedIDs(t, store)
	if len(staged) != 1 {
		t.Fatalf("staged snapshots are %v, want exactly the abandoned one", staged)
	}
	abandoned := staged[0]

	// The registry reports one marker it could not interpret next to the one it could.
	store.stagedSkipped = 1

	third := newTestRun(t, dir, newFakeGraph(nil), store).at(abandonedAt.Add(abandonedAfter + time.Minute))
	if _, err := Run(context.Background(), third.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("third Run: %v", err)
	}

	if record := requireRecordAt(t, third, "staging_markers_unreadable", LevelWarn); record.Skipped != 1 {
		t.Errorf("the record reports %d skipped markers, want 1", record.Skipped)
	}
	if _, found := store.expiry(abandoned); !found {
		t.Errorf("the readable marker's chunks were not reclaimed: %s", third.logs.String())
	}
	if isStaged(t, store, abandoned) {
		t.Errorf("the reclaimed marker was kept")
	}
}

func TestReclaimIsDeferredWhenThePointerCannotBeRead(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	if _, err := Run(context.Background(), first.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("first Run: %v", err)
	}

	abandonedAt := fixedNow.Add(time.Hour)
	store.putLatestErr = errInjected
	second := newTestRun(t, dir, newFakeGraph(nil), store).at(abandonedAt)
	if _, err := Run(context.Background(), second.deps, Event{Group: GroupLong}); err == nil {
		t.Fatalf("the second run published despite the injected failure")
	}
	store.putLatestErr = nil
	staged := stagedIDs(t, store)
	if len(staged) != 1 {
		t.Fatalf("staged snapshots are %v, want exactly the abandoned one", staged)
	}
	abandoned := staged[0]

	// A pointer that cannot be read says nothing about which snapshot is live, so
	// nothing may be reclaimed against it. The run still publishes past it.
	store.getLatestErr = errInjected
	third := newTestRun(t, dir, newFakeGraph(nil), store).at(abandonedAt.Add(abandonedAfter + time.Hour))
	if _, err := Run(context.Background(), third.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("third Run: %v", err)
	}
	requireRecordAt(t, third, "abandoned_chunks_pointer_unreadable", LevelWarn)
	if _, found := store.expiry(abandoned); found {
		t.Errorf("a snapshot was expired against a pointer that could not be read")
	}
	if !isStaged(t, store, abandoned) {
		t.Errorf("a staging marker was dropped without reclaiming its chunks")
	}

	store.getLatestErr = nil
	if _, _, err := snapshot.Read(context.Background(), store); err != nil {
		t.Errorf("the published snapshot is not readable: %v", err)
	}
}

// TestReclaimIsDeferredWhenTheRegistryCannotBeQueried is the other anomaly that
// reclaims nothing. It is a distinct event from an unreadable pointer and from an
// exhausted budget, so an operator can alarm on the two faults without being paged by
// the backlog draining normally.
func TestReclaimIsDeferredWhenTheRegistryCannotBeQueried(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	if _, err := Run(context.Background(), first.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("first Run: %v", err)
	}

	abandonedAt := fixedNow.Add(time.Hour)
	store.putLatestErr = errInjected
	second := newTestRun(t, dir, newFakeGraph(nil), store).at(abandonedAt)
	if _, err := Run(context.Background(), second.deps, Event{Group: GroupLong}); err == nil {
		t.Fatalf("the second run published despite the injected failure")
	}
	store.putLatestErr = nil
	staged := stagedIDs(t, store)
	if len(staged) != 1 {
		t.Fatalf("staged snapshots are %v, want exactly the abandoned one", staged)
	}
	abandoned := staged[0]

	// A registry that cannot be queried at all lists no marker, and a pass that acted
	// on that would be acting on an empty answer it never got.
	store.stagedErr = errInjected
	third := newTestRun(t, dir, newFakeGraph(nil), store).at(abandonedAt.Add(abandonedAfter + time.Hour))
	if _, err := Run(context.Background(), third.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("a failed registry query failed the run: %v", err)
	}
	requireRecordAt(t, third, "abandoned_chunks_registry_unreadable", LevelWarn)
	if _, found := store.expiry(abandoned); found {
		t.Errorf("a snapshot was expired without reading the staging registry")
	}
	store.stagedErr = nil
	if !isStaged(t, store, abandoned) {
		t.Errorf("a staging marker was dropped without reclaiming its chunks")
	}
	if _, _, err := snapshot.Read(context.Background(), store); err != nil {
		t.Errorf("the published snapshot is not readable: %v", err)
	}
}

func TestRunRefusesToWriteChunksItCannotStage(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	first := newTestRun(t, dir, newFakeGraph(nil), store)
	live, err := Run(context.Background(), first.deps, Event{Group: GroupShort})
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}

	// Writing chunks with no durable record of them is the one orphan staging exists
	// to prevent, so a run that cannot stage must not write any.
	store.stageErr = errInjected
	second := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(time.Hour))
	if _, err := Run(context.Background(), second.deps, Event{Group: GroupLong}); err == nil {
		t.Fatalf("Run published a snapshot it could not stage")
	}
	requireRecordAt(t, second, "snapshot_stage_failed", LevelError)
	if got := store.SnapshotIDs(); !equalStrings(sortedCopy(got), []string{live.Latest.SnapshotID}) {
		t.Errorf("the store holds %v, want only %q", got, live.Latest.SnapshotID)
	}
	if _, latest, err := snapshot.Read(context.Background(), store); err != nil || latest.SnapshotID != live.Latest.SnapshotID {
		t.Errorf("readers no longer see %q: %v", live.Latest.SnapshotID, err)
	}
}

func TestConcurrentRunsLeaveOneCoherentSnapshot(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)

	var wait sync.WaitGroup
	failures := make([]error, 2)
	groups := []Group{GroupShort, GroupLong}
	for i, group := range groups {
		i, group := i, group
		run := newTestRun(t, dir, newFakeGraph(nil), store).at(fixedNow.Add(time.Duration(i) * time.Minute))
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, failures[i] = Run(context.Background(), run.deps, Event{Group: group})
		}()
	}
	wait.Wait()

	// Both schedules may fire at once. Whichever pointer wins, the snapshot it
	// names must be complete and verified, and at most one run may be refused.
	published, latest, err := snapshot.Read(context.Background(), store)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(published.Results) != latest.Names || latest.Names == 0 {
		t.Errorf("the served snapshot holds %d results but its pointer claims %d", len(published.Results), latest.Names)
	}
	for i, err := range failures {
		if err != nil && !errors.Is(err, snapshot.ErrPointerConflict) {
			t.Errorf("run %d failed for an unexpected reason: %v", i, err)
		}
	}
}

func TestLogsCarryNoCandidateNamesOrCredentials(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)
	graph := newFakeGraph(nil)
	run := newTestRun(t, dir, graph, store)
	// An error from a lower layer is the realistic way a name or an endpoint would
	// reach a log line, so the failing run quotes both.
	graph.err = fmt.Errorf("post https://gateway.thegraph.com/api/secret-key/subgraphs/id/abc: lookup zap.eth failed")

	if _, err := Run(context.Background(), run.deps, Event{Group: GroupShort}); err == nil {
		t.Fatalf("Run succeeded despite a failing subgraph")
	}
	logs := run.logs.String()
	for _, forbidden := range []string{"secret-key", "gateway.thegraph.com", "https://", "zap.eth", "subgraph.test"} {
		if strings.Contains(logs, forbidden) {
			t.Errorf("the log contains %q: %s", forbidden, logs)
		}
	}
	if !strings.Contains(logs, "[endpoint]") || !strings.Contains(logs, "[name]") {
		t.Errorf("the redacted error kept neither placeholder: %s", logs)
	}

	// A successful run must not name a candidate either.
	success := newTestRun(t, dir, newFakeGraph(nil), store)
	if _, err := Run(context.Background(), success.deps, Event{Group: GroupShort}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	for _, label := range append(append([]string(nil), shortLabels...), longLabels...) {
		if strings.Contains(success.logs.String(), label) {
			t.Errorf("the log names the candidate %q: %s", label, success.logs.String())
		}
	}
}

// testAPIKey is invented here and is not a credential. Every assertion about it is
// that it is absent from output, which is the only safe thing to assert about one.
const testAPIKey = "test-graph-key-0123456789abcdef"

func TestLogsCarryNoBareAPIKey(t *testing.T) {
	store := newFakeStore()
	dir := defaultLists(t)
	graph := newFakeGraph(nil)
	run := newTestRun(t, dir, graph, store)
	run.deps.Config.APIKey = testAPIKey
	// The Graph client folds a slice of the gateway's response body into its error, so
	// a gateway that echoed the credential back would put a bare key in the log group
	// with no URL for the endpoint pattern to match.
	graph.err = fmt.Errorf(`ENS subgraph returned 401 Unauthorized: {"message":"invalid api key %s"}`, testAPIKey)

	if _, err := Run(context.Background(), run.deps, Event{Group: GroupShort}); err == nil {
		t.Fatalf("Run succeeded despite a failing subgraph")
	}
	logs := run.logs.String()
	if strings.Contains(logs, testAPIKey) {
		t.Errorf("the log carries the configured credential: %s", logs)
	}
	if !strings.Contains(logs, "[redacted]") {
		t.Errorf("the credential was not replaced with a placeholder: %s", logs)
	}
}

func TestRedactorStripsConfiguredSecrets(t *testing.T) {
	config := Config{APIKey: testAPIKey, Endpoint: "https://gateway.test/api/" + testAPIKey + "/subgraphs/id/abc"}
	redactor := config.Redactor()

	bare := redactor.Error(fmt.Errorf("invalid api key %s", testAPIKey))
	if strings.Contains(bare, testAPIKey) {
		t.Errorf("a bare credential survived redaction: %q", bare)
	}
	if bare != "invalid api key [redacted]" {
		t.Errorf("redacted error = %q, want the message with a placeholder", bare)
	}

	quoted := redactor.Error(fmt.Errorf("post %s: lookup zap.eth failed", config.Endpoint))
	for _, forbidden := range []string{testAPIKey, "gateway.test"} {
		if strings.Contains(quoted, forbidden) {
			t.Errorf("redacted error %q still contains %q", quoted, forbidden)
		}
	}
	if strings.Contains(quoted, "zap.eth") {
		t.Errorf("redacted error %q still names a candidate", quoted)
	}

	// A store with no credential configured must behave exactly like the default.
	empty := Config{}.Redactor()
	if got, want := empty.Error(errInjected), (*Redactor)(nil).Error(errInjected); got != want {
		t.Errorf("an unconfigured redactor rendered %q, want %q", got, want)
	}
	// A literal too short to be a credential is left alone, so an ordinary message
	// cannot be mangled by one.
	short := NewRedactor("ab")
	if got, want := short.Error(errors.New("chunk ab checksum mismatch")), "chunk ab checksum mismatch"; got != want {
		t.Errorf("redacted error = %q, want %q", got, want)
	}
}

func TestLoggerWritesOneRecordPerLine(t *testing.T) {
	buffer := &bytes.Buffer{}
	logger := NewLogger(buffer, func() time.Time { return fixedNow })
	logger.Log(LevelInfo, "scan_started", Fields{Group: GroupShort, Names: 3})
	logger.LogError(LevelWarn, "previous_snapshot_unreadable", Fields{Attempt: 2}, errInjected)

	lines := strings.Split(strings.TrimSpace(buffer.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("wrote %d lines, want 2", len(lines))
	}
	for _, line := range lines {
		if !strings.HasPrefix(line, `{"time":"2026-03-01T12:00:00Z"`) {
			t.Errorf("record %q does not start with its timestamp", line)
		}
	}
	if !strings.Contains(lines[0], `"event":"scan_started"`) || !strings.Contains(lines[0], `"names":3`) {
		t.Errorf("record %q lost its fields", lines[0])
	}
	if !strings.Contains(lines[1], `"error":"injected failure"`) {
		t.Errorf("record %q lost its error", lines[1])
	}
}

func TestLoggerToleratesNoWriter(t *testing.T) {
	// A misconfigured logger must not be able to end a scan.
	NewLogger(nil, nil).Log(LevelInfo, "scan_started", Fields{})
	var logger *Logger
	logger.Log(LevelInfo, "scan_started", Fields{})
}

// TestNilRedactorStripsThePatterns covers the redactor a logger uses before its
// configuration is known, which strips the patterns and no literal.
func TestNilRedactorStripsThePatterns(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "no error", err: nil, want: ""},
		{
			name: "an endpoint carrying an API key",
			err:  errors.New("get https://gateway.thegraph.com/api/secret/subgraphs/id/abc: timeout"),
			want: "get [endpoint] timeout",
		},
		{
			name: "a candidate name",
			err:  errors.New("classify zap.eth: bad expiry"),
			want: "classify [name]: bad expiry",
		},
		{
			name: "both at once",
			err:  fmt.Errorf("lookup orb.eth via https://subgraph.test/ens failed"),
			want: "lookup [name] via [endpoint] failed",
		},
		{
			name: "an ordinary message is untouched",
			err:  errors.New("chunk 3 checksum mismatch"),
			want: "chunk 3 checksum mismatch",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			if got := (*Redactor)(nil).Error(test.err); got != test.want {
				t.Errorf("a nil Redactor rendered %q, want %q", got, test.want)
			}
		})
	}
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func sortedCopy(values []string) []string {
	copied := append([]string(nil), values...)
	sort.Strings(copied)
	return copied
}

// qualifyLess is the sorted label set, not the qualified names: the client is
// asked for labels and returns qualified names.
func qualifyLess(labels []string) []string {
	return sortedCopy(labels)
}
