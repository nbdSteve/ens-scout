package snapshot

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"

	"ens-scrape/internal/ens"
)

// update regenerates the committed fixture files instead of comparing against
// them: go test ./internal/snapshot -update.
var update = flag.Bool("update", false, "rewrite the committed snapshot fixtures")

// fixtureRoot is the committed fixture directory, relative to this package.
var fixtureRoot = filepath.Join("..", "..", "data", "fixtures")

func TestFixturesCoverEveryLifecycleStatus(t *testing.T) {
	snapshot, err := Fixture(FixturePreview)
	if err != nil {
		t.Fatalf("Fixture: %v", err)
	}

	for _, status := range ens.Statuses {
		if snapshot.Metadata.Counts[status] < 1 {
			t.Errorf("the preview fixture has no %q result", status)
		}
	}

	var (
		full  int // expiry, grace end, and premium end all present
		empty int // no timestamps at all
	)
	for _, result := range snapshot.Results {
		switch {
		case result.Expiry != nil && result.GraceEnds != nil && result.PremiumEnds != nil:
			full++
		case result.Expiry == nil && result.GraceEnds == nil && result.PremiumEnds == nil:
			empty++
		}
	}
	if full == 0 {
		t.Error("no fixture result carries the complete set of lifecycle timestamps")
	}
	if empty == 0 {
		t.Error("no fixture result omits every lifecycle timestamp")
	}
}

func TestFixtureStalenessIsVisible(t *testing.T) {
	tests := []struct {
		name      string
		fixture   string
		now       time.Time
		wantStale bool
	}{
		{name: "preview is fresh", fixture: FixturePreview, now: FixtureScannedAt.Add(time.Hour)},
		{name: "stale trips the threshold", fixture: FixtureStale, now: FixtureScannedAt, wantStale: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			snapshot, err := Fixture(test.fixture)
			if err != nil {
				t.Fatalf("Fixture: %v", err)
			}
			latest, err := FixtureLatest(test.fixture)
			if err != nil {
				t.Fatalf("FixtureLatest: %v", err)
			}

			age := snapshot.Metadata.ResolveScanAge(test.now)
			if age.Stale != test.wantStale {
				t.Errorf("snapshot stale is %t at %s (age %s, threshold %s), want %t", age.Stale, test.now, age.Age, age.StaleAfter, test.wantStale)
			}
			// The pointer carries the same thresholds, so a client that only
			// reads the pointer reaches the same conclusion.
			if pointerAge := latest.ResolveScanAge(test.now); pointerAge != age {
				t.Errorf("pointer reports %+v, want %+v", pointerAge, age)
			}
			if !latest.PublishedAt.After(latest.ScannedAt) {
				t.Errorf("publication time %s does not follow the scan time %s", latest.PublishedAt, latest.ScannedAt)
			}
		})
	}
}

func TestFixturesPublishAndRead(t *testing.T) {
	ctx := context.Background()
	for _, name := range FixtureNames() {
		t.Run(name, func(t *testing.T) {
			snapshot, err := Fixture(name)
			if err != nil {
				t.Fatalf("Fixture: %v", err)
			}
			want, err := FixtureLatest(name)
			if err != nil {
				t.Fatalf("FixtureLatest: %v", err)
			}

			store := NewFileStore(t.TempDir())
			got, err := Publish(ctx, store, snapshot, want.PublishedAt)
			if err != nil {
				t.Fatalf("Publish: %v", err)
			}
			if !bytes.Equal(mustMarshal(t, got), mustMarshal(t, want)) {
				t.Fatalf("published pointer differs from FixtureLatest")
			}

			readSnapshot, _, err := Read(ctx, store)
			if err != nil {
				t.Fatalf("Read: %v", err)
			}
			if readSnapshot.Metadata.SnapshotID != snapshot.Metadata.SnapshotID {
				t.Fatalf("read snapshot %q, want %q", readSnapshot.Metadata.SnapshotID, snapshot.Metadata.SnapshotID)
			}
		})
	}
}

func TestFixtureNamesAreDistinct(t *testing.T) {
	seen := make(map[string]struct{})
	for _, name := range FixtureNames() {
		snapshot, err := Fixture(name)
		if err != nil {
			t.Fatalf("Fixture %q: %v", name, err)
		}
		if _, exists := seen[snapshot.Metadata.SnapshotID]; exists {
			t.Fatalf("fixture %q reuses snapshot id %q", name, snapshot.Metadata.SnapshotID)
		}
		seen[snapshot.Metadata.SnapshotID] = struct{}{}
	}
	if _, err := Fixture("does-not-exist"); err == nil {
		t.Error("Fixture accepted an unknown name")
	}
	if _, err := FixtureLatest("does-not-exist"); err == nil {
		t.Error("FixtureLatest accepted an unknown name")
	}
}

// TestCommittedFixturesAreCurrent compares the committed fixture files with what
// this package produces today. It is the guard that the serialization really is
// byte-stable: a change in field order, timestamp formatting, or classification
// shows up here as a diff rather than as a surprise in the browser.
func TestCommittedFixturesAreCurrent(t *testing.T) {
	for _, name := range FixtureNames() {
		t.Run(name, func(t *testing.T) {
			snapshot, err := Fixture(name)
			if err != nil {
				t.Fatalf("Fixture: %v", err)
			}
			raw, err := EncodeJSON(snapshot)
			if err != nil {
				t.Fatalf("EncodeJSON: %v", err)
			}
			latest, err := FixtureLatest(name)
			if err != nil {
				t.Fatalf("FixtureLatest: %v", err)
			}

			assertGolden(t, filepath.Join(fixtureRoot, name, "snapshot.json"), raw)
			assertGolden(t, filepath.Join(fixtureRoot, name, "latest.json"), mustMarshal(t, latest))
		})
	}
}

func mustMarshal(t *testing.T, value interface{}) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return encoded
}

// assertGolden compares content with a committed file, or rewrites the file when
// -update is set. Committed files end with a newline so they stay diff friendly.
func assertGolden(t *testing.T, path string, content []byte) {
	t.Helper()
	want := append(append([]byte(nil), content...), '\n')

	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("create fixture directory: %v", err)
		}
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatalf("write fixture %s: %v", path, err)
		}
		t.Logf("updated %s", path)
		return
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v (run go test ./internal/snapshot -update)", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("fixture %s is out of date; run go test ./internal/snapshot -update", path)
	}
}
