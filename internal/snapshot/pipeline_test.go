package snapshot

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"ens-scrape/internal/checker"
	"ens-scrape/internal/ens"
)

// TestScanToSnapshotThroughTheRealClient drives the whole intended path with the
// real ens.Client rather than a fake: an httptest.Server stands in for the
// subgraph, so the label plus ".eth" suffixing inside Client.Lookup actually runs,
// and its output flows through checker.Run into Build and out to a store.
//
// The fakes elsewhere in this package accept whatever name shape a test hands
// them, so only this test proves the contract can ingest what the one real
// producer emits. It never contacts the ENS endpoint.
func TestScanToSnapshotThroughTheRealClient(t *testing.T) {
	// Input labels are bare, which is what names.Normalize hands the checker, and
	// one is upper case because Client.Lookup is what lowercases it.
	labels := []string{"ZAP", "dusk", "orb", "amber"}

	// The subgraph indexes three of them; orb has never been registered.
	indexed := map[string]time.Duration{
		"zap.eth":   200 * 24 * time.Hour,
		"dusk.eth":  -10 * 24 * time.Hour,
		"amber.eth": -200 * 24 * time.Hour,
	}

	// Two workers look names up concurrently and httptest serves each request in
	// its own goroutine, so the recorded names need a lock. Concurrent lookups are
	// part of what this test exercises, so the worker count stays as it is.
	var (
		requestedMutex sync.Mutex
		requested      []string
	)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var payload struct {
			Variables struct {
				Names []string `json:"names"`
			} `json:"variables"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Errorf("decode request: %v", err)
			http.Error(writer, "bad request", http.StatusBadRequest)
			return
		}
		requestedMutex.Lock()
		requested = append(requested, payload.Variables.Names...)
		requestedMutex.Unlock()

		registrations := make([]string, 0, len(payload.Variables.Names))
		for _, name := range payload.Variables.Names {
			offset, ok := indexed[name]
			if !ok {
				continue
			}
			expiry := fixedNow.Add(offset).Unix()
			registrations = append(registrations, fmt.Sprintf(
				`{"expiryDate":"%d","domain":{"name":%q}}`, expiry, name,
			))
		}
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(writer, `{"data":{"registrations":[%s]}}`, joinJSON(registrations))
	}))
	defer server.Close()

	client, err := ens.NewClient(server.URL, server.Client(), 0)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	results, stats, err := checker.Run(context.Background(), client, labels, checker.Options{
		Workers:   2,
		BatchSize: 3,
		Soon:      testSoon,
		Now:       func() time.Time { return fixedNow },
	})
	if err != nil {
		t.Fatalf("checker.Run: %v", err)
	}

	// The client asks the subgraph for fully-qualified names. Batches complete out
	// of order, so compare the sorted set rather than the arrival order.
	requestedMutex.Lock()
	asked := append([]string(nil), requested...)
	requestedMutex.Unlock()
	sort.Strings(asked)

	wantRequested := []string{"amber.eth", "dusk.eth", "orb.eth", "zap.eth"}
	if len(asked) != len(wantRequested) {
		t.Fatalf("the client asked for %v, want %v", asked, wantRequested)
	}
	for i, want := range wantRequested {
		if asked[i] != want {
			t.Fatalf("the client asked for %v, want %v", asked, wantRequested)
		}
	}

	snapshot, err := Build("real-client", stats.ClassifiedAt, testSources(len(results)), results)
	if err != nil {
		t.Fatalf("Build rejected results from the real client: %v", err)
	}

	// The snapshot stores the fully-qualified name, sorted by that name.
	wantStored := []string{"amber.eth", "dusk.eth", "orb.eth", "zap.eth"}
	if len(snapshot.Results) != len(wantStored) {
		t.Fatalf("snapshot holds %d results, want %d", len(snapshot.Results), len(wantStored))
	}
	for i, want := range wantStored {
		if snapshot.Results[i].Name != want {
			t.Errorf("result %d is %q, want %q", i, snapshot.Results[i].Name, want)
		}
	}

	wantStatus := map[string]ens.Status{
		"zap.eth":   ens.StatusRegistered,
		"dusk.eth":  ens.StatusGracePeriod,
		"amber.eth": ens.StatusAvailable,
		"orb.eth":   ens.StatusAvailable,
	}
	for _, result := range snapshot.Results {
		if got := result.Status; got != wantStatus[result.Name] {
			t.Errorf("%s is %q, want %q", result.Name, got, wantStatus[result.Name])
		}
	}

	// The same results publish and read back through the store interfaces.
	ctx := context.Background()
	for name, store := range newStores(t) {
		t.Run(name, func(t *testing.T) {
			if _, err := Publish(ctx, store, snapshot, stats.ClassifiedAt.Add(time.Minute)); err != nil {
				t.Fatalf("Publish: %v", err)
			}
			readSnapshot, _, err := Read(ctx, store)
			if err != nil {
				t.Fatalf("Read: %v", err)
			}
			for i, want := range wantStored {
				if readSnapshot.Results[i].Name != want {
					t.Errorf("read result %d is %q, want %q", i, readSnapshot.Results[i].Name, want)
				}
			}
		})
	}
}

func joinJSON(items []string) string {
	out := ""
	for i, item := range items {
		if i > 0 {
			out += ","
		}
		out += item
	}
	return out
}
