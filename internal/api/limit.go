package api

import (
	"sync"
	"time"
)

// gate bounds how many requests may be in the upstream at once on this instance.
//
// It is deliberately the one control here that is per instance and stays that way.
// A slot is a live goroutine holding a live HTTP request, so it cannot be held in a
// table: nothing durable can know that a process on another host is still waiting.
// The deployment-wide bound on in-flight upstream work is the function's reserved
// concurrency multiplied by this, and infra/ owns the first factor.
//
// A request over the bound is refused immediately rather than queued. Queueing
// would spend the waiting request's whole deadline before its first upstream call
// and then fail anyway, and a client that is told to retry can decide for itself
// whether it still wants the answer.
type gate struct {
	slots chan struct{}
}

func newGate(size int) *gate {
	return &gate{slots: make(chan struct{}, size)}
}

// acquire takes a slot if one is free, and reports whether it did.
func (g *gate) acquire() bool {
	select {
	case g.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (g *gate) release() {
	select {
	case <-g.slots:
	default:
	}
}

// localCache is a bounded process-local copy of entries the shared store holds.
//
// It is an optimization and nothing else. The shared store is the authority for
// what is cached: every entry here was either read from it or written to it under
// the same key, and carries the same bytes and the same expiry, so a local hit and
// a shared hit are the same answer. That is what makes it safe to consult first:
// this layer can save a store read, and it cannot invent, extend, or outlive one.
//
// The two properties that keep it honest are that it stores the response bytes
// rather than the results, so a hit returns the instant the index was really read
// at rather than the instant of the hit, and that an entry is dropped at the expiry
// the shared entry declared rather than at one derived here. Emptying it changes
// nothing a client can observe except how many store reads happen.
type localCache struct {
	maxEntries int

	mutex   sync.Mutex
	entries map[string]localEntry
}

// localEntry is one copy. ExpiresAt is the shared entry's own expiry, never a
// lifetime added on arrival: a copy taken late in an entry's life must expire with
// the entry and not a full lifetime later.
type localEntry struct {
	body      []byte
	expiresAt time.Time
}

func newLocalCache(maxEntries int) *localCache {
	return &localCache{
		maxEntries: maxEntries,
		entries:    make(map[string]localEntry),
	}
}

// get returns a copy that has not expired against now. An expired one is removed
// and reported as a miss, so a stale answer is never served: the whole promise of
// this path is that a client knows how old its answer is.
func (c *localCache) get(key string, now time.Time) ([]byte, bool) {
	c.mutex.Lock()
	defer c.mutex.Unlock()

	held, exists := c.entries[key]
	if !exists {
		return nil, false
	}
	if !now.Before(held.expiresAt) {
		delete(c.entries, key)
		return nil, false
	}
	return held.body, true
}

// put keeps a copy, making room by dropping expired entries first and then the one
// closest to its own expiry. An entry that has already expired is not kept at all:
// storing it would only cost a sweep later.
func (c *localCache) put(key string, body []byte, expiresAt, now time.Time) {
	if !now.Before(expiresAt) {
		return
	}

	c.mutex.Lock()
	defer c.mutex.Unlock()

	if _, exists := c.entries[key]; !exists && len(c.entries) >= c.maxEntries {
		c.sweepExpired(now)
	}
	for len(c.entries) >= c.maxEntries {
		c.evictOldest()
	}
	c.entries[key] = localEntry{body: body, expiresAt: expiresAt}
}

func (c *localCache) sweepExpired(now time.Time) {
	for key, held := range c.entries {
		if !now.Before(held.expiresAt) {
			delete(c.entries, key)
		}
	}
}

func (c *localCache) evictOldest() {
	var (
		oldestKey string
		oldest    time.Time
		found     bool
	)
	for key, held := range c.entries {
		if !found || held.expiresAt.Before(oldest) {
			oldestKey, oldest, found = key, held.expiresAt, true
		}
	}
	if found {
		delete(c.entries, oldestKey)
	}
}

// held reports how many copies are kept. It exists for tests: the eviction rule
// above is a behaviour, so it has to be observable.
func (c *localCache) held() int {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	return len(c.entries)
}
