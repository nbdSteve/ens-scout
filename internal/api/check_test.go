package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ens-scrape/internal/checkstore"
	"ens-scrape/internal/ens"
	"ens-scrape/internal/snapshot"
)

// Every test here drives the real net/http adapter through Handler.ServeHTTP with
// a real request, and every upstream is either a local fake or a local httptest
// server. Nothing in this file reaches the ENS endpoint, AWS, or any other public
// service, and nothing needs a credential.

func TestCheckReturnsFreshAnswer(t *testing.T) {
	harness := newCheckHarness(t, nil)
	harness.upstream.register("zap", checkTime.Add(365*24*time.Hour))

	response := checkNames(harness.handler, []string{"zap", "abc", "def"})
	document := decodeCheck(t, response)

	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want %q", got, "no-store")
	}
	if got := response.Header().Get("Content-Type"); got != contentTypeJSON {
		t.Errorf("Content-Type = %q, want %q", got, contentTypeJSON)
	}
	if got, want := response.Header().Get("Content-Length"), strconv.Itoa(response.Body.Len()); got != want {
		t.Errorf("Content-Length = %q, want %q", got, want)
	}

	if document.FormatVersion != CheckFormatVersion {
		t.Errorf("format_version = %d, want %d", document.FormatVersion, CheckFormatVersion)
	}
	// The three authority statements are separate fields, so a client cannot read a
	// fresh index read as a registry promise by accident.
	if document.Source != CheckSource {
		t.Errorf("source = %q, want %q", document.Source, CheckSource)
	}
	if document.Authority != CheckAuthority {
		t.Errorf("authority = %q, want %q", document.Authority, CheckAuthority)
	}
	if document.Advisory != CheckAdvisory {
		t.Errorf("advisory = %q, want the check advisory", document.Advisory)
	}
	if !document.CheckedAt.Equal(checkTime) {
		t.Errorf("checked_at = %s, want %s", document.CheckedAt, checkTime)
	}
	if want := checkTime.Add(harness.config.CacheLifetime); !document.ExpiresAt.Equal(want) {
		t.Errorf("expires_at = %s, want %s", document.ExpiresAt, want)
	}

	// The covered set is the normalized, qualified one, which is the only set the
	// statuses say anything about.
	wantNames := []string{"abc.eth", "def.eth", "zap.eth"}
	if !equalStrings(document.Names, wantNames) {
		t.Fatalf("names = %v, want %v", document.Names, wantNames)
	}
	if len(document.Results) != len(wantNames) {
		t.Fatalf("results = %d, want %d", len(document.Results), len(wantNames))
	}
	for i, result := range document.Results {
		if result.Name != wantNames[i] {
			t.Errorf("results[%d].name = %q, want %q", i, result.Name, wantNames[i])
		}
	}
	if got := document.Results[0].Status; got != ens.StatusAvailable {
		t.Errorf("abc.eth status = %q, want %q", got, ens.StatusAvailable)
	}
	if got := document.Results[2].Status; got != ens.StatusRegistered {
		t.Errorf("zap.eth status = %q, want %q", got, ens.StatusRegistered)
	}

	// Batched with the subgraph's name filter rather than one call per name.
	if sizes := sortedInts(harness.upstream.batchSizes()); !equalInts(sizes, []int{1, 2}) {
		t.Errorf("upstream batch sizes = %v, want one call of 2 and one of 1", sizes)
	}
	if asked := sortedStrings(harness.upstream.asked()); !equalStrings(asked, []string{"abc", "def", "zap"}) {
		t.Errorf("upstream was asked about %v", asked)
	}

	record := harness.lastRecord(t)
	if record.Event != "check_completed" || record.Level != checkLevelInfo {
		t.Errorf("record = %s %s, want an info check_completed", record.Level, record.Event)
	}
	if record.Names != 3 || record.Batches != 2 || record.Status != http.StatusOK || record.Cache != "" {
		t.Errorf("record = %+v, want 3 names, 2 batches, 200, and no cache layer", record)
	}
	if record.CacheWriteFailed {
		t.Errorf("record = %+v, want the shared cache write to have landed", record)
	}
}

func TestCheckRequiresJSONContentType(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  int
	}{
		{"absent", "", http.StatusUnsupportedMediaType},
		{"form", "application/x-www-form-urlencoded", http.StatusUnsupportedMediaType},
		{"text", "text/plain", http.StatusUnsupportedMediaType},
		{"unparseable", "application/", http.StatusUnsupportedMediaType},
		{"json", "application/json", http.StatusOK},
		{"json with charset", "application/json; charset=utf-8", http.StatusOK},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			harness := newCheckHarness(t, nil)
			response := checkNames(harness.handler, []string{"zap"}, withContentType(test.value))
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d (body %s)", response.Code, test.want, response.Body)
			}
			if test.want == http.StatusOK {
				return
			}
			decodeFailure(t, response, http.StatusUnsupportedMediaType, CodeUnsupportedMedia)
			// A refused type never reaches the upstream, which is the point of charging
			// the cheapest refusals first.
			if calls := harness.upstream.calls(); calls != 0 {
				t.Errorf("upstream was called %d times for a refused content type", calls)
			}
		})
	}
}

func TestCheckRefusesOversizedRequest(t *testing.T) {
	t.Run("declared length", func(t *testing.T) {
		harness := newCheckHarness(t, nil)
		response := checkNames(harness.handler, []string{"zap"},
			withDeclaredLength(int64(harness.config.MaxRequestBytes)+1))

		decodeFailure(t, response, http.StatusRequestEntityTooLarge, CodeRequestTooLarge)
		if calls := harness.upstream.calls(); calls != 0 {
			t.Errorf("upstream was called %d times for an oversized request", calls)
		}
	})

	t.Run("actual body", func(t *testing.T) {
		harness := newCheckHarness(t, nil)
		// A body that declares nothing, as a chunked request does, so only the read
		// bound can catch it.
		body := namesBody(strings.Repeat("a", harness.config.MaxRequestBytes+64))
		response := postCheck(harness.handler, body, withDeclaredLength(-1))

		decodeFailure(t, response, http.StatusRequestEntityTooLarge, CodeRequestTooLarge)
		if calls := harness.upstream.calls(); calls != 0 {
			t.Errorf("upstream was called %d times for an oversized body", calls)
		}
	})
}

func TestCheckRefusesMalformedBody(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"empty", ""},
		{"truncated", `{"names":["zap"`},
		{"array", `["zap"]`},
		{"wrong type", `{"names":"zap"}`},
		// An unknown field is refused rather than ignored, so no future field and no
		// endpoint, query, or retry setting can be smuggled in.
		{"unknown field", `{"names":["zap"],"endpoint":"http://attacker.example"}`},
		{"trailing document", `{"names":["zap"]} {"names":["abc"]}`},
		{"trailing text", `{"names":["zap"]}!`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			harness := newCheckHarness(t, nil)
			response := postCheck(harness.handler, test.body)

			decodeFailure(t, response, http.StatusBadRequest, CodeMalformedRequest)
			if calls := harness.upstream.calls(); calls != 0 {
				t.Errorf("upstream was called %d times for a malformed body", calls)
			}
		})
	}
}

func TestCheckBoundsTheNameList(t *testing.T) {
	// The allowance is raised because these subtests share one instance and none of
	// them is about throttling. Leaving it at the default would let a spent bucket
	// answer 429 and make every assertion below vacuous.
	harness := newCheckHarness(t, func(check *CheckConfig) { check.ClientLimit = maxCheckClientLimit })
	limit := harness.config.MaxNames

	t.Run("nothing requested", func(t *testing.T) {
		for _, body := range []string{`{"names":[]}`, `{"names":null}`, `{}`} {
			response := postCheck(harness.handler, body)
			decodeFailure(t, response, http.StatusBadRequest, CodeNoNames)
		}
	})

	t.Run("too many", func(t *testing.T) {
		names := make([]string, 0, limit+1)
		for i := 0; i <= limit; i++ {
			names = append(names, fmt.Sprintf("nm%d", i))
		}
		response := checkNames(harness.handler, names)
		decodeFailure(t, response, http.StatusBadRequest, CodeTooManyNames)
	})

	t.Run("duplicates count", func(t *testing.T) {
		// The bound is charged against the raw list, before duplicates are removed, so
		// a caller cannot expand one label into an unbounded request.
		names := make([]string, 0, limit+1)
		for i := 0; i <= limit; i++ {
			names = append(names, "zap")
		}
		response := checkNames(harness.handler, names)
		decodeFailure(t, response, http.StatusBadRequest, CodeTooManyNames)
	})

	if calls := harness.upstream.calls(); calls != 0 {
		t.Errorf("upstream was called %d times for requests that were all refused", calls)
	}
}

func TestCheckDeduplicatesAndOrders(t *testing.T) {
	first := newCheckHarness(t, nil)
	first.upstream.register("zap", checkTime.Add(365*24*time.Hour))
	firstResponse := checkNames(first.handler, []string{"Zap.eth", " zap ", "abc", "ZAP"})

	document := decodeCheck(t, firstResponse)
	if want := []string{"abc.eth", "zap.eth"}; !equalStrings(document.Names, want) {
		t.Fatalf("names = %v, want %v", document.Names, want)
	}
	if asked := sortedStrings(first.upstream.asked()); !equalStrings(asked, []string{"abc", "zap"}) {
		t.Errorf("upstream was asked about %v, want each label once", asked)
	}

	// A second instance, asked for the same set written differently, produces the
	// same bytes. That is what makes the response comparable across a retry.
	second := newCheckHarness(t, nil)
	second.upstream.register("zap", checkTime.Add(365*24*time.Hour))
	secondResponse := checkNames(second.handler, []string{"abc.eth", "zap"})

	if firstResponse.Body.String() != secondResponse.Body.String() {
		t.Errorf("two instances rendered the same set differently:\n%s\n%s",
			firstResponse.Body, secondResponse.Body)
	}
}

func TestCheckRefusesInvalidNames(t *testing.T) {
	harness := newCheckHarness(t, func(check *CheckConfig) { check.ClientLimit = maxCheckClientLimit })
	long := strings.Repeat("a", harness.config.MaxLabelBytes+1)

	cases := []struct {
		name  string
		value string
	}{
		{"empty", ""},
		{"suffix only", ".eth"},
		{"whitespace only", "   "},
		{"inner space", "ab cd"},
		{"third level", "a.b.eth"},
		{"dotted", "zap.xyz"},
		{"control character", "za\x00p"},
		{"over the label bound", long},
		{"markup", "<script>alert(1)</script>"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			// One invalid entry refuses the whole request, so the valid label beside it is
			// not quietly answered about either.
			response := checkNames(harness.handler, []string{"zap", test.value})
			decodeFailure(t, response, http.StatusBadRequest, CodeInvalidName)
		})
	}

	// The refusal describes the requirement and never repeats what was sent: a
	// reflected value is how one caller's payload reaches another reader. The value
	// here is distinctive so the assertion cannot pass or fail on wording that the
	// fixed message happens to share with a rejected entry.
	t.Run("nothing is reflected", func(t *testing.T) {
		const payload = "<kwyjibo>alert(1)</kwyjibo>"
		response := checkNames(harness.handler, []string{payload})
		decodeFailure(t, response, http.StatusBadRequest, CodeInvalidName)

		for _, fragment := range []string{payload, "kwyjibo", "alert"} {
			if strings.Contains(response.Body.String(), fragment) {
				t.Errorf("the refusal reflected %q: %s", fragment, response.Body)
			}
		}
	})

	if calls := harness.upstream.calls(); calls != 0 {
		t.Errorf("upstream was called %d times for requests naming something invalid", calls)
	}
}

func TestCheckServesAndExpiresACachedAnswer(t *testing.T) {
	harness := newCheckHarness(t, func(check *CheckConfig) { check.ClientLimit = 10 })
	harness.upstream.register("zap", checkTime.Add(365*24*time.Hour))

	first := checkNames(harness.handler, []string{"zap"})
	decodeCheck(t, first)
	if calls := harness.upstream.calls(); calls != 1 {
		t.Fatalf("upstream calls after the first request = %d, want 1", calls)
	}

	second := checkNames(harness.handler, []string{"ZAP.eth"})
	decodeCheck(t, second)
	if calls := harness.upstream.calls(); calls != 1 {
		t.Errorf("upstream calls after a cache hit = %d, want 1", calls)
	}
	// A hit returns the bytes the miss returned, including the instant the answer
	// was really taken, rather than the instant it was asked for again.
	if first.Body.String() != second.Body.String() {
		t.Errorf("a cache hit rendered different bytes:\n%s\n%s", first.Body, second.Body)
	}
	if record := harness.lastRecord(t); record.Cache != cacheLocal {
		t.Errorf("record = %+v, want a local cache hit", record)
	}

	// A different set is a different entry rather than a hit.
	decodeCheck(t, checkNames(harness.handler, []string{"abc"}))
	if calls := harness.upstream.calls(); calls != 2 {
		t.Errorf("upstream calls after a second set = %d, want 2", calls)
	}
	if held := harness.handler.localResults.held(); held != 2 {
		t.Errorf("the local copy layer holds %d entries, want 2", held)
	}
	if _, entries := harness.store.Items(); entries != 2 {
		t.Errorf("the shared store holds %d entries, want 2", entries)
	}

	harness.clock.advance(harness.config.CacheLifetime)
	third := decodeCheck(t, checkNames(harness.handler, []string{"zap"}))
	if calls := harness.upstream.calls(); calls != 3 {
		t.Errorf("upstream calls after the entry expired = %d, want 3", calls)
	}
	if want := checkTime.Add(harness.config.CacheLifetime); !third.CheckedAt.Equal(want) {
		t.Errorf("checked_at after expiry = %s, want %s", third.CheckedAt, want)
	}
}

// TestCheckLocalCopyIsOnlyAnOptimization is the rule that keeps the process-local
// layer honest. It may save a store read on a warm instance, and it may do nothing
// else: the entry it serves came from the shared store, expires when the shared
// entry does, and is never the reason an answer exists.
func TestCheckLocalCopyIsOnlyAnOptimization(t *testing.T) {
	harness := newCheckHarness(t, func(check *CheckConfig) { check.ClientLimit = 10 })

	decodeCheck(t, checkNames(harness.handler, []string{"zap"}))
	_, loads, stores := harness.store.Counts()
	if loads != 1 || stores != 1 {
		t.Fatalf("the first request made %d loads and %d stores, want 1 and 1", loads, stores)
	}

	// A warm hit is served without reading the store at all, which is the whole
	// benefit the layer exists for.
	decodeCheck(t, checkNames(harness.handler, []string{"zap"}))
	if _, loads, stores = harness.store.Counts(); loads != 1 || stores != 1 {
		t.Errorf("a warm hit made the store do %d loads and %d stores, want 1 and 1", loads, stores)
	}

	// The copy expires with the shared entry rather than on a lifetime of its own, so
	// the layer cannot serve an answer past the moment the deployment stopped standing
	// behind it: the same instance reads the index again.
	harness.clock.advance(harness.config.CacheLifetime)
	document := decodeCheck(t, checkNames(harness.handler, []string{"zap"}))
	if calls := harness.upstream.calls(); calls != 2 {
		t.Errorf("upstream calls after the copy expired = %d, want 2", calls)
	}
	if want := checkTime.Add(harness.config.CacheLifetime); !document.CheckedAt.Equal(want) {
		t.Errorf("checked_at = %s, want %s: a local copy was served past its expiry", document.CheckedAt, want)
	}
	if _, loads, stores = harness.store.Counts(); loads != 2 || stores != 2 {
		t.Errorf("after expiry the store made %d loads and %d stores, want 2 and 2", loads, stores)
	}
}

// TestCheckSharedCacheIsReadableByEveryInstance is the half a per-instance cache
// cannot do. The answer one instance obtained is the answer every other instance
// serves, stamped with the instant the index was really read at rather than the
// instant of the hit, because the stored bytes are returned rather than re-rendered.
func TestCheckSharedCacheIsReadableByEveryInstance(t *testing.T) {
	harness := newCheckHarness(t, func(check *CheckConfig) { check.ClientLimit = 10 })
	harness.upstream.register("zap", checkTime.Add(365*24*time.Hour))

	first := checkNames(harness.handler, []string{"zap"})
	decodeCheck(t, first)

	// Time passes and another instance takes the request.
	harness.clock.advance(harness.config.CacheLifetime / 2)
	other := harness.instance(t, nil)
	second := checkNames(other, []string{"zap"})
	document := decodeCheck(t, second)

	if calls := harness.upstream.calls(); calls != 1 {
		t.Errorf("upstream calls = %d, want 1: the second instance served the stored answer", calls)
	}
	if first.Body.String() != second.Body.String() {
		t.Errorf("a shared hit rendered different bytes:\n%s\n%s", first.Body, second.Body)
	}
	if !document.CheckedAt.Equal(checkTime) {
		t.Errorf("checked_at = %s, want the instant the index was read at, not the instant of the hit",
			document.CheckedAt)
	}
	if record := harness.lastRecord(t); record.Cache != cacheShared {
		t.Errorf("record = %+v, want a shared cache hit", record)
	}

	// And the shared entry expires on the one clock, so no instance can serve it past
	// its own stated expiry.
	harness.clock.advance(harness.config.CacheLifetime / 2)
	third := decodeCheck(t, checkNames(other, []string{"zap"}))
	if calls := harness.upstream.calls(); calls != 2 {
		t.Errorf("upstream calls after the shared entry expired = %d, want 2", calls)
	}
	if want := checkTime.Add(harness.config.CacheLifetime); !third.CheckedAt.Equal(want) {
		t.Errorf("checked_at after expiry = %s, want %s", third.CheckedAt, want)
	}
}

// TestCheckSharedCacheIsScopedToTheWireVersion is the other half of sharing one
// store. A stored entry is the rendered body, returned unchanged, so an entry a
// different wire version wrote must be unreachable rather than served: a rolling
// deployment has both versions reading the one store, and a client handed the other
// shape refuses it until the entry lapses. The two instances here are one deployment
// of this version, so what they share is still shared.
func TestCheckSharedCacheIsScopedToTheWireVersion(t *testing.T) {
	harness := newCheckHarness(t, func(check *CheckConfig) { check.ClientLimit = 10 })
	harness.upstream.register("zap", checkTime.Add(365*24*time.Hour))

	// What a deployment of the next wire version leaves in the store for the same set.
	foreign := checkstore.Entry{
		Body:      []byte(`{"format_version":2,"names":["zap.eth"]}`),
		ExpiresAt: checkTime.Add(harness.config.CacheLifetime),
	}
	foreignKey := checkCacheKey(CheckFormatVersion+1, []string{"zap.eth"})
	if err := harness.store.Store(context.Background(), foreignKey, foreign); err != nil {
		t.Fatalf("seeding the shared store: %v", err)
	}

	first := checkNames(harness.handler, []string{"zap"})
	document := decodeCheck(t, first)
	if document.FormatVersion != CheckFormatVersion {
		t.Errorf("format_version = %d, want %d: another version's entry was served",
			document.FormatVersion, CheckFormatVersion)
	}
	if calls := harness.upstream.calls(); calls != 1 {
		t.Errorf("upstream calls = %d, want 1: the index was not read for this version's answer", calls)
	}
	// Beside the other version's entry rather than over it, so neither version can be
	// served the other's bytes.
	entry, hit, err := harness.store.Load(context.Background(), foreignKey, checkTime)
	if err != nil {
		t.Fatalf("reading the other version's entry: %v", err)
	}
	if !hit || string(entry.Body) != string(foreign.Body) {
		t.Errorf("the other version's entry was overwritten: hit = %t, body = %q", hit, entry.Body)
	}

	// And this version's own entry is still the one every instance of it serves.
	second := checkNames(harness.instance(t, nil), []string{"zap"})
	decodeCheck(t, second)
	if calls := harness.upstream.calls(); calls != 1 {
		t.Errorf("upstream calls = %d, want 1: a second instance did not serve the stored answer", calls)
	}
	if first.Body.String() != second.Body.String() {
		t.Errorf("a shared hit rendered different bytes:\n%s\n%s", first.Body, second.Body)
	}
}

func TestCheckThrottlesEachClientSeparately(t *testing.T) {
	harness := newCheckHarness(t, nil)
	allowance := harness.config.ClientLimit

	for i := 0; i < allowance; i++ {
		response := checkNames(harness.handler, []string{"zap"}, fromClient("198.51.100.7:4000"))
		if response.Code != http.StatusOK {
			t.Fatalf("request %d of the allowance: status = %d (body %s)", i+1, response.Code, response.Body)
		}
	}

	spent := checkNames(harness.handler, []string{"zap"}, fromClient("198.51.100.7:4000"))
	decodeFailure(t, spent, http.StatusTooManyRequests, CodeClientThrottled)
	// The wait advertised is the allowance window, not the snapshot scan cadence.
	assertRetryAfter(t, spent, int(harness.config.ClientWindow/time.Second))

	// Another client is unaffected, so one caller cannot spend everybody's allowance.
	other := checkNames(harness.handler, []string{"zap"}, fromClient("203.0.113.9:5000"))
	if other.Code != http.StatusOK {
		t.Fatalf("a second client got status %d (body %s)", other.Code, other.Body)
	}

	// The allowance is the store's, so what was spent is readable there rather than
	// only inferable from the refusal. A refused charge adds nothing.
	key := harness.handler.clientHash.hash("198.51.100.7")
	if spent := harness.store.Spent(checkstore.KindClient, key, checkTime, harness.config.clientWindow()); spent != int64(allowance) {
		t.Errorf("the store recorded %d of the allowance, want %d", spent, allowance)
	}

	// The window rolls over on the injected clock rather than on a timer, and the next
	// window is a different item rather than a reset one.
	harness.clock.advance(harness.config.ClientWindow)
	refilled := checkNames(harness.handler, []string{"zap"}, fromClient("198.51.100.7:4000"))
	if refilled.Code != http.StatusOK {
		t.Fatalf("after the window the client got status %d (body %s)", refilled.Code, refilled.Body)
	}
	next := checkTime.Add(harness.config.ClientWindow)
	if spent := harness.store.Spent(checkstore.KindClient, key, next, harness.config.clientWindow()); spent != 1 {
		t.Errorf("the new window holds %d, want 1", spent)
	}
}

func TestCheckRefusesARequestWithNoClientIdentity(t *testing.T) {
	harness := newCheckHarness(t, nil)

	response := checkNames(harness.handler, []string{"zap"}, fromClient(""))
	decodeFailure(t, response, http.StatusServiceUnavailable, CodeClientUnidentified)
	// Waiting cannot add an address to a request, so nothing advises a retry.
	assertNoRetryAfter(t, response)
	if calls := harness.upstream.calls(); calls != 0 {
		t.Errorf("upstream was called %d times for an unidentified client", calls)
	}
}

// TestCheckFailsClosedWhenTheStoreIsUnavailable is what makes the shared store an
// authority rather than an optimization. A store that cannot be charged cannot
// bound anything, so answering anyway would be exactly the bypass it exists to
// close.
func TestCheckFailsClosedWhenTheStoreIsUnavailable(t *testing.T) {
	t.Run("a charge that cannot be recorded", func(t *testing.T) {
		harness := newCheckHarness(t, nil)
		harness.store.FailCharges(1, errors.New(leakedText))

		response := checkNames(harness.handler, []string{"zap"})
		decodeFailure(t, response, http.StatusServiceUnavailable, CodeCheckStoreUnavailable)
		// Retryable, because the usual cause is a throttled table and the next request
		// may well be charged.
		assertRetryAfter(t, response, int(harness.config.Timeout/time.Second))

		// The allowance is charged before any work, so nothing reached the index.
		if calls := harness.upstream.calls(); calls != 0 {
			t.Errorf("upstream was called %d times behind an uncharged allowance", calls)
		}
		if record := harness.lastRecord(t); record.Event != "check_failed" || record.Level != checkLevelError {
			t.Errorf("record = %s %s, want an error check_failed", record.Level, record.Event)
		}
		assertNoLeakedText(t, "the failure body", response.Body.String())
		assertNoLeakedText(t, "the log", harness.logs.String())
	})

	t.Run("a cache read that fails", func(t *testing.T) {
		harness := newCheckHarness(t, nil)
		harness.store.FailCache(1, errors.New(leakedText))

		response := checkNames(harness.handler, []string{"zap"})
		decodeFailure(t, response, http.StatusServiceUnavailable, CodeCheckStoreUnavailable)
		// A store that cannot be read is not evidence that the set is uncached, so the
		// request is refused rather than treated as a miss and charged to the index.
		if calls := harness.upstream.calls(); calls != 0 {
			t.Errorf("upstream was called %d times behind an unreadable cache", calls)
		}
		assertNoLeakedText(t, "the failure body", response.Body.String())
	})

	t.Run("a whole store that has gone away", func(t *testing.T) {
		harness := newCheckHarness(t, nil)
		harness.store.Close()

		response := checkNames(harness.handler, []string{"zap"})
		decodeFailure(t, response, http.StatusServiceUnavailable, CodeCheckStoreUnavailable)
		if calls := harness.upstream.calls(); calls != 0 {
			t.Errorf("upstream was called %d times with no store at all", calls)
		}
	})
}

// TestCheckStillAnswersWhenTheSharedCacheWriteFails is the one store failure a
// caller must not fail closed on. The fresh answer was already obtained, so
// refusing would throw away a verification that really happened because a cache
// could not keep it. The cost is the next identical request.
func TestCheckStillAnswersWhenTheSharedCacheWriteFails(t *testing.T) {
	harness := newCheckHarness(t, func(check *CheckConfig) { check.ClientLimit = 10 })
	harness.store.FailStores(1, errors.New(leakedText))

	first := decodeCheck(t, checkNames(harness.handler, []string{"zap"}))
	if !first.CheckedAt.Equal(checkTime) {
		t.Errorf("checked_at = %s, want %s", first.CheckedAt, checkTime)
	}

	record := harness.lastRecord(t)
	if record.Event != "check_completed" || record.Level != checkLevelInfo {
		t.Errorf("record = %s %s, want an info check_completed", record.Level, record.Event)
	}
	if !record.CacheWriteFailed {
		t.Errorf("record = %+v, want the failed shared write reported", record)
	}

	// Nothing is kept locally either: a copy the shared store never accepted would be
	// an entry only this instance could serve, which is the per-instance cache the
	// shared store replaced.
	if held := harness.handler.localResults.held(); held != 0 {
		t.Errorf("the local copy layer holds %d entries, want 0", held)
	}
	if _, entries := harness.store.Items(); entries != 0 {
		t.Errorf("the shared store holds %d entries, want 0", entries)
	}

	// So the next identical request reads the index again rather than serving a hit
	// nothing recorded.
	decodeCheck(t, checkNames(harness.handler, []string{"zap"}))
	if calls := harness.upstream.calls(); calls != 2 {
		t.Errorf("upstream calls = %d, want 2: the answer was never cached", calls)
	}
	assertNoLeakedText(t, "the log", harness.logs.String())
}

func TestCheckBudgetsTheUpstreamAcrossEveryClient(t *testing.T) {
	// Three is the floor validate() allows for these bounds, because one request may
	// cost ceil(MaxNames/BatchSize) calls and an allowance that cannot cover one
	// request would refuse every request.
	harness := newCheckHarness(t, func(check *CheckConfig) { check.UpstreamLimit = 3 })

	// Distinct single-name sets, so the cache cannot pay for a request and each one
	// really costs exactly one upstream call.
	for i, name := range []string{"aaa", "bbb", "ccc"} {
		response := checkNames(harness.handler, []string{name}, fromClient(fmt.Sprintf("10.1.1.%d:1000", i)))
		if response.Code != http.StatusOK {
			t.Fatalf("client %d: status = %d (body %s)", i, response.Code, response.Body)
		}
	}

	// A fourth identity is refused even though its own allowance is untouched: many
	// clients must not add up to unbounded Graph load.
	response := checkNames(harness.handler, []string{"ddd"}, fromClient("10.1.1.9:1000"))
	decodeFailure(t, response, http.StatusServiceUnavailable, CodeUpstreamBudget)
	assertRetryAfter(t, response, int(harness.config.UpstreamWindow/time.Second))

	if calls := harness.upstream.calls(); calls != 3 {
		t.Errorf("upstream calls = %d, want the budgeted 3", calls)
	}

	// The budget lives in the shared store under one key, which is what makes it
	// deployment-wide rather than per instance. A refused charge added nothing.
	spent := harness.store.Spent(checkstore.KindUpstream, checkstore.UpstreamKey, checkTime, harness.config.upstreamWindow())
	if spent != 3 {
		t.Errorf("the store recorded %d upstream calls, want 3", spent)
	}
}

func TestCheckRefusesWhenTheUpstreamSlotsAreTaken(t *testing.T) {
	harness := newCheckHarness(t, func(check *CheckConfig) {
		check.UpstreamConcurrency = 1
		check.ClientLimit = 10
	})
	entered, release := harness.upstream.holdInside()

	var waiting sync.WaitGroup
	waiting.Add(1)
	go func() {
		defer waiting.Done()
		if response := checkNames(harness.handler, []string{"aaa"}); response.Code != http.StatusOK {
			t.Errorf("the held request got status %d (body %s)", response.Code, response.Body)
		}
	}()

	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		release()
		waiting.Wait()
		t.Fatal("the first request never reached the upstream")
	}

	// The slot is taken, so this one is refused rather than queued: queueing would
	// spend its whole deadline waiting and then fail anyway.
	refused := checkNames(harness.handler, []string{"bbb"})
	decodeFailure(t, refused, http.StatusServiceUnavailable, CodeUpstreamBusy)
	// A slot frees within one deadline, which is what it advertises rather than the
	// far longer budget window.
	assertRetryAfter(t, refused, int(harness.config.Timeout/time.Second))

	release()
	waiting.Wait()

	// The slot is given back, so the next request is served.
	if response := checkNames(harness.handler, []string{"ccc"}); response.Code != http.StatusOK {
		t.Fatalf("after the slot was released: status = %d (body %s)", response.Code, response.Body)
	}
}

func TestCheckTimesOutOnItsOwnDeadline(t *testing.T) {
	harness := newCheckHarness(t, func(check *CheckConfig) {
		// The floor, so the test waits out the shortest deadline the configuration
		// allows rather than a chosen one.
		check.Timeout = time.Second
	})
	harness.upstream.holdUntilCancelled()

	response := checkNames(harness.handler, []string{"zap"})
	decodeFailure(t, response, http.StatusGatewayTimeout, CodeCheckTimedOut)
	assertRetryAfter(t, response, 1)

	if held := harness.handler.localResults.held(); held != 0 {
		t.Errorf("cache holds %d entries after a timeout, want 0", held)
	}
	if record := harness.lastRecord(t); record.Event != "check_failed" || record.Level != checkLevelError {
		t.Errorf("record = %s %s, want an error check_failed", record.Level, record.Event)
	}
}

func TestCheckClassifiesALostRequestContext(t *testing.T) {
	t.Run("cancelled", func(t *testing.T) {
		harness := newCheckHarness(t, nil)
		harness.upstream.holdUntilCancelled()

		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		response := checkNames(harness.handler, []string{"zap"}, inContext(ctx))

		// The client decided to go away, so there is nobody to advise about a retry.
		decodeFailure(t, response, http.StatusServiceUnavailable, CodeCheckCancelled)
		assertNoRetryAfter(t, response)
	})

	t.Run("deadline expired", func(t *testing.T) {
		harness := newCheckHarness(t, nil)
		harness.upstream.holdUntilCancelled()

		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		response := checkNames(harness.handler, []string{"zap"}, inContext(ctx))

		// A deadline the platform set is still a timeout, and reporting it as a
		// cancellation would say the client hung up when it did not.
		decodeFailure(t, response, http.StatusGatewayTimeout, CodeCheckTimedOut)
		assertRetryAfter(t, response, int(harness.config.Timeout/time.Second))
	})
}

func TestCheckFailsClosedOnAnUpstreamFailure(t *testing.T) {
	harness := newCheckHarness(t, nil)
	harness.upstream.failWith(errors.New(leakedText))

	response := checkNames(harness.handler, []string{"zap"})
	decodeFailure(t, response, http.StatusBadGateway, CodeUpstreamFailed)
	assertRetryAfter(t, response, int(harness.config.Timeout/time.Second))

	// Nothing is cached, so a later request tries again rather than serving a
	// failure as though it were an answer.
	if held := harness.handler.localResults.held(); held != 0 {
		t.Errorf("cache holds %d entries after a failure, want 0", held)
	}
	assertNoLeakedText(t, "the failure body", response.Body.String())
	assertNoLeakedText(t, "the log", harness.logs.String())
}

func TestCheckRefusesAnAnswerThatDoesNotCoverTheRequest(t *testing.T) {
	cases := []struct {
		name    string
		corrupt func(*fakeGraph)
	}{
		{"short answer", func(g *fakeGraph) { g.dropLast = true }},
		{"substituted name", func(g *fakeGraph) { g.renameFirst = "other.eth" }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			harness := newCheckHarness(t, nil)
			test.corrupt(harness.upstream)

			response := checkNames(harness.handler, []string{"zap", "abc"})
			// A partial or substituted answer is not evidence about any name in it.
			decodeFailure(t, response, http.StatusBadGateway, CodeUpstreamFailed)
			if held := harness.handler.localResults.held(); held != 0 {
				t.Errorf("cache holds %d entries, want 0", held)
			}
		})
	}
}

// TestCheckAgainstALocalGraphServer drives the real ens.Client over a real
// transport, so the retry bound, a challenge page, a truncated body, and an error
// document are exercised as they arrive rather than as a fake's error value.
func TestCheckAgainstALocalGraphServer(t *testing.T) {
	// Each body carries the fabricated credential, because internal/ens folds a slice
	// of the gateway's response into its error and this is what must not escape.
	cases := []struct {
		name         string
		status       int
		body         string
		wantAttempts int
		wantStatus   int
		wantCode     string
	}{
		{
			name:         "rate limited",
			status:       http.StatusTooManyRequests,
			body:         `{"message":"slow down ` + leakedSecret + `"}`,
			wantAttempts: 3,
			wantStatus:   http.StatusBadGateway,
			wantCode:     CodeUpstreamFailed,
		},
		{
			name:         "server error",
			status:       http.StatusBadGateway,
			body:         "upstream exploded",
			wantAttempts: 3,
			wantStatus:   http.StatusBadGateway,
			wantCode:     CodeUpstreamFailed,
		},
		{
			name:   "challenge",
			status: http.StatusForbidden,
			body:   `<html><body>prove you are human ` + leakedSecret + `</body></html>`,
			// A challenge is not transient, so it is not retried.
			wantAttempts: 1,
			wantStatus:   http.StatusBadGateway,
			wantCode:     CodeUpstreamFailed,
		},
		{
			name:         "truncated body",
			status:       http.StatusOK,
			body:         `{"data":{"registrations":[{"expiryDate":"1`,
			wantAttempts: 1,
			wantStatus:   http.StatusBadGateway,
			wantCode:     CodeUpstreamFailed,
		},
		{
			name:         "error document",
			status:       http.StatusOK,
			body:         `{"errors":[{"message":"bad auth for ` + leakedSecret + `"}]}`,
			wantAttempts: 1,
			wantStatus:   http.StatusBadGateway,
			wantCode:     CodeUpstreamFailed,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			server := newGraphServer(t, test.status, test.body)
			harness := newCheckHarness(t, func(check *CheckConfig) {
				check.Upstream = server.client(t, check.Retries)
			})

			response := checkNames(harness.handler, []string{"kwyjibo"})
			decodeFailure(t, response, test.wantStatus, test.wantCode)

			if attempts := server.attempts(); attempts != test.wantAttempts {
				t.Errorf("upstream attempts = %d, want %d", attempts, test.wantAttempts)
			}
			for label, text := range map[string]string{
				"the failure body": response.Body.String(),
				"the log":          harness.logs.String(),
			} {
				assertNoLeakedText(t, label, text)
				// Neither the endpoint nor the response body may reach a client or a log
				// group, and neither may the candidate label.
				if strings.Contains(text, server.server.URL) {
					t.Errorf("%s holds the upstream endpoint: %s", label, text)
				}
				if strings.Contains(text, test.body) {
					t.Errorf("%s holds the upstream response body: %s", label, text)
				}
				if strings.Contains(text, "kwyjibo") {
					t.Errorf("%s holds a candidate label: %s", label, text)
				}
			}
		})
	}
}

func TestCheckServesTheRealClientWhenTheGraphAnswers(t *testing.T) {
	expiry := checkTime.Add(365 * 24 * time.Hour)
	body := fmt.Sprintf(
		`{"data":{"registrations":[{"expiryDate":"%d","domain":{"name":"zap.eth"}}]}}`,
		expiry.Unix(),
	)
	server := newGraphServer(t, http.StatusOK, body)
	harness := newCheckHarness(t, func(check *CheckConfig) {
		check.Upstream = server.client(t, check.Retries)
	})

	document := decodeCheck(t, checkNames(harness.handler, []string{"zap", "abc"}))
	if want := []string{"abc.eth", "zap.eth"}; !equalStrings(document.Names, want) {
		t.Fatalf("names = %v, want %v", document.Names, want)
	}
	// One batch, because the two names fit the configured batch size.
	if attempts := server.attempts(); attempts != 1 {
		t.Errorf("upstream attempts = %d, want 1", attempts)
	}
	if got := document.Results[1].Status; got != ens.StatusRegistered {
		t.Errorf("zap.eth status = %q, want %q", got, ens.StatusRegistered)
	}
	if got := document.Results[0].Status; got != ens.StatusAvailable {
		t.Errorf("abc.eth status = %q, want %q", got, ens.StatusAvailable)
	}
}

// TestCheckColdInstanceInheritsTheSpentAllowance is the property a per-instance
// throttle cannot have. A replaced or additional Lambda instance is a new Handler
// with empty process-local state over the same table, and it must find the
// allowance already spent and the cache already warm: otherwise the deployment's
// real limit would be this allowance times the instances a client reaches, which is
// a number nothing bounds.
func TestCheckColdInstanceInheritsTheSpentAllowance(t *testing.T) {
	warm := newCheckHarness(t, nil)
	client := fromClient("198.51.100.20:4000")

	for i := 0; i < warm.config.ClientLimit; i++ {
		if response := checkNames(warm.handler, []string{"zap"}, client); response.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d", i+1, response.Code)
		}
	}
	// The cold instance shares the store and nothing else.
	cold := warm.instance(t, nil)
	if held := cold.localResults.held(); held != 0 {
		t.Errorf("a cold instance holds %d local copies, want 0", held)
	}

	// The spent allowance carried over, so restarting is not a way to get another one.
	refused := checkNames(cold, []string{"zap"}, client)
	decodeFailure(t, refused, http.StatusTooManyRequests, CodeClientThrottled)
	assertRetryAfter(t, refused, int(warm.config.ClientWindow/time.Second))

	// And so did the cached answer, which is what stops a restart from re-reading the
	// index for a set the deployment has already verified. Another client is needed to
	// reach that far, because the throttle is charged first.
	fresh := checkNames(cold, []string{"zap"}, fromClient("198.51.100.21:4000"))
	document := decodeCheck(t, fresh)
	if !document.CheckedAt.Equal(checkTime) {
		t.Errorf("checked_at = %s, want the instant the index was really read at", document.CheckedAt)
	}
	// Every instance writes to the one log, so the last record is the cold one's.
	if record := warm.lastRecord(t); record.Cache != cacheShared {
		t.Errorf("record = %+v, want a shared cache hit on the cold instance", record)
	}

	// One upstream read in total, made by the warm instance.
	if calls := warm.upstream.calls(); calls != 1 {
		t.Errorf("upstream calls = %d, want 1: the cold instance served the stored answer", calls)
	}
}

// TestCheckConcurrentInstancesShareOneAllowance is the same rule under contention,
// which is the case a per-instance limit fails at without any restart at all: two
// instances serving the same client at the same moment. Exactly the allowance is
// admitted across all of them, because every charge is one atomic operation against
// one item rather than a read and a later write that can interleave.
func TestCheckConcurrentInstancesShareOneAllowance(t *testing.T) {
	const instances = 4
	const allowance = 6

	harness := newCheckHarness(t, func(check *CheckConfig) {
		check.ClientLimit = allowance
		// Wide enough that no request is refused for a slot, so the only bound under
		// test is the client allowance.
		check.UpstreamConcurrency = instances * 2
		check.UpstreamLimit = maxCheckUpstreamLimit
	})
	handlers := make([]*Handler, instances)
	handlers[0] = harness.handler
	for i := 1; i < instances; i++ {
		handlers[i] = harness.instance(t, nil)
	}

	// Every instance asks the same number of times for the same client, and they all
	// ask for the same set so the answers are interchangeable.
	const each = 4
	client := fromClient("198.51.100.60:4000")
	var admitted, throttled int64
	var counting sync.Mutex
	var running sync.WaitGroup
	for _, handler := range handlers {
		for i := 0; i < each; i++ {
			running.Add(1)
			go func(handler *Handler) {
				defer running.Done()
				response := checkNames(handler, []string{"zap"}, client)
				counting.Lock()
				defer counting.Unlock()
				switch response.Code {
				case http.StatusOK:
					admitted++
				case http.StatusTooManyRequests:
					throttled++
				default:
					t.Errorf("unexpected status %d (body %s)", response.Code, response.Body)
				}
			}(handler)
		}
	}
	running.Wait()

	if admitted != allowance {
		t.Errorf("admitted %d requests across %d instances, want exactly the allowance of %d",
			admitted, instances, allowance)
	}
	if want := int64(instances*each) - allowance; throttled != want {
		t.Errorf("throttled %d requests, want %d", throttled, want)
	}

	key := harness.handler.clientHash.hash("198.51.100.60")
	spent := harness.store.Spent(checkstore.KindClient, key, checkTime, harness.config.clientWindow())
	if spent != allowance {
		t.Errorf("the store recorded %d of the allowance, want %d", spent, allowance)
	}
}

// TestCheckClientKeyIsOneWayAndStable covers the identity representation itself.
// The raw address never appears in the key, and the key is derived under a stable
// deployment secret rather than a value minted at cold start: a per-instance key
// would give one visitor a different identity on every instance, which is a
// throttle that cannot bound anything. The stability is the point, and the HMAC is
// what keeps it from also being reversible.
func TestCheckClientKeyIsOneWayAndStable(t *testing.T) {
	const address = "198.51.100.30"

	first, err := newClientHasher(testCheckSecret)
	if err != nil {
		t.Fatalf("mint a client hasher: %v", err)
	}
	// A second instance of the same deployment reads the same secret from its own
	// environment, so it derives the same key.
	second, err := newClientHasher(append([]byte(nil), testCheckSecret...))
	if err != nil {
		t.Fatalf("mint a second client hasher: %v", err)
	}

	digest := first.hash(address)
	if strings.Contains(digest, address) {
		t.Errorf("the digest holds the address: %q", digest)
	}
	if digest != first.hash(address) {
		t.Error("the same address hashed to two different keys on one instance")
	}
	if digest != second.hash(address) {
		t.Error("two instances of one deployment derived different keys, so no shared allowance can be charged")
	}

	// A different deployment's secret is a different key space, which is what makes
	// one deployment's stored digests useless to another.
	other, err := newClientHasher([]byte("fedcba9876543210fedcba9876543210"))
	if err != nil {
		t.Fatalf("mint a hasher under another secret: %v", err)
	}
	if digest == other.hash(address) {
		t.Error("the digest did not depend on the secret, so it is an unkeyed digest of an address")
	}

	// A secret too short to be a credential is refused rather than stretched, so a
	// deployment cannot degrade the keying by misconfiguring it.
	if _, err := newClientHasher([]byte("short")); err == nil {
		t.Error("a short secret was accepted")
	}
	if _, err := newClientHasher(nil); err == nil {
		t.Error("an absent secret was accepted")
	}
}

// TestCheckClientKeyIgnoresForwardingHeaders is the rule that makes throttling
// work at all: a caller-chosen header would let one client mint a fresh identity
// per request.
func TestCheckClientKeyIgnoresForwardingHeaders(t *testing.T) {
	harness := newCheckHarness(t, nil)
	spoof := func(value string) requestOption {
		return func(r *http.Request) {
			r.Header.Set("X-Forwarded-For", value)
			r.Header.Set("Forwarded", "for="+value)
			r.Header.Set("X-Real-IP", value)
		}
	}

	for i := 0; i < harness.config.ClientLimit; i++ {
		response := checkNames(harness.handler, []string{"zap"},
			fromClient("198.51.100.40:4000"), spoof(fmt.Sprintf("203.0.113.%d", i)))
		if response.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d", i+1, response.Code)
		}
	}

	response := checkNames(harness.handler, []string{"zap"},
		fromClient("198.51.100.40:4000"), spoof("203.0.113.200"))
	decodeFailure(t, response, http.StatusTooManyRequests, CodeClientThrottled)

	// One identity, however many the headers claimed, and it is the transport peer
	// with its port dropped: the whole allowance landed on that one key.
	key := harness.handler.clientHash.hash("198.51.100.40")
	spent := harness.store.Spent(checkstore.KindClient, key, checkTime, harness.config.clientWindow())
	if spent != int64(harness.config.ClientLimit) {
		t.Errorf("the peer's key holds %d of the allowance, want all %d", spent, harness.config.ClientLimit)
	}
	for i := 0; i <= harness.config.ClientLimit; i++ {
		claimed := harness.handler.clientHash.hash(fmt.Sprintf("203.0.113.%d", i))
		if spent := harness.store.Spent(checkstore.KindClient, claimed, checkTime, harness.config.clientWindow()); spent != 0 {
			t.Errorf("a header-claimed address became an identity holding %d", spent)
		}
	}

	// No raw address reaches the log or the store, in any request or refusal: the key
	// is the only representation either of them holds.
	logged := harness.logs.String()
	for _, address := range []string{"198.51.100.40", "203.0.113."} {
		if strings.Contains(logged, address) {
			t.Errorf("the log holds the raw address %q", address)
		}
	}
	assertNoLeakedText(t, "the log", logged)
}

// TestCheckPrefersTheTrustedGatewayIdentity covers where the identity comes from
// when a gateway adapter supplies one. It reaches the handler through an unexported
// context key rather than through anything on the wire, so nothing a caller sends
// can land under it, and it wins over the transport peer because behind a gateway
// the peer is the gateway.
func TestCheckPrefersTheTrustedGatewayIdentity(t *testing.T) {
	harness := newCheckHarness(t, nil)
	allowance := harness.config.ClientLimit

	// One gateway-supplied identity arriving over changing connections. A peer-keyed
	// throttle would give each connection its own allowance.
	for i := 0; i < allowance; i++ {
		response := checkNames(harness.handler, []string{"zap"},
			fromClient(fmt.Sprintf("192.0.2.%d:4000", i+1)),
			fromTrustedIdentity("gateway-caller-1"))
		if response.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d (body %s)", i+1, response.Code, response.Body)
		}
	}
	decodeFailure(t, checkNames(harness.handler, []string{"zap"},
		fromClient("192.0.2.99:4000"), fromTrustedIdentity("gateway-caller-1")),
		http.StatusTooManyRequests, CodeClientThrottled)

	// A second gateway identity on the same connection as the first is a separate
	// allowance, so the identity really is what was charged.
	if response := checkNames(harness.handler, []string{"zap"},
		fromClient("192.0.2.1:4000"), fromTrustedIdentity("gateway-caller-2")); response.Code != http.StatusOK {
		t.Fatalf("a second gateway identity got status %d (body %s)", response.Code, response.Body)
	}

	spent := harness.store.Spent(checkstore.KindClient,
		harness.handler.clientHash.hash("gateway-caller-1"), checkTime, harness.config.clientWindow())
	if spent != int64(allowance) {
		t.Errorf("the gateway identity holds %d of the allowance, want %d", spent, allowance)
	}
	// The peers it arrived over are not identities.
	for i := 0; i <= allowance; i++ {
		peer := harness.handler.clientHash.hash(fmt.Sprintf("192.0.2.%d", i+1))
		if spent := harness.store.Spent(checkstore.KindClient, peer, checkTime, harness.config.clientWindow()); spent != 0 {
			t.Errorf("a transport peer became an identity holding %d", spent)
		}
	}
	if logged := harness.logs.String(); strings.Contains(logged, "gateway-caller-1") {
		t.Error("the log holds the raw client identity")
	}
}

// TestCheckLogRecordsCarryOnlyKnownFields is the structural half of the logging
// rule. The record is a closed set of counts, statuses, and fixed codes, so no
// candidate label, endpoint, credential, client address, or upstream text can be
// attached to one even by accident.
func TestCheckLogRecordsCarryOnlyKnownFields(t *testing.T) {
	harness := newCheckHarness(t, func(check *CheckConfig) { check.ClientLimit = 10 })
	harness.upstream.register("kwyjibo", checkTime.Add(365*24*time.Hour))

	client := fromClient("198.51.100.50:4000")
	checkNames(harness.handler, []string{"kwyjibo"}, client)
	checkNames(harness.handler, []string{"kwyjibo"}, client)
	checkNames(harness.handler, []string{"ab cd"}, client)
	postCheck(harness.handler, `{"names":["zap"],"endpoint":"http://attacker.example"}`, client)

	harness.upstream.failWith(errors.New(leakedText))
	checkNames(harness.handler, []string{"snrub"}, client)

	allowed := map[string]struct{}{
		"time": {}, "level": {}, "event": {},
		"names": {}, "batches": {}, "outcome": {},
		"cache": {}, "cache_write_failed": {}, "status": {}, "duration_ms": {},
	}
	lines := strings.Split(strings.TrimSpace(harness.logs.String()), "\n")
	if len(lines) != 5 {
		t.Fatalf("the handler wrote %d records, want one per request", len(lines))
	}
	for _, line := range lines {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &fields); err != nil {
			t.Fatalf("decode %q: %v", line, err)
		}
		for name := range fields {
			if _, ok := allowed[name]; !ok {
				t.Errorf("record holds the unexpected field %q: %s", name, line)
			}
		}
	}

	text := harness.logs.String()
	assertNoLeakedText(t, "the log", text)
	for _, forbidden := range []string{
		// Candidate labels, valid and refused.
		"kwyjibo", "snrub", "ab cd",
		// A raw client address, and the field a request tried to add.
		"198.51.100.50", "attacker.example",
	} {
		if strings.Contains(text, forbidden) {
			t.Errorf("the log holds %q: %s", forbidden, text)
		}
	}

	// Severity separates traffic this API refused from a failure it suffered, which
	// is the whole diagnostic value left once the text is gone.
	var refused, failed, completed int
	for _, record := range harness.records(t) {
		switch record.Event {
		case "check_completed":
			completed++
		case "check_refused":
			refused++
		case "check_failed":
			failed++
		}
	}
	if completed != 2 || refused != 2 || failed != 1 {
		t.Errorf("events = %d completed, %d refused, %d failed; want 2, 2, 1", completed, refused, failed)
	}
}

func TestCheckLoggerDiscardsWithoutAWriter(t *testing.T) {
	harness := newCheckHarness(t, func(check *CheckConfig) { check.Log = nil })

	if response := checkNames(harness.handler, []string{"zap"}); response.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", response.Code, response.Body)
	}
	if text := harness.logs.String(); text != "" {
		t.Errorf("a nil log writer still wrote %q", text)
	}
}

// TestCheckPathIsAbsentWithoutAnUpstream keeps a read-only deployment read-only:
// there is no way to make one reach The Graph by request.
func TestCheckPathIsAbsentWithoutAnUpstream(t *testing.T) {
	handler := newTestHandler(t, snapshot.NewMemoryStore(), checkTime)

	for _, method := range []string{http.MethodPost, http.MethodGet, http.MethodOptions} {
		request := httptest.NewRequest(method, PathCheck, strings.NewReader(`{"names":["zap"]}`))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		// A 404 rather than a 405, and a 404 on the preflight too, so a browser cannot
		// discover the endpoint before it exists.
		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s %s: status = %d, want 404", method, PathCheck, recorder.Code)
		}
	}

	// The advertised surface matches, so nothing describes a path this deployment
	// does not serve.
	response := get(handler, http.MethodOptions, PathSnapshot, http.Header{"Origin": []string{testOrigin}})
	if got := response.Header().Get("Access-Control-Allow-Methods"); got != allowedMethods {
		t.Errorf("Allow-Methods = %q, want %q", got, allowedMethods)
	}
	if strings.Contains(response.Header().Get("Access-Control-Allow-Headers"), "Content-Type") {
		t.Error("a deployment with no check path still invites a Content-Type header")
	}
}

func TestCheckMethodsAndPreflight(t *testing.T) {
	harness := newCheckHarness(t, nil)

	t.Run("wrong method", func(t *testing.T) {
		response := get(harness.handler, http.MethodGet, PathCheck, nil)
		decodeFailure(t, response, http.StatusMethodNotAllowed, CodeMethodNotAllowed)
		if got := response.Header().Get("Allow"); got != checkMethods {
			t.Errorf("Allow = %q, want %q", got, checkMethods)
		}
	})

	t.Run("preflight", func(t *testing.T) {
		response := get(harness.handler, http.MethodOptions, PathCheck, http.Header{
			"Origin": []string{testOrigin},
		})
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", response.Code)
		}
		if got := response.Header().Get("Allow"); got != checkMethods {
			t.Errorf("Allow = %q, want %q", got, checkMethods)
		}
		// A browser sending a JSON body needs both of these through the preflight.
		methods := response.Header().Get("Access-Control-Allow-Methods")
		if !strings.Contains(methods, http.MethodPost) {
			t.Errorf("Allow-Methods = %q, want POST among them", methods)
		}
		headers := response.Header().Get("Access-Control-Allow-Headers")
		if !strings.Contains(headers, "Content-Type") {
			t.Errorf("Allow-Headers = %q, want Content-Type among them", headers)
		}
	})

	t.Run("unknown origin", func(t *testing.T) {
		response := get(harness.handler, http.MethodOptions, PathCheck, http.Header{
			"Origin": []string{"https://attacker.example"},
		})
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", response.Code)
		}
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("Allow-Origin = %q, want no grant", got)
		}
		if got := response.Header().Get("Vary"); got != "Origin" {
			t.Errorf("Vary = %q, want Origin", got)
		}
	})
}

// TestCheckDoesNotWeakenTheSnapshotPaths is the regression guard for the read API:
// configuring a check path must not change what the snapshot paths serve.
func TestCheckDoesNotWeakenTheSnapshotPaths(t *testing.T) {
	store := snapshot.NewMemoryStore()
	publishFixture(t, store, snapshot.FixturePreview)

	plain := newTestHandler(t, store, checkTime)
	clock := newCheckClock(checkTime)
	config := testConfig(store, checkTime)
	config.Now = clock.at
	check := testCheckConfig(newFakeGraph(), checkstore.NewMemoryStore(), &syncBuffer{})
	config.Check = &check
	withCheck, err := New(config)
	if err != nil {
		t.Fatalf("build a handler serving both paths: %v", err)
	}

	for _, path := range []string{PathSnapshot, PathMeta} {
		first := get(plain, http.MethodGet, path, nil)
		second := get(withCheck, http.MethodGet, path, nil)

		if first.Code != http.StatusOK || second.Code != http.StatusOK {
			t.Fatalf("%s: status = %d and %d, want 200", path, first.Code, second.Code)
		}
		if first.Body.String() != second.Body.String() {
			t.Errorf("%s: the check path changed the body served", path)
		}
		for _, header := range []string{"ETag", "Cache-Control", "Last-Modified", "Content-Type"} {
			if first.Header().Get(header) != second.Header().Get(header) {
				t.Errorf("%s: %s = %q with the check path and %q without",
					path, header, second.Header().Get(header), first.Header().Get(header))
			}
		}
	}

	// The snapshot cache still costs one store read for a burst, and the check path
	// has not been given a way to write to the store: Config.Store is a Reader.
	if got := get(withCheck, http.MethodGet, PathHealth, nil).Code; got != http.StatusOK {
		t.Errorf("/health status = %d, want 200", got)
	}
}

// Assertions and small helpers.

func assertRetryAfter(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()

	got := response.Header().Get("Retry-After")
	if got != strconv.Itoa(want) {
		t.Errorf("Retry-After = %q, want %q", got, strconv.Itoa(want))
	}
}

func assertNoRetryAfter(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()

	if got := response.Header().Get("Retry-After"); got != "" {
		t.Errorf("Retry-After = %q, want none: waiting cannot clear this failure", got)
	}
}

// assertNoLeakedText proves the credential, the gateway URL, and the candidate
// name in leakedText are all absent. A real credential is never used here: the
// point is that this fabricated one could not have escaped either.
func assertNoLeakedText(t *testing.T, label, text string) {
	t.Helper()

	for _, forbidden := range []string{leakedSecret, "gateway.thegraph.com", leakedText} {
		if strings.Contains(text, forbidden) {
			t.Errorf("%s holds %q: %s", label, forbidden, text)
		}
	}
}

func sortedStrings(values []string) []string {
	sorted := append([]string(nil), values...)
	sort.Strings(sorted)
	return sorted
}

func sortedInts(values []int) []int {
	sorted := append([]int(nil), values...)
	sort.Ints(sorted)
	return sorted
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func equalInts(got, want []int) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
