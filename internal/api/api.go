// Package api serves the published ENS snapshot over HTTP.
//
// It is the read half of the website. A browser fetches one snapshot, keeps it
// locally, and does every filter, sort, and countdown itself, so ordinary
// browsing never reaches DynamoDB or The Graph. This package therefore does two
// things and no more: it resolves the snapshot the latest pointer names, and it
// answers conditionally so an unchanged snapshot is never retransmitted.
//
// It adds no ENS logic. Lifecycle classification, checksums, chunk assembly, and
// canonical serialization are all internal/snapshot. The body returned for
// GET /api/snapshot is byte-identical to the canonical JSON that was published,
// so its SHA-256 is the checksum the latest pointer carries.
//
// It is not an availability authority. The subgraph is an index rather than the
// registration authority, and a snapshot is one scan of that index at one
// instant, so every response carries the scan time and the Advisory below.
//
// Nothing here depends on AWS or on any outbound HTTP client. The store is the
// read-only half of the snapshot contract, so the whole surface is exercised
// against snapshot.MemoryStore with no network and no credentials.
package api

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"ens-scrape/internal/checkstore"
	"ens-scrape/internal/snapshot"
)

// Request paths. An unknown path is a 404 rather than a prefix match, so no future
// path can be reached by accident. PathCheck is in checkconfig.go, beside the
// bounds that govern it, and a deployment that configures no upstream client does
// not serve it at all.
const (
	// PathSnapshot returns the whole published snapshot.
	PathSnapshot = "/api/snapshot"
	// PathMeta returns the snapshot summary without its results.
	PathMeta = "/api/snapshot/meta"
	// PathHealth reports whether a complete snapshot is being served.
	PathHealth = "/health"
)

// Advisory is on every response this package composes, and in a header on the
// snapshot body. The subgraph is an index, so a result here is a scan of an index
// at one instant and never a promise that a name can be registered now.
const Advisory = "The ENS subgraph is an index and not the registration authority. " +
	"Confirm availability and price with ENS before registering."

// AdvisoryHeader carries Advisory on the snapshot body, whose bytes are the
// published canonical JSON and so cannot be wrapped in an envelope.
const AdvisoryHeader = "X-Snapshot-Advisory"

// Environment variable names. A deployment reads its whole configuration from the
// environment once, at cold start, through LoadConfig.
const (
	EnvAllowedOrigins = "ENS_API_ALLOWED_ORIGINS"
	EnvMaxBodyBytes   = "ENS_API_MAX_BODY_BYTES"
	EnvCacheSeconds   = "ENS_API_CACHE_SECONDS"
	EnvRetrySeconds   = "ENS_API_RETRY_AFTER_SECONDS"
)

// Configuration bounds and defaults. Every setting has a ceiling as well as a
// floor, because a mistyped environment variable must not be able to turn a
// bounded response into an unbounded one.
const (
	// DefaultMaxBodyBytes bounds the snapshot body. The current three-, four-, and
	// five-letter lists serialize to a few megabytes, so this leaves room for
	// several times the planned scan while staying far below snapshot.MaxRawBytes,
	// which bounds decompression rather than a response.
	DefaultMaxBodyBytes = 16 * 1024 * 1024
	minMaxBodyBytes     = 64 * 1024
	maxMaxBodyBytes     = snapshot.MaxRawBytes

	// DefaultCacheSeconds is short next to the three-hourly cadence on purpose. A
	// client revalidates cheaply with If-None-Match and gets a 304, so the freshness
	// window costs one conditional request rather than a retransmitted snapshot.
	DefaultCacheSeconds = 60
	maxCacheSeconds     = 3600

	// DefaultRetrySeconds is what a client is told to wait when nothing valid is
	// published. Every 503 except CodeTooLarge is transient from the client's point
	// of view and carries it: the next scheduled scan republishes. CodeTooLarge
	// carries none, because no scan can shrink a published snapshot below this
	// deployment's EnvMaxBodyBytes and only raising that setting clears it.
	DefaultRetrySeconds = 60
	maxRetrySeconds     = 3600
)

// Config is the whole configuration of a Handler.
type Config struct {
	// Store is the read-only half of the snapshot contract. It is deliberately not
	// a snapshot.Store: a serving path must not be able to write a chunk, remove
	// one, or move the latest pointer.
	Store snapshot.Reader

	// AllowedOrigins is the exact set of browser origins CORS accepts, normally the
	// deployed frontend and a local development origin. Matching is exact: there is
	// no wildcard, no suffix rule, and "*" is refused at startup. An empty set means
	// no browser origin is accepted, which is the safe default; a non-browser client
	// is unaffected, because CORS only ever grants access it would otherwise deny.
	AllowedOrigins []string

	// MaxBodyBytes bounds the snapshot body. It is checked against the pointer's
	// declared raw size before any chunk is fetched, so an oversized snapshot bounds
	// the work as well as the response.
	MaxBodyBytes int

	// CacheSeconds is the max-age on a snapshot and metadata response.
	CacheSeconds int

	// RetrySeconds is the Retry-After on a response that has no snapshot to serve.
	RetrySeconds int

	// Check configures PathCheck. A nil value means this deployment serves the
	// published snapshot only, and PathCheck is then a 404 like any other path this
	// API does not serve, so a read-only deployment cannot be made to reach The Graph
	// by request.
	Check *CheckConfig

	// Now is the clock.
	//
	// Nothing cacheable depends on it. It resolves the age on /health, which is
	// uncacheable for exactly that reason, and it drives the check path's throttle
	// windows, result-cache expiry, and classification instant, none of which reach a
	// cacheable response either: a check response is no-store, and the instant it
	// carries is stated rather than resolved.
	Now func() time.Time
}

// LoadConfig reads the settings from a lookup function, which is os.Getenv in a
// deployment and a map in tests, so no test has to mutate process state. The
// caller supplies Store afterwards, because a store is built rather than parsed.
func LoadConfig(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("a configuration lookup is required")
	}
	get := func(name string) string { return strings.TrimSpace(lookup(name)) }

	config := Config{AllowedOrigins: splitOrigins(get(EnvAllowedOrigins))}

	numbers := []struct {
		name     string
		target   *int
		fallback int
		low      int
		high     int
	}{
		{EnvMaxBodyBytes, &config.MaxBodyBytes, DefaultMaxBodyBytes, minMaxBodyBytes, maxMaxBodyBytes},
		{EnvCacheSeconds, &config.CacheSeconds, DefaultCacheSeconds, 0, maxCacheSeconds},
		{EnvRetrySeconds, &config.RetrySeconds, DefaultRetrySeconds, 1, maxRetrySeconds},
	}
	for _, number := range numbers {
		value, err := intSetting(get(number.name), number.name, number.fallback, number.low, number.high)
		if err != nil {
			return Config{}, err
		}
		*number.target = value
	}

	if err := config.validateSettings(); err != nil {
		return Config{}, err
	}
	return config, nil
}

// splitOrigins parses a comma-separated origin list, ignoring empty entries so a
// trailing comma is not an error.
func splitOrigins(value string) []string {
	if value == "" {
		return nil
	}
	origins := make([]string, 0, 2)
	for _, origin := range strings.Split(value, ",") {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			continue
		}
		origins = append(origins, origin)
	}
	return origins
}

func intSetting(value, name string, fallback, low, high int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be a whole number", name)
	}
	if parsed < low || parsed > high {
		return 0, fmt.Errorf("%s must be between %d and %d", name, low, high)
	}
	return parsed, nil
}

// Validate rejects a configuration a Handler cannot serve from.
func (c Config) Validate() error {
	if c.Store == nil {
		return fmt.Errorf("a snapshot store is required")
	}
	if c.Check != nil {
		// A configured check path with no client would answer every request with an
		// upstream failure. Refusing at cold start says so once instead.
		if c.Check.Upstream == nil {
			return fmt.Errorf("%s needs an upstream ENS client", PathCheck)
		}
		// And one with no shared store would answer every request with a store failure,
		// which is the right refusal but the wrong place to discover it. The store is
		// required rather than optional deliberately: a deployment must not be able to
		// serve this path with its limits held in process, because that is the bypass a
		// shared store exists to close.
		if c.Check.Store == nil {
			return fmt.Errorf("%s needs a shared check store", PathCheck)
		}
		if err := c.Check.validate(); err != nil {
			return err
		}
	}
	return c.validateSettings()
}

// validateSettings checks everything except the store, so LoadConfig can fail on
// a bad environment before a store has been built.
func (c Config) validateSettings() error {
	if c.MaxBodyBytes < minMaxBodyBytes || c.MaxBodyBytes > maxMaxBodyBytes {
		return fmt.Errorf("%s must be between %d and %d", EnvMaxBodyBytes, minMaxBodyBytes, maxMaxBodyBytes)
	}
	if c.CacheSeconds < 0 || c.CacheSeconds > maxCacheSeconds {
		return fmt.Errorf("%s must be between 0 and %d", EnvCacheSeconds, maxCacheSeconds)
	}
	if c.RetrySeconds < 1 || c.RetrySeconds > maxRetrySeconds {
		return fmt.Errorf("%s must be between 1 and %d", EnvRetrySeconds, maxRetrySeconds)
	}
	seen := make(map[string]struct{}, len(c.AllowedOrigins))
	for _, origin := range c.AllowedOrigins {
		if err := validateOrigin(origin); err != nil {
			return err
		}
		if _, exists := seen[origin]; exists {
			return fmt.Errorf("%s lists origin %q twice", EnvAllowedOrigins, origin)
		}
		seen[origin] = struct{}{}
	}
	return nil
}

// validateOrigin requires a serialized origin: a scheme, a host, and nothing
// else. A wildcard is refused rather than normalized, because "*" on a response
// this API can serve would grant every site on the internet read access to it.
func validateOrigin(origin string) error {
	if origin == "" {
		return fmt.Errorf("%s must not contain an empty origin", EnvAllowedOrigins)
	}
	if origin == "*" || strings.Contains(origin, "*") {
		return fmt.Errorf("%s must list exact origins: %q is not one", EnvAllowedOrigins, origin)
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return fmt.Errorf("%s holds an unparseable origin %q", EnvAllowedOrigins, origin)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("origin %q must use http or https", origin)
	}
	if parsed.Host == "" {
		return fmt.Errorf("origin %q needs a host", origin)
	}
	if parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return fmt.Errorf("origin %q must be a scheme and host only", origin)
	}
	return nil
}

// Handler serves the read API.
//
// It holds one cached snapshot, which is the bound: there is one latest pointer,
// so one entry is everything a reader can be serving. Every request still reads
// the pointer, and the cache is used only when the pointer is byte-for-byte the
// one the cached snapshot was verified against, so a publication cannot be served
// past and a rolled-back pointer cannot be served from a stale entry.
type Handler struct {
	config       Config
	cacheControl string

	// corsMethods and corsHeaders are the union of what this deployment serves, so a
	// browser is told about PathCheck only where it exists.
	corsMethods string
	corsHeaders string

	// mutex is held across the whole resolve, including the store reads. That
	// bounds concurrent chunk fetches to one per instance: a burst against a cold
	// cache costs one read of the snapshot rather than one per request.
	mutex  sync.Mutex
	cached *cachedSnapshot

	// The check path, or nil where the deployment does not offer one. Every piece of
	// it is built once, at cold start, so no request allocates one and no request can
	// widen one.
	//
	// checkStore is the authority for both allowances and for the result cache, and it
	// is shared and durable. localResults is a copy of what it holds and upstreamGate
	// counts this instance's in-flight requests; those two are the only per-instance
	// state here, and neither is an allowance.
	check        *CheckConfig
	checkStore   checkstore.Store
	localResults *localCache
	upstreamGate *gate
	clientHash   *clientHasher
	checkLog     *checkLogger
}

// New returns a Handler for a validated configuration.
func New(config Config) (*Handler, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	handler := &Handler{
		config: config,
		// must-revalidate keeps a shared cache from serving a stale snapshot without
		// asking, which is what makes a short max-age safe rather than a guess.
		cacheControl: fmt.Sprintf("public, max-age=%d, must-revalidate", config.CacheSeconds),
		corsMethods:  allowedMethods,
		corsHeaders:  corsRequestHeaders,
	}
	if config.Check == nil {
		return handler, nil
	}

	check := *config.Check
	hasher, err := newClientHasher(check.ClientSecret)
	if err != nil {
		// Failing closed rather than falling back to an unkeyed or a per-process key.
		// An unkeyed digest of an address is undone by hashing the address space, and a
		// per-process key hands every new instance a fresh set of allowances.
		return nil, err
	}
	handler.check = &check
	handler.checkStore = check.Store
	handler.clientHash = hasher
	handler.upstreamGate = newGate(check.UpstreamConcurrency)
	handler.localResults = newLocalCache(check.LocalCacheEntries)
	handler.checkLog = newCheckLogger(check.Log, config.Now)

	// A browser sending a JSON body needs Content-Type through the preflight, and it
	// needs POST among the methods. Both are advertised only here, so a deployment
	// serving the snapshot alone does not describe a surface it does not have.
	handler.corsMethods = allowedMethods + ", " + http.MethodPost
	handler.corsHeaders = corsRequestHeaders + ", Content-Type"
	return handler, nil
}

// ServeHTTP routes one request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	// Vary is set on every response, including the ones that carry no CORS headers,
	// so a shared cache can never hand an origin-specific response to another origin.
	header.Set("Vary", "Origin")
	h.applyCORS(header, r.Header.Get("Origin"))

	// The path is resolved before the method, so an unknown path is a 404 on every
	// method including OPTIONS. A preflight that answered 204 for a path this API
	// does not serve would let a browser discover a future endpoint before it exists.
	serves, known := h.routeFor(r.URL.Path)
	if !known {
		h.writeFailure(w, r, failureNotFound)
		return
	}

	if r.Method == http.MethodOptions {
		// A preflight from a disallowed origin still gets 204 and simply carries no
		// grant, which is what the browser needs to refuse the real request. Saying
		// more would only tell an unknown origin which origins are configured.
		header.Set("Allow", serves.methods)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !methodAllowed(serves.methods, r.Method) {
		header.Set("Allow", serves.methods)
		h.writeFailure(w, r, serves.notAllowed)
		return
	}

	switch r.URL.Path {
	case PathSnapshot:
		h.serveSnapshot(w, r)
	case PathMeta:
		h.serveMeta(w, r)
	case PathHealth:
		h.serveHealth(w, r)
	case PathCheck:
		h.serveCheck(w, r)
	}
}

// route is what this API serves at one path.
type route struct {
	// methods is the Allow header, and it is also what methodAllowed reads, so the
	// header and the decision cannot disagree.
	methods string
	// notAllowed is the 405 for this path, worded for the methods above.
	notAllowed failure
}

// routeFor reports what this API serves at path, and whether it serves it at all.
func (h *Handler) routeFor(path string) (route, bool) {
	switch path {
	case PathSnapshot, PathMeta, PathHealth:
		return route{methods: allowedMethods, notAllowed: failureMethodNotAllowed}, true
	case PathCheck:
		if h.check == nil {
			// A deployment with no upstream client does not offer this path. It is a 404
			// rather than a 405, because a 405 would say the endpoint exists and was
			// merely addressed with the wrong method.
			return route{}, false
		}
		return route{methods: checkMethods, notAllowed: failureCheckMethodNotAllowed}, true
	}
	return route{}, false
}

// methodAllowed reads the same list the Allow header carries.
func methodAllowed(methods, method string) bool {
	for _, allowed := range strings.Split(methods, ", ") {
		if allowed == method {
			return true
		}
	}
	return false
}

const allowedMethods = "GET, HEAD, OPTIONS"

// checkMethods is what PathCheck serves. A fresh check is a POST and deliberately
// not a GET: a GET is cacheable and shareable by URL, so a shared cache or a link
// would hand a later visitor a verification instant nothing verified for them.
const checkMethods = "POST, OPTIONS"

// corsExposedHeaders are the response headers a browser may read. ETag is the one
// a conditional request depends on, and a browser cannot see it unless it is
// exposed explicitly.
const corsExposedHeaders = "ETag, Last-Modified, Retry-After, " + AdvisoryHeader

// corsRequestHeaders are the request headers a browser may send on a read. New
// appends Content-Type where PathCheck is served.
const corsRequestHeaders = "If-None-Match, If-Modified-Since"

// applyCORS grants access to a configured origin and to nothing else. A request
// with no Origin, or one this API was not configured for, gets no grant at all
// rather than a wildcard.
func (h *Handler) applyCORS(header http.Header, origin string) {
	if origin == "" || !h.originAllowed(origin) {
		return
	}
	header.Set("Access-Control-Allow-Origin", origin)
	header.Set("Access-Control-Allow-Methods", h.corsMethods)
	header.Set("Access-Control-Allow-Headers", h.corsHeaders)
	header.Set("Access-Control-Expose-Headers", corsExposedHeaders)
	header.Set("Access-Control-Max-Age", "600")
}

// originAllowed compares byte for byte. An origin is a scheme, host, and port, so
// there is no normalization to do and any looser match would widen access.
func (h *Handler) originAllowed(origin string) bool {
	for _, allowed := range h.config.AllowedOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}

// serveSnapshot returns the published canonical JSON unchanged. Nothing is added
// to it, so the response bytes hash to the checksum in the latest pointer and a
// client can verify what it received.
func (h *Handler) serveSnapshot(w http.ResponseWriter, r *http.Request) {
	cached, failure := h.resolve(r.Context())
	if failure != nil {
		h.writeFailure(w, r, *failure)
		return
	}
	w.Header().Set(AdvisoryHeader, Advisory)
	h.writeCached(w, r, cached, cached.body)
}

// serveMeta returns the summary a client polls to decide whether to download a
// replacement snapshot.
func (h *Handler) serveMeta(w http.ResponseWriter, r *http.Request) {
	cached, failure := h.resolve(r.Context())
	if failure != nil {
		h.writeFailure(w, r, *failure)
		return
	}
	h.writeCached(w, r, cached, cached.meta)
}
