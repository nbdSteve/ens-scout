package ens

import (
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	soon := 7 * 24 * time.Hour

	tests := []struct {
		name   string
		lookup Lookup
		want   Status
	}{
		{name: "not indexed", lookup: Lookup{Name: "free.eth"}, want: StatusAvailable},
		{name: "missing expiry", lookup: Lookup{Name: "odd.eth", Found: true}, want: StatusUnknown},
		{name: "registered", lookup: foundAt("held.eth", now.Add(8*24*time.Hour)), want: StatusRegistered},
		{name: "expiring at boundary", lookup: foundAt("soon.eth", now.Add(soon)), want: StatusExpiringSoon},
		{name: "in grace", lookup: foundAt("grace.eth", now.Add(-24*time.Hour)), want: StatusGracePeriod},
		{name: "grace ending soon", lookup: foundAt("grace-soon.eth", now.Add(-84*24*time.Hour)), want: StatusGraceEndingSoon},
		{name: "premium starts at grace boundary", lookup: foundAt("premium.eth", now.Add(-GracePeriod)), want: StatusPremium},
		{name: "premium", lookup: foundAt("premium.eth", now.Add(-100*24*time.Hour)), want: StatusPremium},
		{name: "standard price", lookup: foundAt("free-again.eth", now.Add(-112*24*time.Hour)), want: StatusAvailable},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := Classify(test.lookup, now, soon)
			if result.Status != test.want {
				t.Fatalf("status = %q, want %q", result.Status, test.want)
			}
		})
	}
}

func foundAt(name string, expiry time.Time) Lookup {
	expiry = expiry.UTC()
	return Lookup{Name: name, Found: true, Expiry: &expiry}
}
