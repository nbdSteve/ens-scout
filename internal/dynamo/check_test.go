package dynamo

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"ens-scrape/internal/checkstore"
	"ens-scrape/internal/snapshot"
)

// checkMinute is a fixed clock, so every window in these tests is derived rather than
// sampled and nothing here waits.
func checkMinute(n int) time.Time {
	return time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC).Add(time.Duration(n) * time.Minute)
}

// newTestCheckStore returns a CheckStore over a fresh fake. There is no sleeper,
// because Charge has no retry loop of its own.
func newTestCheckStore(t *testing.T) (*CheckStore, *fakeDynamo) {
	t.Helper()
	fake := newFake("ens-snapshots")
	store, err := NewCheckStore(fake, CheckOptions{Table: fake.table})
	if err != nil {
		t.Fatalf("NewCheckStore: %v", err)
	}
	return store, fake
}

func TestNewCheckStoreRefusesAnUnusableConfiguration(t *testing.T) {
	if _, err := NewCheckStore(nil, CheckOptions{Table: "t"}); err == nil {
		t.Fatal("NewCheckStore accepted a nil API")
	}
	if _, err := NewCheckStore(newFake("t"), CheckOptions{}); err == nil {
		t.Fatal("NewCheckStore accepted an empty table name")
	}
}

func TestCheckStoreChargesUpToTheLimitAndThenRefuses(t *testing.T) {
	store, fake := newTestCheckStore(t)
	window := checkstore.Window{Limit: 3, Period: time.Minute}
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(0), window)
		if err != nil {
			t.Fatalf("charge %d: %v", i, err)
		}
		if !charge.OK {
			t.Fatalf("charge %d was refused inside the limit", i)
		}
	}

	charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(0), window)
	if err != nil {
		// The refusal is DynamoDB declining the condition, which is a decision and not
		// a failure, so it must never reach the caller as an error.
		t.Fatalf("the refused charge returned an error: %v", err)
	}
	if charge.OK {
		t.Fatal("a fourth charge was accepted against a limit of three")
	}
	if want := checkMinute(1); !charge.RetryAt.Equal(want) {
		t.Fatalf("RetryAt = %s, want the window end %s", charge.RetryAt, want)
	}
	if spent := storedCharge(t, fake, checkstore.KindClient, "peer", checkMinute(0), window); spent != 3 {
		t.Fatalf("the refused charge changed the stored total to %d, want 3", spent)
	}
}

func TestCheckStoreChargesTheWholeCostOrNothing(t *testing.T) {
	store, fake := newTestCheckStore(t)
	window := checkstore.Window{Limit: 10, Period: time.Minute}
	ctx := context.Background()

	if _, err := store.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 7, checkMinute(0), window); err != nil {
		t.Fatalf("first charge: %v", err)
	}
	// A request needing four upstream calls with three left is refused whole. A partial
	// charge would spend budget on work that will not happen.
	charge, err := store.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 4, checkMinute(0), window)
	if err != nil {
		t.Fatalf("second charge: %v", err)
	}
	if charge.OK {
		t.Fatal("a charge of 4 was accepted with 3 left")
	}
	if spent := storedCharge(t, fake, checkstore.KindUpstream, checkstore.UpstreamKey, checkMinute(0), window); spent != 7 {
		t.Fatalf("stored total = %d, want 7 after a refusal", spent)
	}
	if charge, err := store.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 3, checkMinute(0), window); err != nil || !charge.OK {
		t.Fatalf("a charge of exactly the remainder was refused: charge=%+v err=%v", charge, err)
	}
}

func TestCheckStoreKeepsAllowancesApart(t *testing.T) {
	store, _ := newTestCheckStore(t)
	window := checkstore.Window{Limit: 1, Period: time.Minute}
	ctx := context.Background()

	for _, spend := range []struct {
		kind checkstore.Kind
		key  string
	}{
		{checkstore.KindClient, "first"},
		{checkstore.KindClient, "second"},
		{checkstore.KindUpstream, "first"},
	} {
		if charge, err := store.Charge(ctx, spend.kind, spend.key, 1, checkMinute(0), window); err != nil || !charge.OK {
			t.Fatalf("%s/%s: charge=%+v err=%v", spend.kind, spend.key, charge, err)
		}
	}
	// One client spending its allowance spends neither another client's nor the
	// upstream budget, and the same key under two kinds is two items.
	if charge, err := store.Charge(ctx, checkstore.KindClient, "first", 1, checkMinute(0), window); err != nil || charge.OK {
		t.Fatalf("the first client was charged twice against a limit of one: charge=%+v err=%v", charge, err)
	}
}

func TestCheckStoreWindowRollsOverWithoutSweeping(t *testing.T) {
	store, fake := newTestCheckStore(t)
	window := checkstore.Window{Limit: 2, Period: time.Minute}
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		if charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(0), window); err != nil || !charge.OK {
			t.Fatalf("charge %d: charge=%+v err=%v", i, charge, err)
		}
	}
	if charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(0), window); err != nil || charge.OK {
		t.Fatalf("the window did not refuse a third charge: charge=%+v err=%v", charge, err)
	}

	// The next window is a different sort key, so the allowance returns with nothing
	// having to sweep, sleep, or refill. TTL removal on a real table is asynchronous
	// and may lag by hours, and this is why that lag is harmless: the spent counter is
	// still stored and no live charge addresses it.
	if charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(1), window); err != nil || !charge.OK {
		t.Fatalf("the next window refused a charge: charge=%+v err=%v", charge, err)
	}
	if spent := storedCharge(t, fake, checkstore.KindClient, "peer", checkMinute(0), window); spent != 2 {
		t.Fatalf("the closed window holds %d, want the 2 it spent", spent)
	}
	if spent := storedCharge(t, fake, checkstore.KindClient, "peer", checkMinute(1), window); spent != 1 {
		t.Fatalf("the new window holds %d, want 1", spent)
	}
}

func TestCheckStoreBoundaryBurstIsBoundedAtTwiceTheLimit(t *testing.T) {
	store, _ := newTestCheckStore(t)
	window := checkstore.Window{Limit: 2, Period: time.Minute}
	ctx := context.Background()

	// The documented cost of a fixed window. The test pins the bound so it stays 2x and
	// cannot quietly become 3x.
	accepted := 0
	for _, at := range []time.Time{
		checkMinute(1).Add(-time.Millisecond),
		checkMinute(1).Add(-time.Millisecond),
		checkMinute(1).Add(-time.Millisecond),
		checkMinute(1),
		checkMinute(1),
		checkMinute(1),
	} {
		charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, at, window)
		if err != nil {
			t.Fatalf("charge at %s: %v", at, err)
		}
		if charge.OK {
			accepted++
		}
	}
	if accepted != 4 {
		t.Fatalf("the boundary allowed %d charges, want exactly 2*Limit = 4", accepted)
	}
}

func TestCheckStoreColdInstanceChargesTheSameWindowAsAWarmOne(t *testing.T) {
	fake := newFake("ens-snapshots")
	warm, err := NewCheckStore(fake, CheckOptions{Table: fake.table})
	if err != nil {
		t.Fatalf("NewCheckStore: %v", err)
	}
	window := checkstore.Window{Limit: 2, Period: time.Minute}
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		if charge, err := warm.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(0), window); err != nil || !charge.OK {
			t.Fatalf("warm charge %d: charge=%+v err=%v", i, charge, err)
		}
	}

	// A second CheckStore is a second Lambda instance: brand new, no state of its own,
	// and reaching the same table. This is the case the rejected per-instance design got
	// wrong - a cold instance handed the caller a fresh allowance.
	cold, err := NewCheckStore(fake, CheckOptions{Table: fake.table})
	if err != nil {
		t.Fatalf("NewCheckStore: %v", err)
	}
	if charge, err := cold.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(0), window); err != nil || charge.OK {
		t.Fatalf("a cold instance restarted the window: charge=%+v err=%v", charge, err)
	}
	// The same holds for the upstream budget, which is the one many identities could
	// otherwise multiply.
	if charge, err := cold.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 2, checkMinute(0), window); err != nil || !charge.OK {
		t.Fatalf("cold upstream charge: charge=%+v err=%v", charge, err)
	}
	if charge, err := warm.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 1, checkMinute(0), window); err != nil || charge.OK {
		t.Fatalf("the warm instance spent a budget the cold one had exhausted: charge=%+v err=%v", charge, err)
	}
}

func TestCheckStoreIsAtomicUnderContention(t *testing.T) {
	fake := newFake("ens-snapshots")
	window := checkstore.Window{Limit: 50, Period: time.Hour}
	ctx := context.Background()

	// Eight instances charging one key at once. Exactly the limit may be accepted: a
	// read-then-write limiter would let several of them see the same headroom, which is
	// the whole reason Charge is one conditional UpdateItem.
	const (
		instances = 8
		each      = 25
	)
	var (
		wait     sync.WaitGroup
		mutex    sync.Mutex
		accepted int
	)
	for i := 0; i < instances; i++ {
		store, err := NewCheckStore(fake, CheckOptions{Table: fake.table})
		if err != nil {
			t.Fatalf("NewCheckStore: %v", err)
		}
		for j := 0; j < each; j++ {
			wait.Add(1)
			go func(store *CheckStore) {
				defer wait.Done()
				charge, err := store.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 1, checkMinute(0), window)
				if err != nil {
					t.Errorf("concurrent charge: %v", err)
					return
				}
				if charge.OK {
					mutex.Lock()
					accepted++
					mutex.Unlock()
				}
			}(store)
		}
	}
	wait.Wait()

	if accepted != 50 {
		t.Fatalf("%d of %d concurrent charges were accepted, want exactly the limit of 50",
			accepted, instances*each)
	}
	if spent := storedCharge(t, fake, checkstore.KindUpstream, checkstore.UpstreamKey, checkMinute(0), window); spent != 50 {
		t.Fatalf("the stored total is %d, want 50", spent)
	}
}

func TestCheckStoreCounterCarriesItsWindowAndOneTTL(t *testing.T) {
	store, fake := newTestCheckStore(t)
	window := checkstore.Window{Limit: 5, Period: time.Minute}
	ctx := context.Background()

	if charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(0), window); err != nil || !charge.OK {
		t.Fatalf("first charge: charge=%+v err=%v", charge, err)
	}
	item := fake.stored(checkstore.RatePartition(checkstore.KindClient, "peer"),
		checkstore.WindowSort(checkMinute(0)))
	if item == nil {
		t.Fatal("the charge stored no counter")
	}
	if version, err := numberAttribute(item, attrFormatVersion); err != nil || version != checkFormatVersion {
		t.Fatalf("format version = %d err=%v, want %d", version, err, checkFormatVersion)
	}
	if start, err := stringAttribute(item, attrWindowStart); err != nil || start != checkMinute(0).Format(time.RFC3339) {
		t.Fatalf("window start = %q err=%v", start, err)
	}
	// The counter outlives its own window by one period, so a charge arriving at the
	// very end of a window adds to the total that window really holds.
	wantExpiry := checkMinute(2).Unix()
	if expiry, err := numberAttribute(item, attrExpiresAt); err != nil || expiry != wantExpiry {
		t.Fatalf("%s = %d err=%v, want %d", attrExpiresAt, expiry, err, wantExpiry)
	}

	// A later charge in the same window must not push the expiry out, or a hot key would
	// keep its counter alive indefinitely. if_not_exists is what holds it.
	if charge, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(0).Add(30*time.Second), window); err != nil || !charge.OK {
		t.Fatalf("second charge: charge=%+v err=%v", charge, err)
	}
	item = fake.stored(checkstore.RatePartition(checkstore.KindClient, "peer"),
		checkstore.WindowSort(checkMinute(0)))
	if expiry, err := numberAttribute(item, attrExpiresAt); err != nil || expiry != wantExpiry {
		t.Fatalf("a second charge moved the TTL to %d err=%v, want %d", expiry, err, wantExpiry)
	}
	if spent, err := numberAttribute(item, attrCharged); err != nil || spent != 2 {
		t.Fatalf("charged = %d err=%v, want 2", spent, err)
	}
}

func TestCheckStoreChargeFailureIsNotADecision(t *testing.T) {
	store, fake := newTestCheckStore(t)
	window := checkstore.Window{Limit: 5, Period: time.Minute}
	boom := errors.New("throttled")
	fake.onUpdateItem = func(call int) error { return boom }

	charge, err := store.Charge(context.Background(), checkstore.KindClient, "peer", 1, checkMinute(0), window)
	if !errors.Is(err, boom) {
		t.Fatalf("Charge returned %v, want the injected failure", err)
	}
	if charge.OK {
		t.Fatal("a failed charge reported OK")
	}
	if !charge.RetryAt.IsZero() {
		t.Fatal("a failed charge advertised a retry instant, which only a refusal has")
	}
	// A store that could not say is not evidence that an allowance is unspent, so the
	// error names the allowance and nothing about what spent it.
	if strings.Contains(err.Error(), "peer") {
		t.Fatalf("the error quotes the client key: %v", err)
	}
}

func TestCheckStoreRefusesAChargeNoWindowCouldAccept(t *testing.T) {
	store, fake := newTestCheckStore(t)
	window := checkstore.Window{Limit: 2, Period: time.Minute}

	// A cost larger than the whole window is a configuration error, not a refusal that
	// could succeed later, so it never reaches the table at all.
	if _, err := store.Charge(context.Background(), checkstore.KindClient, "peer", 3, checkMinute(0), window); err == nil {
		t.Fatal("Charge accepted a cost larger than the window")
	}
	if calls := fake.callCount("UpdateItem"); calls != 0 {
		t.Fatalf("an impossible charge made %d table calls, want 0", calls)
	}
}

func TestCheckStoreCacheRoundTripsAndExpires(t *testing.T) {
	store, _ := newTestCheckStore(t)
	ctx := context.Background()
	body := []byte(`{"checked_at":"2026-04-01T12:00:00Z"}`)

	if err := store.Store(ctx, "digest", checkstore.Entry{Body: body, ExpiresAt: checkMinute(1)}); err != nil {
		t.Fatalf("Store: %v", err)
	}
	entry, hit, err := store.Load(ctx, "digest", checkMinute(0))
	if err != nil || !hit {
		t.Fatalf("Load: hit=%v err=%v", hit, err)
	}
	// The bytes come back unchanged, so the instant in them is the instant the index was
	// really read at rather than the time of the hit.
	if string(entry.Body) != string(body) {
		t.Fatalf("Load returned %q, want %q", entry.Body, body)
	}
	if !entry.ExpiresAt.Equal(checkMinute(1)) {
		t.Fatalf("ExpiresAt = %s, want %s", entry.ExpiresAt, checkMinute(1))
	}

	// Expiry is judged on read against the caller's clock, because TTL removal is
	// asynchronous and an expired answer must never be served as a fresh one.
	if _, hit, err := store.Load(ctx, "digest", checkMinute(1)); err != nil || hit {
		t.Fatalf("an entry at its expiry was a hit: hit=%v err=%v", hit, err)
	}
}

func TestCheckStoreCacheMissesAnAbsentKey(t *testing.T) {
	store, _ := newTestCheckStore(t)
	if _, hit, err := store.Load(context.Background(), "absent", checkMinute(0)); err != nil || hit {
		t.Fatalf("an absent key: hit=%v err=%v", hit, err)
	}
}

func TestCheckStoreCacheOverwritesTheSameKey(t *testing.T) {
	store, _ := newTestCheckStore(t)
	ctx := context.Background()

	if err := store.Store(ctx, "digest", checkstore.Entry{Body: []byte("first"), ExpiresAt: checkMinute(1)}); err != nil {
		t.Fatalf("first Store: %v", err)
	}
	// Two instances that both missed and both read the index produced two honest
	// answers, so the later write is accepted rather than refused.
	if err := store.Store(ctx, "digest", checkstore.Entry{Body: []byte("second"), ExpiresAt: checkMinute(2)}); err != nil {
		t.Fatalf("second Store: %v", err)
	}
	entry, hit, err := store.Load(ctx, "digest", checkMinute(0))
	if err != nil || !hit {
		t.Fatalf("Load: hit=%v err=%v", hit, err)
	}
	if string(entry.Body) != "second" {
		t.Fatalf("Load returned %q, want the later write", entry.Body)
	}
}

func TestCheckStoreCacheRefusesAnUnusableEntry(t *testing.T) {
	store, fake := newTestCheckStore(t)
	ctx := context.Background()

	oversized := make([]byte, maxCacheBodyBytes+1)
	for _, test := range []struct {
		name  string
		key   string
		entry checkstore.Entry
	}{
		{"no body", "digest", checkstore.Entry{ExpiresAt: checkMinute(1)}},
		{"no expiry", "digest", checkstore.Entry{Body: []byte("x")}},
		{"blank key", "  ", checkstore.Entry{Body: []byte("x"), ExpiresAt: checkMinute(1)}},
		{"oversized body", "digest", checkstore.Entry{Body: oversized, ExpiresAt: checkMinute(1)}},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			if err := store.Store(ctx, test.key, test.entry); err == nil {
				t.Fatal("Store accepted an entry it cannot hold")
			}
		})
	}
	if calls := fake.callCount("PutItem"); calls != 0 {
		t.Fatalf("a refused entry made %d writes, want 0", calls)
	}
}

func TestCheckStoreCacheFailsClosedOnAnItemItCannotAccountFor(t *testing.T) {
	store, fake := newTestCheckStore(t)
	ctx := context.Background()

	good := func() map[string]types.AttributeValue {
		item := cacheKey("digest")
		item[attrFormatVersion] = numberValue(checkFormatVersion)
		item[attrCacheKey] = stringValue("digest")
		item[attrBody] = &types.AttributeValueMemberB{Value: []byte("answer")}
		item[attrExpiresAt] = numberValue(checkMinute(1).Unix())
		return item
	}

	for _, test := range []struct {
		name    string
		corrupt func(map[string]types.AttributeValue)
	}{
		{"a version this build does not know", func(item map[string]types.AttributeValue) {
			item[attrFormatVersion] = numberValue(checkFormatVersion + 1)
		}},
		{"a key that is not the one asked for", func(item map[string]types.AttributeValue) {
			item[attrCacheKey] = stringValue("another")
		}},
		{"an empty body", func(item map[string]types.AttributeValue) {
			item[attrBody] = &types.AttributeValueMemberB{Value: nil}
		}},
		{"a body over the bound", func(item map[string]types.AttributeValue) {
			item[attrBody] = &types.AttributeValueMemberB{Value: make([]byte, maxCacheBodyBytes+1)}
		}},
		{"a missing expiry", func(item map[string]types.AttributeValue) {
			delete(item, attrExpiresAt)
		}},
		{"a body of the wrong type", func(item map[string]types.AttributeValue) {
			item[attrBody] = stringValue("answer")
		}},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			item := good()
			test.corrupt(item)
			fake.put(item)
			// A stored answer that cannot be accounted for is a failure and not a miss.
			// A miss would hide a wrong item behind one extra upstream call for as long
			// as it stayed stored, and the body is returned to a client verbatim.
			if _, hit, err := store.Load(ctx, "digest", checkMinute(0)); err == nil || hit {
				t.Fatalf("Load returned hit=%v err=%v, want a failure", hit, err)
			}
		})
	}
}

func TestCheckStoreCacheReadFailureIsNotAMiss(t *testing.T) {
	store, fake := newTestCheckStore(t)
	boom := errors.New("throttled")
	fake.onGetItem = func(call int) error { return boom }

	if _, hit, err := store.Load(context.Background(), "digest", checkMinute(0)); !errors.Is(err, boom) || hit {
		t.Fatalf("Load returned hit=%v err=%v, want the injected failure and no hit", hit, err)
	}
}

func TestCheckStoreCancelledContextIsNotEvidence(t *testing.T) {
	store, fake := newTestCheckStore(t)
	window := checkstore.Window{Limit: 5, Period: time.Minute}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(0), window); !errors.Is(err, context.Canceled) {
		t.Fatalf("Charge returned %v, want context.Canceled", err)
	}
	if _, _, err := store.Load(ctx, "digest", checkMinute(0)); !errors.Is(err, context.Canceled) {
		t.Fatalf("Load returned %v, want context.Canceled", err)
	}
	if err := store.Store(ctx, "digest", checkstore.Entry{Body: []byte("x"), ExpiresAt: checkMinute(1)}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Store returned %v, want context.Canceled", err)
	}
	if keys := fake.keys(); len(keys) != 0 {
		t.Fatalf("a cancelled call wrote %v", keys)
	}
}

func TestCheckItemsAreOutsideEverySnapshotAddress(t *testing.T) {
	store, fake := newTestCheckStore(t)
	window := checkstore.Window{Limit: 5, Period: time.Minute}
	ctx := context.Background()

	if _, err := store.Charge(ctx, checkstore.KindClient, "peer", 1, checkMinute(0), window); err != nil {
		t.Fatalf("Charge: %v", err)
	}
	if _, err := store.Charge(ctx, checkstore.KindUpstream, checkstore.UpstreamKey, 1, checkMinute(0), window); err != nil {
		t.Fatalf("Charge: %v", err)
	}
	if err := store.Store(ctx, "digest", checkstore.Entry{Body: []byte("x"), ExpiresAt: checkMinute(1)}); err != nil {
		t.Fatalf("Store: %v", err)
	}

	// The check items share the publisher's table, and the snapshot side reads its
	// pointer by exact key and runs exactly one query, over META for STAGING#. Nothing
	// this store writes may land where either of those looks.
	keys := fake.keys()
	if len(keys) != 3 {
		t.Fatalf("stored %d items, want 3: %v", len(keys), keys)
	}
	for _, key := range keys {
		partition := strings.SplitN(key, " ", 2)[0]
		if !checkstore.IsCheckPartition(partition) {
			t.Fatalf("%q is not a check partition", partition)
		}
		if partition == snapshot.LatestPartition {
			t.Fatalf("%q is the snapshot pointer partition", partition)
		}
		if strings.HasPrefix(partition, snapshot.SnapshotPartition("")) {
			t.Fatalf("%q is inside the snapshot chunk partitions", partition)
		}
	}
}

func TestCachedItemLeavesAMarginUnderTheItemLimit(t *testing.T) {
	// A binary attribute travels base64 encoded, so the bound has to be judged against
	// the encoded size and not the body's own. This asserts the margin the comment on
	// maxCacheBodyBytes claims rather than trusting it.
	body := make([]byte, maxCacheBodyBytes)
	total := cacheItemBytes(strings.Repeat("d", 64), body)
	const itemLimit = 400 << 10
	if total >= itemLimit {
		t.Fatalf("a full cached answer costs %d bytes, which is not under the %d byte item limit",
			total, itemLimit)
	}
	if margin := itemLimit - total; margin < 64<<10 {
		t.Fatalf("the margin under the item limit is %d bytes, want at least 64 KiB", margin)
	}
}

// storedCharge reads a counter straight out of the fake. Nothing on the serving path
// reads one, so this is for assertions only.
func storedCharge(t *testing.T, fake *fakeDynamo, kind checkstore.Kind, key string, now time.Time, window checkstore.Window) int64 {
	t.Helper()
	item := fake.stored(checkstore.RatePartition(kind, key), checkstore.WindowSort(window.Start(now)))
	if item == nil {
		return 0
	}
	charged, err := numberAttribute(item, attrCharged)
	if err != nil {
		t.Fatalf("stored counter: %v", err)
	}
	return charged
}
