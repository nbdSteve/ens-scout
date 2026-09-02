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

	"ens-scrape/internal/snapshot"
)

// Request paths. There are three, and an unknown path is a 404 rather than a
// prefix match, so no future path can be reached by accident.
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
	// published. Every such failure is transient from the client's point of view:
	// the next scheduled scan republishes.
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

	// Now is the clock. It is used only for the resolved age on /health, which is
	// uncacheable for exactly that reason; nothing cacheable depends on it.
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

	// mutex is held across the whole resolve, including the store reads. That
	// bounds concurrent chunk fetches to one per instance: a burst against a cold
	// cache costs one read of the snapshot rather than one per request.
	mutex  sync.Mutex
	cached *cachedSnapshot
}

// New returns a Handler for a validated configuration.
func New(config Config) (*Handler, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &Handler{
		config: config,
		// must-revalidate keeps a shared cache from serving a stale snapshot without
		// asking, which is what makes a short max-age safe rather than a guess.
		cacheControl: fmt.Sprintf("public, max-age=%d, must-revalidate", config.CacheSeconds),
	}, nil
}

// ServeHTTP routes one request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	// Vary is set on every response, including the ones that carry no CORS headers,
	// so a shared cache can never hand an origin-specific response to another origin.
	header.Set("Vary", "Origin")
	h.applyCORS(header, r.Header.Get("Origin"))

	if r.Method == http.MethodOptions {
		// A preflight from a disallowed origin still gets 204 and simply carries no
		// grant, which is what the browser needs to refuse the real request. Saying
		// more would only tell an unknown origin which origins are configured.
		header.Set("Allow", allowedMethods)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		header.Set("Allow", allowedMethods)
		h.writeFailure(w, r, failureMethodNotAllowed)
		return
	}

	switch r.URL.Path {
	case PathSnapshot:
		h.serveSnapshot(w, r)
	case PathMeta:
		h.serveMeta(w, r)
	case PathHealth:
		h.serveHealth(w, r)
	default:
		h.writeFailure(w, r, failureNotFound)
	}
}

const allowedMethods = "GET, HEAD, OPTIONS"

// corsExposedHeaders are the response headers a browser may read. ETag is the one
// a conditional request depends on, and a browser cannot see it unless it is
// exposed explicitly.
const corsExposedHeaders = "ETag, Last-Modified, Retry-After, " + AdvisoryHeader

// applyCORS grants access to a configured origin and to nothing else. A request
// with no Origin, or one this API was not configured for, gets no grant at all
// rather than a wildcard.
func (h *Handler) applyCORS(header http.Header, origin string) {
	if origin == "" || !h.originAllowed(origin) {
		return
	}
	header.Set("Access-Control-Allow-Origin", origin)
	header.Set("Access-Control-Allow-Methods", allowedMethods)
	header.Set("Access-Control-Allow-Headers", "If-None-Match, If-Modified-Since")
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
