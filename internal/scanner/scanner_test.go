package scanner

import (
	"bytes"
	"context"
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

// fakeStore is a local Store: the contract's in-memory backend plus the retention
// call, with injectable failures for each publication step.
//
// ExpireChunks repeats the DynamoDB backend's guard rather than trusting the
// caller, so a test that expired a live snapshot would fail here too.
type fakeStore struct {
	*snapshot.MemoryStore

	mu      sync.Mutex
	expired map[string]time.Time

	putChunksErr error
	getChunksErr error
	putLatestErr error
	getLatestErr error
	expireErr    error
}

func newFakeStore() *fakeStore {
	return &fakeStore{MemoryStore: snapshot.NewMemoryStore(), expired: make(map[string]time.Time)}
}

func (s *fakeStore) PutChunks(ctx context.Context, snapshotID string, chunks []snapshot.Chunk) error {
	if s.putChunksErr != nil {
		return s.putChunksErr
	}
	return s.MemoryStore.PutChunks(ctx, snapshotID, chunks)
}

func (s *fakeStore) GetChunks(ctx context.Context, snapshotID string) ([]snapshot.Chunk, error) {
	if s.getChunksErr != nil {
		return nil, s.getChunksErr
	}
	return s.MemoryStore.GetChunks(ctx, snapshotID)
}

func (s *fakeStore) PutLatest(ctx context.Context, latest snapshot.Latest) error {
	if s.putLatestErr != nil {
		return s.putLatestErr
	}
	return s.MemoryStore.PutLatest(ctx, latest)
}

func (s *fakeStore) GetLatest(ctx context.Context) (snapshot.Latest, error) {
	if s.getLatestErr != nil {
		return snapshot.Latest{}, s.getLatestErr
	}
	return s.MemoryStore.GetLatest(ctx)
}

func (s *fakeStore) ExpireChunks(ctx context.Context, snapshotID string, expiresAt time.Time) error {
	if s.expireErr != nil {
		return s.expireErr
	}
	published, err := s.GetLatest(ctx)
	if err != nil {
		return err
	}
	if published.SnapshotID == snapshotID {
		return fmt.Errorf("refusing to expire snapshot %s because the latest pointer still names it", snapshotID)
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
	if !strings.Contains(run.logs.String(), "previous_snapshot_unreadable") {
		t.Errorf("an unreadable pointer was not reported: %s", run.logs.String())
	}
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
	if !strings.Contains(second.logs.String(), "superseded_chunks_expired") {
		t.Errorf("the TTL was not reported: %s", second.logs.String())
	}
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
	if !strings.Contains(second.logs.String(), "superseded_chunks_expire_failed") {
		t.Errorf("the retention failure was not reported: %s", second.logs.String())
	}
	if _, _, err := snapshot.Read(context.Background(), store); err != nil {
		t.Errorf("the published snapshot is not readable: %v", err)
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

func TestRedact(t *testing.T) {
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
			if got := Redact(test.err); got != test.want {
				t.Errorf("Redact() = %q, want %q", got, test.want)
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
