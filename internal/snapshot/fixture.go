package snapshot

import (
	"fmt"
	"time"

	"ens-scrape/internal/ens"
)

// Fixture snapshots are small, fully deterministic snapshots for local
// development. They let the read API, the local preview, and the browser be
// built and demonstrated without credentials and without querying The Graph.
//
// The bundled fixtures cover every status in ens.Statuses and every timestamp
// field, and they are classified by ens.Classify rather than hand written, so
// they cannot drift away from the real lifecycle rules.
const (
	// FixturePreview is the fresh fixture used for ordinary UI work.
	FixturePreview = "preview"
	// FixtureStale is the same data scanned long enough ago to trip the
	// staleness threshold, so the stale-state warning can be exercised.
	FixtureStale = "stale"
)

var (
	// FixtureScannedAt is the fixed scan time of the preview fixture.
	FixtureScannedAt = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	// FixturePublishedAt is the fixed publication time of the preview fixture
	// pointer. Every fixture publishes fixturePublishDelay after its own scan.
	FixturePublishedAt = FixtureScannedAt.Add(fixturePublishDelay)
	// FixtureSoonWindow matches the CLI default for expiry warnings.
	FixtureSoonWindow = 7 * 24 * time.Hour
	// fixtureStaleAge exceeds the daily cadence stale threshold of 48 hours.
	fixtureStaleAge = 72 * time.Hour
	// fixturePublishDelay is the gap between a fixture scan and its pointer.
	fixturePublishDelay = 2 * time.Minute
)

// FixtureNames lists the bundled fixtures in a stable order.
func FixtureNames() []string {
	return []string{FixturePreview, FixtureStale}
}

type fixtureCandidate struct {
	sourceID string
	label    string
	// found and expiryOffset describe the indexed registration relative to the
	// scan time. A nil expiryOffset on a found name is an indexed registration
	// with no usable expiry, which must classify as unknown rather than
	// available.
	found        bool
	expiryOffset *time.Duration
}

// Fixture builds one bundled fixture snapshot.
func Fixture(name string) (Snapshot, error) {
	var (
		snapshotID string
		scannedAt  time.Time
	)
	switch name {
	case FixturePreview:
		snapshotID = "fixture-preview"
		scannedAt = FixtureScannedAt
	case FixtureStale:
		snapshotID = "fixture-stale"
		scannedAt = FixtureScannedAt.Add(-fixtureStaleAge)
	default:
		return Snapshot{}, fmt.Errorf("unknown snapshot fixture %q", name)
	}

	candidates := fixtureCandidates()
	sources := fixtureSources(candidates)
	results := make([]ens.Result, 0, len(candidates))
	for _, candidate := range candidates {
		lookup := ens.Lookup{Name: candidate.label, Found: candidate.found}
		if candidate.expiryOffset != nil {
			expiry := scannedAt.Add(*candidate.expiryOffset)
			lookup.Expiry = &expiry
		}
		results = append(results, ens.Classify(lookup, scannedAt, FixtureSoonWindow))
	}
	return Build(snapshotID, scannedAt, sources, results)
}

// FixtureLatest builds the pointer that publishes a fixture.
func FixtureLatest(name string) (Latest, error) {
	snapshot, err := Fixture(name)
	if err != nil {
		return Latest{}, err
	}
	payload, err := Encode(snapshot)
	if err != nil {
		return Latest{}, err
	}
	return payload.Latest(snapshot.Metadata.ScannedAt.Add(fixturePublishDelay)), nil
}

// fixtureCandidates lists candidates deliberately chosen so that classification
// at the fixture scan time produces every lifecycle status, both shapes of an
// available name, and every timestamp field.
func fixtureCandidates() []fixtureCandidate {
	offset := func(d time.Duration) *time.Duration { return &d }
	day := 24 * time.Hour
	return []fixtureCandidate{
		// Never registered: available with no timestamps at all.
		{sourceID: "three-letters", label: "orb", found: false},
		// Expired 100 days ago: grace has ended, premium is still declining.
		{sourceID: "three-letters", label: "vex", found: true, expiryOffset: offset(-100 * day)},
		// Comfortably registered.
		{sourceID: "three-letters", label: "zap", found: true, expiryOffset: offset(200 * day)},
		// Expired 10 days ago: still in grace, far from the grace end.
		{sourceID: "four-letters", label: "dusk", found: true, expiryOffset: offset(-10 * day)},
		// Expired 87 days ago: grace ends inside the soon window.
		{sourceID: "four-letters", label: "flux", found: true, expiryOffset: offset(-87 * day)},
		// Expires inside the soon window.
		{sourceID: "four-letters", label: "helm", found: true, expiryOffset: offset(3 * day)},
		// Indexed but without a usable expiry: unknown, never available.
		{sourceID: "four-letters", label: "nova", found: true},
		// Expired 200 days ago: available at standard price, with the full set
		// of historical timestamps.
		{sourceID: "five-letters", label: "amber", found: true, expiryOffset: offset(-200 * day)},
		{sourceID: "five-letters", label: "quill", found: true, expiryOffset: offset(400 * day)},
		{sourceID: "five-letters", label: "raven", found: true, expiryOffset: offset(-95 * day)},
	}
}

func fixtureSources(candidates []fixtureCandidate) []SourceList {
	definitions := []SourceList{
		{ID: "three-letters", Path: "data/words/3-letters.txt", Cadence: CadenceThreeHourly},
		{ID: "four-letters", Path: "data/words/4-letters.txt", Cadence: CadenceThreeHourly},
		{ID: "five-letters", Path: "data/words/5-letters.txt", Cadence: CadenceDaily},
	}
	for i := range definitions {
		for _, candidate := range candidates {
			if candidate.sourceID == definitions[i].ID {
				definitions[i].Names++
			}
		}
	}
	return definitions
}
