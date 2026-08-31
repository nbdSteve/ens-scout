// Package ens contains the ENS subgraph client and registration lifecycle model.
package ens

import "time"

const (
	// ENSv1 .eth registrations have a 90-day grace period and a subsequent
	// 21-day temporary premium period.
	GracePeriod   = 90 * 24 * time.Hour
	PremiumPeriod = 21 * 24 * time.Hour
)

// Status describes the current lifecycle state of a .eth registration.
type Status string

const (
	StatusRegistered      Status = "registered"
	StatusExpiringSoon    Status = "expiring-soon"
	StatusGracePeriod     Status = "grace-period"
	StatusGraceEndingSoon Status = "grace-ending-soon"
	StatusPremium         Status = "premium"
	StatusAvailable       Status = "available"
	StatusUnknown         Status = "unknown"
)

// Statuses is the complete ordered set of statuses produced by Classify.
var Statuses = []Status{
	StatusRegistered,
	StatusExpiringSoon,
	StatusGracePeriod,
	StatusGraceEndingSoon,
	StatusPremium,
	StatusAvailable,
	StatusUnknown,
}

// Lookup is the registration data returned by the subgraph for one name.
type Lookup struct {
	Name   string
	Found  bool
	Expiry *time.Time
}

// Result is a lookup enriched with its current lifecycle status.
type Result struct {
	Name        string     `json:"name"`
	Status      Status     `json:"status"`
	Expiry      *time.Time `json:"expiry,omitempty"`
	GraceEnds   *time.Time `json:"grace_ends,omitempty"`
	PremiumEnds *time.Time `json:"premium_ends,omitempty"`
}

// Classify computes the current status of a lookup. The soon window is used
// for active registrations and grace periods that are close to ending.
func Classify(lookup Lookup, now time.Time, soon time.Duration) Result {
	result := Result{
		Name:   lookup.Name,
		Status: StatusUnknown,
		Expiry: lookup.Expiry,
	}

	if !lookup.Found {
		result.Status = StatusAvailable
		return result
	}
	if lookup.Expiry == nil {
		return result
	}

	now = now.UTC()
	expiry := lookup.Expiry.UTC()
	result.Expiry = &expiry

	if expiry.After(now) {
		if !expiry.After(now.Add(soon)) {
			result.Status = StatusExpiringSoon
		} else {
			result.Status = StatusRegistered
		}
		return result
	}

	graceEnds := expiry.Add(GracePeriod)
	premiumEnds := graceEnds.Add(PremiumPeriod)
	result.GraceEnds = &graceEnds
	result.PremiumEnds = &premiumEnds

	if graceEnds.After(now) {
		if !graceEnds.After(now.Add(soon)) {
			result.Status = StatusGraceEndingSoon
		} else {
			result.Status = StatusGracePeriod
		}
		return result
	}

	if premiumEnds.After(now) {
		result.Status = StatusPremium
		return result
	}

	result.Status = StatusAvailable
	return result
}
