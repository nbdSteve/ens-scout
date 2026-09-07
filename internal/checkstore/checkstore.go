// Package checkstore is the shared durable contract for the fresh-check path.
//
// The check path spends a Graph budget on a visitor's behalf, so the state that
// bounds that spend cannot live in one process. A Lambda deployment runs as many
// instances as it is given concurrency for, each one starting with empty state, so
// a per-instance allowance is really that allowance times however many instances a
// caller reaches, and a per-instance cache is a cache a caller misses by being
// routed somewhere else. This package is where that state lives instead: one
// authority every instance charges against and reads from.
//
// It holds three things, and they are the three a request cannot be judged without:
// a per-client allowance, one deployment-wide upstream budget, and the short-lived
// result cache. A process may keep a copy of what it read here as an optimization,
// but a copy may only ever refuse or repeat what this store already decided.
//
// The package is deliberately free of AWS, HTTP, and frontend dependencies, the same
// way internal/snapshot is. Backends implement Limiter, Cache, or Store;
// internal/dynamo has the DynamoDB one, and MemoryStore is the local fake both the
// tests and a local preview use.
package checkstore

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Kind names which allowance a charge is against. It is part of the stored key, so
// a client allowance and the upstream budget cannot collide even if they were ever
// given the same key.
type Kind string

const (
	// KindClient is one client identity's allowance.
	KindClient Kind = "client"

	// KindUpstream is the deployment-wide upstream budget. Every instance and every
	// client identity charges the same key, which is the point: the budget exists so
	// that many identities cannot add up to unbounded Graph load.
	KindUpstream Kind = "upstream"
)

// UpstreamKey is the single key KindUpstream is held under.
const UpstreamKey = "all"

// ErrClosed is returned by a store that has been closed. It exists so a fake can
// model a backend that has gone away, which must fail closed rather than read as an
// empty allowance.
var ErrClosed = errors.New("checkstore: store is closed")

// Window is a fixed counting window: at most Limit units may be charged against
// one key in one Period.
//
// It is a fixed window rather than a token bucket, and that is a deliberate
// trade. A bucket that refills has to be read, adjusted, and written back, which
// against a shared store is a compare-and-swap loop on the hottest key in the
// system - so the moment the limit starts doing its job is the moment every
// attempt starts contending with every other. A fixed window is one atomic
// conditional increment, whatever the concurrency, and it needs no loop, no
// retry budget of its own, and no stored version.
//
// The cost is at a boundary: a caller that spends its whole allowance at the end
// of one window and again at the start of the next has made 2*Limit charges in
// close succession. That is bounded, it is the same bound every instance sees,
// and it is documented in docs/read-api.md rather than being smoothed over.
type Window struct {
	// Limit is the most that may be charged in one Period. It must be positive.
	Limit int64

	// Period is how long one window lasts. It must be positive, and a store derives
	// the current window from Start so that two instances reading the same clock
	// derive the same window.
	Period time.Duration
}

// Validate rejects a window that would not bound anything.
func (w Window) Validate() error {
	if w.Limit <= 0 {
		return fmt.Errorf("checkstore: a window limit must be positive, got %d", w.Limit)
	}
	if w.Period <= 0 {
		return fmt.Errorf("checkstore: a window period must be positive, got %s", w.Period)
	}
	return nil
}

// Start returns the instant the window containing now began.
//
// This is the whole reason two instances agree. The window is derived from the
// clock rather than from when a key was first seen, so an instance that has never
// served a request before charges the same window as one that has been warm for an
// hour, and neither can restart a window by restarting.
func (w Window) Start(now time.Time) time.Time {
	if w.Period <= 0 {
		return now.UTC().Truncate(time.Second)
	}
	return now.UTC().Truncate(w.Period)
}

// End returns the instant the window containing now ends, which is when a refused
// charge may next succeed.
func (w Window) End(now time.Time) time.Time {
	return w.Start(now).Add(w.Period)
}

// Charge is the outcome of one atomic charge.
type Charge struct {
	// OK reports whether the charge was accepted. A refused charge changed nothing.
	OK bool

	// RetryAt is when the window that refused the charge ends. It is zero when OK.
	RetryAt time.Time
}

// Limiter charges allowances atomically.
//
// A backend must make Charge a single atomic operation against the shared store:
// either the whole cost is recorded and the charge is accepted, or nothing is
// recorded and it is refused. It must never read a count, decide, and then write,
// because two instances doing that concurrently both see room that only one of them
// can have.
//
// An error is not a refusal and not an acceptance. It means the store could not say,
// and a caller must fail closed on it: a store that cannot be reached is not
// evidence that an allowance is unspent.
type Limiter interface {
	// Charge records cost against key in the window containing now, and reports
	// whether it was accepted. A cost of zero or less, an invalid window, or an empty
	// key is an error rather than a free charge.
	Charge(ctx context.Context, kind Kind, key string, cost int64, now time.Time, window Window) (Charge, error)
}

// Entry is one cached rendered response.
//
// It holds the rendered bytes rather than the results, so a hit returns exactly the
// body the miss returned, including the instant the index was really read at. That
// is what a re-rendered document cannot do: it would stamp the answer with the time
// of the hit and claim a verification that never happened.
type Entry struct {
	// Body is the rendered response, stored and returned unchanged.
	Body []byte

	// ExpiresAt is when this answer stops counting as fresh. A store never returns an
	// entry at or after it, and uses it as the item's own expiry so the store does not
	// grow without bound.
	ExpiresAt time.Time
}

// Validate rejects an entry a store must not hold.
func (e Entry) Validate() error {
	if len(e.Body) == 0 {
		return errors.New("checkstore: a cache entry needs a body")
	}
	if e.ExpiresAt.IsZero() {
		return errors.New("checkstore: a cache entry needs an expiry")
	}
	return nil
}

// Cache is the shared short-lived result cache.
//
// The same rule as Limiter applies to an error: a store that could not be read has
// said nothing, and a caller must treat that as neither a hit nor a miss but as a
// failure of its own.
type Cache interface {
	// Load returns the entry stored under key when one is stored and has not expired
	// at now. An expired entry is a miss.
	Load(ctx context.Context, key string, now time.Time) (Entry, bool, error)

	// Store writes entry under key. A repeated write of the same key is accepted and
	// overwrites: two instances that both missed and both went upstream produce two
	// honest answers, and either one is a correct thing to have cached.
	Store(ctx context.Context, key string, entry Entry) error
}

// Store is both halves. A backend that offers the check path implements it.
type Store interface {
	Limiter
	Cache
}

// Key layout. These builders are here rather than in a backend for the same reason
// internal/snapshot owns the snapshot partitions: the shared store is a contract, so
// exactly one package decides what an item is called.
const (
	// ratePrefix and resultPrefix begin the partition key of a counter and of a
	// cached result. They are distinct from every partition internal/snapshot names,
	// so no read or query on the snapshot side can see one of these items, and no
	// query here can see a snapshot item.
	ratePrefix   = "CHECKRATE#"
	resultPrefix = "CHECKRESULT#"

	// windowPrefix begins the sort key of one window's counter. The window is in the
	// sort key so a key's counters expire on their own and a partition stays one
	// identity's.
	windowPrefix = "W#"

	// ResultSort is the sort key every cached result takes. There is one item per
	// key, so it is fixed.
	ResultSort = "RESULT"
)

// RatePartition is the partition key of one key's counters.
func RatePartition(kind Kind, key string) string {
	return ratePrefix + string(kind) + "#" + key
}

// WindowSort is the sort key of the counter for the window beginning at start.
//
// The window start is written as Unix seconds, so the sort key of a later window
// sorts after an earlier one and a store can expire a whole key by range.
func WindowSort(start time.Time) string {
	return windowPrefix + strconv.FormatInt(start.UTC().Unix(), 10)
}

// ResultPartition is the partition key of one cached result.
func ResultPartition(key string) string {
	return resultPrefix + key
}

// IsCheckPartition reports whether a partition key belongs to this package. It
// exists so a backend can assert it is not addressing a snapshot item, and so a
// test can prove the two layouts do not overlap.
func IsCheckPartition(partition string) bool {
	return strings.HasPrefix(partition, ratePrefix) || strings.HasPrefix(partition, resultPrefix)
}

// ValidateCharge is the argument check every backend applies, so a refusal to charge
// nothing reads the same from every one of them.
func ValidateCharge(kind Kind, key string, cost int64, window Window) error {
	if kind != KindClient && kind != KindUpstream {
		return fmt.Errorf("checkstore: unknown allowance kind %q", kind)
	}
	if strings.TrimSpace(key) == "" {
		return errors.New("checkstore: a charge needs a key")
	}
	if cost <= 0 {
		return fmt.Errorf("checkstore: a charge must cost at least one unit, got %d", cost)
	}
	if err := window.Validate(); err != nil {
		return err
	}
	if cost > window.Limit {
		// A charge larger than the whole window can never be accepted, so reporting it
		// as an ordinary refusal would advertise a retry that must always fail. A
		// caller validates its own bounds at startup instead: see CheckConfig.
		return fmt.Errorf("checkstore: a charge of %d can never fit a window limit of %d", cost, window.Limit)
	}
	return nil
}

// ValidateKey is the same for a cache key.
func ValidateKey(key string) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("checkstore: a cache key is required")
	}
	return nil
}
