package snapshot

import (
	"context"
	"math/rand"
	"strings"
	"testing"
	"time"

	"ens-scrape/internal/checker"
	"ens-scrape/internal/ens"
)

// fixedNow is the single reference instant used by these tests. No test reads
// the wall clock, and no test contacts the ENS endpoint.
var fixedNow = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

const testSoon = 7 * 24 * time.Hour

// lifecycleLookups returns one lookup per ENS lifecycle status, so every test
// that uses it exercises the complete status set.
func lifecycleLookups(now time.Time) []ens.Lookup {
	day := 24 * time.Hour
	at := func(offset time.Duration) *time.Time {
		value := now.Add(offset)
		return &value
	}
	return []ens.Lookup{
		{Name: "zap", Found: true, Expiry: at(200 * day)},    // registered
		{Name: "helm", Found: true, Expiry: at(3 * day)},     // expiring-soon
		{Name: "dusk", Found: true, Expiry: at(-10 * day)},   // grace-period
		{Name: "flux", Found: true, Expiry: at(-87 * day)},   // grace-ending-soon
		{Name: "vex", Found: true, Expiry: at(-100 * day)},   // premium
		{Name: "amber", Found: true, Expiry: at(-200 * day)}, // available after premium
		{Name: "orb", Found: false},                          // available, never registered
		{Name: "nova", Found: true},                          // unknown
	}
}

func lifecycleResults(t *testing.T, now time.Time) []ens.Result {
	t.Helper()
	lookups := lifecycleLookups(now)
	results := make([]ens.Result, 0, len(lookups))
	for _, lookup := range lookups {
		results = append(results, ens.Classify(lookup, now, testSoon))
	}
	return results
}

func testSources(names int) []SourceList {
	return []SourceList{{
		ID:      "test-list",
		Path:    "data/words/test.txt",
		Cadence: CadenceThreeHourly,
		Names:   names,
	}}
}

func TestBuildProducesCanonicalOrderAndCounts(t *testing.T) {
	results := lifecycleResults(t, fixedNow)
	snapshot, err := Build("test-snapshot", fixedNow, testSources(len(results)), results)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}

	wantOrder := []string{"amber", "dusk", "flux", "helm", "nova", "orb", "vex", "zap"}
	if len(snapshot.Results) != len(wantOrder) {
		t.Fatalf("got %d results, want %d", len(snapshot.Results), len(wantOrder))
	}
	for i, want := range wantOrder {
		if snapshot.Results[i].Name != want {
			t.Errorf("result %d is %q, want %q", i, snapshot.Results[i].Name, want)
		}
	}

	if snapshot.Metadata.FormatVersion != FormatVersion {
		t.Errorf("format version is %d, want %d", snapshot.Metadata.FormatVersion, FormatVersion)
	}
	if snapshot.Metadata.Names != len(wantOrder) {
		t.Errorf("metadata reports %d names, want %d", snapshot.Metadata.Names, len(wantOrder))
	}
	if len(snapshot.Metadata.Counts) != len(ens.Statuses) {
		t.Fatalf("counts list %d statuses, want %d", len(snapshot.Metadata.Counts), len(ens.Statuses))
	}
	for _, status := range ens.Statuses {
		if snapshot.Metadata.Counts[status] < 1 {
			t.Errorf("status %q is not represented in the counts", status)
		}
	}
	if snapshot.Metadata.Counts[ens.StatusAvailable] != 2 {
		t.Errorf("available count is %d, want 2", snapshot.Metadata.Counts[ens.StatusAvailable])
	}
}

func TestBuildDerivesLifecycleTimestamps(t *testing.T) {
	results := lifecycleResults(t, fixedNow)
	snapshot, err := Build("test-snapshot", fixedNow, testSources(len(results)), results)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}

	byName := make(map[string]ens.Result, len(snapshot.Results))
	for _, result := range snapshot.Results {
		byName[result.Name] = result
	}

	premium := byName["vex"]
	if premium.Status != ens.StatusPremium {
		t.Fatalf("vex is %q, want %q", premium.Status, ens.StatusPremium)
	}
	if premium.Expiry == nil || premium.GraceEnds == nil || premium.PremiumEnds == nil {
		t.Fatalf("premium result is missing timestamps: %+v", premium)
	}
	if !premium.GraceEnds.Equal(premium.Expiry.Add(ens.GracePeriod)) {
		t.Errorf("grace end %s does not follow expiry %s", premium.GraceEnds, premium.Expiry)
	}
	if !premium.PremiumEnds.Equal(premium.GraceEnds.Add(ens.PremiumPeriod)) {
		t.Errorf("premium end %s does not follow grace end %s", premium.PremiumEnds, premium.GraceEnds)
	}

	if never := byName["orb"]; never.Expiry != nil || never.GraceEnds != nil || never.PremiumEnds != nil {
		t.Errorf("never-registered result carries timestamps: %+v", never)
	}
	if unknown := byName["nova"]; unknown.Status != ens.StatusUnknown {
		t.Errorf("nova is %q, want %q", unknown.Status, ens.StatusUnknown)
	}

	for _, result := range snapshot.Results {
		for label, value := range map[string]*time.Time{
			"expiry":       result.Expiry,
			"grace_ends":   result.GraceEnds,
			"premium_ends": result.PremiumEnds,
		} {
			if value == nil {
				continue
			}
			if value.Location() != time.UTC {
				t.Errorf("%s %s is not UTC", result.Name, label)
			}
			if !value.Equal(value.Truncate(time.Second)) {
				t.Errorf("%s %s is not second precision", result.Name, label)
			}
		}
	}
}

func TestBuildIgnoresInputOrder(t *testing.T) {
	results := lifecycleResults(t, fixedNow)
	reference, err := Encode(mustBuild(t, results))
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	random := rand.New(rand.NewSource(20260301))
	for attempt := 0; attempt < 20; attempt++ {
		shuffled := append([]ens.Result(nil), results...)
		random.Shuffle(len(shuffled), func(i, j int) {
			shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
		})
		payload, err := Encode(mustBuild(t, shuffled))
		if err != nil {
			t.Fatalf("Encode shuffled attempt %d: %v", attempt, err)
		}
		assertSamePayload(t, reference, payload)
	}
}

// fakeLookupClient serves lookups from a fixed table. It reverses each batch and
// sleeps for a batch-dependent time, so batches complete in an order unrelated
// to the order they were scheduled in.
type fakeLookupClient struct {
	lookups map[string]ens.Lookup
}

func (c fakeLookupClient) Lookup(ctx context.Context, batch []string) ([]ens.Lookup, error) {
	if len(batch) > 0 {
		time.Sleep(time.Duration('z'-batch[0][0]) * 200 * time.Microsecond)
	}
	out := make([]ens.Lookup, 0, len(batch))
	for i := len(batch) - 1; i >= 0; i-- {
		out = append(out, c.lookups[batch[i]])
	}
	return out, nil
}

func TestBuildIgnoresWorkerCompletionOrder(t *testing.T) {
	lookups := lifecycleLookups(fixedNow)
	table := make(map[string]ens.Lookup, len(lookups))
	labels := make([]string, 0, len(lookups))
	for _, lookup := range lookups {
		table[lookup.Name] = lookup
		labels = append(labels, lookup.Name)
	}
	client := fakeLookupClient{lookups: table}

	reference, err := Encode(mustBuild(t, lifecycleResults(t, fixedNow)))
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	for _, workers := range []int{1, 2, 5} {
		for _, batchSize := range []int{1, 3, 8} {
			results, _, err := checker.Run(context.Background(), client, labels, checker.Options{
				Workers:   workers,
				BatchSize: batchSize,
				Soon:      testSoon,
				Now:       func() time.Time { return fixedNow },
			})
			if err != nil {
				t.Fatalf("checker.Run workers=%d batch=%d: %v", workers, batchSize, err)
			}
			payload, err := Encode(mustBuild(t, results))
			if err != nil {
				t.Fatalf("Encode workers=%d batch=%d: %v", workers, batchSize, err)
			}
			assertSamePayload(t, reference, payload)
		}
	}
}

// TestBuildAcceptsTheCheckerClassificationInstant proves the scan time contract is
// satisfiable end to end. checker.Run reports the instant it classified against,
// and Build accepts exactly that instant even with a sub-second fraction, because
// ENS boundaries are whole seconds. Sampling the clock again past a boundary is
// refused, which is why the instant has to be carried rather than re-derived.
func TestBuildAcceptsTheCheckerClassificationInstant(t *testing.T) {
	classifyAt := fixedNow.Add(500 * time.Millisecond)
	// The nearest lifecycle boundary to the classification instant.
	expiry := fixedNow.Add(time.Second)

	client := fakeLookupClient{lookups: map[string]ens.Lookup{
		"zap": {Name: "zap", Found: true, Expiry: &expiry},
	}}
	results, stats, err := checker.Run(context.Background(), client, []string{"zap"}, checker.Options{
		Workers:   1,
		BatchSize: 1,
		Soon:      testSoon,
		Now:       func() time.Time { return classifyAt },
	})
	if err != nil {
		t.Fatalf("checker.Run: %v", err)
	}
	if !stats.ClassifiedAt.Equal(classifyAt) {
		t.Fatalf("checker reports ClassifiedAt %s, want %s", stats.ClassifiedAt, classifyAt)
	}
	if len(results) != 1 || results[0].Status != ens.StatusExpiringSoon {
		t.Fatalf("results are %+v, want one expiring-soon result", results)
	}

	if _, err := Build("test-snapshot", stats.ClassifiedAt, testSources(len(results)), results); err != nil {
		t.Fatalf("Build rejected the instant checker classified against: %v", err)
	}

	// Two seconds later the expiry has passed, so the stored status no longer
	// describes the scan time and the whole snapshot is refused.
	if _, err := Build("test-snapshot", classifyAt.Add(2*time.Second), testSources(len(results)), results); err == nil {
		t.Fatal("Build accepted a scan time on the far side of a lifecycle boundary")
	} else if !strings.Contains(err.Error(), "at the scan time") {
		t.Fatalf("error %q does not mention the scan time", err)
	}
}

func TestBuildRejectsInvalidInput(t *testing.T) {
	results := lifecycleResults(t, fixedNow)
	sources := testSources(len(results))

	tests := []struct {
		name       string
		snapshotID string
		sources    []SourceList
		results    []ens.Result
		want       string
	}{
		{
			name:       "empty id",
			snapshotID: "",
			sources:    sources,
			results:    results,
			want:       "snapshot id is required",
		},
		{
			name:       "id with path separator",
			snapshotID: "../escape",
			sources:    sources,
			results:    results,
			want:       "must use lowercase letters",
		},
		{
			name:       "id too long",
			snapshotID: strings.Repeat("a", maxSnapshotIDLength+1),
			sources:    sources,
			results:    results,
			want:       "longer than",
		},
		{
			name:       "no sources",
			snapshotID: "test-snapshot",
			sources:    nil,
			results:    results,
			want:       "at least one source list is required",
		},
		{
			name:       "unknown cadence",
			snapshotID: "test-snapshot",
			sources:    []SourceList{{ID: "a", Path: "a.txt", Cadence: "weekly", Names: len(results)}},
			results:    results,
			want:       "unknown cadence",
		},
		{
			name:       "duplicate source id",
			snapshotID: "test-snapshot",
			sources: []SourceList{
				{ID: "a", Path: "a.txt", Cadence: CadenceDaily, Names: len(results)},
				{ID: "a", Path: "b.txt", Cadence: CadenceDaily, Names: 0},
			},
			results: results,
			want:    "duplicate source list id",
		},
		{
			name:       "source counts disagree",
			snapshotID: "test-snapshot",
			sources:    testSources(len(results) + 1),
			results:    results,
			want:       "account for",
		},
		{
			name:       "duplicate result",
			snapshotID: "test-snapshot",
			sources:    testSources(len(results) + 1),
			results:    append(append([]ens.Result(nil), results...), results[0]),
			want:       "sorted by name without duplicates",
		},
		{
			name:       "unnormalized name",
			snapshotID: "test-snapshot",
			sources:    testSources(1),
			results:    []ens.Result{{Name: "Zap", Status: ens.StatusAvailable}},
			want:       "not a normalized ENS label",
		},
		{
			name:       "unknown status",
			snapshotID: "test-snapshot",
			sources:    testSources(1),
			results:    []ens.Result{{Name: "zap", Status: "renewed"}},
			want:       "unknown status",
		},
		{
			name:       "grace end without expiry",
			snapshotID: "test-snapshot",
			sources:    testSources(1),
			results:    []ens.Result{{Name: "zap", Status: ens.StatusGracePeriod, GraceEnds: &fixedNow}},
			want:       "grace end without an expiry",
		},
		{
			name:       "grace end breaks the lifecycle rules",
			snapshotID: "test-snapshot",
			sources:    testSources(1),
			results: []ens.Result{{
				Name:      "zap",
				Status:    ens.StatusGracePeriod,
				Expiry:    &fixedNow,
				GraceEnds: timePointer(fixedNow.Add(30 * 24 * time.Hour)),
			}},
			want: "does not follow the ENS grace period",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Build(test.snapshotID, fixedNow, test.sources, test.results)
			if err == nil {
				t.Fatalf("Build accepted invalid input")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}
		})
	}
}

// TestBuildRejectsStatusThatContradictsItsTimestamps covers the labels a snapshot
// must never publish: a status that ens.Classify could not produce from the same
// timestamps at the same scan time. The soon window is not on the wire, so the two
// soon statuses are the only slack.
func TestBuildRejectsStatusThatContradictsItsTimestamps(t *testing.T) {
	day := 24 * time.Hour
	at := func(offset time.Duration) *time.Time {
		value := fixedNow.Add(offset)
		return &value
	}
	// expired builds a result whose timestamps follow the ENS lifecycle rules for
	// a name that expired offset before the scan, so only the status is in doubt.
	expired := func(status ens.Status, offset time.Duration) ens.Result {
		expiry := fixedNow.Add(offset)
		graceEnds := expiry.Add(ens.GracePeriod)
		premiumEnds := graceEnds.Add(ens.PremiumPeriod)
		return ens.Result{Name: "zap", Status: status, Expiry: &expiry, GraceEnds: &graceEnds, PremiumEnds: &premiumEnds}
	}

	tests := []struct {
		name   string
		result ens.Result
		want   string
	}{
		{
			name:   "available with a future expiry",
			result: ens.Result{Name: "zap", Status: ens.StatusAvailable, Expiry: at(200 * day)},
			want:   `is "available" but its timestamps classify as "registered"`,
		},
		{
			name:   "registered without an expiry",
			result: ens.Result{Name: "zap", Status: ens.StatusRegistered},
			want:   `is "registered" but carries no expiry`,
		},
		{
			name:   "expiring soon without an expiry",
			result: ens.Result{Name: "zap", Status: ens.StatusExpiringSoon},
			want:   `is "expiring-soon" but carries no expiry`,
		},
		{
			name:   "premium without an expiry",
			result: ens.Result{Name: "zap", Status: ens.StatusPremium},
			want:   `is "premium" but carries no expiry`,
		},
		{
			name:   "unknown with an expiry",
			result: ens.Result{Name: "zap", Status: ens.StatusUnknown, Expiry: at(200 * day)},
			want:   `is "unknown" but its timestamps classify as "registered"`,
		},
		{
			name:   "still in grace but labelled premium",
			result: expired(ens.StatusPremium, -10*day),
			want:   `is "premium" but its timestamps classify as "grace-period"`,
		},
		{
			name:   "grace already over but labelled grace-period",
			result: expired(ens.StatusGracePeriod, -100*day),
			want:   `is "grace-period" but its timestamps classify as "premium"`,
		},
		{
			name:   "premium already over but labelled premium",
			result: expired(ens.StatusPremium, -200*day),
			want:   `is "premium" but its timestamps classify as "available"`,
		},
		{
			name:   "registered but carrying grace timestamps",
			result: expired(ens.StatusRegistered, 10*day),
			want:   "lifecycle timestamps disagree with its expiry at the scan time",
		},
		{
			name: "expired without the derived timestamps",
			result: ens.Result{
				Name:   "zap",
				Status: ens.StatusPremium,
				Expiry: at(-100 * day),
			},
			want: "lifecycle timestamps disagree with its expiry at the scan time",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Build("test-snapshot", fixedNow, testSources(1), []ens.Result{test.result})
			if err == nil {
				t.Fatalf("Build accepted invalid input")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}
		})
	}
}

// TestBuildAcceptsEverySoonWindowLabel proves the status check does not reject the
// labels a real scan produces. The soon window is a CLI setting rather than a wire
// field, so a status and its soon sibling are both valid for the same timestamps,
// and a name that was never registered stays available with no timestamps at all.
func TestBuildAcceptsEverySoonWindowLabel(t *testing.T) {
	day := 24 * time.Hour
	classified := func(offset time.Duration, soon time.Duration) ens.Result {
		expiry := fixedNow.Add(offset)
		return ens.Classify(ens.Lookup{Name: "zap", Found: true, Expiry: &expiry}, fixedNow, soon)
	}

	tests := []struct {
		name       string
		result     ens.Result
		wantStatus ens.Status
	}{
		{name: "registered outside the window", result: classified(200*day, testSoon), wantStatus: ens.StatusRegistered},
		{name: "registered inside the window", result: classified(3*day, testSoon), wantStatus: ens.StatusExpiringSoon},
		{name: "grace outside the window", result: classified(-10*day, testSoon), wantStatus: ens.StatusGracePeriod},
		{name: "grace inside the window", result: classified(-87*day, testSoon), wantStatus: ens.StatusGraceEndingSoon},
		{name: "premium", result: classified(-100*day, testSoon), wantStatus: ens.StatusPremium},
		{name: "available after premium", result: classified(-200*day, testSoon), wantStatus: ens.StatusAvailable},
		{
			name:       "never registered",
			result:     ens.Classify(ens.Lookup{Name: "zap"}, fixedNow, testSoon),
			wantStatus: ens.StatusAvailable,
		},
		{
			name:       "indexed without a usable expiry",
			result:     ens.Classify(ens.Lookup{Name: "zap", Found: true}, fixedNow, testSoon),
			wantStatus: ens.StatusUnknown,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.result.Status != test.wantStatus {
				t.Fatalf("test case classifies as %q, want %q", test.result.Status, test.wantStatus)
			}
			snapshot, err := Build("test-snapshot", fixedNow, testSources(1), []ens.Result{test.result})
			if err != nil {
				t.Fatalf("Build rejected a %q result produced by ens.Classify: %v", test.wantStatus, err)
			}
			if snapshot.Results[0].Status != test.wantStatus {
				t.Fatalf("stored status is %q, want %q", snapshot.Results[0].Status, test.wantStatus)
			}
		})
	}
}

func TestValidateRejectsNonCanonicalSnapshot(t *testing.T) {
	base := mustBuild(t, lifecycleResults(t, fixedNow))

	tests := []struct {
		name   string
		mutate func(*Snapshot)
		want   string
	}{
		{
			name:   "wrong format version",
			mutate: func(s *Snapshot) { s.Metadata.FormatVersion = FormatVersion + 1 },
			want:   "unsupported snapshot format version",
		},
		{
			name:   "zero scan time",
			mutate: func(s *Snapshot) { s.Metadata.ScannedAt = time.Time{} },
			want:   "scan time is required",
		},
		{
			name: "sub-second scan time",
			mutate: func(s *Snapshot) {
				s.Metadata.ScannedAt = s.Metadata.ScannedAt.Add(500 * time.Millisecond)
			},
			want: "UTC with second precision",
		},
		{
			name: "unsorted sources",
			mutate: func(s *Snapshot) {
				s.Metadata.Sources = []SourceList{
					{ID: "b", Path: "b.txt", Cadence: CadenceThreeHourly, Names: 8},
					{ID: "a", Path: "a.txt", Cadence: CadenceThreeHourly, Names: 0},
				}
			},
			want: "not sorted by id",
		},
		{
			name:   "stale thresholds",
			mutate: func(s *Snapshot) { s.Metadata.ScanAge.StaleAfterSeconds *= 3 },
			want:   "scan age thresholds disagree",
		},
		{
			name:   "wrong name total",
			mutate: func(s *Snapshot) { s.Metadata.Names++ },
			want:   "reports 9 names",
		},
		{
			name:   "wrong counts",
			mutate: func(s *Snapshot) { s.Metadata.Counts[ens.StatusAvailable] = 99 },
			want:   "counts report 99",
		},
		{
			name: "missing status in counts",
			mutate: func(s *Snapshot) {
				delete(s.Metadata.Counts, ens.StatusUnknown)
			},
			want: "must list every lifecycle status",
		},
		{
			name: "unsorted results",
			mutate: func(s *Snapshot) {
				s.Results[0], s.Results[1] = s.Results[1], s.Results[0]
			},
			want: "sorted by name without duplicates",
		},
		{
			// Relabelling a name and matching the counts keeps every derived total
			// consistent, so only the status check can catch it.
			name: "status contradicts its timestamps",
			mutate: func(s *Snapshot) {
				for i := range s.Results {
					if s.Results[i].Name == "zap" {
						s.Results[i].Status = ens.StatusAvailable
					}
				}
				s.Metadata.Counts[ens.StatusRegistered]--
				s.Metadata.Counts[ens.StatusAvailable]++
			},
			want: `is "available" but its timestamps classify as "registered"`,
		},
		{
			// The same snapshot read as if it were scanned much later: the grace
			// period has ended, so the stored grace-period label no longer holds.
			name: "scan time moved past the lifecycle boundaries",
			mutate: func(s *Snapshot) {
				s.Metadata.ScannedAt = s.Metadata.ScannedAt.Add(365 * 24 * time.Hour)
			},
			want: "at the scan time",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			snapshot := cloneSnapshot(base)
			test.mutate(&snapshot)
			err := snapshot.Validate()
			if err == nil {
				t.Fatalf("Validate accepted a non-canonical snapshot")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}
		})
	}
}

func TestScanAgeThresholds(t *testing.T) {
	threeHourly, err := DeriveScanAgeInput([]SourceList{{ID: "a", Path: "a.txt", Cadence: CadenceThreeHourly}})
	if err != nil {
		t.Fatalf("DeriveScanAgeInput: %v", err)
	}
	if threeHourly.ExpectedSeconds != int64(3*time.Hour/time.Second) {
		t.Errorf("expected interval is %ds, want %ds", threeHourly.ExpectedSeconds, int64(3*time.Hour/time.Second))
	}
	if threeHourly.StaleAfterSeconds != threeHourly.ExpectedSeconds*StaleFactor {
		t.Errorf("stale threshold is %ds, want %ds", threeHourly.StaleAfterSeconds, threeHourly.ExpectedSeconds*StaleFactor)
	}

	// The slowest cadence governs a mixed snapshot.
	mixed, err := DeriveScanAgeInput([]SourceList{
		{ID: "a", Path: "a.txt", Cadence: CadenceThreeHourly},
		{ID: "b", Path: "b.txt", Cadence: CadenceDaily},
	})
	if err != nil {
		t.Fatalf("DeriveScanAgeInput: %v", err)
	}
	if mixed.ExpectedSeconds != int64(24*time.Hour/time.Second) {
		t.Errorf("mixed expected interval is %ds, want %ds", mixed.ExpectedSeconds, int64(24*time.Hour/time.Second))
	}

	tests := []struct {
		name      string
		now       time.Time
		wantAge   time.Duration
		wantStale bool
	}{
		{name: "fresh", now: fixedNow.Add(time.Hour), wantAge: time.Hour},
		{name: "one missed scan", now: fixedNow.Add(5 * time.Hour), wantAge: 5 * time.Hour},
		{name: "at the threshold", now: fixedNow.Add(6 * time.Hour), wantAge: 6 * time.Hour},
		{name: "past the threshold", now: fixedNow.Add(7 * time.Hour), wantAge: 7 * time.Hour, wantStale: true},
		{name: "clock skew", now: fixedNow.Add(-time.Hour), wantAge: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			age := threeHourly.At(fixedNow, test.now)
			if age.Age != test.wantAge {
				t.Errorf("age is %s, want %s", age.Age, test.wantAge)
			}
			if age.Stale != test.wantStale {
				t.Errorf("stale is %t, want %t", age.Stale, test.wantStale)
			}
		})
	}
}

func TestUnknownCadenceHasNoInterval(t *testing.T) {
	for _, cadence := range Cadences {
		if _, ok := cadence.Interval(); !ok {
			t.Errorf("cadence %q has no interval", cadence)
		}
	}
	if _, ok := Cadence("hourly").Interval(); ok {
		t.Error("an unsupported cadence reported an interval")
	}
}

func mustBuild(t *testing.T, results []ens.Result) Snapshot {
	t.Helper()
	snapshot, err := Build("test-snapshot", fixedNow, testSources(len(results)), results)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return snapshot
}

func cloneSnapshot(snapshot Snapshot) Snapshot {
	clone := snapshot
	clone.Metadata.Sources = append([]SourceList(nil), snapshot.Metadata.Sources...)
	clone.Metadata.Counts = make(Counts, len(snapshot.Metadata.Counts))
	for status, count := range snapshot.Metadata.Counts {
		clone.Metadata.Counts[status] = count
	}
	clone.Results = append([]ens.Result(nil), snapshot.Results...)
	return clone
}

func timePointer(value time.Time) *time.Time {
	return &value
}

func assertSamePayload(t *testing.T, want, got Payload) {
	t.Helper()
	if got.Checksum != want.Checksum {
		t.Fatalf("checksum is %s, want %s", got.Checksum, want.Checksum)
	}
	if got.CompressedChecksum != want.CompressedChecksum {
		t.Fatalf("compressed checksum is %s, want %s", got.CompressedChecksum, want.CompressedChecksum)
	}
	if got.RawBytes != want.RawBytes || got.CompressedBytes != want.CompressedBytes {
		t.Fatalf("byte counts are %d/%d, want %d/%d", got.RawBytes, got.CompressedBytes, want.RawBytes, want.CompressedBytes)
	}
	if len(got.Chunks) != len(want.Chunks) {
		t.Fatalf("chunk count is %d, want %d", len(got.Chunks), len(want.Chunks))
	}
	for i := range want.Chunks {
		if got.Chunks[i].Checksum != want.Chunks[i].Checksum {
			t.Fatalf("chunk %d checksum is %s, want %s", i, got.Chunks[i].Checksum, want.Chunks[i].Checksum)
		}
	}
}
