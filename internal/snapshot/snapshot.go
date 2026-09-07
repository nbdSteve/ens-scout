// Package snapshot defines the deterministic, storage-neutral snapshot contract
// shared by the scanner, the read API, local previews, and the browser.
//
// A snapshot is an immutable record of one scan: metadata that identifies the
// scan and its source lists, plus the lifecycle results produced by
// internal/ens. Snapshots are canonically ordered and canonically serialized,
// so the same logical results always produce the same bytes and the same
// checksum regardless of input order or worker completion order.
//
// Nothing here depends on AWS. Storage backends implement the interfaces in
// store.go; MemoryStore and FileStore are local fakes so later Lambda and
// frontend work can be developed and tested without a network.
package snapshot

import (
	"fmt"
	"sort"
	"time"

	"ens-scrape/internal/ens"
	"ens-scrape/internal/names"
)

// FormatVersion is the wire version of this contract. Readers must reject a
// snapshot or latest pointer that declares any other version rather than
// guessing at an unknown layout.
//
// Version 2 stores the fully-qualified name, "zap.eth", where version 1 stored
// the bare label, "zap".
//
// Version 3 gives every source list its own last-scanned instant. Version 2
// carried one scan time for the whole snapshot, so a reader had to measure every
// source against it, and a merge-forward publication then reported a list whose
// own schedule had stopped as freshly scanned. There is no fallback for a version
// 2 payload: a reader rejects the version it does not know, and a publisher that
// cannot read the stored pointer republishes past it, which is the migration.
const FormatVersion = 3

// NameSuffix is the parent zone every stored name carries. A snapshot records the
// fully-qualified name that ens.Result, internal/report, and the CLI all use, so
// nothing downstream has to reattach it. A client filtering by label length
// strips this suffix first.
const NameSuffix = ".eth"

// StaleFactor sets how long a published snapshot stays fresh. A snapshot is
// stale once its age exceeds StaleFactor multiplied by the slowest source
// cadence, which tolerates exactly one missed scheduled scan.
const StaleFactor = 2

// maxSnapshotIDLength bounds snapshot identifiers so they remain safe as
// storage keys and as single path segments in FileStore.
const maxSnapshotIDLength = 64

// Cadence names how often a source list is rescanned.
type Cadence string

const (
	// CadenceThreeHourly is the approved cadence for the three- and
	// four-letter lists.
	CadenceThreeHourly Cadence = "three-hourly"
	// CadenceDaily is the approved cadence for the five-letter list.
	CadenceDaily Cadence = "daily"
)

// Cadences is the complete ordered set of supported cadences.
var Cadences = []Cadence{CadenceThreeHourly, CadenceDaily}

// Interval reports the scheduled gap between scans for a cadence. The second
// return value is false for an unknown cadence.
func (c Cadence) Interval() (time.Duration, bool) {
	switch c {
	case CadenceThreeHourly:
		return 3 * time.Hour, true
	case CadenceDaily:
		return 24 * time.Hour, true
	default:
		return 0, false
	}
}

// SourceList identifies one input word list that contributed to a snapshot.
// ID is stable across scans so clients can offer a list filter without
// depending on file paths, which may move.
type SourceList struct {
	ID      string  `json:"id"`
	Path    string  `json:"path"`
	Cadence Cadence `json:"cadence"`
	// Names is the number of unique labels this list contributed after
	// cross-list deduplication, so the source counts sum to the result count.
	Names int `json:"names"`
	// LastScannedAt is the instant this list was last asked about, which is the
	// snapshot scan time for a list the publishing run scanned and the older
	// instant its own schedule last reached for a list carried forward. It is what
	// makes each source's freshness its own: one pointer serves every group, so a
	// reader measuring a carried list against the snapshot-wide scan time reports a
	// list whose schedule has stopped as freshly scanned. It is always UTC with
	// second precision and never after the snapshot scan time.
	LastScannedAt time.Time `json:"last_scanned_at"`
}

// Equal reports whether two source lists describe the same list scanned at the
// same instant.
//
// It exists because == on a struct holding a time.Time also compares the
// location and the monotonic reading, neither of which a canonical snapshot may
// depend on, and because a location that differs while the instant does not is
// still not canonical form. Every comparison of stored sources goes through it.
func (s SourceList) Equal(other SourceList) bool {
	return s.ID == other.ID &&
		s.Path == other.Path &&
		s.Cadence == other.Cadence &&
		s.Names == other.Names &&
		s.LastScannedAt.Equal(other.LastScannedAt) &&
		s.LastScannedAt.Location() == other.LastScannedAt.Location()
}

// ScanAgeInput reports the thresholds for this one list, from its own cadence
// rather than from the slowest cadence in the snapshot.
func (s SourceList) ScanAgeInput() (ScanAgeInput, error) {
	return DeriveScanAgeInput([]SourceList{s})
}

// ResolveScanAge resolves this list's own staleness at now.
//
// It is the only way to resolve a source's age, so no caller can reach for the
// snapshot-wide scan time by mistake. That substitution is the whole defect
// LastScannedAt exists to remove.
func (s SourceList) ResolveScanAge(now time.Time) (ScanAge, error) {
	input, err := s.ScanAgeInput()
	if err != nil {
		return ScanAge{}, err
	}
	return input.At(s.LastScannedAt, now), nil
}

// Counts is the number of results in each lifecycle status. Every status in
// ens.Statuses is always present, including zeros, so clients never have to
// branch on a missing key.
type Counts map[ens.Status]int

// cloneCounts copies a counts map so a caller cannot reach through it and change
// snapshot metadata or stored pointer state.
func cloneCounts(counts Counts) Counts {
	if counts == nil {
		return nil
	}
	clone := make(Counts, len(counts))
	for status, count := range counts {
		clone[status] = count
	}
	return clone
}

// cloneSources copies a source list slice for the same reason.
func cloneSources(sources []SourceList) []SourceList {
	if sources == nil {
		return nil
	}
	return append([]SourceList(nil), sources...)
}

// ScanAgeInput carries the cadence-derived thresholds a client needs to judge
// staleness itself. A snapshot never publishes a stale flag, because such a
// flag ages out between the response and the render.
type ScanAgeInput struct {
	ExpectedSeconds   int64 `json:"expected_interval_seconds"`
	StaleAfterSeconds int64 `json:"stale_after_seconds"`
}

// ScanAge is the resolved staleness of a snapshot at one point in time.
type ScanAge struct {
	Age        time.Duration
	Expected   time.Duration
	StaleAfter time.Duration
	Stale      bool
}

// At resolves the age of a scan. A scan time in the future, which indicates
// clock skew rather than freshness, yields a zero age and is never stale.
func (in ScanAgeInput) At(scannedAt, now time.Time) ScanAge {
	age := now.UTC().Sub(scannedAt.UTC())
	if age < 0 {
		age = 0
	}
	staleAfter := time.Duration(in.StaleAfterSeconds) * time.Second
	return ScanAge{
		Age:        age,
		Expected:   time.Duration(in.ExpectedSeconds) * time.Second,
		StaleAfter: staleAfter,
		Stale:      age > staleAfter,
	}
}

// DeriveScanAgeInput computes the staleness thresholds for a set of source
// lists. The slowest cadence governs, because the snapshot is only as fresh as
// its least frequently scanned list.
func DeriveScanAgeInput(sources []SourceList) (ScanAgeInput, error) {
	slowest := time.Duration(0)
	for _, source := range sources {
		interval, ok := source.Cadence.Interval()
		if !ok {
			return ScanAgeInput{}, fmt.Errorf("source %q has unknown cadence %q", source.ID, source.Cadence)
		}
		if interval > slowest {
			slowest = interval
		}
	}
	if slowest == 0 {
		return ScanAgeInput{}, fmt.Errorf("at least one source list is required")
	}
	return ScanAgeInput{
		ExpectedSeconds:   int64(slowest / time.Second),
		StaleAfterSeconds: int64(slowest/time.Second) * StaleFactor,
	}, nil
}

// Metadata describes one scan. Derived fields are stored rather than
// recomputed by clients, and Validate proves they agree with the results.
type Metadata struct {
	FormatVersion int          `json:"format_version"`
	SnapshotID    string       `json:"snapshot_id"`
	ScannedAt     time.Time    `json:"scanned_at"`
	Sources       []SourceList `json:"sources"`
	ScanAge       ScanAgeInput `json:"scan_age"`
	Names         int          `json:"names"`
	Counts        Counts       `json:"counts"`
}

// ResolveScanAge reports the staleness of this snapshot at now.
func (m Metadata) ResolveScanAge(now time.Time) ScanAge {
	return m.ScanAge.At(m.ScannedAt, now)
}

// Snapshot is the complete published record of one scan.
type Snapshot struct {
	Metadata Metadata     `json:"metadata"`
	Results  []ens.Result `json:"results"`
}

// Build normalizes results into canonical order, derives metadata, and
// validates the whole snapshot. Callers may pass results in any order, so the
// output does not depend on input order or on which worker finished first.
//
// scannedAt must be the instant the results were classified against, which
// checker.Run reports as Stats.ClassifiedAt. It is not "roughly when the scan
// ran": every status is checked against it, so a scan that classifies at one
// instant and then builds with a freshly sampled clock is rejected as soon as
// any expiry, grace end, or premium end falls between the two. Build truncates
// scannedAt to the second, which is safe because ENS lifecycle timestamps are
// whole seconds and so no boundary sits inside the truncated fraction.
func Build(snapshotID string, scannedAt time.Time, sources []SourceList, results []ens.Result) (Snapshot, error) {
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return Snapshot{}, err
	}

	scanTime := canonicalTime(scannedAt)
	// Source instants are truncated here for the same reason scannedAt is, so a
	// caller that passes a clock reading straight through gets canonical bytes.
	// Validate is the strict half: it rejects an instant that is not already
	// canonical rather than repairing a stored snapshot.
	canonicalSources := cloneSources(sources)
	for i := range canonicalSources {
		canonicalSources[i].LastScannedAt = canonicalTime(canonicalSources[i].LastScannedAt)
	}
	normalizedSources, err := normalizeSources(canonicalSources, scanTime)
	if err != nil {
		return Snapshot{}, err
	}
	scanAge, err := DeriveScanAgeInput(normalizedSources)
	if err != nil {
		return Snapshot{}, err
	}

	normalizedResults := make([]ens.Result, 0, len(results))
	for _, result := range results {
		normalized, err := normalizeResult(result, scanTime)
		if err != nil {
			return Snapshot{}, err
		}
		normalizedResults = append(normalizedResults, normalized)
	}
	sortResults(normalizedResults)

	snapshot := Snapshot{
		Metadata: Metadata{
			FormatVersion: FormatVersion,
			SnapshotID:    snapshotID,
			ScannedAt:     scanTime,
			Sources:       normalizedSources,
			ScanAge:       scanAge,
			Names:         len(normalizedResults),
			Counts:        DeriveCounts(normalizedResults),
		},
		Results: normalizedResults,
	}
	if err := snapshot.Validate(); err != nil {
		return Snapshot{}, err
	}
	return snapshot, nil
}

// DeriveCounts tallies results by status. Every status in ens.Statuses is
// present in the result, including zeros.
func DeriveCounts(results []ens.Result) Counts {
	counts := make(Counts, len(ens.Statuses))
	for _, status := range ens.Statuses {
		counts[status] = 0
	}
	for _, result := range results {
		counts[result.Status]++
	}
	return counts
}

// Validate fails closed on any snapshot that is not in canonical form: wrong
// format version, unsorted or duplicated names, timestamps that disagree with
// the ENS lifecycle rules, or derived metadata that disagrees with the results.
func (s Snapshot) Validate() error {
	if s.Metadata.FormatVersion != FormatVersion {
		return fmt.Errorf("unsupported snapshot format version %d (want %d)", s.Metadata.FormatVersion, FormatVersion)
	}
	if err := ValidateSnapshotID(s.Metadata.SnapshotID); err != nil {
		return err
	}
	if s.Metadata.ScannedAt.IsZero() {
		return fmt.Errorf("snapshot scan time is required")
	}
	if !s.Metadata.ScannedAt.Equal(canonicalTime(s.Metadata.ScannedAt)) || s.Metadata.ScannedAt.Location() != time.UTC {
		return fmt.Errorf("snapshot scan time must be UTC with second precision")
	}

	expectedSources, err := normalizeSources(s.Metadata.Sources, s.Metadata.ScannedAt)
	if err != nil {
		return err
	}
	for i, source := range s.Metadata.Sources {
		if !source.Equal(expectedSources[i]) {
			return fmt.Errorf("snapshot source lists are not sorted by id")
		}
	}

	scanAge, err := DeriveScanAgeInput(s.Metadata.Sources)
	if err != nil {
		return err
	}
	if s.Metadata.ScanAge != scanAge {
		return fmt.Errorf("snapshot scan age thresholds disagree with the source cadences")
	}

	sourceNames := 0
	for _, source := range s.Metadata.Sources {
		sourceNames += source.Names
	}
	if sourceNames != len(s.Results) {
		return fmt.Errorf("source lists account for %d names but the snapshot holds %d results", sourceNames, len(s.Results))
	}
	if s.Metadata.Names != len(s.Results) {
		return fmt.Errorf("snapshot metadata reports %d names but holds %d results", s.Metadata.Names, len(s.Results))
	}

	counts := DeriveCounts(s.Results)
	if len(s.Metadata.Counts) != len(counts) {
		return fmt.Errorf("snapshot counts must list every lifecycle status")
	}
	for status, want := range counts {
		got, ok := s.Metadata.Counts[status]
		if !ok {
			return fmt.Errorf("snapshot counts are missing status %q", status)
		}
		if got != want {
			return fmt.Errorf("snapshot counts report %d %q results but holds %d", got, status, want)
		}
	}

	previous := ""
	for i, result := range s.Results {
		normalized, err := normalizeResult(result, s.Metadata.ScannedAt)
		if err != nil {
			return err
		}
		if !resultsEqual(normalized, result) {
			return fmt.Errorf("result %d (%q) is not in canonical form", i, result.Name)
		}
		if i > 0 && result.Name <= previous {
			return fmt.Errorf("results must be sorted by name without duplicates: %q follows %q", result.Name, previous)
		}
		previous = result.Name
	}
	return nil
}

// ValidateSnapshotID checks that an identifier is a short, lowercase token that
// is safe to use as a storage key and as a single filesystem path segment.
func ValidateSnapshotID(snapshotID string) error {
	if snapshotID == "" {
		return fmt.Errorf("snapshot id is required")
	}
	if len(snapshotID) > maxSnapshotIDLength {
		return fmt.Errorf("snapshot id %q is longer than %d characters", snapshotID, maxSnapshotIDLength)
	}
	for i, character := range snapshotID {
		switch {
		case character >= 'a' && character <= 'z':
		case character >= '0' && character <= '9':
		case character == '-' && i > 0:
		default:
			return fmt.Errorf("snapshot id %q must use lowercase letters, digits, and inner dashes", snapshotID)
		}
	}
	return nil
}

// normalizeSources validates a source set against the scan time it belongs to
// and returns it in canonical order.
//
// scannedAt is required rather than optional because every rule about a source's
// last-scanned instant is a rule about its relationship to the snapshot's own
// scan time. A missing instant is refused instead of standing in for the scan
// time, which is exactly the substitution that reported a stopped list as fresh.
func normalizeSources(sources []SourceList, scannedAt time.Time) ([]SourceList, error) {
	if len(sources) == 0 {
		return nil, fmt.Errorf("at least one source list is required")
	}
	scanTime := canonicalTime(scannedAt)
	normalized := make([]SourceList, 0, len(sources))
	seen := make(map[string]struct{}, len(sources))
	for _, source := range sources {
		if source.ID == "" {
			return nil, fmt.Errorf("source list id is required")
		}
		if source.Path == "" {
			return nil, fmt.Errorf("source list %q needs a path", source.ID)
		}
		if _, ok := source.Cadence.Interval(); !ok {
			return nil, fmt.Errorf("source %q has unknown cadence %q", source.ID, source.Cadence)
		}
		if source.Names < 0 {
			return nil, fmt.Errorf("source %q reports a negative name count", source.ID)
		}
		if _, exists := seen[source.ID]; exists {
			return nil, fmt.Errorf("duplicate source list id %q", source.ID)
		}
		seen[source.ID] = struct{}{}
		if source.LastScannedAt.IsZero() {
			return nil, fmt.Errorf("source %q needs a last scanned time", source.ID)
		}
		if !source.LastScannedAt.Equal(canonicalTime(source.LastScannedAt)) || source.LastScannedAt.Location() != time.UTC {
			return nil, fmt.Errorf("source %q last scanned time must be UTC with second precision", source.ID)
		}
		// A list cannot have been scanned after the scan this snapshot records. Such
		// an instant means the sources were assembled from a newer publication than
		// the one being built, and carrying it would let a client resolve a source
		// age against a moment that had not happened when the results were classified.
		if source.LastScannedAt.After(scanTime) {
			return nil, fmt.Errorf("source %q was last scanned after the snapshot scan time", source.ID)
		}
		normalized = append(normalized, source)
	}
	// The snapshot scan time is the instant a fresh scan classified at, so some
	// list has to own it. A set where every instant is older describes a snapshot
	// that scanned nothing and would still advance the pointer's scan time, which
	// is how a snapshot-wide age could keep reading fresh with no list behind it.
	scanned := false
	for _, source := range normalized {
		if source.LastScannedAt.Equal(scanTime) {
			scanned = true
			break
		}
	}
	if !scanned {
		return nil, fmt.Errorf("no source list was scanned at the snapshot scan time")
	}
	sort.Slice(normalized, func(i, j int) bool {
		return normalized[i].ID < normalized[j].ID
	})
	return normalized, nil
}

// normalizeResult puts one lifecycle result into canonical form and rejects
// results that break the ENS lifecycle rules in internal/ens. scannedAt is the
// snapshot scan time, which is the instant the published status must describe.
func normalizeResult(result ens.Result, scannedAt time.Time) (ens.Result, error) {
	// names.Normalize is the single definition of a valid label, and it accepts
	// both the bare label and the fully-qualified form, so the rules are applied
	// here without being restated. Its bare output is then requalified, because
	// the canonical stored name is the fully-qualified one.
	label, err := names.Normalize(result.Name)
	if err != nil {
		return ens.Result{}, fmt.Errorf("result name %q: %w", result.Name, err)
	}
	name := label + NameSuffix

	known := false
	for _, status := range ens.Statuses {
		if status == result.Status {
			known = true
			break
		}
	}
	if !known {
		return ens.Result{}, fmt.Errorf("result %q has unknown status %q", result.Name, result.Status)
	}

	normalized := ens.Result{
		Name:        name,
		Status:      result.Status,
		Expiry:      canonicalTimePointer(result.Expiry),
		GraceEnds:   canonicalTimePointer(result.GraceEnds),
		PremiumEnds: canonicalTimePointer(result.PremiumEnds),
	}
	// Without an expiry there is nothing for ens.Classify to derive a grace or
	// premium end from, so this is the one shape the check below cannot judge.
	if normalized.Expiry == nil && (normalized.GraceEnds != nil || normalized.PremiumEnds != nil) {
		return ens.Result{}, fmt.Errorf("result %q has a grace or premium end without an expiry", result.Name)
	}
	if err := checkStatusAgainstScanTime(normalized, scannedAt); err != nil {
		return ens.Result{}, err
	}
	return normalized, nil
}

// checkStatusAgainstScanTime proves the published status and timestamps are ones
// ens.Classify could produce at the scan time, so a snapshot can never publish a
// lifecycle label or a derived timestamp that its own expiry contradicts. It is
// also why the grace and premium durations appear only inside internal/ens:
// comparing against Classify's output covers the arithmetic without restating it.
//
// The soon window is not on the wire, so classification runs with a zero window
// and each soon status is accepted wherever its steady-state sibling is. That is
// the only slack: every governing boundary must still fall on the correct side of
// the scan time.
func checkStatusAgainstScanTime(result ens.Result, scannedAt time.Time) error {
	if result.Expiry == nil {
		// Without an expiry the only honest labels are a name that was never
		// registered and an indexed registration whose expiry is missing or
		// malformed. A registered name with no expiry is unknown, not available.
		if result.Status != ens.StatusAvailable && result.Status != ens.StatusUnknown {
			return fmt.Errorf("result %q is %q but carries no expiry", result.Name, result.Status)
		}
		return nil
	}

	lookup := ens.Lookup{Name: result.Name, Found: true, Expiry: result.Expiry}
	expected := ens.Classify(lookup, scannedAt, 0)
	if !timePointersEqual(result.GraceEnds, expected.GraceEnds) || !timePointersEqual(result.PremiumEnds, expected.PremiumEnds) {
		return fmt.Errorf("result %q lifecycle timestamps disagree with its expiry at the scan time", result.Name)
	}
	if result.Status == expected.Status || result.Status == soonSibling(expected.Status) {
		return nil
	}
	return fmt.Errorf("result %q is %q but its timestamps classify as %q at the scan time", result.Name, result.Status, expected.Status)
}

// soonSibling maps a steady-state status to the status ens.Classify produces for
// the same timestamps inside a positive soon window.
func soonSibling(status ens.Status) ens.Status {
	switch status {
	case ens.StatusRegistered:
		return ens.StatusExpiringSoon
	case ens.StatusGracePeriod:
		return ens.StatusGraceEndingSoon
	default:
		return status
	}
}

// sortResults applies the canonical order: byte-wise ascending name. Labels are
// normalized lowercase ASCII, so byte order is stable and locale independent.
func sortResults(results []ens.Result) {
	sort.Slice(results, func(i, j int) bool {
		return results[i].Name < results[j].Name
	})
}

func resultsEqual(left, right ens.Result) bool {
	return left.Name == right.Name &&
		left.Status == right.Status &&
		timePointersEqual(left.Expiry, right.Expiry) &&
		timePointersEqual(left.GraceEnds, right.GraceEnds) &&
		timePointersEqual(left.PremiumEnds, right.PremiumEnds)
}

func timePointersEqual(left, right *time.Time) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Equal(*right) && left.Location() == right.Location()
}

// canonicalTime renders a timestamp as UTC with second precision so JSON
// encoding never varies with monotonic readings or sub-second noise.
func canonicalTime(value time.Time) time.Time {
	return value.UTC().Truncate(time.Second)
}

func canonicalTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	canonical := canonicalTime(*value)
	return &canonical
}
