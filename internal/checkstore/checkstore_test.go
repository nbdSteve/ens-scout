package checkstore_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"ens-scrape/internal/checkstore"
	"ens-scrape/internal/snapshot"
)

func minute(n int) time.Time {
	return time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC).Add(time.Duration(n) * time.Minute)
}

func TestWindowStartIsDerivedFromTheClock(t *testing.T) {
	window := checkstore.Window{Limit: 10, Period: time.Minute}

	// Two instants inside one minute derive one window, and the next minute derives a
	// different one. This is what makes a cold instance and a warm instance agree: the
	// window comes from the clock, not from when a key was first seen.
	first := window.Start(time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC))
	same := window.Start(time.Date(2026, 4, 1, 12, 0, 59, 999_000_000, time.UTC))
	next := window.Start(time.Date(2026, 4, 1, 12, 1, 0, 0, time.UTC))

	if !first.Equal(same) {
		t.Fatalf("two instants in one window derived %s and %s", first, same)
	}
	if !next.After(first) {
		t.Fatalf("the next window %s does not follow %s", next, first)
	}
	if got := window.End(first); !got.Equal(next) {
		t.Fatalf("End = %s, want %s", got, next)
	}
}

func TestWindowStartIsUTCWhateverTheClocksZone(t *testing.T) {
	window := checkstore.Window{Limit: 5, Period: time.Hour}
	zone := time.FixedZone("shifted", 5*3600+1800)

	local := window.Start(time.Date(2026, 4, 1, 17, 30, 0, 0, zone))
	utc := window.Start(time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC))

	// A backend derives the sort key from this, so an instance whose clock reports a
	// different zone must still land in the same window as every other one.
	if !local.Equal(utc) {
		t.Fatalf("a zoned clock derived %s, a UTC clock derived %s", local, utc)
	}
	if local.Location() != time.UTC {
		t.Fatalf("Start returned %s, want a UTC instant", local.Location())
	}
}

func TestWindowValidateRefusesWhatWouldNotBound(t *testing.T) {
	for _, test := range []struct {
		name   string
		window checkstore.Window
	}{
		{"no limit", checkstore.Window{Limit: 0, Period: time.Minute}},
		{"negative limit", checkstore.Window{Limit: -1, Period: time.Minute}},
		{"no period", checkstore.Window{Limit: 5, Period: 0}},
		{"negative period", checkstore.Window{Limit: 5, Period: -time.Minute}},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			if err := test.window.Validate(); err == nil {
				t.Fatal("Validate accepted a window that bounds nothing")
			}
		})
	}
	if err := (checkstore.Window{Limit: 1, Period: time.Second}).Validate(); err != nil {
		t.Fatalf("Validate refused a usable window: %v", err)
	}
}

func TestValidateChargeRefusesAFreeOrImpossibleCharge(t *testing.T) {
	window := checkstore.Window{Limit: 4, Period: time.Minute}
	for _, test := range []struct {
		name string
		kind checkstore.Kind
		key  string
		cost int64
	}{
		{"unknown kind", checkstore.Kind("elsewhere"), "k", 1},
		{"empty key", checkstore.KindClient, "", 1},
		{"blank key", checkstore.KindClient, "   ", 1},
		{"free charge", checkstore.KindClient, "k", 0},
		{"negative charge", checkstore.KindClient, "k", -2},
		{"larger than the window", checkstore.KindClient, "k", 5},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			if err := checkstore.ValidateCharge(test.kind, test.key, test.cost, window); err == nil {
				t.Fatal("ValidateCharge accepted a charge no backend should apply")
			}
		})
	}
}

func TestKeyLayoutDoesNotOverlapTheSnapshotLayout(t *testing.T) {
	// The check items share a table with the snapshot, and the snapshot side reads its
	// pointer by exact key and runs exactly one query, over META for STAGING#. A check
	// partition that collided with either would be returned by a read that has no idea
	// what it is looking at.
	partitions := []string{
		checkstore.RatePartition(checkstore.KindClient, "abc"),
		checkstore.RatePartition(checkstore.KindUpstream, checkstore.UpstreamKey),
		checkstore.ResultPartition("digest"),
	}
	for _, partition := range partitions {
		if partition == snapshot.LatestPartition {
			t.Fatalf("%q is the snapshot pointer partition", partition)
		}
		if strings.HasPrefix(partition, snapshot.SnapshotPartition("")) {
			t.Fatalf("%q is inside the snapshot chunk partitions", partition)
		}
		if !checkstore.IsCheckPartition(partition) {
			t.Fatalf("IsCheckPartition(%q) = false", partition)
		}
	}
	for _, partition := range []string{
		snapshot.LatestPartition,
		snapshot.SnapshotPartition("snap-1"),
	} {
		if checkstore.IsCheckPartition(partition) {
			t.Fatalf("IsCheckPartition(%q) = true for a snapshot partition", partition)
		}
	}

	// The two kinds cannot collide with each other either, even given one key.
	client := checkstore.RatePartition(checkstore.KindClient, "same")
	upstream := checkstore.RatePartition(checkstore.KindUpstream, "same")
	if client == upstream {
		t.Fatalf("both kinds share the partition %q", client)
	}
}

func TestWindowSortOrdersByTime(t *testing.T) {
	window := checkstore.Window{Limit: 1, Period: time.Minute}
	earlier := checkstore.WindowSort(window.Start(minute(0)))
	later := checkstore.WindowSort(window.Start(minute(1)))
	if !(earlier < later) {
		t.Fatalf("sort keys %q and %q are not in time order", earlier, later)
	}
}

func TestMemoryStoreChargesUpToTheLimitAndThenRefuses(t *testing.T) {
	store := checkstore.NewMemoryStore()
	window := checkstore.Window{Limit: 3, Period: time.Minute}
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, minute(0), window)
		if err != nil {
			t.Fatalf("charge %d: %v", i, err)
		}
		if !charge.OK {
			t.Fatalf("charge %d was refused inside the limit", i)
		}
	}

	charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, minute(0), window)
	if err != nil {
		t.Fatalf("the refused charge returned an error: %v", err)
	}
	if charge.OK {
		t.Fatal("a fourth charge was accepted against a limit of three")
	}
	if want := minute(1); !charge.RetryAt.Equal(want) {
		t.Fatalf("RetryAt = %s, want the window end %s", charge.RetryAt, want)
	}
	if spent := store.Spent(checkstore.KindClient, "peer", minute(0), window); spent != 3 {
		t.Fatalf("the refused charge changed the total to %d, want 3", spent)
	}
}

func TestMemoryStoreChargesTheWholeCostOrNothing(t *testing.T) {
	store := checkstore.NewMemoryStore()
	window := checkstore.Window{Limit: 10, Period: time.Minute}
	ctx := context.Background()

	if _, err := store.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 7, minute(0), window); err != nil {
		t.Fatalf("first charge: %v", err)
	}
	// A request costing four batches must not be part-charged into the three that are
	// left: it is refused whole, so nothing is spent on work that will not happen.
	charge, err := store.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 4, minute(0), window)
	if err != nil {
		t.Fatalf("second charge: %v", err)
	}
	if charge.OK {
		t.Fatal("a charge of 4 was accepted with 3 left")
	}
	if spent := store.Spent(checkstore.KindUpstream, checkstore.UpstreamKey, minute(0), window); spent != 7 {
		t.Fatalf("spent = %d, want 7 after a refusal", spent)
	}
	if charge, err := store.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 3, minute(0), window); err != nil || !charge.OK {
		t.Fatalf("a charge of exactly the remainder was refused: charge=%+v err=%v", charge, err)
	}
}

func TestMemoryStoreKeepsKeysApart(t *testing.T) {
	store := checkstore.NewMemoryStore()
	window := checkstore.Window{Limit: 1, Period: time.Minute}
	ctx := context.Background()

	if charge, err := store.Charge(ctx, checkstore.KindClient, "first", 1, minute(0), window); err != nil || !charge.OK {
		t.Fatalf("first client: charge=%+v err=%v", charge, err)
	}
	// One client spending its allowance must not spend another's, and must not spend
	// the upstream budget either.
	if charge, err := store.Charge(ctx, checkstore.KindClient, "second", 1, minute(0), window); err != nil || !charge.OK {
		t.Fatalf("second client: charge=%+v err=%v", charge, err)
	}
	if charge, err := store.Charge(ctx, checkstore.KindUpstream, "first", 1, minute(0), window); err != nil || !charge.OK {
		t.Fatalf("upstream: charge=%+v err=%v", charge, err)
	}
	if charge, err := store.Charge(ctx, checkstore.KindClient, "first", 1, minute(0), window); err != nil || charge.OK {
		t.Fatalf("the first client was charged twice against a limit of one: charge=%+v err=%v", charge, err)
	}
}

func TestMemoryStoreWindowRollsOver(t *testing.T) {
	store := checkstore.NewMemoryStore()
	window := checkstore.Window{Limit: 2, Period: time.Minute}
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		if charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, minute(0), window); err != nil || !charge.OK {
			t.Fatalf("charge %d: charge=%+v err=%v", i, charge, err)
		}
	}
	if charge, _ := store.Charge(ctx, checkstore.KindClient, "peer", 1, minute(0), window); charge.OK {
		t.Fatal("the window did not refuse a third charge")
	}
	// The next window is a different key, so the allowance is available again without
	// anything having to sweep, sleep, or refill.
	if charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, minute(1), window); err != nil || !charge.OK {
		t.Fatalf("the next window refused a charge: charge=%+v err=%v", charge, err)
	}
	if spent := store.Spent(checkstore.KindClient, "peer", minute(1), window); spent != 1 {
		t.Fatalf("the new window holds %d, want 1", spent)
	}
}

func TestMemoryStoreBoundaryBurstIsBoundedAtTwiceTheLimit(t *testing.T) {
	store := checkstore.NewMemoryStore()
	window := checkstore.Window{Limit: 2, Period: time.Minute}
	ctx := context.Background()

	// This is the documented cost of a fixed window rather than a bug: a caller at the
	// very end of one window and the very start of the next gets 2*Limit in quick
	// succession. The test pins the bound so it stays 2x and cannot quietly become 3x.
	accepted := 0
	for _, at := range []time.Time{
		minute(1).Add(-time.Millisecond),
		minute(1).Add(-time.Millisecond),
		minute(1).Add(-time.Millisecond),
		minute(1),
		minute(1),
		minute(1),
	} {
		if charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, at, window); err != nil {
			t.Fatalf("charge at %s: %v", at, err)
		} else if charge.OK {
			accepted++
		}
	}
	if accepted != 4 {
		t.Fatalf("the boundary allowed %d charges, want exactly 2*Limit = 4", accepted)
	}
}

func TestMemoryStoreIsAtomicUnderContention(t *testing.T) {
	store := checkstore.NewMemoryStore()
	window := checkstore.Window{Limit: 50, Period: time.Hour}
	ctx := context.Background()

	// Two hundred concurrent charges against one key stand in for two hundred requests
	// arriving at however many instances at once. Exactly the limit may be accepted: a
	// read-then-write limiter would let several of them see the same headroom.
	const attempts = 200
	var (
		wait     sync.WaitGroup
		mutex    sync.Mutex
		accepted int
	)
	for i := 0; i < attempts; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			charge, err := store.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 1, minute(0), window)
			if err != nil {
				t.Errorf("concurrent charge: %v", err)
				return
			}
			if charge.OK {
				mutex.Lock()
				accepted++
				mutex.Unlock()
			}
		}()
	}
	wait.Wait()

	if accepted != 50 {
		t.Fatalf("%d of %d concurrent charges were accepted, want exactly the limit of 50", accepted, attempts)
	}
	if spent := store.Spent(checkstore.KindUpstream, checkstore.UpstreamKey, minute(0), window); spent != 50 {
		t.Fatalf("the stored total is %d, want 50", spent)
	}
}

func TestMemoryStoreCacheRoundTripsAndExpires(t *testing.T) {
	store := checkstore.NewMemoryStore()
	ctx := context.Background()
	body := []byte(`{"checked_at":"2026-04-01T12:00:00Z"}`)

	if err := store.Store(ctx, "digest", checkstore.Entry{Body: body, ExpiresAt: minute(1)}); err != nil {
		t.Fatalf("Store: %v", err)
	}

	entry, hit, err := store.Load(ctx, "digest", minute(0))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !hit {
		t.Fatal("a stored entry did not read back")
	}
	if string(entry.Body) != string(body) {
		t.Fatalf("Load returned %q, want the stored bytes %q", entry.Body, body)
	}

	// The bytes are returned rather than re-rendered, so the instant in them is the
	// instant the index was really read at. A copy is handed out, so a caller cannot
	// reach back into the store.
	entry.Body[0] = 'X'
	again, hit, err := store.Load(ctx, "digest", minute(0))
	if err != nil || !hit {
		t.Fatalf("second Load: hit=%v err=%v", hit, err)
	}
	if string(again.Body) != string(body) {
		t.Fatalf("a caller mutating its copy changed the store to %q", again.Body)
	}

	// At the expiry it is a miss, not a stale hit.
	if _, hit, err := store.Load(ctx, "digest", minute(1)); err != nil || hit {
		t.Fatalf("an entry at its expiry was a hit: hit=%v err=%v", hit, err)
	}
	if _, entries := store.Items(); entries != 0 {
		t.Fatalf("%d entries are still held after expiry, want 0", entries)
	}
}

func TestMemoryStoreCacheOverwritesTheSameKey(t *testing.T) {
	store := checkstore.NewMemoryStore()
	ctx := context.Background()

	if err := store.Store(ctx, "digest", checkstore.Entry{Body: []byte("first"), ExpiresAt: minute(1)}); err != nil {
		t.Fatalf("first Store: %v", err)
	}
	// Two instances that both missed and both went upstream produce two honest
	// answers, so a second write is accepted rather than refused.
	if err := store.Store(ctx, "digest", checkstore.Entry{Body: []byte("second"), ExpiresAt: minute(2)}); err != nil {
		t.Fatalf("second Store: %v", err)
	}
	entry, hit, err := store.Load(ctx, "digest", minute(0))
	if err != nil || !hit {
		t.Fatalf("Load: hit=%v err=%v", hit, err)
	}
	if string(entry.Body) != "second" {
		t.Fatalf("Load returned %q, want the later write", entry.Body)
	}
}

func TestMemoryStoreCacheRefusesAnUnusableEntry(t *testing.T) {
	store := checkstore.NewMemoryStore()
	ctx := context.Background()

	if err := store.Store(ctx, "digest", checkstore.Entry{ExpiresAt: minute(1)}); err == nil {
		t.Fatal("Store accepted an entry with no body")
	}
	if err := store.Store(ctx, "digest", checkstore.Entry{Body: []byte("x")}); err == nil {
		t.Fatal("Store accepted an entry with no expiry")
	}
	if err := store.Store(ctx, "  ", checkstore.Entry{Body: []byte("x"), ExpiresAt: minute(1)}); err == nil {
		t.Fatal("Store accepted a blank key")
	}
	if _, _, err := store.Load(ctx, "", minute(0)); err == nil {
		t.Fatal("Load accepted an empty key")
	}
}

// MemoryStore is the local Store, so the compiler holds it to both halves of the
// interface a backend has to satisfy.
var _ checkstore.Store = (*checkstore.MemoryStore)(nil)

func TestMemoryStoreCacheMissesAnAbsentKey(t *testing.T) {
	var store checkstore.Store = checkstore.NewMemoryStore()
	if _, hit, err := store.Load(context.Background(), "absent", minute(0)); err != nil || hit {
		t.Fatalf("an absent key: hit=%v err=%v", hit, err)
	}
}

func TestMemoryStoreFailuresAreErrorsAndNotDecisions(t *testing.T) {
	store := checkstore.NewMemoryStore()
	window := checkstore.Window{Limit: 5, Period: time.Minute}
	ctx := context.Background()
	boom := errors.New("throttled")

	store.FailCharges(1, boom)
	charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, minute(0), window)
	if !errors.Is(err, boom) {
		t.Fatalf("Charge returned %v, want the injected failure", err)
	}
	if charge.OK {
		t.Fatal("a failed charge reported OK")
	}
	if spent := store.Spent(checkstore.KindClient, "peer", minute(0), window); spent != 0 {
		t.Fatalf("a failed charge recorded %d", spent)
	}

	store.FailCache(1, boom)
	if _, hit, err := store.Load(ctx, "digest", minute(0)); !errors.Is(err, boom) || hit {
		t.Fatalf("Load returned hit=%v err=%v, want the injected failure and no hit", hit, err)
	}

	store.Close()
	if _, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, minute(0), window); !errors.Is(err, checkstore.ErrClosed) {
		t.Fatalf("a closed store returned %v, want ErrClosed", err)
	}
	if _, _, err := store.Load(ctx, "digest", minute(0)); !errors.Is(err, checkstore.ErrClosed) {
		t.Fatalf("a closed store returned %v from Load", err)
	}
	if err := store.Store(ctx, "digest", checkstore.Entry{Body: []byte("x"), ExpiresAt: minute(1)}); !errors.Is(err, checkstore.ErrClosed) {
		t.Fatalf("a closed store returned %v from Store", err)
	}
}

func TestMemoryStoreCancelledContextIsNotEvidence(t *testing.T) {
	store := checkstore.NewMemoryStore()
	window := checkstore.Window{Limit: 5, Period: time.Minute}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, minute(0), window); !errors.Is(err, context.Canceled) {
		t.Fatalf("Charge returned %v, want context.Canceled", err)
	}
	if _, _, err := store.Load(ctx, "digest", minute(0)); !errors.Is(err, context.Canceled) {
		t.Fatalf("Load returned %v, want context.Canceled", err)
	}
	if err := store.Store(ctx, "digest", checkstore.Entry{Body: []byte("x"), ExpiresAt: minute(1)}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Store returned %v, want context.Canceled", err)
	}
	// A cancelled charge must not have been applied either: it is neither an
	// acceptance nor a refusal.
	if spent := store.Spent(checkstore.KindClient, "peer", minute(0), window); spent != 0 {
		t.Fatalf("a cancelled charge recorded %d", spent)
	}
}
