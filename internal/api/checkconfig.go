package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"ens-scrape/internal/checker"
	"ens-scrape/internal/checkstore"
)

// PathCheck rechecks a small list of labels against the ENS subgraph now, rather
// than reading the published snapshot.
//
// It is the one path in this package that leaves the process, so it is also the
// only one with a spending limit. Everything below is a ceiling on what one
// request, one client, or one deployment may cost.
const PathCheck = "/api/check"

// CheckFormatVersion is the wire version of a check response. A client that does
// not know a version must refuse the body rather than read the fields it
// recognises, so this is bumped for any change to the document.
const CheckFormatVersion = 1

// CheckSource names what produced a fresh status: one live query of the ENS
// subgraph index. It is deliberately not the registry.
const CheckSource = "ens-subgraph-index"

// CheckAuthority names what actually decides whether a name can be registered.
// A response carries both, because a fresh index read, a snapshot's recorded
// status, and the registry are three different things and a client that conflates
// them will tell someone a name is theirs when it is not.
const CheckAuthority = "ens-registry"

// CheckAdvisory is on every check response, including the failures.
const CheckAdvisory = "This is one live read of the ENS subgraph index at the stated instant, " +
	"not a reservation and not a quote. A name the index does not hold may still fail to " +
	"register. Confirm availability and price with ENS before registering."

// Environment variable names for the check path. Every one is a bound except the
// client secret, which is the keying value the throttle identity is derived under.
const (
	EnvCheckMaxRequestBytes     = "ENS_API_CHECK_MAX_REQUEST_BYTES"
	EnvCheckMaxNames            = "ENS_API_CHECK_MAX_NAMES"
	EnvCheckMaxLabelBytes       = "ENS_API_CHECK_MAX_LABEL_BYTES"
	EnvCheckBatchSize           = "ENS_API_CHECK_BATCH_SIZE"
	EnvCheckWorkers             = "ENS_API_CHECK_WORKERS"
	EnvCheckRetries             = "ENS_API_CHECK_RETRIES"
	EnvCheckTimeoutSeconds      = "ENS_API_CHECK_TIMEOUT_SECONDS"
	EnvCheckSoonDays            = "ENS_API_CHECK_SOON_DAYS"
	EnvCheckCacheSeconds        = "ENS_API_CHECK_CACHE_SECONDS"
	EnvCheckLocalCacheEntries   = "ENS_API_CHECK_LOCAL_CACHE_ENTRIES"
	EnvCheckClientLimit         = "ENS_API_CHECK_CLIENT_LIMIT"
	EnvCheckClientWindowSeconds = "ENS_API_CHECK_CLIENT_WINDOW_SECONDS"
	EnvCheckClientSecret        = "ENS_API_CHECK_CLIENT_SECRET"
	EnvCheckUpstreamLimit       = "ENS_API_CHECK_UPSTREAM_LIMIT"
	EnvCheckUpstreamWindow      = "ENS_API_CHECK_UPSTREAM_WINDOW_SECONDS"
	EnvCheckUpstreamConcurrency = "ENS_API_CHECK_UPSTREAM_CONCURRENCY"
)

// Defaults and bounds. A floor stops a setting from disabling a control, and a
// ceiling stops a mistyped variable from removing one.
const (
	// DefaultCheckMaxRequestBytes fits the largest request the bounds below allow
	// several times over, and is small enough that reading one costs nothing.
	DefaultCheckMaxRequestBytes = 8 * 1024
	minCheckMaxRequestBytes     = 256
	maxCheckMaxRequestBytes     = 1 << 20

	// DefaultCheckMaxNames is what a visitor can plausibly be looking at and about
	// to act on. It bounds the Graph cost of one request, and with the batch size
	// below it is one upstream call.
	DefaultCheckMaxNames = 25
	minCheckMaxNames     = 1
	maxCheckMaxNames     = 100

	// DefaultCheckMaxLabelBytes bounds one normalized label. A .eth label longer
	// than this is not a candidate anybody is about to register.
	DefaultCheckMaxLabelBytes = 64
	minCheckMaxLabelBytes     = 1
	maxCheckMaxLabelBytes     = 255

	// DefaultCheckBatchSize keeps one request to one upstream call at the default
	// name limit. The ceiling is the subgraph's own batch limit.
	DefaultCheckBatchSize = 25
	minCheckBatchSize     = 1
	maxCheckBatchSize     = 1000

	// DefaultCheckWorkers is small because a request is small. This is per request,
	// so the in-flight bound is EnvCheckUpstreamConcurrency and not this.
	DefaultCheckWorkers = 2
	minCheckWorkers     = 1
	maxCheckWorkers     = 8

	// DefaultCheckRetries is what the injected upstream client is expected to have
	// been built with. It is parsed and validated here so a deployment that
	// mistypes it fails at cold start in tested code rather than in an entrypoint.
	DefaultCheckRetries = 2
	minCheckRetries     = 0
	maxCheckRetries     = 5

	// DefaultCheckTimeoutSeconds bounds the whole request, retries and backoff
	// included. A visitor waiting on a button will not wait longer than this, and
	// neither will the Graph budget.
	DefaultCheckTimeoutSeconds = 10
	minCheckTimeoutSeconds     = 1
	maxCheckTimeoutSeconds     = 60

	// DefaultCheckSoonDays matches the CLI and the publisher, so a fresh status is
	// directly comparable to the snapshot status beside it. A different window here
	// would make the two disagree for a name near a boundary.
	DefaultCheckSoonDays = 30
	minCheckSoonDays     = 0
	maxCheckSoonDays     = 365

	// DefaultCheckCacheSeconds is how long a fresh answer stays fresh. It is short:
	// the point of this path is that a client can say when it last really looked. It
	// is the shared entry's lifetime and the response's declared expiry, so every
	// instance and every client agree on when an answer stopped counting as fresh.
	DefaultCheckCacheSeconds = 60
	minCheckCacheSeconds     = 1
	maxCheckCacheSeconds     = 600

	// DefaultCheckLocalCacheEntries bounds the process-local copy layer in items
	// rather than in bytes, because a response is bounded by EnvCheckMaxNames
	// already. It bounds a copy and never the shared cache, which is bounded by its
	// own TTL rather than by an item count.
	DefaultCheckLocalCacheEntries = 512
	minCheckLocalCacheEntries     = 1
	maxCheckLocalCacheEntries     = 1 << 16

	// DefaultCheckClientLimit and DefaultCheckClientWindowSeconds are one client's
	// allowance. It is charged against the shared store, so it is the allowance for
	// the deployment and not for one instance: see CheckConfig.Store.
	DefaultCheckClientLimit         = 5
	minCheckClientLimit             = 1
	maxCheckClientLimit             = 100
	DefaultCheckClientWindowSeconds = 60
	minCheckClientWindowSeconds     = 1
	maxCheckClientWindowSeconds     = 3600

	// DefaultCheckUpstreamLimit is the allowance across every client identity
	// together, counted in upstream calls rather than in requests, so many client
	// identities cannot multiply Graph load by simply being many.
	DefaultCheckUpstreamLimit         = 60
	minCheckUpstreamLimit             = 1
	maxCheckUpstreamLimit             = 10000
	DefaultCheckUpstreamWindowSeconds = 60
	minCheckUpstreamWindowSeconds     = 1
	maxCheckUpstreamWindowSeconds     = 3600

	// DefaultCheckUpstreamConcurrency bounds how many requests may be in the Graph
	// at once on one instance. A request over the bound is refused rather than
	// queued: see acquire.
	DefaultCheckUpstreamConcurrency = 2
	minCheckUpstreamConcurrency     = 1
	maxCheckUpstreamConcurrency     = 16

	// minCheckClientSecretBytes is the shortest keying value that makes the client
	// identity irreversible in practice. It is a floor rather than a warning: a
	// Redactor-style degradation, where a short value silently keys a weaker digest,
	// is exactly what turns a one-way representation of a visitor's address back into
	// a reversible one.
	minCheckClientSecretBytes = 32
)

// ClientKeyFunc derives the identity a request is throttled against.
//
// It returns false when the request carries no identity, which is refused rather
// than pooled: one shared bucket for every unidentifiable caller is a bucket an
// attacker can empty on everybody else's behalf.
type ClientKeyFunc func(*http.Request) (string, bool)

// CheckConfig is the whole configuration of the check path. A nil *CheckConfig on
// a Config means the deployment does not offer PathCheck at all, and the path is
// then a 404 like any other path this API does not serve.
type CheckConfig struct {
	// Upstream is the Graph client. It is injected rather than built here, and that
	// is the whole reason this package never holds the endpoint: a client cannot
	// choose the endpoint, the query, the retry policy, or the authorization,
	// because none of them are reachable from a request. checker.Client is the same
	// seam the scheduled publisher injects, so both are exercised against the same
	// local fakes.
	Upstream checker.Client

	// Store is the shared durable authority for the per-client allowance, the
	// upstream budget, and the short-lived result cache. It is required.
	//
	// It is shared rather than per instance because a per-instance limit is not the
	// limit it claims to be. A Lambda deployment runs as many instances as it is
	// given concurrency for, and each one starts with an empty map, so an allowance
	// held in process is really that allowance times however many instances a caller
	// reaches, and it resets every time one is replaced. Charging an atomic
	// conditional write against one item instead makes a cold instance and a warm one
	// spend the same allowance, and makes a window something the clock decides rather
	// than something a restart can restart. localCache is the only process-local
	// layer left, and it is an optimization over this one: see its own comment.
	Store checkstore.Store

	// MaxRequestBytes bounds the request body. It is checked against the declared
	// length before anything is read, and again while reading, because the declared
	// length is advisory.
	MaxRequestBytes int

	// MaxNames bounds the raw list a request may carry, before duplicates are
	// removed. Charging the bound against the raw list is what stops a request from
	// expanding: a caller cannot send a thousand copies of one label and have the
	// bound apply to the one that survives.
	MaxNames int

	// MaxLabelBytes bounds one normalized label.
	MaxLabelBytes int

	// BatchSize and Workers are the upstream batching and per-request concurrency.
	BatchSize int
	Workers   int

	// Retries is the transient-failure retry bound the injected Upstream is
	// expected to hold. Timeout bounds the retrying either way, so this is the
	// deployment stating its intent rather than a control this package applies.
	Retries int

	// Timeout bounds one whole request, upstream retries and backoff included.
	Timeout time.Duration

	// Soon is the expiring-soon window a fresh status is classified with. It
	// matches the publisher's, so a fresh status and a snapshot status agree.
	Soon time.Duration

	// CacheLifetime is how long a fresh answer may be served again, and also what
	// the response advertises as its own expiry. A client must refuse an expired
	// one rather than treat it as still verified. It is the shared entry's lifetime,
	// so every instance stops serving one answer at the same instant.
	CacheLifetime time.Duration

	// LocalCacheEntries bounds the process-local copy layer. It bounds a copy of
	// what Store holds and never Store itself.
	LocalCacheEntries int

	// ClientLimit and ClientWindow are one client identity's allowance, charged
	// against Store in a fixed window the clock derives.
	//
	// The documented cost of a fixed window rather than a token bucket is a bounded
	// burst of twice the limit across a window boundary, which internal/checkstore
	// pins with a test. What it buys is that a charge is one conditional write with
	// no read, no stored version, and no compare-and-swap loop, so it is correct
	// under any amount of concurrency and cannot be defeated by arriving at two
	// instances at once.
	ClientLimit  int
	ClientWindow time.Duration

	// ClientSecret keys the client identity. It is a stable deployment value, not a
	// per-process one, because the identity has to mean the same thing on every
	// instance and across a replacement: a key minted at cold start hands each new
	// instance a fresh set of allowances, which is the same bypass a per-instance map
	// is. It is required and never logged, never returned, and never part of an item.
	ClientSecret []byte

	// UpstreamLimit and UpstreamWindow bound upstream calls across every client
	// identity together, so a flood of identities cannot multiply Graph load by being
	// many. They are charged against Store for the same reason ClientLimit is.
	// UpstreamConcurrency bounds how many are in flight on this instance, which is
	// the one bound that cannot be shared: see gate.
	UpstreamLimit       int
	UpstreamWindow      time.Duration
	UpstreamConcurrency int

	// ClientKey derives the throttling identity. A nil value selects
	// DefaultClientKey, which reads the trusted transport peer or an identity a
	// trusted adapter put on the request context, and never a header.
	ClientKey ClientKeyFunc

	// Log receives one JSON object per request. A nil writer discards them. See
	// checkLogger for what a record may hold, which is counts and fixed codes and
	// nothing derived from a request or an upstream response.
	Log io.Writer
}

// LoadCheckConfig reads the check settings from a lookup function.
//
// The caller supplies Upstream and Store afterwards, because a Graph client and a
// table client are built rather than parsed. That is also what keeps the Graph
// credential out of this package altogether: no setting here holds it, nothing here
// reads THEGRAPH_API_KEY or the endpoint, and a package that never receives one
// cannot expose one. EnvCheckClientSecret is the one secret this package does read,
// it is not the Graph credential, and it never reaches a log record, a response, or
// a stored item - only the HMAC it keys does.
func LoadCheckConfig(lookup func(string) string) (CheckConfig, error) {
	if lookup == nil {
		return CheckConfig{}, fmt.Errorf("a configuration lookup is required")
	}
	get := func(name string) string { return strings.TrimSpace(lookup(name)) }

	var (
		config                                     CheckConfig
		timeoutSeconds, soonDays, cacheSeconds     int
		clientWindowSeconds, upstreamWindowSeconds int
	)
	numbers := []struct {
		name     string
		target   *int
		fallback int
		low      int
		high     int
	}{
		{EnvCheckMaxRequestBytes, &config.MaxRequestBytes, DefaultCheckMaxRequestBytes, minCheckMaxRequestBytes, maxCheckMaxRequestBytes},
		{EnvCheckMaxNames, &config.MaxNames, DefaultCheckMaxNames, minCheckMaxNames, maxCheckMaxNames},
		{EnvCheckMaxLabelBytes, &config.MaxLabelBytes, DefaultCheckMaxLabelBytes, minCheckMaxLabelBytes, maxCheckMaxLabelBytes},
		{EnvCheckBatchSize, &config.BatchSize, DefaultCheckBatchSize, minCheckBatchSize, maxCheckBatchSize},
		{EnvCheckWorkers, &config.Workers, DefaultCheckWorkers, minCheckWorkers, maxCheckWorkers},
		{EnvCheckRetries, &config.Retries, DefaultCheckRetries, minCheckRetries, maxCheckRetries},
		{EnvCheckTimeoutSeconds, &timeoutSeconds, DefaultCheckTimeoutSeconds, minCheckTimeoutSeconds, maxCheckTimeoutSeconds},
		{EnvCheckSoonDays, &soonDays, DefaultCheckSoonDays, minCheckSoonDays, maxCheckSoonDays},
		{EnvCheckCacheSeconds, &cacheSeconds, DefaultCheckCacheSeconds, minCheckCacheSeconds, maxCheckCacheSeconds},
		{EnvCheckLocalCacheEntries, &config.LocalCacheEntries, DefaultCheckLocalCacheEntries, minCheckLocalCacheEntries, maxCheckLocalCacheEntries},
		{EnvCheckClientLimit, &config.ClientLimit, DefaultCheckClientLimit, minCheckClientLimit, maxCheckClientLimit},
		{EnvCheckClientWindowSeconds, &clientWindowSeconds, DefaultCheckClientWindowSeconds, minCheckClientWindowSeconds, maxCheckClientWindowSeconds},
		{EnvCheckUpstreamLimit, &config.UpstreamLimit, DefaultCheckUpstreamLimit, minCheckUpstreamLimit, maxCheckUpstreamLimit},
		{EnvCheckUpstreamWindow, &upstreamWindowSeconds, DefaultCheckUpstreamWindowSeconds, minCheckUpstreamWindowSeconds, maxCheckUpstreamWindowSeconds},
		{EnvCheckUpstreamConcurrency, &config.UpstreamConcurrency, DefaultCheckUpstreamConcurrency, minCheckUpstreamConcurrency, maxCheckUpstreamConcurrency},
	}
	for _, number := range numbers {
		value, err := intSetting(get(number.name), number.name, number.fallback, number.low, number.high)
		if err != nil {
			return CheckConfig{}, err
		}
		*number.target = value
	}

	config.Timeout = time.Duration(timeoutSeconds) * time.Second
	config.Soon = time.Duration(soonDays) * 24 * time.Hour
	config.CacheLifetime = time.Duration(cacheSeconds) * time.Second
	config.ClientWindow = time.Duration(clientWindowSeconds) * time.Second
	config.UpstreamWindow = time.Duration(upstreamWindowSeconds) * time.Second

	// The secret is not trimmed with the others: leading and trailing bytes are part
	// of a keying value, and quietly changing it would key two deployments that were
	// configured identically to two different identities.
	if secret := lookup(EnvCheckClientSecret); secret != "" {
		config.ClientSecret = []byte(secret)
	}

	if err := config.validate(); err != nil {
		return CheckConfig{}, err
	}
	return config, nil
}

// validate rejects a configuration the check path cannot serve from. It does not
// require Upstream or Store: LoadCheckConfig runs before either is built, and New
// refuses a CheckConfig missing one.
func (c CheckConfig) validate() error {
	bounds := []struct {
		name  string
		value int
		low   int
		high  int
	}{
		{EnvCheckMaxRequestBytes, c.MaxRequestBytes, minCheckMaxRequestBytes, maxCheckMaxRequestBytes},
		{EnvCheckMaxNames, c.MaxNames, minCheckMaxNames, maxCheckMaxNames},
		{EnvCheckMaxLabelBytes, c.MaxLabelBytes, minCheckMaxLabelBytes, maxCheckMaxLabelBytes},
		{EnvCheckBatchSize, c.BatchSize, minCheckBatchSize, maxCheckBatchSize},
		{EnvCheckWorkers, c.Workers, minCheckWorkers, maxCheckWorkers},
		{EnvCheckRetries, c.Retries, minCheckRetries, maxCheckRetries},
		{EnvCheckLocalCacheEntries, c.LocalCacheEntries, minCheckLocalCacheEntries, maxCheckLocalCacheEntries},
		{EnvCheckClientLimit, c.ClientLimit, minCheckClientLimit, maxCheckClientLimit},
		{EnvCheckUpstreamLimit, c.UpstreamLimit, minCheckUpstreamLimit, maxCheckUpstreamLimit},
		{EnvCheckUpstreamConcurrency, c.UpstreamConcurrency, minCheckUpstreamConcurrency, maxCheckUpstreamConcurrency},
	}
	for _, bound := range bounds {
		if bound.value < bound.low || bound.value > bound.high {
			return fmt.Errorf("%s must be between %d and %d", bound.name, bound.low, bound.high)
		}
	}

	durations := []struct {
		name  string
		value time.Duration
		low   time.Duration
		high  time.Duration
	}{
		{EnvCheckTimeoutSeconds, c.Timeout, minCheckTimeoutSeconds * time.Second, maxCheckTimeoutSeconds * time.Second},
		{EnvCheckSoonDays, c.Soon, minCheckSoonDays * 24 * time.Hour, maxCheckSoonDays * 24 * time.Hour},
		{EnvCheckCacheSeconds, c.CacheLifetime, minCheckCacheSeconds * time.Second, maxCheckCacheSeconds * time.Second},
		{EnvCheckClientWindowSeconds, c.ClientWindow, minCheckClientWindowSeconds * time.Second, maxCheckClientWindowSeconds * time.Second},
		{EnvCheckUpstreamWindow, c.UpstreamWindow, minCheckUpstreamWindowSeconds * time.Second, maxCheckUpstreamWindowSeconds * time.Second},
	}
	for _, duration := range durations {
		if duration.value < duration.low || duration.value > duration.high {
			return fmt.Errorf("%s is outside the range %s to %s", duration.name, duration.low, duration.high)
		}
	}

	// The message names the variable and never the value or any prefix of it, for the
	// same reason internal/scanner's key check does: a rejection is written to
	// somewhere output goes and stays.
	if len(c.ClientSecret) == 0 {
		return fmt.Errorf("%s is required to key the client throttling identity", EnvCheckClientSecret)
	}
	if len(c.ClientSecret) < minCheckClientSecretBytes {
		return fmt.Errorf("%s must be at least %d bytes", EnvCheckClientSecret, minCheckClientSecretBytes)
	}

	// A request needing more upstream calls than the whole budget holds could never
	// be accepted, and internal/checkstore refuses such a charge as an error rather
	// than as a retryable refusal. Left unchecked, the endpoint would answer every
	// request with a store failure; saying so once at cold start is the whole point of
	// having a ceiling and a floor on both settings.
	perRequest := (c.MaxNames + c.BatchSize - 1) / c.BatchSize
	if int64(perRequest) > int64(c.UpstreamLimit) {
		return fmt.Errorf("%s of %d cannot cover the %d upstream calls %s of %d needs",
			EnvCheckUpstreamLimit, c.UpstreamLimit, perRequest, EnvCheckMaxNames, c.MaxNames)
	}
	return nil
}

// clientWindow and upstreamWindow are the two allowances as internal/checkstore
// windows. They are built here rather than stored so a Window can never disagree
// with the setting it came from.
func (c CheckConfig) clientWindow() checkstore.Window {
	return checkstore.Window{Limit: int64(c.ClientLimit), Period: c.ClientWindow}
}

func (c CheckConfig) upstreamWindow() checkstore.Window {
	return checkstore.Window{Limit: int64(c.UpstreamLimit), Period: c.UpstreamWindow}
}

// clientIdentityKey is the context key a trusted adapter attaches a request's
// source identity under.
//
// It is an unexported type with an unexported value, so nothing outside this
// package can construct one and nothing a client sends can land under it. The
// identity therefore comes from code that has already authenticated the transport,
// which is the property a forwarding header does not have.
type clientIdentityKey struct{}

// WithClientIdentity returns a context carrying the trusted source identity of a
// request.
//
// It is the seam an API Gateway adapter uses: the gateway signs and delivers the
// request context, an adapter reads the source identity out of it, and this carries
// that value to the handler without it ever being part of the HTTP request a caller
// controls. A blank identity is not attached, so a missing one fails closed at
// DefaultClientKey rather than becoming an empty shared bucket.
func WithClientIdentity(ctx context.Context, identity string) context.Context {
	identity = strings.TrimSpace(identity)
	if ctx == nil || identity == "" {
		return ctx
	}
	return context.WithValue(ctx, clientIdentityKey{}, identity)
}

// ContextClientKey reads the identity WithClientIdentity attached, and reports
// whether there was one.
func ContextClientKey(r *http.Request) (string, bool) {
	if r == nil || r.Context() == nil {
		return "", false
	}
	identity, ok := r.Context().Value(clientIdentityKey{}).(string)
	if !ok || identity == "" {
		return "", false
	}
	return identity, true
}

// DefaultClientKey is the identity used when a deployment configures none.
//
// It prefers what a trusted adapter attached, and falls back to the transport peer.
// Both are values this process obtained from something it trusts; neither is
// anything a caller wrote. It is deliberately not X-Forwarded-For or any other
// forwarding header: a header is chosen by the caller, so throttling on one lets a
// client mint a fresh identity per request and defeat the limit entirely.
func DefaultClientKey(r *http.Request) (string, bool) {
	if identity, ok := ContextClientKey(r); ok {
		return identity, true
	}
	return RemoteAddrClientKey(r)
}

// RemoteAddrClientKey is the transport peer.
//
// An API Gateway proxy integration sets RemoteAddr from the source address in the
// request context the gateway delivered, so the peer is the trusted value in a
// deployment as well as in a local server. WithClientIdentity exists for an adapter
// that would rather pass that value explicitly than through this field.
//
// The port is dropped: it changes per connection, and keeping it would make every
// request a new identity.
func RemoteAddrClientKey(r *http.Request) (string, bool) {
	if r == nil || r.RemoteAddr == "" {
		return "", false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		// A gateway integration may set a bare address with no port at all.
		host = strings.TrimSpace(r.RemoteAddr)
	}
	if host == "" {
		return "", false
	}
	return host, true
}

// clientHasher turns a client identity into the durable key it is throttled under.
//
// The raw address is never stored, never logged, and never returned. It is keyed
// with the deployment's own stable secret, so the value that reaches the table
// cannot be reversed into an address, and so the same visitor is the same identity
// on every instance and after every replacement. HMAC rather than a bare hash is
// what makes the first half true: an unkeyed digest of an address is undone by
// hashing the address space. A stable secret rather than a per-process one is what
// makes the second half true, and the second half is the limit actually being a
// limit.
type clientHasher struct {
	key []byte
}

// newClientHasher keys a hasher, and fails closed on a secret too short to make the
// digest irreversible. CheckConfig.validate has already refused one, so this is the
// second of two refusals rather than the only one: a caller that builds a
// CheckConfig by hand must not be able to reach a weaker key than a caller that
// loaded one from the environment.
func newClientHasher(secret []byte) (*clientHasher, error) {
	if len(secret) < minCheckClientSecretBytes {
		return nil, fmt.Errorf("%s must be at least %d bytes", EnvCheckClientSecret, minCheckClientSecretBytes)
	}
	key := make([]byte, len(secret))
	copy(key, secret)
	return &clientHasher{key: key}, nil
}

func (h *clientHasher) hash(identity string) string {
	mac := hmac.New(sha256.New, h.key)
	mac.Write([]byte(identity))
	return hex.EncodeToString(mac.Sum(nil))
}
