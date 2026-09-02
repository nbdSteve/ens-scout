package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ens-scrape/internal/ens"
	"ens-scrape/internal/scanner"
	"ens-scrape/internal/snapshot"
)

// The tests here cover only what this file adds: response shaping and the
// redaction of the error the Lambda runtime logs. Everything the run does is
// covered in internal/scanner. Nothing here contacts the Graph, AWS, or the
// network.

// fakeClient answers every label as unregistered.
type fakeClient struct {
	err error
}

func (c *fakeClient) Lookup(_ context.Context, labels []string) ([]ens.Lookup, error) {
	if c.err != nil {
		return nil, c.err
	}
	lookups := make([]ens.Lookup, 0, len(labels))
	for _, label := range labels {
		lookups = append(lookups, ens.Lookup{Name: label + ".eth"})
	}
	return lookups, nil
}

// fakeStore is a memory store with the TTL call the scanner needs. The memory store
// carries the staging registry itself. Expiry is a no-op because no test here
// supersedes or abandons a snapshot.
type fakeStore struct {
	*snapshot.MemoryStore
}

func (s fakeStore) ExpireChunks(_ context.Context, _ string, _ time.Time) error { return nil }

// testAPIKey is invented here and is not a credential. Every assertion about it is
// that it is absent from what the handler returns.
const testAPIKey = "test-graph-key-0123456789abcdef"

func testDependencies(t *testing.T, client *fakeClient) scanner.Dependencies {
	t.Helper()
	dir := t.TempDir()
	for _, spec := range scanner.Lists {
		name := filepath.Base(spec.Path)
		labels := "zap\norb\nelm\n"
		if spec.Group == scanner.GroupLong {
			labels = "amber\nstone\n"
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(labels), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return scanner.Dependencies{
		Config: scanner.Config{
			Table:                "snapshots",
			Endpoint:             "https://subgraph.test/graphql/" + testAPIKey,
			APIKey:               testAPIKey,
			WordListDir:          dir,
			Workers:              2,
			BatchSize:            2,
			Retries:              0,
			RequestTimeout:       time.Second,
			ScanBudget:           time.Minute,
			PreviousReadAttempts: 1,
		},
		Store:  fakeStore{MemoryStore: snapshot.NewMemoryStore()},
		Client: client,
		Logger: scanner.NewLogger(nil, nil),
	}
}

func TestHandlerReportsCountsAndNoCandidateNames(t *testing.T) {
	deps := testDependencies(t, &fakeClient{})

	got, err := handler(deps)(context.Background(), scanner.Event{Group: scanner.GroupShort})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}

	if got.Group != scanner.GroupShort {
		t.Errorf("group = %q, want %q", got.Group, scanner.GroupShort)
	}
	if got.SnapshotID == "" {
		t.Error("snapshot id is empty")
	}
	// The short group owns the three-letter and four-letter lists, and a bootstrap
	// run has nothing to carry forward.
	if got.Names != 3 || got.Scanned != 3 || got.Carried != 0 {
		t.Errorf("names/scanned/carried = %d/%d/%d, want 3/3/0", got.Names, got.Scanned, got.Carried)
	}
	if got.Chunks < 1 {
		t.Errorf("chunks = %d, want at least 1", got.Chunks)
	}
	if _, err := time.Parse(time.RFC3339, got.ScannedAt); err != nil {
		t.Errorf("scanned_at %q is not RFC3339: %v", got.ScannedAt, err)
	}
	if got.Superseded != "" {
		t.Errorf("superseded = %q, want empty on a bootstrap run", got.Superseded)
	}

	// A response is logged wherever the invocation result is recorded, so it must
	// carry no candidate name and no endpoint.
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	for _, forbidden := range []string{"zap", ".eth", "subgraph.test", "https://"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Errorf("response %s contains %q", encoded, forbidden)
		}
	}
}

func TestHandlerRedactsTheErrorItReturns(t *testing.T) {
	// The Lambda runtime writes the returned error to the log group itself. The Graph
	// gateway carries the API key in its path, and the client quotes a slice of
	// whatever the gateway sent back, which can hold the key with no URL around it.
	deps := testDependencies(t, &fakeClient{
		err: errors.New("post https://gateway.thegraph.com/api/secret-key/subgraphs/id/abc: " +
			`zap.eth failed: {"message":"invalid api key ` + testAPIKey + `"}`),
	})

	got, err := handler(deps)(context.Background(), scanner.Event{Group: scanner.GroupShort})
	if err == nil {
		t.Fatal("handler succeeded, want an error")
	}
	if got != (response{}) {
		t.Errorf("response = %+v, want the zero value on failure", got)
	}
	message := err.Error()
	for _, forbidden := range []string{"secret-key", "gateway.thegraph.com", "https://", "zap.eth", testAPIKey} {
		if strings.Contains(message, forbidden) {
			t.Errorf("error %q contains %q", message, forbidden)
		}
	}
	if !strings.Contains(message, "[endpoint]") || !strings.Contains(message, "[name]") {
		t.Errorf("error %q lost its redaction placeholders", message)
	}
}

func TestBuildFailsBeforeItReachesAWS(t *testing.T) {
	// LoadConfig runs first, so a deployment with no endpoint configured fails at
	// cold start without an AWS call. That is also what keeps this test offline, so
	// it only holds when the environment really has no endpoint.
	for _, name := range []string{scanner.EnvSubgraphURL, scanner.EnvAPIKey} {
		if os.Getenv(name) != "" {
			t.Skipf("%s is set in this environment", name)
		}
	}
	if _, err := build(context.Background(), scanner.NewLogger(nil, nil)); err == nil {
		t.Fatal("build succeeded with no configuration, want an error")
	}
}
