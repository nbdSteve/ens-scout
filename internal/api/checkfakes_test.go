package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ens-scrape/internal/checkstore"
	"ens-scrape/internal/ens"
	"ens-scrape/internal/snapshot"
)

// checkClock is a clock a test moves by hand.
//
// Every throttle window and every cache expiry on the check path is resolved
// against Config.Now, so a test proves a window rolls over and an entry expires by
// advancing this rather than by sleeping.
type checkClock struct {
	mutex sync.Mutex
	now   time.Time
}

func newCheckClock(at time.Time) *checkClock {
	return &checkClock{now: at.UTC()}
}

func (c *checkClock) at() time.Time {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	return c.now
}

func (c *checkClock) advance(d time.Duration) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	c.now = c.now.Add(d)
}

// syncBuffer collects log output. The logger writes under its own lock, but a
// test reads while nothing else is running, so this only has to be safe rather
// than ordered.
type syncBuffer struct {
	mutex  sync.Mutex
	buffer bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.Write(p)
}

func (b *syncBuffer) String() string {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.String()
}

// checkTime is the instant every check test starts at. It is fixed so a
// classified status, a cache expiry, and a rolled-over window are all deterministic.
var checkTime = time.Date(2025, 6, 1, 12, 0, 0, 0, time.UTC)

// testCheckSecret is the stable deployment secret these tests key the client
// identity under. It is exactly the minimum length, so a test that shortens it by
// one byte proves the floor rather than a rounded-down guess. It is a test literal
// and not a credential of any kind.
var testCheckSecret = []byte("0123456789abcdef0123456789abcdef")

// testCheckConfig is the check configuration these tests use.
//
// Every bound is far smaller than a deployment's, so a test reaches one by
// sending a handful of bytes rather than by generating a realistic flood. The
// values are otherwise ordinary: nothing here disables a control.
func testCheckConfig(upstream *fakeGraph, store checkstore.Store, log *syncBuffer) CheckConfig {
	return CheckConfig{
		Upstream:        upstream,
		Store:           store,
		MaxRequestBytes: 1024,
		MaxNames:        5,
		MaxLabelBytes:   8,
		// Two names per upstream call, so a three-name request is two batches and the
		// budget a request is charged is observable rather than always one.
		BatchSize:           2,
		Workers:             2,
		Retries:             2,
		Timeout:             2 * time.Second,
		Soon:                30 * 24 * time.Hour,
		CacheLifetime:       30 * time.Second,
		LocalCacheEntries:   4,
		ClientLimit:         2,
		ClientWindow:        time.Minute,
		ClientSecret:        testCheckSecret,
		UpstreamLimit:       10,
		UpstreamWindow:      time.Minute,
		UpstreamConcurrency: 2,
		Log:                 log,
	}
}

// checkHarness is one deployment that serves PathCheck, plus everything a test
// needs to drive it: the shared store its allowances live in, the clock it resolves
// windows against, the log it writes, and the upstream it calls.
//
// The snapshot store is an empty MemoryStore. The check path never reads it, and a
// test that needs a published snapshot as well builds its own handler.
type checkHarness struct {
	handler  *Handler
	store    *checkstore.MemoryStore
	clock    *checkClock
	upstream *fakeGraph
	logs     *syncBuffer
	config   CheckConfig
}

// newCheckHarness builds a handler whose check configuration is testCheckConfig
// with tune applied, so one test can lower one bound without restating the rest.
func newCheckHarness(t *testing.T, tune func(*CheckConfig)) *checkHarness {
	t.Helper()

	harness := &checkHarness{
		store:    checkstore.NewMemoryStore(),
		clock:    newCheckClock(checkTime),
		upstream: newFakeGraph(),
		logs:     &syncBuffer{},
	}
	harness.config = testCheckConfig(harness.upstream, harness.store, harness.logs)
	if tune != nil {
		tune(&harness.config)
	}
	harness.handler = harness.instance(t, nil)
	return harness
}

// instance builds another handler over the same store, clock, upstream, and log.
//
// It is how a cold instance and a concurrent one are modelled: a Lambda replacement
// or a second container is exactly a new Handler with empty process-local state over
// the same table. tune edits that instance's own configuration, so one instance can
// differ from another the way two deployments of one stack can.
func (h *checkHarness) instance(t *testing.T, tune func(*CheckConfig)) *Handler {
	t.Helper()

	check := h.config
	if tune != nil {
		tune(&check)
	}

	config := testConfig(snapshot.NewMemoryStore(), checkTime)
	config.Now = h.clock.at
	config.Check = &check

	handler, err := New(config)
	if err != nil {
		t.Fatalf("build a handler serving %s: %v", PathCheck, err)
	}
	return handler
}

// records decodes every log line the handler wrote.
func (h *checkHarness) records(t *testing.T) []checkRecord {
	t.Helper()

	var records []checkRecord
	for _, line := range strings.Split(strings.TrimSpace(h.logs.String()), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var record checkRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode log line %q: %v", line, err)
		}
		records = append(records, record)
	}
	return records
}

// lastRecord returns the record for the most recent request.
func (h *checkHarness) lastRecord(t *testing.T) checkRecord {
	t.Helper()

	records := h.records(t)
	if len(records) == 0 {
		t.Fatal("the handler wrote no log record")
	}
	return records[len(records)-1]
}

// requestOption edits a request before it is served, so one helper covers a
// missing content type, a lying content length, another client, and a request
// whose own context is already lost.
type requestOption func(*http.Request)

// fromClient sets the transport peer, which is the identity the throttle keys on
// when no trusted adapter supplied one.
func fromClient(address string) requestOption {
	return func(r *http.Request) { r.RemoteAddr = address }
}

// fromTrustedIdentity attaches the identity a gateway adapter would have read out
// of a signed request context. It stands in for that adapter: nothing a caller
// writes can land under the context key, which is the whole difference between this
// and a forwarding header.
func fromTrustedIdentity(identity string) requestOption {
	return func(r *http.Request) { *r = *r.WithContext(WithClientIdentity(r.Context(), identity)) }
}

// withHeader sets one request header, so a test can prove a forwarding header is
// ignored rather than trusted.
func withHeader(name, value string) requestOption {
	return func(r *http.Request) { r.Header.Set(name, value) }
}

// withContentType replaces the content type, or removes it when value is empty.
func withContentType(value string) requestOption {
	return func(r *http.Request) {
		if value == "" {
			r.Header.Del("Content-Type")
			return
		}
		r.Header.Set("Content-Type", value)
	}
}

// withDeclaredLength sets Content-Length without changing the body, so a test can
// present the declared length as the advisory value it is.
func withDeclaredLength(length int64) requestOption {
	return func(r *http.Request) { r.ContentLength = length }
}

// inContext replaces the request context, which is how a test presents a client
// that hung up or a platform deadline that expired.
func inContext(ctx context.Context) requestOption {
	return func(r *http.Request) { *r = *r.WithContext(ctx) }
}

// postCheck sends one request to PathCheck with a raw body.
func postCheck(handler *Handler, body string, options ...requestOption) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, PathCheck, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	for _, option := range options {
		option(request)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// checkNames sends one well-formed request for the given entries.
func checkNames(handler *Handler, names []string, options ...requestOption) *httptest.ResponseRecorder {
	return postCheck(handler, namesBody(names...), options...)
}

// namesBody renders the request document.
func namesBody(names ...string) string {
	body, err := json.Marshal(checkRequest{Names: names})
	if err != nil {
		panic(err)
	}
	return string(body)
}

// decodeCheck decodes a successful check response, failing the test on any other
// status so a later assertion cannot be vacuous.
func decodeCheck(t *testing.T, response *httptest.ResponseRecorder) checkDocument {
	t.Helper()

	if response.Code != http.StatusOK {
		t.Fatalf("check status = %d, want %d (body %s)", response.Code, http.StatusOK, response.Body)
	}
	var document checkDocument
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode check response: %v", err)
	}
	return document
}

// decodeFailure decodes a failure response and asserts its status and code.
func decodeFailure(t *testing.T, response *httptest.ResponseRecorder, status int, code string) errorDocument {
	t.Helper()

	if response.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", response.Code, status, response.Body)
	}
	var document errorDocument
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode failure response: %v", err)
	}
	if document.Error.Code != code {
		t.Fatalf("failure code = %q, want %q", document.Error.Code, code)
	}
	return document
}

// fakeGraph is a deterministic checker.Client.
//
// It records what it was asked, answers from a registration table so the real
// classifier produces the statuses, and can be told to fail, to hold until the
// request context ends, or to answer about a set that is not the one it was asked
// about. No test in this package reaches a network through it.
type fakeGraph struct {
	mutex sync.Mutex

	// batches is every call, in the order the calls were recorded.
	batches [][]string

	// registered maps a bare label to its expiry. A label that is absent is
	// answered as not indexed, which ens.Classify reports as available.
	registered map[string]time.Time

	// err fails every call.
	err error

	// hold blocks every call until the request context ends, which is how a test
	// reaches a deadline without sleeping through one.
	hold bool

	// dropLast and renameFirst break the answer's coverage of the request, which is
	// a truncated and a substituted upstream answer respectively.
	dropLast    bool
	renameFirst string

	// entered and release hold a call inside the fake. It reports that it is in the
	// lookup and then waits to be let go, so a concurrency bound is proved by two
	// requests whose overlap is arranged rather than raced.
	entered chan struct{}
	release chan struct{}
}

func newFakeGraph() *fakeGraph {
	return &fakeGraph{registered: make(map[string]time.Time)}
}

// register makes one label answer as an active registration expiring at expiry.
func (g *fakeGraph) register(label string, expiry time.Time) {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	g.registered[label] = expiry.UTC()
}

func (g *fakeGraph) failWith(err error) {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	g.err = err
}

func (g *fakeGraph) holdUntilCancelled() {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	g.hold = true
}

// holdInside makes the next call block once it is inside the lookup. The returned
// channel reports that, and the returned function lets the call finish.
//
// It holds exactly one call. A test that proves a released slot is usable again
// sends another request afterwards, and that one must run normally rather than
// wait for a receiver nobody is going to provide.
func (g *fakeGraph) holdInside() (<-chan struct{}, func()) {
	entered := make(chan struct{})
	release := make(chan struct{})

	g.mutex.Lock()
	g.entered, g.release = entered, release
	g.mutex.Unlock()

	var once sync.Once
	return entered, func() { once.Do(func() { close(release) }) }
}

func (g *fakeGraph) calls() int {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	return len(g.batches)
}

// asked returns every label the fake was asked about, across every call.
func (g *fakeGraph) asked() []string {
	g.mutex.Lock()
	defer g.mutex.Unlock()

	var labels []string
	for _, batch := range g.batches {
		labels = append(labels, batch...)
	}
	return labels
}

// batchSizes returns the size of each call, so a test can prove batching happened
// rather than one call per name.
func (g *fakeGraph) batchSizes() []int {
	g.mutex.Lock()
	defer g.mutex.Unlock()

	sizes := make([]int, 0, len(g.batches))
	for _, batch := range g.batches {
		sizes = append(sizes, len(batch))
	}
	return sizes
}

func (g *fakeGraph) Lookup(ctx context.Context, labels []string) ([]ens.Lookup, error) {
	g.mutex.Lock()
	g.batches = append(g.batches, append([]string(nil), labels...))
	err, hold := g.err, g.hold
	// Claimed rather than read, so holdInside holds one call and no more.
	entered, release := g.entered, g.release
	g.entered, g.release = nil, nil
	dropLast, renameFirst := g.dropLast, g.renameFirst
	registered := make(map[string]time.Time, len(g.registered))
	for label, expiry := range g.registered {
		registered[label] = expiry
	}
	g.mutex.Unlock()

	if entered != nil {
		// The context is honoured on both halves, so a test that forgets to release
		// fails on its own deadline rather than deadlocking the package.
		select {
		case entered <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if hold {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, err
	}

	lookups := make([]ens.Lookup, 0, len(labels))
	for _, label := range labels {
		lookup := ens.Lookup{Name: label + snapshot.NameSuffix}
		if expiry, found := registered[label]; found {
			at := expiry
			lookup.Found = true
			lookup.Expiry = &at
		}
		lookups = append(lookups, lookup)
	}
	if dropLast && len(lookups) > 0 {
		lookups = lookups[:len(lookups)-1]
	}
	if renameFirst != "" && len(lookups) > 0 {
		lookups[0].Name = renameFirst
	}
	return lookups, nil
}

// graphServer is a local HTTP server standing in for the Graph gateway, so a test
// exercises the real ens.Client against a real transport. Nothing here reaches a
// public service: the address is the loopback one httptest chose.
type graphServer struct {
	server *httptest.Server

	mutex    sync.Mutex
	requests int
}

// newGraphServer answers every request with the given status and body, and counts
// the attempts, which is how a retry bound is proved.
func newGraphServer(t *testing.T, status int, body string) *graphServer {
	t.Helper()

	fake := &graphServer{}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.mutex.Lock()
		fake.requests++
		fake.mutex.Unlock()

		// Retry-After: 0 so a retrying client does not sleep. The bound under test is
		// how many attempts are made, not how long each backoff is.
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (s *graphServer) attempts() int {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.requests
}

// client builds the real subgraph client against this server.
func (s *graphServer) client(t *testing.T, retries int) *ens.Client {
	t.Helper()

	client, err := ens.NewClient(s.server.URL, s.server.Client(), retries)
	if err != nil {
		t.Fatalf("build an ENS client for the local server: %v", err)
	}
	return client
}
