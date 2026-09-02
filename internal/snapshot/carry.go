package snapshot

import (
	"fmt"
	"time"

	"ens-scrape/internal/ens"
)

// CarryForward re-derives published results at a new scan time without asking the
// subgraph about them again.
//
// One snapshot holds every source list, but the lists are scanned on different
// cadences, so a run that rescans one cadence group still has to publish the
// other group's names. Rescanning everything on every schedule would multiply the
// Graph query budget by the fastest cadence; publishing only the freshly scanned
// group would make the two schedules erase each other, because there is exactly
// one latest pointer.
//
// What is carried is the subgraph's answer, not the lifecycle label derived from
// it. Registration data changes only when someone registers, renews, or lets a
// name lapse, while the label changes on its own as the expiry, the grace end, and
// the premium end pass. So each carried result is turned back into the ens.Lookup
// it came from and reclassified at the new scan time by ens.Classify, which is
// what keeps a carried name's status honest at the instant it is published and
// keeps this package free of a second classifier.
//
// The trade-off is bounded and already published: a carried name's registration
// data is as old as its own list's cadence, which is exactly what the snapshot's
// ScanAge thresholds describe. A renewal inside that window is not visible until
// that list is rescanned, which is why user-facing output must still tell users to
// confirm with ENS before registering.
//
// soon must be the window the fresh scan used, so a carried name and a freshly
// scanned name with equally near boundaries get the same status.
//
// The results are returned in the order they were given. Build sorts and validates
// them, so a caller concatenates fresh and carried results and hands the whole set
// over without ordering it.
func CarryForward(results []ens.Result, scannedAt time.Time, soon time.Duration) ([]ens.Result, error) {
	if soon < 0 {
		return nil, fmt.Errorf("soon window must not be negative")
	}
	scanTime := canonicalTime(scannedAt)
	carried := make([]ens.Result, 0, len(results))
	for _, result := range results {
		lookup, err := lookupFromResult(result)
		if err != nil {
			return nil, err
		}
		carried = append(carried, ens.Classify(lookup, scanTime, soon))
	}
	return carried, nil
}

// lookupFromResult recovers the subgraph answer a result was classified from.
//
// The mapping is exact because Classify derives everything else from these two
// fields: an unfound name is the only way to reach StatusAvailable with no expiry,
// and a found name with no usable expiry is the only way to reach StatusUnknown.
// Every other status carries an expiry. A pair that Classify could not have
// produced is rejected rather than guessed at, so a hand-edited or foreign result
// cannot be laundered into a snapshot through this path.
func lookupFromResult(result ens.Result) (ens.Lookup, error) {
	lookup := ens.Lookup{Name: result.Name, Expiry: result.Expiry}
	switch {
	case result.Expiry != nil:
		lookup.Found = true
	case result.Status == ens.StatusUnknown:
		// Indexed as a registration, but with an absent or malformed expiry.
		lookup.Found = true
	case result.Status == ens.StatusAvailable:
		lookup.Found = false
	default:
		return ens.Lookup{}, fmt.Errorf("result %q is %q but carries no expiry, so it cannot be carried forward", result.Name, result.Status)
	}
	return lookup, nil
}
