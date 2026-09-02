package snapshot

import (
	"strings"
	"testing"
	"time"

	"ens-scrape/internal/ens"
)

// TestCarryForwardIsIdentityAtTheSameInstant proves the round trip through
// lookupFromResult loses nothing: carried at the instant they were classified,
// every lifecycle status comes back exactly as it went in.
func TestCarryForwardIsIdentityAtTheSameInstant(t *testing.T) {
	results := lifecycleResults(t, fixedNow)

	carried, err := CarryForward(results, fixedNow, testSoon)
	if err != nil {
		t.Fatalf("CarryForward: %v", err)
	}
	if len(carried) != len(results) {
		t.Fatalf("carried %d results, want %d", len(carried), len(results))
	}
	for i, want := range results {
		if !resultsEqual(carried[i], want) {
			t.Errorf("result %d (%q) changed: status %q expiry %v, want status %q expiry %v",
				i, want.Name, carried[i].Status, carried[i].Expiry, want.Status, want.Expiry)
		}
	}
}

// TestCarryForwardAdvancesTheLifecycle is the reason carrying reclassifies rather
// than copying: the subgraph answer does not change on its own, but the label
// derived from it does as each boundary passes.
func TestCarryForwardAdvancesTheLifecycle(t *testing.T) {
	day := 24 * time.Hour
	expiry := fixedNow.Add(2 * day)

	registered := ens.Classify(ens.Lookup{Name: "zap.eth", Found: true, Expiry: &expiry}, fixedNow, 0)
	if registered.Status != ens.StatusRegistered {
		t.Fatalf("setup: %q is %q, want %q", registered.Name, registered.Status, ens.StatusRegistered)
	}

	tests := []struct {
		name       string
		later      time.Duration
		wantStatus ens.Status
	}{
		{name: "still registered", later: day, wantStatus: ens.StatusRegistered},
		{name: "into grace", later: 3 * day, wantStatus: ens.StatusGracePeriod},
		{name: "into premium", later: 95 * day, wantStatus: ens.StatusPremium},
		{name: "fully available", later: 200 * day, wantStatus: ens.StatusAvailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			scannedAt := fixedNow.Add(test.later)
			carried, err := CarryForward([]ens.Result{registered}, scannedAt, 0)
			if err != nil {
				t.Fatalf("CarryForward: %v", err)
			}
			if carried[0].Status != test.wantStatus {
				t.Errorf("carried status is %q, want %q", carried[0].Status, test.wantStatus)
			}
			// The registration data itself is carried unchanged. Only the label moves.
			if carried[0].Expiry == nil || !carried[0].Expiry.Equal(expiry) {
				t.Errorf("carried expiry is %v, want %v", carried[0].Expiry, expiry)
			}
		})
	}
}

// TestCarryForwardKeepsTheSoonWindow proves a carried name and a freshly scanned
// name with the same near boundary get the same label, so the published status of a
// name does not depend on which cadence group was rescanned.
func TestCarryForwardKeepsTheSoonWindow(t *testing.T) {
	day := 24 * time.Hour
	expiry := fixedNow.Add(3 * day)
	stale := ens.Classify(ens.Lookup{Name: "helm.eth", Found: true, Expiry: &expiry}, fixedNow.Add(-day), testSoon)

	fresh := ens.Classify(ens.Lookup{Name: "helm.eth", Found: true, Expiry: &expiry}, fixedNow, testSoon)
	if fresh.Status != ens.StatusExpiringSoon {
		t.Fatalf("setup: fresh status is %q, want %q", fresh.Status, ens.StatusExpiringSoon)
	}

	carried, err := CarryForward([]ens.Result{stale}, fixedNow, testSoon)
	if err != nil {
		t.Fatalf("CarryForward: %v", err)
	}
	if carried[0].Status != fresh.Status {
		t.Errorf("carried status is %q but a fresh scan says %q", carried[0].Status, fresh.Status)
	}

	// Without the window the same name is merely registered, which is what makes
	// passing the scan's window rather than zero the point of this test.
	withoutWindow, err := CarryForward([]ens.Result{stale}, fixedNow, 0)
	if err != nil {
		t.Fatalf("CarryForward: %v", err)
	}
	if withoutWindow[0].Status != ens.StatusRegistered {
		t.Errorf("without a soon window the status is %q, want %q", withoutWindow[0].Status, ens.StatusRegistered)
	}
}

// TestCarryForwardOutputBuildsIntoASnapshot is the contract-level guarantee: what
// CarryForward returns is accepted by Build at the new scan time, so a merged
// publication of fresh and carried results never trips the status check that
// normalizeResult applies.
func TestCarryForwardOutputBuildsIntoASnapshot(t *testing.T) {
	// The previous scan is far enough back that several boundaries have passed.
	previous := fixedNow.Add(-40 * 24 * time.Hour)
	published := lifecycleResults(t, previous)

	carried, err := CarryForward(published, fixedNow, testSoon)
	if err != nil {
		t.Fatalf("CarryForward: %v", err)
	}
	snapshot, err := Build("carried", fixedNow, testSources(len(carried)), carried)
	if err != nil {
		t.Fatalf("Build rejected carried results: %v", err)
	}
	if snapshot.Metadata.Names != len(published) {
		t.Errorf("snapshot holds %d names, want %d", snapshot.Metadata.Names, len(published))
	}

	// At least one label must have moved, or this test would pass without
	// exercising anything the identity case does not already cover.
	moved := false
	byName := make(map[string]ens.Status, len(published))
	for _, result := range published {
		byName[result.Name] = result.Status
	}
	for _, result := range snapshot.Results {
		if byName[result.Name] != result.Status {
			moved = true
			break
		}
	}
	if !moved {
		t.Errorf("no carried status advanced across %v, so the test proves nothing", fixedNow.Sub(previous))
	}
}

// TestCarryForwardMergesWithFreshResults covers the shape the scanner uses: one
// cadence group is rescanned and the other is carried, and the concatenation
// builds regardless of the order the two sets are joined in.
func TestCarryForwardMergesWithFreshResults(t *testing.T) {
	day := 24 * time.Hour
	at := func(offset time.Duration) *time.Time {
		value := fixedNow.Add(offset)
		return &value
	}

	fresh := []ens.Result{
		ens.Classify(ens.Lookup{Name: "zap.eth", Found: true, Expiry: at(200 * day)}, fixedNow, testSoon),
		ens.Classify(ens.Lookup{Name: "orb.eth"}, fixedNow, testSoon),
	}
	stale := []ens.Result{
		ens.Classify(ens.Lookup{Name: "amber.eth", Found: true, Expiry: at(-10 * day)}, fixedNow.Add(-day), testSoon),
		ens.Classify(ens.Lookup{Name: "nova.eth", Found: true}, fixedNow.Add(-day), testSoon),
	}

	carried, err := CarryForward(stale, fixedNow, testSoon)
	if err != nil {
		t.Fatalf("CarryForward: %v", err)
	}

	merged := append(append([]ens.Result(nil), carried...), fresh...)
	sources := []SourceList{
		{ID: "carried-list", Path: "data/words/carried.txt", Cadence: CadenceDaily, Names: len(carried)},
		{ID: "fresh-list", Path: "data/words/fresh.txt", Cadence: CadenceThreeHourly, Names: len(fresh)},
	}
	snapshot, err := Build("merged", fixedNow, sources, merged)
	if err != nil {
		t.Fatalf("Build rejected a merged snapshot: %v", err)
	}
	want := []string{"amber.eth", "nova.eth", "orb.eth", "zap.eth"}
	for i, name := range want {
		if snapshot.Results[i].Name != name {
			t.Errorf("result %d is %q, want %q", i, snapshot.Results[i].Name, name)
		}
	}
	// The slowest carried cadence governs staleness even though the fresh group is
	// faster, which is what stops a merged snapshot from claiming to be fresher
	// than its oldest list.
	if snapshot.Metadata.ScanAge.ExpectedSeconds != int64(24*time.Hour/time.Second) {
		t.Errorf("expected interval is %ds, want %ds",
			snapshot.Metadata.ScanAge.ExpectedSeconds, int64(24*time.Hour/time.Second))
	}
}

// TestCarryForwardRejectsAResultClassifyCouldNotProduce proves the inverse mapping
// fails closed rather than guessing a Found value, so a hand-edited result cannot
// be laundered into a snapshot through the carry path.
func TestCarryForwardRejectsAResultClassifyCouldNotProduce(t *testing.T) {
	tests := []struct {
		name   string
		result ens.Result
	}{
		{name: "registered with no expiry", result: ens.Result{Name: "zap.eth", Status: ens.StatusRegistered}},
		{name: "grace with no expiry", result: ens.Result{Name: "zap.eth", Status: ens.StatusGracePeriod}},
		{name: "premium with no expiry", result: ens.Result{Name: "zap.eth", Status: ens.StatusPremium}},
		{name: "empty status", result: ens.Result{Name: "zap.eth"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := CarryForward([]ens.Result{test.result}, fixedNow, testSoon); err == nil {
				t.Fatalf("CarryForward accepted a result Classify could not produce")
			} else if !strings.Contains(err.Error(), "carries no expiry") {
				t.Errorf("error is %v, want one about a missing expiry", err)
			}
		})
	}
}

// TestCarryForwardRejectsANegativeSoonWindow keeps the one numeric argument from
// silently inverting the near-boundary comparison inside Classify.
func TestCarryForwardRejectsANegativeSoonWindow(t *testing.T) {
	results := lifecycleResults(t, fixedNow)
	if _, err := CarryForward(results, fixedNow, -time.Hour); err == nil {
		t.Fatalf("CarryForward accepted a negative soon window")
	}
}

// TestCarryForwardCanonicalizesTheScanTime keeps a caller's sub-second clock from
// reaching Classify, so carrying at a fractional instant cannot land a result on
// the other side of a whole-second boundary from where Build puts it.
func TestCarryForwardCanonicalizesTheScanTime(t *testing.T) {
	expiry := fixedNow.Add(time.Second)
	registered := ens.Classify(ens.Lookup{Name: "zap.eth", Found: true, Expiry: &expiry}, fixedNow, 0)

	// A scan time inside the second before the expiry. Truncated it is fixedNow,
	// where the name is still registered; untruncated it is past the expiry.
	scannedAt := expiry.Add(500 * time.Millisecond)
	carried, err := CarryForward([]ens.Result{registered}, scannedAt, 0)
	if err != nil {
		t.Fatalf("CarryForward: %v", err)
	}
	if carried[0].Status != ens.StatusGracePeriod {
		t.Fatalf("carried status is %q, want %q at the truncated scan time", carried[0].Status, ens.StatusGracePeriod)
	}
	// Build truncates the same way, so the carried result is canonical for it.
	if _, err := Build("truncated", scannedAt, testSources(1), carried); err != nil {
		t.Errorf("Build rejected a result carried at a fractional instant: %v", err)
	}
}

// TestCarryForwardAcceptsNoResults covers the first run of a schedule group, when
// nothing has been published yet and there is nothing to carry.
func TestCarryForwardAcceptsNoResults(t *testing.T) {
	carried, err := CarryForward(nil, fixedNow, testSoon)
	if err != nil {
		t.Fatalf("CarryForward: %v", err)
	}
	if len(carried) != 0 {
		t.Errorf("carried %d results from nothing", len(carried))
	}
}
