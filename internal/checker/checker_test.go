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
}
