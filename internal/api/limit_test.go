package api

import (
	"testing"
	"time"
)

// The units here are exercised directly because the HTTP path cannot reach all of
// them: an unmatched gate release and the copy layer's eviction order are states a
// request cannot arrange for itself. Every expiry is resolved against an instant the
// test passes in, so nothing in this file sleeps.
//
// There is deliberately no limiter here any more. Every allowance is charged against
// the shared store, so what a limiter test used to prove - a spent allowance, a whole
// charge, isolation between identities, a window rolling over - is proved against
// internal/checkstore and again through the HTTP path in check_test.go, where a cold
// instance and two concurrent ones can be shown to spend the same allowance.

func TestGateBoundsConcurrentUse(t *testing.T) {
	slots := newGate(2)

	if !slots.acquire() || !slots.acquire() {
		t.Fatal("the gate refused a request within its size")
	}
	if slots.acquire() {
		t.Fatal("the gate admitted a request over its size")
	}

	slots.release()
	if !slots.acquire() {
		t.Error("a released slot was not usable again")
	}
	if slots.acquire() {
		t.Error("the gate admitted a request over its size after a release")
	}
}

// TestGateReleaseCannotCreateCapacity keeps a stray release from widening the
// bound. A release is deferred on a path that can also refuse before acquiring,
// so an unmatched one has to be harmless rather than a free slot.
func TestGateReleaseCannotCreateCapacity(t *testing.T) {
	slots := newGate(1)

	slots.release()
	slots.release()

	if !slots.acquire() {
		t.Fatal("the gate refused the first request")
	}
	if slots.acquire() {
		t.Error("unmatched releases widened the gate")
	}
}

// TestLocalCacheExpiresAtTheSharedExpiry is the property that makes the copy layer
// an optimization: an entry is dropped at the expiry the shared store declared, not
// at a lifetime this layer added when the copy arrived.
func TestLocalCacheExpiresAtTheSharedExpiry(t *testing.T) {
	cache := newLocalCache(4)
	expiresAt := checkTime.Add(30 * time.Second)

	// The copy is taken 20 seconds into a 30 second entry, which is what a second
	// instance reading a shared entry really sees.
	cache.put("key", []byte("body"), expiresAt, checkTime.Add(20*time.Second))

	if _, hit := cache.get("key", checkTime.Add(29*time.Second)); !hit {
		t.Fatal("a copy expired before the shared entry it came from")
	}
	// The moment it expires, not the moment after: an answer that has reached its
	// own stated expiry is not a fresh check any more.
	if _, hit := cache.get("key", expiresAt); hit {
		t.Error("an expired copy was served")
	}
	if cache.held() != 0 {
		t.Errorf("held = %d, want 0: reading an expired copy should remove it", cache.held())
	}
}

// TestLocalCacheRefusesAnAlreadyExpiredCopy covers the guard in put. Nothing can
// read such a copy, so keeping it would only cost a sweep later.
func TestLocalCacheRefusesAnAlreadyExpiredCopy(t *testing.T) {
	cache := newLocalCache(4)

	cache.put("key", []byte("body"), checkTime, checkTime)

	if cache.held() != 0 {
		t.Errorf("held = %d, want 0", cache.held())
	}
	if _, hit := cache.get("key", checkTime); hit {
		t.Error("an already expired copy was kept and served")
	}
}

// TestLocalCacheEvictsTheNearestExpiry covers the room-making order in put:
// expired entries first, and then the entry with the least life left, because
// that is the one whose removal costs the fewest future hits.
func TestLocalCacheEvictsTheNearestExpiry(t *testing.T) {
	cache := newLocalCache(2)

	at := func(seconds int) time.Time { return checkTime.Add(time.Duration(seconds) * time.Second) }
	cache.put("far", []byte("body"), at(60), checkTime)
	cache.put("near", []byte("body"), at(10), checkTime)
	cache.put("new", []byte("body"), at(60), checkTime)

	if cache.held() != 2 {
		t.Fatalf("held = %d, want 2", cache.held())
	}
	if _, hit := cache.get("near", checkTime); hit {
		t.Error("the entry closest to its own expiry survived")
	}
	for _, key := range []string{"far", "new"} {
		if _, hit := cache.get(key, checkTime); !hit {
			t.Errorf("%q was evicted instead", key)
		}
	}
}

// TestLocalCacheSweepsExpiredBeforeEvicting keeps an entry that is still useful
// from being dropped while an expired one takes up the room.
func TestLocalCacheSweepsExpiredBeforeEvicting(t *testing.T) {
	cache := newLocalCache(2)

	cache.put("stale", []byte("body"), checkTime.Add(10*time.Second), checkTime)
	cache.put("live", []byte("body"), checkTime.Add(2*time.Minute), checkTime)

	later := checkTime.Add(30 * time.Second)
	cache.put("new", []byte("body"), later.Add(time.Minute), later)

	if cache.held() != 2 {
		t.Fatalf("held = %d, want 2", cache.held())
	}
	if _, hit := cache.get("stale", later); hit {
		t.Error("the expired entry survived")
	}
	for _, key := range []string{"live", "new"} {
		if _, hit := cache.get(key, later); !hit {
			t.Errorf("%q was dropped while an expired entry held the room", key)
		}
	}
}

// TestLocalCacheReplacesInPlace keeps a re-read answer for a set the layer already
// holds from evicting an unrelated set, because replacing needs no room.
func TestLocalCacheReplacesInPlace(t *testing.T) {
	cache := newLocalCache(2)
	expiresAt := checkTime.Add(time.Minute)

	cache.put("a", []byte("first"), expiresAt, checkTime)
	cache.put("b", []byte("other"), expiresAt, checkTime)
	cache.put("a", []byte("second"), expiresAt, checkTime)

	if cache.held() != 2 {
		t.Fatalf("held = %d, want 2", cache.held())
	}
	body, hit := cache.get("a", checkTime)
	if !hit {
		t.Fatal("the replaced entry is missing")
	}
	if string(body) != "second" {
		t.Errorf("body = %q, want the replacement", body)
	}
	if _, hit := cache.get("b", checkTime); !hit {
		t.Error("replacing one entry evicted another")
	}
}
