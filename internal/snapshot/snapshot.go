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
const FormatVersion = 1

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
}

// Counts is the number of results in each lifecycle status. Every status in
// ens.Statuses is always present, including zeros, so clients never have to
// branch on a missing key.
type Counts map[ens.Status]int

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
func Build(snapshotID string, scannedAt time.Time, sources []SourceList, results []ens.Result) (Snapshot, error) {
	if err := ValidateSnapshotID(snapshotID); err != nil {
		return Snapshot{}, err
	}

	normalizedSources, err := normalizeSources(sources)
	if err != nil {
		return Snapshot{}, err
	}
	scanAge, err := DeriveScanAgeInput(normalizedSources)
	if err != nil {
		return Snapshot{}, err
	}

	normalizedResults := make([]ens.Result, 0, len(results))
	for _, result := range results {
		normalized, err := normalizeResult(result)
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
			ScannedAt:     canonicalTime(scannedAt),
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

	expectedSources, err := normalizeSources(s.Metadata.Sources)
	if err != nil {
		return err
	}
	if len(expectedSources) != len(s.Metadata.Sources) {
		return fmt.Errorf("snapshot source lists are not canonical")
	}
	for i, source := range s.Metadata.Sources {
		if source != expectedSources[i] {
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
		normalized, err := normalizeResult(result)
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

func normalizeSources(sources []SourceList) ([]SourceList, error) {
	if len(sources) == 0 {
		return nil, fmt.Errorf("at least one source list is required")
	}
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
		normalized = append(normalized, source)
	}
	sort.Slice(normalized, func(i, j int) bool {
		return normalized[i].ID < normalized[j].ID
	})
	return normalized, nil
}

// normalizeResult puts one lifecycle result into canonical form and rejects
// results that break the ENS lifecycle rules in internal/ens.
func normalizeResult(result ens.Result) (ens.Result, error) {
	label, err := names.Normalize(result.Name)
	if err != nil {
		return ens.Result{}, fmt.Errorf("result name %q: %w", result.Name, err)
	}
	if label != result.Name {
		return ens.Result{}, fmt.Errorf("result name %q is not a normalized ENS label", result.Name)
	}

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
		Name:        label,
		Status:      result.Status,
		Expiry:      canonicalTimePointer(result.Expiry),
		GraceEnds:   canonicalTimePointer(result.GraceEnds),
		PremiumEnds: canonicalTimePointer(result.PremiumEnds),
	}
	if normalized.GraceEnds != nil {
		if normalized.Expiry == nil {
			return ens.Result{}, fmt.Errorf("result %q has a grace end without an expiry", result.Name)
		}
		if !normalized.GraceEnds.Equal(normalized.Expiry.Add(ens.GracePeriod)) {
			return ens.Result{}, fmt.Errorf("result %q grace end does not follow the ENS grace period", result.Name)
		}
	}
	if normalized.PremiumEnds != nil {
		if normalized.GraceEnds == nil {
			return ens.Result{}, fmt.Errorf("result %q has a premium end without a grace end", result.Name)
		}
		if !normalized.PremiumEnds.Equal(normalized.GraceEnds.Add(ens.PremiumPeriod)) {
			return ens.Result{}, fmt.Errorf("result %q premium end does not follow the ENS premium period", result.Name)
		}
	}
	return normalized, nil
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
