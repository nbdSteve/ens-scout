package api

import (
	"strings"
	"testing"

	"ens-scrape/internal/snapshot"
)

// lookupFrom turns a map into the lookup LoadConfig takes, so no test has to
// mutate process environment state.
func lookupFrom(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestLoadConfigDefaults(t *testing.T) {
	config, err := LoadConfig(lookupFrom(nil))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if config.MaxBodyBytes != DefaultMaxBodyBytes {
		t.Errorf("MaxBodyBytes = %d, want %d", config.MaxBodyBytes, DefaultMaxBodyBytes)
	}
	if config.CacheSeconds != DefaultCacheSeconds {
		t.Errorf("CacheSeconds = %d, want %d", config.CacheSeconds, DefaultCacheSeconds)
	}
	if config.RetrySeconds != DefaultRetrySeconds {
		t.Errorf("RetrySeconds = %d, want %d", config.RetrySeconds, DefaultRetrySeconds)
	}
	// No configured origin means no browser origin is granted, which is the safe
	// default: a deployment has to name its frontend before a browser can read it.
	if len(config.AllowedOrigins) != 0 {
		t.Errorf("AllowedOrigins = %v, want none by default", config.AllowedOrigins)
	}
	// A store is built rather than parsed, so LoadConfig leaves it unset and
	// Validate is what refuses to serve without one.
	if err := config.Validate(); err == nil {
		t.Error("Validate accepted a configuration with no store")
	}
	config.Store = snapshot.NewMemoryStore()
	if err := config.Validate(); err != nil {
		t.Errorf("Validate rejected the defaults: %v", err)
	}
}

func TestLoadConfigReadsSettings(t *testing.T) {
	config, err := LoadConfig(lookupFrom(map[string]string{
		EnvAllowedOrigins: " https://scout.example , http://localhost:5173 ,",
		EnvMaxBodyBytes:   "131072",
		EnvCacheSeconds:   "0",
		EnvRetrySeconds:   "900",
	}))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	want := []string{"https://scout.example", "http://localhost:5173"}
	if len(config.AllowedOrigins) != len(want) {
		t.Fatalf("AllowedOrigins = %v, want %v", config.AllowedOrigins, want)
	}
	for i, origin := range want {
		if config.AllowedOrigins[i] != origin {
			t.Errorf("AllowedOrigins[%d] = %q, want %q", i, config.AllowedOrigins[i], origin)
		}
	}
	if config.MaxBodyBytes != 131072 || config.CacheSeconds != 0 || config.RetrySeconds != 900 {
		t.Errorf("settings = %d/%d/%d, want 131072/0/900", config.MaxBodyBytes, config.CacheSeconds, config.RetrySeconds)
	}
}

// TestLoadConfigRejectsBadSettings covers the floors and the ceilings. A ceiling
// matters as much as a floor here: a mistyped body limit must not be able to turn
// a bounded response into an unbounded one.
func TestLoadConfigRejectsBadSettings(t *testing.T) {
	tests := []struct {
		name   string
		values map[string]string
	}{
		{"body limit is not a number", map[string]string{EnvMaxBodyBytes: "sixteen"}},
		{"body limit below the floor", map[string]string{EnvMaxBodyBytes: "1024"}},
		{"body limit above the ceiling", map[string]string{EnvMaxBodyBytes: "999999999999"}},
		{"negative cache window", map[string]string{EnvCacheSeconds: "-1"}},
		{"cache window above the ceiling", map[string]string{EnvCacheSeconds: "86400"}},
		{"zero retry delay", map[string]string{EnvRetrySeconds: "0"}},
		{"retry delay above the ceiling", map[string]string{EnvRetrySeconds: "86400"}},
		{"wildcard origin", map[string]string{EnvAllowedOrigins: "*"}},
		{"wildcard subdomain", map[string]string{EnvAllowedOrigins: "https://*.example"}},
		{"origin with a path", map[string]string{EnvAllowedOrigins: "https://scout.example/app"}},
		{"origin with no scheme", map[string]string{EnvAllowedOrigins: "scout.example"}},
		{"origin with a foreign scheme", map[string]string{EnvAllowedOrigins: "ftp://scout.example"}},
		{"origin with credentials", map[string]string{EnvAllowedOrigins: "https://user@scout.example"}},
		{"duplicate origin", map[string]string{EnvAllowedOrigins: "https://a.example,https://a.example"}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			if _, err := LoadConfig(lookupFrom(test.values)); err == nil {
				t.Fatalf("LoadConfig accepted %v", test.values)
			}
		})
	}
}

// TestLoadConfigRequiresALookup keeps a nil lookup from silently loading every
// default, which would look like a deployment that was configured.
func TestLoadConfigRequiresALookup(t *testing.T) {
	if _, err := LoadConfig(nil); err == nil {
		t.Fatal("LoadConfig accepted a nil lookup")
	}
}

// TestConfigErrorsNameTheVariable keeps an operator from having to guess which
// setting was refused.
func TestConfigErrorsNameTheVariable(t *testing.T) {
	_, err := LoadConfig(lookupFrom(map[string]string{EnvMaxBodyBytes: "1"}))
	if err == nil {
		t.Fatal("LoadConfig accepted an undersized body limit")
	}
	if !strings.Contains(err.Error(), EnvMaxBodyBytes) {
		t.Errorf("error %q does not name %s", err, EnvMaxBodyBytes)
	}
}

// TestNewDefaultsTheClock keeps a caller from having to supply a clock just to get
// a working handler.
func TestNewDefaultsTheClock(t *testing.T) {
	config := testConfig(snapshot.NewMemoryStore(), testNow)
	config.Now = nil
	handler, err := New(config)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if handler.config.Now == nil {
		t.Fatal("New left the clock unset")
	}
	if handler.config.Now().IsZero() {
		t.Error("the default clock reports a zero time")
	}
}

func TestNewRejectsAnInvalidConfiguration(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("New accepted an empty configuration")
	}
	config := testConfig(snapshot.NewMemoryStore(), testNow)
	config.AllowedOrigins = []string{"*"}
	if _, err := New(config); err == nil {
		t.Fatal("New accepted a wildcard origin")
	}
}
