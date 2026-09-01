package checker

import (
	"context"
	"sync"
	"testing"
	"time"

	"ens-scrape/internal/ens"
)

type fakeClient struct {
	mu      sync.Mutex
	batches [][]string
	expiry  map[string]time.Time
}

func (client *fakeClient) Lookup(_ context.Context, labels []string) ([]ens.Lookup, error) {
	client.mu.Lock()
	client.batches = append(client.batches, append([]string(nil), labels...))
	client.mu.Unlock()

	lookups := make([]ens.Lookup, len(labels))
	for i, label := range labels {
		name := label + ".eth"
		lookups[i] = ens.Lookup{Name: name}
		if expiry, ok := client.expiry[name]; ok {
			expiry = expiry.UTC()
			lookups[i].Found = true
			lookups[i].Expiry = &expiry
		}
	}
	return lookups, nil
}

func TestRunBatchesClassifiesAndSorts(t *testing.T) {
	now := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	client := &fakeClient{expiry: map[string]time.Time{
		"held.eth": now.Add(30 * 24 * time.Hour),
		"soon.eth": now.Add(2 * 24 * time.Hour),
	}}

	results, stats, err := Run(
		context.Background(),
		client,
		[]string{"soon", "free", "zeta", "held", "alpha"},
		Options{Workers: 3, BatchSize: 2, Soon: 7 * 24 * time.Hour, Now: func() time.Time { return now }},
	)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if stats.Names != 5 || stats.Batches != 3 {
		t.Fatalf("stats = %+v", stats)
	}
	client.mu.Lock()
	batchCount := len(client.batches)
	client.mu.Unlock()
	if batchCount != 3 {
		t.Fatalf("batch count = %d, want 3", batchCount)
	}
	if len(results) != 5 {
		t.Fatalf("result count = %d, want 5", len(results))
	}
	if results[0].Name != "alpha.eth" || results[4].Name != "zeta.eth" {
		t.Fatalf("results are not sorted: %+v", results)
	}

	statuses := make(map[string]ens.Status)
	for _, result := range results {
		statuses[result.Name] = result.Status
	}
	if statuses["held.eth"] != ens.StatusRegistered {
		t.Errorf("held status = %q", statuses["held.eth"])
	}
	if statuses["soon.eth"] != ens.StatusExpiringSoon {
		t.Errorf("soon status = %q", statuses["soon.eth"])
	}
	if statuses["free.eth"] != ens.StatusAvailable {
		t.Errorf("free status = %q", statuses["free.eth"])
	}
	if !stats.ClassifiedAt.Equal(now) {
		t.Errorf("ClassifiedAt = %s, want %s", stats.ClassifiedAt, now)
	}
}

// TestRunReportsOneClassificationInstant proves Run samples the clock exactly once
// and reports that instant, which is what a publisher must pass to snapshot.Build
// as the scan time.
func TestRunReportsOneClassificationInstant(t *testing.T) {
	first := time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name  string
		names []string
	}{
		{name: "with names", names: []string{"alpha", "beta", "gamma"}},
		{name: "with no names", names: nil},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// A clock that advances on every call would produce a different
			// instant per batch if Run sampled it more than once.
			calls := 0
			clock := func() time.Time {
				calls++
				return first.Add(time.Duration(calls-1) * time.Hour)
			}

			_, stats, err := Run(context.Background(), &fakeClient{}, test.names, Options{
				Workers:   2,
				BatchSize: 1,
				Soon:      7 * 24 * time.Hour,
				Now:       clock,
			})
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			if calls != 1 {
				t.Fatalf("Run sampled the clock %d times, want 1", calls)
			}
			if !stats.ClassifiedAt.Equal(first) {
				t.Fatalf("ClassifiedAt = %s, want %s", stats.ClassifiedAt, first)
			}
			if stats.ClassifiedAt.Location() != time.UTC {
				t.Fatalf("ClassifiedAt is in %s, want UTC", stats.ClassifiedAt.Location())
			}
		})
	}
}

// TestRunLeavesTheInstantUnsetWhenItRejectsOptions keeps the documented contract
// honest: a caller must not read ClassifiedAt from a failed run.
func TestRunLeavesTheInstantUnsetWhenItRejectsOptions(t *testing.T) {
	tests := []struct {
		name    string
		client  Client
		options Options
	}{
		{name: "no client", options: Options{Workers: 1, BatchSize: 1}},
		{name: "no workers", client: &fakeClient{}, options: Options{Workers: 0, BatchSize: 1}},
		{name: "bad batch size", client: &fakeClient{}, options: Options{Workers: 1, BatchSize: 0}},
		{name: "negative soon window", client: &fakeClient{}, options: Options{Workers: 1, BatchSize: 1, Soon: -time.Hour}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, stats, err := Run(context.Background(), test.client, []string{"alpha"}, test.options)
			if err == nil {
				t.Fatal("Run accepted invalid options")
			}
			if !stats.ClassifiedAt.IsZero() {
				t.Fatalf("ClassifiedAt = %s, want the zero time", stats.ClassifiedAt)
			}
		})
	}
}
