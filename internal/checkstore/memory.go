package checkstore

import (
	"context"
	"sync"
	"time"
)

// MemoryStore is a deterministic in-process Store.
//
// It is the local fake, and it is also what makes the durable behaviour testable
// without AWS. The important property is that it is shared rather than per handler:
// two handlers constructed against one MemoryStore behave the way two Lambda
// instances behave against one table, so a test proves that a cold instance charges
// the same allowance a warm one already spent, and that neither can restart a window
// by restarting.
//
// Every method is safe for concurrent use, and a charge is applied under one lock, so
// a contention test can run many charges in parallel and assert that exactly Limit of
// them were accepted.
type MemoryStore struct {
	mutex sync.Mutex

	// counts holds one window's total, keyed by partition and sort key exactly as a
	// real backend would, so the key layout is exercised rather than bypassed.
	counts map[string]int64

	// expiries holds each item's own expiry, so a swept counter and an expired cache
	// entry are modelled rather than assumed. A real backend leaves this to a TTL,
	// which is asynchronous, so both this fake and the DynamoDB backend judge expiry
	// on read as well.
	expiries map[string]time.Time

	entries map[string]Entry

	// closed models a backend that has gone away. Every method then returns ErrClosed,
	// which a caller must fail closed on rather than read as an empty allowance.
	closed bool

	// failCharge, failCache, and failStore make the next n calls fail, so a test can
	// prove the fail-closed path without a fake that is wrong in some other way as well.
	// A write is separately injectable because a caller loads before it stores: one
	// counter for both could never express the case where an answer was obtained
	// honestly and only the caching of it failed.
	failCharge int
	failCache  int
	failStore  int
	failErr    error

	// charges and loads count calls, which is how a test proves the process-local copy
	// layer is an optimization: the second identical request must not reach the store.
	charges int
	loads   int
	stores  int
}

// NewMemoryStore returns an empty store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		counts:   make(map[string]int64),
		expiries: make(map[string]time.Time),
		entries:  make(map[string]Entry),
	}
}

// Charge implements Limiter atomically under one lock.
func (m *MemoryStore) Charge(ctx context.Context, kind Kind, key string, cost int64, now time.Time, window Window) (Charge, error) {
	if err := ctx.Err(); err != nil {
		// A cancelled context is not evidence about the allowance, so it is an error and
		// never a refusal.
		return Charge{}, err
	}
	if err := ValidateCharge(kind, key, cost, window); err != nil {
		return Charge{}, err
	}

	m.mutex.Lock()
	defer m.mutex.Unlock()
	if m.closed {
		return Charge{}, ErrClosed
	}
	m.charges++
	if m.failCharge > 0 {
		m.failCharge--
		return Charge{}, m.chargeError()
	}

	start := window.Start(now)
	item := RatePartition(kind, key) + "\x00" + WindowSort(start)
	if expiry, ok := m.expiries[item]; ok && !expiry.After(now) {
		delete(m.counts, item)
		delete(m.expiries, item)
	}
	if m.counts[item]+cost > window.Limit {
		return Charge{RetryAt: start.Add(window.Period)}, nil
	}
	m.counts[item] += cost
	// A counter outlives its own window by one period, the same way the backend's TTL
	// does, so a late charge against a window that has closed still finds the total it
	// is adding to rather than starting again.
	m.expiries[item] = start.Add(2 * window.Period)
	return Charge{OK: true}, nil
}

// Load implements Cache.
func (m *MemoryStore) Load(ctx context.Context, key string, now time.Time) (Entry, bool, error) {
	if err := ctx.Err(); err != nil {
		return Entry{}, false, err
	}
	if err := ValidateKey(key); err != nil {
		return Entry{}, false, err
	}

	m.mutex.Lock()
	defer m.mutex.Unlock()
	if m.closed {
		return Entry{}, false, ErrClosed
	}
	m.loads++
	if m.failCache > 0 {
		m.failCache--
		return Entry{}, false, m.chargeError()
	}

	entry, ok := m.entries[ResultPartition(key)]
	if !ok {
		return Entry{}, false, nil
	}
	if !entry.ExpiresAt.After(now) {
		delete(m.entries, ResultPartition(key))
		return Entry{}, false, nil
	}
	// Copy the body out, so a caller that keeps or mutates it cannot reach into the
	// store the way it could not reach into a table.
	body := make([]byte, len(entry.Body))
	copy(body, entry.Body)
	return Entry{Body: body, ExpiresAt: entry.ExpiresAt}, true, nil
}

// Store implements Cache.
func (m *MemoryStore) Store(ctx context.Context, key string, entry Entry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateKey(key); err != nil {
		return err
	}
	if err := entry.Validate(); err != nil {
		return err
	}

	m.mutex.Lock()
	defer m.mutex.Unlock()
	if m.closed {
		return ErrClosed
	}
	m.stores++
	if m.failCache > 0 {
		m.failCache--
		return m.chargeError()
	}
	if m.failStore > 0 {
		m.failStore--
		return m.chargeError()
	}

	body := make([]byte, len(entry.Body))
	copy(body, entry.Body)
	m.entries[ResultPartition(key)] = Entry{Body: body, ExpiresAt: entry.ExpiresAt}
	return nil
}

// Close makes every later call fail with ErrClosed. It models a backend that has gone
// away, which is the case a caller has to fail closed on.
func (m *MemoryStore) Close() {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	m.closed = true
}

// FailCharges makes the next n charges fail with err.
func (m *MemoryStore) FailCharges(n int, err error) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	m.failCharge = n
	m.failErr = err
}

// FailCache makes the next n cache calls fail with err, reads and writes alike.
func (m *MemoryStore) FailCache(n int, err error) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	m.failCache = n
	m.failErr = err
}

// FailStores makes the next n cache writes fail with err, leaving reads alone.
//
// It is the one failure a caller must not fail closed on: the fresh answer was
// already obtained, so refusing the request would throw away a verification that
// really happened because a cache could not keep it.
func (m *MemoryStore) FailStores(n int, err error) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	m.failStore = n
	m.failErr = err
}

// Counts reports how many times each method was called, which is how a test tells a
// store read from a process-local hit.
func (m *MemoryStore) Counts() (charges, loads, stores int) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	return m.charges, m.loads, m.stores
}

// Spent reports the total charged against one key in the window containing now. It is
// for assertions only; nothing on the serving path reads a counter.
func (m *MemoryStore) Spent(kind Kind, key string, now time.Time, window Window) int64 {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	item := RatePartition(kind, key) + "\x00" + WindowSort(window.Start(now))
	if expiry, ok := m.expiries[item]; ok && !expiry.After(now) {
		return 0
	}
	return m.counts[item]
}

// Items reports how many counters and cache entries are held, so a test can prove
// expiry actually removes them rather than only hiding them.
func (m *MemoryStore) Items() (counters, entries int) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	return len(m.counts), len(m.entries)
}

func (m *MemoryStore) chargeError() error {
	if m.failErr != nil {
		return m.failErr
	}
	return ErrClosed
}
