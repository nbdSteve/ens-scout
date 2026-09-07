package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ens-scrape/internal/checkstore"
	"ens-scrape/internal/snapshot"
)

// checkSettings is every value LoadCheckConfig parses, and nothing it does not.
//
// CheckConfig itself is not comparable: it carries an upstream client, a store, an
// identity function, a secret, and a log writer, and only the secret is parsed from
// the environment. This is the comparable part, so one comparison covers all fifteen
// bounds and a new one cannot be added without being asserted here. The secret is
// asserted separately, never by value.
type checkSettings struct {
	MaxRequestBytes     int
	MaxNames            int
	MaxLabelBytes       int
	BatchSize           int
	Workers             int
	Retries             int
	Timeout             time.Duration
	Soon                time.Duration
	CacheLifetime       time.Duration
	LocalCacheEntries   int
	ClientLimit         int
	ClientWindow        time.Duration
	UpstreamLimit       int
	UpstreamWindow      time.Duration
	UpstreamConcurrency int
}

func settingsOf(c CheckConfig) checkSettings {
	return checkSettings{
		MaxRequestBytes:     c.MaxRequestBytes,
		MaxNames:            c.MaxNames,
		MaxLabelBytes:       c.MaxLabelBytes,
		BatchSize:           c.BatchSize,
		Workers:             c.Workers,
		Retries:             c.Retries,
		Timeout:             c.Timeout,
		Soon:                c.Soon,
		CacheLifetime:       c.CacheLifetime,
		LocalCacheEntries:   c.LocalCacheEntries,
		ClientLimit:         c.ClientLimit,
		ClientWindow:        c.ClientWindow,
		UpstreamLimit:       c.UpstreamLimit,
		UpstreamWindow:      c.UpstreamWindow,
		UpstreamConcurrency: c.UpstreamConcurrency,
	}
}

// checkEnv is a valid environment with overrides applied. The secret is always
// present, because it is required: without it every subtest below would fail on the
// secret rather than on the bound it is about.
func checkEnv(overrides map[string]string) map[string]string {
	values := map[string]string{EnvCheckClientSecret: string(testCheckSecret)}
	for name, value := range overrides {
		values[name] = value
	}
	return values
}

func TestLoadCheckConfigDefaults(t *testing.T) {
	config, err := LoadCheckConfig(lookupFrom(checkEnv(nil)))
	if err != nil {
		t.Fatalf("LoadCheckConfig: %v", err)
	}

	ints := []struct {
		name string
		got  int
		want int
	}{
		{EnvCheckMaxRequestBytes, config.MaxRequestBytes, DefaultCheckMaxRequestBytes},
		{EnvCheckMaxNames, config.MaxNames, DefaultCheckMaxNames},
		{EnvCheckMaxLabelBytes, config.MaxLabelBytes, DefaultCheckMaxLabelBytes},
		{EnvCheckBatchSize, config.BatchSize, DefaultCheckBatchSize},
		{EnvCheckWorkers, config.Workers, DefaultCheckWorkers},
		{EnvCheckRetries, config.Retries, DefaultCheckRetries},
		{EnvCheckLocalCacheEntries, config.LocalCacheEntries, DefaultCheckLocalCacheEntries},
		{EnvCheckClientLimit, config.ClientLimit, DefaultCheckClientLimit},
		{EnvCheckUpstreamLimit, config.UpstreamLimit, DefaultCheckUpstreamLimit},
		{EnvCheckUpstreamConcurrency, config.UpstreamConcurrency, DefaultCheckUpstreamConcurrency},
	}
	for _, value := range ints {
		if value.got != value.want {
			t.Errorf("%s = %d, want %d", value.name, value.got, value.want)
		}
	}

	durations := []struct {
		name string
		got  time.Duration
		want time.Duration
	}{
		{EnvCheckTimeoutSeconds, config.Timeout, DefaultCheckTimeoutSeconds * time.Second},
		{EnvCheckSoonDays, config.Soon, DefaultCheckSoonDays * 24 * time.Hour},
		{EnvCheckCacheSeconds, config.CacheLifetime, DefaultCheckCacheSeconds * time.Second},
		{EnvCheckClientWindowSeconds, config.ClientWindow, DefaultCheckClientWindowSeconds * time.Second},
		{EnvCheckUpstreamWindow, config.UpstreamWindow, DefaultCheckUpstreamWindowSeconds * time.Second},
	}
	for _, value := range durations {
		if value.got != value.want {
			t.Errorf("%s = %s, want %s", value.name, value.got, value.want)
		}
	}

	// The Graph client and the store are built rather than parsed, which is what keeps
	// the Graph credential and the endpoint out of this package: no setting here holds
	// either.
	if config.Upstream != nil {
		t.Error("LoadCheckConfig produced an upstream client of its own")
	}
	if config.Store != nil {
		t.Error("LoadCheckConfig produced a store of its own")
	}
	if config.ClientKey != nil {
		t.Error("LoadCheckConfig chose a client identity function")
	}
	if config.Log != nil {
		t.Error("LoadCheckConfig chose a log writer")
	}
	if err := config.validate(); err != nil {
		t.Errorf("validate rejected the defaults: %v", err)
	}
}

func TestLoadCheckConfigReadsSettings(t *testing.T) {
	config, err := LoadCheckConfig(lookupFrom(checkEnv(map[string]string{
		EnvCheckMaxRequestBytes:     " 4096 ",
		EnvCheckMaxNames:            "10",
		EnvCheckMaxLabelBytes:       "32",
		EnvCheckBatchSize:           "5",
		EnvCheckWorkers:             "4",
		EnvCheckRetries:             "0",
		EnvCheckTimeoutSeconds:      "20",
		EnvCheckSoonDays:            "0",
		EnvCheckCacheSeconds:        "5",
		EnvCheckLocalCacheEntries:   "8",
		EnvCheckClientLimit:         "3",
		EnvCheckClientWindowSeconds: "30",
		EnvCheckUpstreamLimit:       "7",
		EnvCheckUpstreamWindow:      "15",
		EnvCheckUpstreamConcurrency: "1",
	})))
	if err != nil {
		t.Fatalf("LoadCheckConfig: %v", err)
	}

	want := checkSettings{
		MaxRequestBytes:     4096,
		MaxNames:            10,
		MaxLabelBytes:       32,
		BatchSize:           5,
		Workers:             4,
		Retries:             0,
		Timeout:             20 * time.Second,
		Soon:                0,
		CacheLifetime:       5 * time.Second,
		LocalCacheEntries:   8,
		ClientLimit:         3,
		ClientWindow:        30 * time.Second,
		UpstreamLimit:       7,
		UpstreamWindow:      15 * time.Second,
		UpstreamConcurrency: 1,
	}
	if got := settingsOf(config); got != want {
		t.Errorf("configuration = %+v, want %+v", got, want)
	}

	// The two allowances become internal/checkstore windows, built from the settings
	// rather than stored beside them, so a window can never disagree with its bound.
	if got := config.clientWindow(); got.Limit != 3 || got.Period != 30*time.Second {
		t.Errorf("clientWindow = %+v, want the client limit and window", got)
	}
	if got := config.upstreamWindow(); got.Limit != 7 || got.Period != 15*time.Second {
		t.Errorf("upstreamWindow = %+v, want the upstream limit and window", got)
	}
	for _, window := range []checkstore.Window{config.clientWindow(), config.upstreamWindow()} {
		if err := window.Validate(); err != nil {
			t.Errorf("a window built from a valid configuration is invalid: %v", err)
		}
	}
}

// TestLoadCheckConfigRejectsBadSettings covers every floor and every ceiling. A
// ceiling matters as much as a floor: a mistyped bound must not be able to remove
// a control, and a zero must not be able to disable one.
func TestLoadCheckConfigRejectsBadSettings(t *testing.T) {
	tests := []struct {
		name   string
		values map[string]string
	}{
		{"request bytes are not a number", map[string]string{EnvCheckMaxRequestBytes: "eight kilobytes"}},
		{"request bytes below the floor", map[string]string{EnvCheckMaxRequestBytes: "16"}},
		{"request bytes above the ceiling", map[string]string{EnvCheckMaxRequestBytes: "1073741824"}},
		{"no names allowed", map[string]string{EnvCheckMaxNames: "0"}},
		{"name limit above the ceiling", map[string]string{EnvCheckMaxNames: "1000"}},
		{"empty labels allowed", map[string]string{EnvCheckMaxLabelBytes: "0"}},
		{"label bytes above the ceiling", map[string]string{EnvCheckMaxLabelBytes: "4096"}},
		{"empty batches", map[string]string{EnvCheckBatchSize: "0"}},
		{"batch above the subgraph limit", map[string]string{EnvCheckBatchSize: "5000"}},
		{"no workers", map[string]string{EnvCheckWorkers: "0"}},
		{"workers above the ceiling", map[string]string{EnvCheckWorkers: "64"}},
		{"negative retries", map[string]string{EnvCheckRetries: "-1"}},
		{"retries above the ceiling", map[string]string{EnvCheckRetries: "50"}},
		{"no timeout", map[string]string{EnvCheckTimeoutSeconds: "0"}},
		{"timeout above the ceiling", map[string]string{EnvCheckTimeoutSeconds: "600"}},
		{"negative expiring-soon window", map[string]string{EnvCheckSoonDays: "-1"}},
		{"expiring-soon window above the ceiling", map[string]string{EnvCheckSoonDays: "3650"}},
		{"no cache lifetime", map[string]string{EnvCheckCacheSeconds: "0"}},
		{"cache lifetime above the ceiling", map[string]string{EnvCheckCacheSeconds: "86400"}},
		{"no local copies", map[string]string{EnvCheckLocalCacheEntries: "0"}},
		{"local copies above the ceiling", map[string]string{EnvCheckLocalCacheEntries: "1048576"}},
		{"no client allowance", map[string]string{EnvCheckClientLimit: "0"}},
		{"client allowance above the ceiling", map[string]string{EnvCheckClientLimit: "1000"}},
		{"no client window", map[string]string{EnvCheckClientWindowSeconds: "0"}},
		{"client window above the ceiling", map[string]string{EnvCheckClientWindowSeconds: "86400"}},
		{"no upstream budget", map[string]string{EnvCheckUpstreamLimit: "0"}},
		{"upstream budget above the ceiling", map[string]string{EnvCheckUpstreamLimit: "100000"}},
		{"no upstream window", map[string]string{EnvCheckUpstreamWindow: "0"}},
		{"upstream window above the ceiling", map[string]string{EnvCheckUpstreamWindow: "86400"}},
		{"no upstream concurrency", map[string]string{EnvCheckUpstreamConcurrency: "0"}},
		{"upstream concurrency above the ceiling", map[string]string{EnvCheckUpstreamConcurrency: "128"}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			config, err := LoadCheckConfig(lookupFrom(checkEnv(test.values)))
			if err == nil {
				t.Fatalf("LoadCheckConfig accepted %v", test.values)
			}
			// A refused load returns nothing usable, so a caller that ignores the error
			// cannot end up serving with one bound quietly set to zero.
			if got := settingsOf(config); got != (checkSettings{}) {
				t.Errorf("a refused load returned %+v, want a zero configuration", got)
			}
			if len(config.ClientSecret) != 0 {
				t.Error("a refused load returned the secret")
			}
			for name := range test.values {
				if !strings.Contains(err.Error(), name) {
					t.Errorf("error %q does not name %s", err, name)
				}
			}
		})
	}
}

// TestLoadCheckConfigRequiresAClientSecret is the fail-closed half of the keying
// rule. A deployment with no secret, or one too short to make the digest
// irreversible, does not serve the path at all: it must not fall back to an unkeyed
// digest, a fixed value, or a value minted per process, because each of those is a
// different way of not having the limit the secret makes possible.
func TestLoadCheckConfigRequiresAClientSecret(t *testing.T) {
	tests := []struct {
		name   string
		secret string
	}{
		{"absent", ""},
		{"one byte short", strings.Repeat("k", minCheckClientSecretBytes-1)},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			values := map[string]string{}
			if test.secret != "" {
				values[EnvCheckClientSecret] = test.secret
			}
			_, err := LoadCheckConfig(lookupFrom(values))
			if err == nil {
				t.Fatal("LoadCheckConfig accepted a configuration it cannot key an identity under")
			}
			if !strings.Contains(err.Error(), EnvCheckClientSecret) {
				t.Errorf("error %q does not name %s", err, EnvCheckClientSecret)
			}
			// The rejection names the variable and never the value or any prefix of it, for
			// the same reason internal/scanner's key check does: it goes somewhere output
			// goes and stays.
			if test.secret != "" && strings.Contains(err.Error(), test.secret) {
				t.Errorf("error %q quotes the secret", err)
			}
			for size := 4; size <= len(test.secret); size++ {
				if strings.Contains(err.Error(), test.secret[:size]) {
					t.Errorf("error %q quotes a prefix of the secret", err)
				}
			}
		})
	}
}

// TestLoadCheckConfigKeepsTheSecretExactly covers the one setting that is not
// trimmed. Leading and trailing bytes are part of a keying value, so trimming would
// key two deployments that were configured identically to two different identities,
// and every stored digest on one of them would be unreachable.
func TestLoadCheckConfigKeepsTheSecretExactly(t *testing.T) {
	padded := " " + strings.Repeat("s", minCheckClientSecretBytes) + " "
	config, err := LoadCheckConfig(lookupFrom(map[string]string{EnvCheckClientSecret: padded}))
	if err != nil {
		t.Fatalf("LoadCheckConfig: %v", err)
	}
	if string(config.ClientSecret) != padded {
		t.Errorf("the secret was altered: %d bytes stored, %d configured",
			len(config.ClientSecret), len(padded))
	}
}

// TestLoadCheckConfigRefusesABudgetTooSmallForOneRequest covers the one rule that
// spans two settings. Left unchecked, a budget smaller than one request needs would
// make internal/checkstore refuse every charge as an error, so the endpoint would
// answer every request with a store failure; saying so once at cold start is what
// the two bounds exist for.
func TestLoadCheckConfigRefusesABudgetTooSmallForOneRequest(t *testing.T) {
	_, err := LoadCheckConfig(lookupFrom(checkEnv(map[string]string{
		EnvCheckMaxNames:      "10",
		EnvCheckBatchSize:     "2",
		EnvCheckUpstreamLimit: "4",
	})))
	if err == nil {
		t.Fatal("LoadCheckConfig accepted a budget smaller than one request")
	}
	for _, name := range []string{EnvCheckUpstreamLimit, EnvCheckMaxNames} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("error %q does not name %s", err, name)
		}
	}

	// Exactly enough is accepted, so the rule is a floor and not a margin.
	if _, err := LoadCheckConfig(lookupFrom(checkEnv(map[string]string{
		EnvCheckMaxNames:      "10",
		EnvCheckBatchSize:     "2",
		EnvCheckUpstreamLimit: "5",
	}))); err != nil {
		t.Errorf("LoadCheckConfig refused a budget that covers exactly one request: %v", err)
	}
}

func TestLoadCheckConfigRequiresALookup(t *testing.T) {
	if _, err := LoadCheckConfig(nil); err == nil {
		t.Fatal("LoadCheckConfig accepted a nil lookup")
	}
}

// TestCheckConfigIsValidatedByNew ties the bounds above to the handler: a
// deployment that mistypes one fails at cold start rather than on a request.
func TestCheckConfigIsValidatedByNew(t *testing.T) {
	base := func() Config {
		config := testConfig(snapshot.NewMemoryStore(), testNow)
		check := testCheckConfig(newFakeGraph(), checkstore.NewMemoryStore(), nil)
		config.Check = &check
		return config
	}

	if _, err := New(base()); err != nil {
		t.Fatalf("New rejected a valid check configuration: %v", err)
	}

	config := base()
	config.Check.UpstreamConcurrency = 0
	_, err := New(config)
	if err == nil {
		t.Fatal("New accepted an unbounded upstream concurrency")
	}
	if !strings.Contains(err.Error(), EnvCheckUpstreamConcurrency) {
		t.Errorf("error %q does not name %s", err, EnvCheckUpstreamConcurrency)
	}

	// A configured path with no client would answer every request with an upstream
	// failure, so it is refused once at startup instead.
	config = base()
	config.Check.Upstream = nil
	if _, err := New(config); err == nil {
		t.Fatalf("New accepted %s with no upstream client", PathCheck)
	}

	// A configured path with no store would hold its allowances in process, which is
	// the bypass the shared store exists to close, so it is refused rather than
	// degraded.
	config = base()
	config.Check.Store = nil
	if _, err := New(config); err == nil {
		t.Fatalf("New accepted %s with its limits held in process", PathCheck)
	}

	// And one that cannot key an identity does not serve the path either, because the
	// alternative is throttling every visitor as one identity or none.
	config = base()
	config.Check.ClientSecret = []byte("short")
	if _, err := New(config); err == nil {
		t.Fatalf("New accepted %s with a secret too short to key an identity", PathCheck)
	}
}

// TestNewCopiesTheCheckConfig keeps a caller from being able to widen a bound
// after the handler was built, which would make the validation above advisory.
func TestNewCopiesTheCheckConfig(t *testing.T) {
	config := testConfig(snapshot.NewMemoryStore(), testNow)
	check := testCheckConfig(newFakeGraph(), checkstore.NewMemoryStore(), nil)
	config.Check = &check

	handler, err := New(config)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	check.MaxNames = maxCheckMaxNames
	if handler.check.MaxNames == check.MaxNames {
		t.Error("editing the caller's configuration changed the handler's bound")
	}
}

func TestRemoteAddrClientKey(t *testing.T) {
	tests := []struct {
		name    string
		address string
		want    string
		ok      bool
	}{
		{"host and port", "198.51.100.7:54321", "198.51.100.7", true},
		// A gateway integration may present a bare address with no port at all.
		{"bare address", "198.51.100.7", "198.51.100.7", true},
		{"bracketed IPv6", "[2001:db8::1]:443", "2001:db8::1", true},
		{"bare IPv6", "2001:db8::1", "2001:db8::1", true},
		{"padded address", "  198.51.100.7  ", "198.51.100.7", true},
		// No identity at all is refused rather than pooled, because one shared bucket
		// for every unidentifiable caller is a bucket anybody can empty.
		{"no address", "", "", false},
		{"only whitespace", "   ", "", false},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, PathCheck, nil)
			request.RemoteAddr = test.address

			key, ok := RemoteAddrClientKey(request)
			if ok != test.ok {
				t.Fatalf("RemoteAddrClientKey(%q) ok = %v, want %v", test.address, ok, test.ok)
			}
			if key != test.want {
				t.Errorf("RemoteAddrClientKey(%q) = %q, want %q", test.address, key, test.want)
			}
		})
	}

	if _, ok := RemoteAddrClientKey(nil); ok {
		t.Error("RemoteAddrClientKey accepted a nil request")
	}
}

// TestClientIdentityContext covers the seam a gateway adapter delivers a trusted
// source identity through. It is an unexported context key, so nothing outside this
// package can construct one and nothing a caller writes can land under it, which is
// the whole difference between this and a forwarding header.
func TestClientIdentityContext(t *testing.T) {
	request := func(ctx context.Context, peer string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, PathCheck, nil)
		r.RemoteAddr = peer
		if ctx != nil {
			r = r.WithContext(ctx)
		}
		return r
	}

	// An attached identity wins over the transport peer, because behind a gateway the
	// peer is the gateway.
	attached := WithClientIdentity(context.Background(), "gateway-caller")
	if key, ok := ContextClientKey(request(attached, "10.0.0.1:1000")); !ok || key != "gateway-caller" {
		t.Errorf("ContextClientKey = %q, %v, want the attached identity", key, ok)
	}
	if key, ok := DefaultClientKey(request(attached, "10.0.0.1:1000")); !ok || key != "gateway-caller" {
		t.Errorf("DefaultClientKey = %q, %v, want the attached identity", key, ok)
	}

	// It is trimmed once, on the way in, so one identity cannot become several by
	// being padded differently.
	padded := WithClientIdentity(context.Background(), "  gateway-caller  ")
	if key, _ := ContextClientKey(request(padded, "")); key != "gateway-caller" {
		t.Errorf("a padded identity became %q", key)
	}

	// A blank one is not attached at all, so a missing identity falls through to the
	// peer and then fails closed rather than becoming an empty shared bucket.
	for _, identity := range []string{"", "   "} {
		ctx := WithClientIdentity(context.Background(), identity)
		if _, ok := ContextClientKey(request(ctx, "")); ok {
			t.Errorf("a blank identity %q was attached", identity)
		}
		if key, ok := DefaultClientKey(request(ctx, "198.51.100.9:1000")); !ok || key != "198.51.100.9" {
			t.Errorf("DefaultClientKey = %q, %v, want the transport peer", key, ok)
		}
		if _, ok := DefaultClientKey(request(ctx, "")); ok {
			t.Error("DefaultClientKey invented an identity for a request that carries none")
		}
	}

	// A nil context is not a place to put one.
	if ctx := WithClientIdentity(nil, "gateway-caller"); ctx != nil {
		t.Error("WithClientIdentity built a context out of nothing")
	}
	if _, ok := ContextClientKey(nil); ok {
		t.Error("ContextClientKey accepted a nil request")
	}
	if _, ok := DefaultClientKey(nil); ok {
		t.Error("DefaultClientKey accepted a nil request")
	}
}

// TestCheckUsesTheConfiguredClientKey proves the identity function is a seam a
// deployment supplies, which is how a gateway's own trusted context reaches the
// throttle without this package reading a header.
func TestCheckUsesTheConfiguredClientKey(t *testing.T) {
	var asked int
	harness := newCheckHarness(t, func(check *CheckConfig) {
		check.ClientLimit = 1
		check.ClientKey = func(r *http.Request) (string, bool) {
			asked++
			// Deliberately constant: every request is one identity, so the second one is
			// throttled however it arrived.
			return "gateway-context", true
		}
	})

	first := checkNames(harness.handler, []string{"zap"}, fromClient("198.51.100.1:1111"))
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d, want %d (body %s)", first.Code, http.StatusOK, first.Body)
	}
	second := checkNames(harness.handler, []string{"abc"}, fromClient("198.51.100.2:2222"))
	decodeFailure(t, second, http.StatusTooManyRequests, CodeClientThrottled)

	if asked != 2 {
		t.Errorf("the configured identity function was asked %d times, want 2", asked)
	}

	// One identity, so one counter, and it holds the whole allowance.
	key := harness.handler.clientHash.hash("gateway-context")
	if spent := harness.store.Spent(checkstore.KindClient, key, checkTime, harness.config.clientWindow()); spent != 1 {
		t.Errorf("the configured identity holds %d of the allowance, want 1", spent)
	}
}
