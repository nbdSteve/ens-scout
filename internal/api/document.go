package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"ens-scrape/internal/snapshot"
)

// metaDocument is the snapshot summary, served at PathMeta.
//
// It is what a client polls to decide whether to download a replacement, so it
// is deliberately a pure function of the snapshot ID: everything in it is fixed
// by the snapshot, so the entity tag stays a correct validator for this document
// as well as for the snapshot body.
//
// Two things are therefore absent. There is no published_at, because a retried
// publication rewrites only that field and the contract excludes it from pointer
// identity, so including it would let the document change while its validator
// did not. And there is no resolved age or stale flag, for the reason the
// contract gives for publishing thresholds instead: a resolved age is wrong the
// moment a cache keeps it. Both are on PathHealth, which is uncacheable.
type metaDocument struct {
	FormatVersion int       `json:"format_version"`
	SnapshotID    string    `json:"snapshot_id"`
	ScannedAt     time.Time `json:"scanned_at"`

	// Checksum is the SHA-256 of the PathSnapshot body, so a client can verify
	// what it downloaded against a summary it fetched separately. RawBytes is that
	// body's length, so a client can decide whether to fetch it at all.
	Checksum string `json:"checksum"`
	RawBytes int    `json:"raw_bytes"`

	Names  int             `json:"names"`
	Counts snapshot.Counts `json:"counts"`

	// Sources carries each contributing list with its own thresholds, so a client
	// showing a per-list filter can say how fresh that list is rather than only
	// how fresh the snapshot's slowest list is.
	Sources []metaSource `json:"sources"`

	// ScanAge is the snapshot-wide threshold pair, governed by the slowest
	// cadence among the sources.
	ScanAge snapshot.ScanAgeInput `json:"scan_age"`

	Advisory string `json:"advisory"`
}

// metaSource is one contributing word list.
type metaSource struct {
	ID      string           `json:"id"`
	Path    string           `json:"path"`
	Cadence snapshot.Cadence `json:"cadence"`
	Names   int              `json:"names"`
	// ScanAge is this list's own cadence expressed as thresholds. Every source in
	// one snapshot shares the scan time, because a carried-forward result is
	// re-derived at the fresh scan's instant rather than copied, so the sources
	// differ in how long that shared scan time may stand and not in what it is.
	ScanAge snapshot.ScanAgeInput `json:"scan_age"`
}

// encodeMeta builds and serializes the summary document.
//
// It reads the summary from the verified snapshot's own metadata rather than from
// the pointer. Verify has already proved the two agree field for field, so either
// would do, and taking the payload's copy keeps the pointer's role to naming the
// snapshot and describing its bytes.
func encodeMeta(metadata snapshot.Metadata, latest snapshot.Latest) ([]byte, error) {
	sources := make([]metaSource, 0, len(metadata.Sources))
	for _, source := range metadata.Sources {
		// A validated pointer and a validated snapshot both reject an unknown
		// cadence, so this cannot fail here. It is still checked rather than
		// discarded, because a summary with a silently zeroed threshold would tell
		// a client a fresh snapshot is stale.
		scanAge, err := snapshot.DeriveScanAgeInput([]snapshot.SourceList{source})
		if err != nil {
			return nil, err
		}
		sources = append(sources, metaSource{
			ID:      source.ID,
			Path:    source.Path,
			Cadence: source.Cadence,
			Names:   source.Names,
			ScanAge: scanAge,
		})
	}

	return json.Marshal(metaDocument{
		FormatVersion: metadata.FormatVersion,
		SnapshotID:    metadata.SnapshotID,
		ScannedAt:     metadata.ScannedAt.UTC(),
		Checksum:      latest.Checksum,
		RawBytes:      latest.RawBytes,
		Names:         metadata.Names,
		Counts:        metadata.Counts,
		Sources:       sources,
		ScanAge:       metadata.ScanAge,
		Advisory:      Advisory,
	})
}

// healthDocument reports whether a complete snapshot is being served, and how old
// it is now.
//
// This is the one place a resolved age and a stale flag appear, and it is the one
// response that is never cacheable. A client that wants to judge staleness itself
// uses the thresholds on PathMeta; this exists so an operator and a monitor can
// read one answer without reproducing the arithmetic.
type healthDocument struct {
	Status      string    `json:"status"`
	SnapshotID  string    `json:"snapshot_id"`
	ScannedAt   time.Time `json:"scanned_at"`
	PublishedAt time.Time `json:"published_at"`
	// CheckedAt is the instant the ages below were resolved against, so a reader
	// can tell an old answer from a fresh one.
	CheckedAt time.Time      `json:"checked_at"`
	ScanAge   healthScanAge  `json:"scan_age"`
	Sources   []healthSource `json:"sources"`
	Names     int            `json:"names"`
	Advisory  string         `json:"advisory"`
}

// statusOK is the only status a healthDocument carries. A run that cannot serve a
// snapshot answers with a failure code instead, so there is no degraded state to
// name here.
const statusOK = "ok"

// healthScanAge is one resolved staleness reading. It repeats the thresholds
// alongside the age so a reader never has to fetch PathMeta to interpret it.
type healthScanAge struct {
	AgeSeconds        int64 `json:"age_seconds"`
	ExpectedSeconds   int64 `json:"expected_interval_seconds"`
	StaleAfterSeconds int64 `json:"stale_after_seconds"`
	Stale             bool  `json:"stale"`
}

// healthSource is one contributing list's resolved staleness. A snapshot whose
// fast lists are fresh and whose slow list is overdue reports exactly that,
// rather than collapsing to one flag governed by the slowest list.
type healthSource struct {
	ID      string           `json:"id"`
	Cadence snapshot.Cadence `json:"cadence"`
	Names   int              `json:"names"`
	ScanAge healthScanAge    `json:"scan_age"`
}

// resolveScanAge renders a ScanAge for the wire. Seconds are the unit because
// they are what the published thresholds use, so nothing here introduces a second
// precision a client has to reconcile.
func resolveScanAge(input snapshot.ScanAgeInput, scannedAt, now time.Time) healthScanAge {
	age := input.At(scannedAt, now)
	return healthScanAge{
		AgeSeconds:        int64(age.Age / time.Second),
		ExpectedSeconds:   int64(age.Expected / time.Second),
		StaleAfterSeconds: int64(age.StaleAfter / time.Second),
		Stale:             age.Stale,
	}
}

// serveHealth reports on the snapshot that would be served now.
//
// It resolves exactly what PathSnapshot resolves, through the same call and the
// same cache, so a 200 here means a complete checksum-verified snapshot really is
// available and not merely that the process is running. Everything it reports
// comes from the latest pointer, so a healthy answer costs no chunk fetch once
// the snapshot is cached.
//
// A stale but complete snapshot is still a 200. Staleness means the publisher is
// behind, which is a separate alarm from the read path being unable to serve, and
// the response says so in the fields above.
func (h *Handler) serveHealth(w http.ResponseWriter, r *http.Request) {
	cached, failure := h.resolve(r.Context())
	if failure != nil {
		h.writeFailure(w, r, *failure)
		return
	}

	latest := cached.latest
	now := h.config.Now().UTC().Truncate(time.Second)

	sources := make([]healthSource, 0, len(latest.Sources))
	for _, source := range latest.Sources {
		scanAge, err := snapshot.DeriveScanAgeInput([]snapshot.SourceList{source})
		if err != nil {
			// Unreachable for a validated pointer, and reported rather than
			// silently zeroed for the same reason encodeMeta reports it.
			h.writeFailure(w, r, failureUnreadable)
			return
		}
		sources = append(sources, healthSource{
			ID:      source.ID,
			Cadence: source.Cadence,
			Names:   source.Names,
			ScanAge: resolveScanAge(scanAge, latest.ScannedAt, now),
		})
	}

	body, err := json.Marshal(healthDocument{
		Status:      statusOK,
		SnapshotID:  latest.SnapshotID,
		ScannedAt:   latest.ScannedAt.UTC(),
		PublishedAt: latest.PublishedAt.UTC(),
		CheckedAt:   now,
		ScanAge:     resolveScanAge(latest.ScanAge, latest.ScannedAt, now),
		Sources:     sources,
		Names:       latest.Names,
		Advisory:    Advisory,
	})
	if err != nil {
		h.writeFailure(w, r, failureUnreadable)
		return
	}

	header := w.Header()
	// no-store rather than a short max-age: the resolved ages in this body are
	// correct only at CheckedAt, and a monitor that got a cached copy would be
	// reading an answer about a moment that has passed.
	header.Set("Cache-Control", "no-store")
	header.Set("Content-Type", contentTypeJSON)
	header.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		w.Write(body)
	}
}
