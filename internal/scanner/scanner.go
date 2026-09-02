// Package scanner runs one scheduled ENS scan and publishes its snapshot.
//
// It is the whole body of the scheduled Lambda, minus the runtime wiring: the
// entrypoint constructs a Graph client and a storage backend and calls Run. That
// split keeps this package free of AWS and HTTP transport dependencies, so every
// behaviour below - which lists a schedule scans, what happens to the lists it
// does not, and what a failure leaves published - is tested against local fakes
// with no network and no credentials.
//
// The package adds no ENS or publication logic of its own. Lifecycle
// classification is ens.Classify, batching and bounded concurrency are
// checker.Run, and serialization, chunking, verification, and pointer ordering
// are internal/snapshot.
package scanner

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ens-scrape/internal/checker"
	"ens-scrape/internal/ens"
	"ens-scrape/internal/names"
	"ens-scrape/internal/snapshot"
)

// Group is the set of word lists one schedule scans.
//
// There are two schedules rather than one because the lists differ by orders of
// magnitude in size: the short lists are cheap enough to re-check every few
// hours, and the five-letter list is not. A group is the unit of a scan, so the
// schedule payload names a group and never a file, a cadence, or a count.
type Group string

const (
	// GroupShort covers the three- and four-letter lists, scanned three-hourly.
	GroupShort Group = "three-four-letter"

	// GroupLong covers the five-letter list, scanned daily.
	GroupLong Group = "five-letter"
)

// Groups is every group a schedule may name.
var Groups = []Group{GroupShort, GroupLong}

// Event is the schedule payload. It carries a group and nothing else: a payload
// that could name arbitrary files, name counts, or cadences would let whatever
// can invoke the function decide how much Graph budget to spend.
type Event struct {
	Group Group `json:"group"`
}

// ListSpec binds one word list to its identity, its published path, its cadence,
// and the schedule that scans it.
//
// Path is the declared repository-relative path and is what the snapshot
// publishes. Reads resolve against Config.WordListDir instead, so the published
// bytes do not change when the deployment bundle unpacks the same lists somewhere
// else.
type ListSpec struct {
	ID      string
	Path    string
	Cadence snapshot.Cadence
	Group   Group
}

// Lists is every input list, in the order that decides which list owns a label
// that appears in more than one. The order is the contract: names.Load gives the
// first path a duplicate label, and per-list attribution has to reproduce that
// exactly or the published source counts will not sum to the result count.
var Lists = []ListSpec{
	{ID: "3-letters", Path: "data/words/3-letters.txt", Cadence: snapshot.CadenceThreeHourly, Group: GroupShort},
	{ID: "4-letters", Path: "data/words/4-letters.txt", Cadence: snapshot.CadenceThreeHourly, Group: GroupShort},
	{ID: "5-letters", Path: "data/words/5-letters.txt", Cadence: snapshot.CadenceDaily, Group: GroupLong},
}

// Environment variable names. The Lambda reads its whole configuration from the
// environment once, at cold start, through LoadConfig.
const (
	EnvTable          = "ENS_SNAPSHOT_TABLE"
	EnvSubgraphURL    = "ENS_SUBGRAPH_URL"
	EnvSubgraphID     = "ENS_SUBGRAPH_ID"
	EnvAPIKey         = "THEGRAPH_API_KEY"
	EnvWordListDir    = "ENS_WORD_LIST_DIR"
	EnvWorkers        = "ENS_SCAN_WORKERS"
	EnvBatchSize      = "ENS_SCAN_BATCH_SIZE"
	EnvRetries        = "ENS_SCAN_HTTP_RETRIES"
	EnvSoonDays       = "ENS_SCAN_SOON_DAYS"
	EnvRequestSeconds = "ENS_SCAN_REQUEST_TIMEOUT_SECONDS"
	EnvScanSeconds    = "ENS_SCAN_BUDGET_SECONDS"
	EnvPreviousReads  = "ENS_SCAN_PREVIOUS_READ_ATTEMPTS"
)

// gatewayTemplate is the authenticated Graph gateway. The API key travels in the
// path, which is why the resolved endpoint is treated as a secret: it is never a
// log field, and a Redactor strips any URL an error quotes as well as the key and
// the endpoint as literals.
const gatewayTemplate = "https://gateway.thegraph.com/api/%s/subgraphs/id/%s"

// Configuration bounds. Every knob has a ceiling as well as a floor, because a
// mistyped environment variable must not be able to turn a scheduled job into an
// unbounded one.
const (
	maxWorkers          = 64
	maxBatchSize        = 1000
	maxRetries          = 10
	maxSoonDays         = 365
	maxRequestSeconds   = 300
	maxScanSeconds      = 3600
	maxPreviousReads    = 10
	defaultWordListDir  = "data/words"
	defaultWorkers      = 4
	defaultBatchSize    = 100
	defaultRetries      = 3
	defaultSoonDays     = 30
	defaultRequestSecs  = 30
	defaultScanSecs     = 600
	defaultPreviousRead = 3
)

// previousReadBackoff is the wait between attempts to read the previous snapshot.
// It is short and fixed: the read is one strongly consistent pointer fetch plus
// its chunks, so a retry is either immediately useful or not useful at all.
const previousReadBackoff = 250 * time.Millisecond

// Bounds on the superseded snapshot's TTL write.
//
// It is the only retention a publication can aim at the set it replaced, and no later
// run knows what this one replaced, so a single throttled item write would otherwise
// leak a whole snapshot. ExpireChunks sets the same attribute to the same value on
// every chunk, so a retry is idempotent and also finishes an expiry that stopped part
// way through.
const (
	maxExpireAttempts = 3
	expireBackoff     = 250 * time.Millisecond
)

// Retention of chunk sets that were written but never published.
//
// A publication writes every chunk and then moves the pointer. Between those two
// steps the chunk set exists and nothing names it, so a run that is killed, times
// out, or loses the pointer race leaves a complete set behind. The run stages its
// snapshot ID before the first chunk write, which makes that set findable from the
// next run rather than from a deferred cleanup this one may never reach.
const (
	// abandonedAfter is how long a snapshot must have been staged before a later
	// run may reclaim it. It has to exceed the longest an invocation can live, or a
	// reclaim could expire chunks a publisher is still writing; Lambda's own
	// ceiling is fifteen minutes, so this is generously past any run while staying
	// inside the three-hourly cadence, and an abandoned set is reclaimed on the next
	// schedule at the earliest and the one after it at the latest.
	abandonedAfter = 2 * time.Hour

	// abandonedRetention is how long a reclaimed set stays readable. No pointer
	// ever named it, so no reader can be resolving it and the window exists only so
	// an operator can inspect the payload of a publication that failed.
	abandonedRetention = 24 * time.Hour

	// stagingRetention bounds a staging marker itself, so a marker whose chunks are
	// already gone cannot accumulate. It is far longer than the reclaim window on
	// purpose: a marker that expired before its chunks were reclaimed would leave
	// them unreachable again, which is the state staging exists to prevent.
	stagingRetention = 30 * 24 * time.Hour

	// maxReclaimsPerRun bounds the retention work one invocation does, so a table
	// holding many abandoned sets is drained over several runs instead of turning
	// one scheduled scan into an unbounded cleanup job.
	maxReclaimsPerRun = 8
)

// Config is the scanner's whole configuration.
type Config struct {
	// Table is the DynamoDB table the entrypoint opens. The scanner itself never
	// uses it; it is parsed and validated here so a deployment misconfiguration
	// fails in tested code at cold start rather than in the entrypoint.
	Table string

	// Endpoint is the resolved Graph endpoint. It may embed an API key, so it is
	// never logged and never published.
	Endpoint string

	// APIKey is the Graph credential, when one is configured. It is kept so the run
	// can strip it from anything it logs or returns: it travels in the endpoint's
	// path, and an error from a lower layer may quote text this process never
	// composed, including a slice of an upstream response body. It is never a log
	// field and never published.
	APIKey string

	// WordListDir is where the deployed word lists are read from.
	WordListDir string

	// Workers, BatchSize, and Soon bound and shape the scan itself. Retries and
	// RequestTimeout configure the HTTP client the entrypoint builds, and are
	// parsed here for the same reason Table is.
	Workers        int
	BatchSize      int
	Retries        int
	Soon           time.Duration
	RequestTimeout time.Duration

	// ScanBudget bounds the Graph phase, leaving the rest of the invocation for
	// publication. A scan that overruns is abandoned before it can eat the time
	// its own snapshot needs to be written, read back, and verified.
	ScanBudget time.Duration

	// PreviousReadAttempts bounds how hard the run tries to read the snapshot it
	// is merging forward from.
	PreviousReadAttempts int
}

// LoadConfig reads the configuration from a lookup function, which is os.Getenv
// in the Lambda and a map in tests, so no test has to mutate process state.
//
// There is deliberately no fallback to the public ENS endpoint. The CLI falls
// back because an interactive user checking a handful of names is exactly the
// rate-limited endpoint's audience; a scheduled scan of tens of thousands of
// names is not, and a silent fallback would turn a missing credential into a
// slow, partial, failing scan rather than a startup error.
func LoadConfig(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("a configuration lookup is required")
	}
	get := func(name string) string { return strings.TrimSpace(lookup(name)) }

	config := Config{
		Table:       get(EnvTable),
		WordListDir: get(EnvWordListDir),
		APIKey:      get(EnvAPIKey),
	}
	if config.WordListDir == "" {
		config.WordListDir = defaultWordListDir
	}

	endpoint, err := resolveEndpoint(get(EnvSubgraphURL), get(EnvAPIKey), get(EnvSubgraphID))
	if err != nil {
		return Config{}, err
	}
	config.Endpoint = endpoint

	numbers := []struct {
		name     string
		target   *int
		fallback int
		low      int
		high     int
	}{
		{EnvWorkers, &config.Workers, defaultWorkers, 1, maxWorkers},
		{EnvBatchSize, &config.BatchSize, defaultBatchSize, 1, maxBatchSize},
		{EnvRetries, &config.Retries, defaultRetries, 0, maxRetries},
		{EnvPreviousReads, &config.PreviousReadAttempts, defaultPreviousRead, 1, maxPreviousReads},
	}
	for _, number := range numbers {
		value, err := intSetting(get(number.name), number.name, number.fallback, number.low, number.high)
		if err != nil {
			return Config{}, err
		}
		*number.target = value
	}

	soonDays, err := intSetting(get(EnvSoonDays), EnvSoonDays, defaultSoonDays, 0, maxSoonDays)
	if err != nil {
		return Config{}, err
	}
	config.Soon = time.Duration(soonDays) * 24 * time.Hour

	requestSeconds, err := intSetting(get(EnvRequestSeconds), EnvRequestSeconds, defaultRequestSecs, 1, maxRequestSeconds)
	if err != nil {
		return Config{}, err
	}
	config.RequestTimeout = time.Duration(requestSeconds) * time.Second

	scanSeconds, err := intSetting(get(EnvScanSeconds), EnvScanSeconds, defaultScanSecs, 1, maxScanSeconds)
	if err != nil {
		return Config{}, err
	}
	config.ScanBudget = time.Duration(scanSeconds) * time.Second

	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

// Validate rejects a configuration that cannot run a bounded scan.
func (c Config) Validate() error {
	if c.Table == "" {
		return fmt.Errorf("%s is required", EnvTable)
	}
	if c.Endpoint == "" {
		return fmt.Errorf("a Graph endpoint is required")
	}
	if c.WordListDir == "" {
		return fmt.Errorf("a word list directory is required")
	}
	if c.Workers < 1 || c.Workers > maxWorkers {
		return fmt.Errorf("%s must be between 1 and %d", EnvWorkers, maxWorkers)
	}
	if c.BatchSize < 1 || c.BatchSize > maxBatchSize {
		return fmt.Errorf("%s must be between 1 and %d", EnvBatchSize, maxBatchSize)
	}
	if c.Retries < 0 || c.Retries > maxRetries {
		return fmt.Errorf("%s must be between 0 and %d", EnvRetries, maxRetries)
	}
	if c.Soon < 0 {
		return fmt.Errorf("%s must not be negative", EnvSoonDays)
	}
	if c.RequestTimeout <= 0 {
		return fmt.Errorf("%s must be positive", EnvRequestSeconds)
	}
	if c.ScanBudget <= 0 {
		return fmt.Errorf("%s must be positive", EnvScanSeconds)
	}
	if c.PreviousReadAttempts < 1 {
		return fmt.Errorf("%s must be at least 1", EnvPreviousReads)
	}
	// A configured credential has to be long enough for the redactor to strip it as
	// a literal, or the configuration-aware half of redaction silently degrades to
	// the URL pattern alone and a key the gateway echoes back in a response body
	// reaches the log group bare. Failing at startup matches the rest of this
	// Lambda: a credential that is not usable is not something to run without.
	// Neither the value nor any prefix of it is quoted back.
	if c.APIKey != "" && len(c.APIKey) < minRedactedSecret {
		return fmt.Errorf("%s is too short to be a Graph API key: it must be at least %d characters so it can be redacted",
			EnvAPIKey, minRedactedSecret)
	}
	return nil
}

// Redactor returns the redactor for this configuration. On top of the URL and
// candidate-name patterns every Redactor applies, it strips the configured API key
// and the resolved endpoint as literals, because the layer that produced an error
// promises nothing about what its text quotes.
func (c Config) Redactor() *Redactor {
	return NewRedactor(c.APIKey, c.Endpoint)
}

// resolveEndpoint picks the Graph endpoint. An explicit URL wins, so an operator
// can point a run at a self-hosted index; otherwise an API key and a subgraph ID
// together select the authenticated gateway. The subgraph ID has no default on
// the key path, because a scheduled job should say which index it queries rather
// than inherit one.
func resolveEndpoint(explicit, apiKey, subgraphID string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if apiKey == "" {
		return "", fmt.Errorf("set %s or %s to choose a Graph endpoint", EnvSubgraphURL, EnvAPIKey)
	}
	if subgraphID == "" {
		return "", fmt.Errorf("%s is required when %s selects the Graph gateway", EnvSubgraphID, EnvAPIKey)
	}
	if strings.ContainsAny(apiKey, "/?#") || strings.ContainsAny(subgraphID, "/?#") {
		// Path segments, not query values: a separator here would silently
		// redirect the scan somewhere other than the intended subgraph. The
		// offending value is not quoted back, because one of them is a secret.
		return "", fmt.Errorf("%s and %s must not contain URL separators", EnvAPIKey, EnvSubgraphID)
	}
	return fmt.Sprintf(gatewayTemplate, apiKey, subgraphID), nil
}

func intSetting(raw, name string, fallback, low, high int) (int, error) {
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	if value < low || value > high {
		return 0, fmt.Errorf("%s must be between %d and %d", name, low, high)
	}
	return value, nil
}

// Store is the storage surface one run needs: the published snapshot contract, the
// staging registry that keeps an unpublished chunk set findable, and the retention
// call that expires a snapshot this run no longer needs.
//
// It is an interface so this package imports no AWS SDK. The DynamoDB backend
// satisfies it, and so does a local fake.
type Store interface {
	snapshot.Store
	snapshot.StagingStore

	// ExpireChunks assigns a TTL to the chunks of a snapshot that is not the
	// published one. It refuses while the latest pointer names that snapshot, so a
	// run cannot expire what readers are serving, and refuses on a pointer it
	// cannot read, which proves nothing either way.
	ExpireChunks(ctx context.Context, snapshotID string, expiresAt time.Time) error
}

// Dependencies are what Run needs from its caller.
type Dependencies struct {
	Config Config
	Store  Store
	Client checker.Client
	Logger *Logger

	// Now is the wall clock, injected so tests are deterministic. The scan's own
	// classification instant comes from checker.Run, not from here.
	Now func() time.Time

	// Sleep waits between previous-snapshot read attempts, and returns the
	// context error rather than waiting out a cancelled run.
	Sleep func(ctx context.Context, delay time.Duration) error
}

func (d Dependencies) validate() error {
	if err := d.Config.Validate(); err != nil {
		return err
	}
	if d.Store == nil {
		return fmt.Errorf("a snapshot store is required")
	}
	if d.Client == nil {
		return fmt.Errorf("a Graph client is required")
	}
	return nil
}

func (d Dependencies) now() time.Time {
	if d.Now == nil {
		return time.Now().UTC()
	}
	return d.Now().UTC()
}

func (d Dependencies) sleep(ctx context.Context, delay time.Duration) error {
	if d.Sleep != nil {
		return d.Sleep(ctx, delay)
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Result reports what one run published.
type Result struct {
	Latest  snapshot.Latest
	Group   Group
	Scanned int
	Carried int

	// Previous is the snapshot this publication superseded, as reported by the
	// pointer write, and is empty when the run published into an empty store or
	// replaced a pointer that could not be read. It is deliberately not the snapshot
	// the run merged forward from: those are the same snapshot on the ordinary path,
	// and where they differ it is the replaced one that needs a retention window.
	Previous string
}

// Run performs one scheduled scan and publishes its snapshot.
//
// The published snapshot always covers every list, not just the ones this
// schedule scans. There is exactly one latest pointer, so a run that published
// only its own group would erase the other group's results, and a run that
// rescanned every list would multiply the Graph budget by the fastest cadence.
// The group's lists are scanned; the rest are carried forward from the previous
// snapshot and reclassified at this scan's instant by snapshot.CarryForward.
//
// Nothing becomes visible until the whole snapshot is stored, read back, and
// verified: snapshot.Publish writes the pointer last. So a Graph failure, a
// normalization failure, a serialization failure, a write failure, a readback
// failure, a checksum mismatch, a timeout, a cancellation, or a losing
// compare-and-swap all leave the previous snapshot serving.
//
// A failure between the chunk write and the pointer write leaves a chunk set no
// pointer names. The run stages its snapshot ID before it writes a chunk and
// unstages it after the pointer moves, so the next run can find and reclaim what
// this one abandoned. Staging is durable before anything can go wrong, which is what
// separates it from a deferred cleanup: the failures that abandon a chunk set are
// exactly the ones that never run a defer.
func Run(ctx context.Context, deps Dependencies, event Event) (Result, error) {
	logger := deps.Logger
	// Every error this run logs is rendered through the configuration's redactor, so
	// the credential in the endpoint's path cannot reach a log group even if a lower
	// layer quotes text this process never composed.
	logger.UseRedactor(deps.Config.Redactor())
	started := deps.now()

	group, err := parseGroup(event.Group)
	if err != nil {
		logger.LogError(LevelError, "scan_rejected", Fields{}, err)
		return Result{}, err
	}
	if err := deps.validate(); err != nil {
		logger.LogError(LevelError, "scan_rejected", Fields{Group: group}, err)
		return Result{}, err
	}
	logger.Log(LevelInfo, "scan_started", Fields{Group: group, Lists: len(Lists)})

	inputs, owner, err := loadLists(deps.Config.WordListDir)
	if err != nil {
		return Result{}, deps.fail(logger, "list_load_failed", Fields{Group: group}, err)
	}
	fresh := freshLabels(inputs, group)
	if len(fresh) == 0 {
		// A group with no labels would publish a snapshot describing a scan that
		// asked the subgraph nothing, and would move the pointer to do it.
		err := fmt.Errorf("group %q has no labels to scan", group)
		return Result{}, deps.fail(logger, "list_load_failed", Fields{Group: group}, err)
	}
	logger.Log(LevelInfo, "lists_loaded", Fields{Group: group, Lists: len(inputs), Names: len(owner), Scanned: len(fresh)})

	scanContext, cancelScan := context.WithTimeout(ctx, deps.Config.ScanBudget)
	results, stats, err := checker.Run(scanContext, deps.Client, fresh, checker.Options{
		Workers:   deps.Config.Workers,
		BatchSize: deps.Config.BatchSize,
		Soon:      deps.Config.Soon,
		Now:       func() time.Time { return deps.now() },
	})
	cancelScan()
	if err != nil {
		return Result{}, deps.fail(logger, "scan_failed", Fields{Group: group}, err)
	}
	logger.Log(LevelInfo, "scan_completed", Fields{
		Group:        group,
		Scanned:      len(results),
		Batches:      stats.Batches,
		ScannedAt:    stats.ClassifiedAt.Format(time.RFC3339),
		DurationMill: millis(deps.now().Sub(started)),
	})

	// The previous snapshot is read after the scan, not before it. A scan takes
	// minutes, the other group's schedule can publish during those minutes, and
	// carrying forward what was published before this scan started would overwrite
	// that fresher data with a status this run never checked. Reading last also puts
	// the bounded retry and its backoff after the Graph spend, which is the cost of
	// carrying the newest published snapshot rather than the oldest one this run
	// could have seen.
	previous, err := readPrevious(ctx, deps, logger)
	if err != nil {
		return Result{}, deps.fail(logger, "previous_snapshot_read_failed", Fields{Group: group}, err)
	}

	// Every published status is checked against the instant the scan classified
	// at, so carried results are re-derived at that same instant and the snapshot
	// is built with it rather than with a freshly sampled clock.
	carried, err := snapshot.CarryForward(carryForwardResults(previous, owner, group), stats.ClassifiedAt, deps.Config.Soon)
	if err != nil {
		return Result{}, deps.fail(logger, "carry_forward_failed", Fields{Group: group}, err)
	}

	combined := make([]ens.Result, 0, len(results)+len(carried))
	combined = append(combined, results...)
	combined = append(combined, carried...)

	sources, err := deriveSources(inputs, owner, combined)
	if err != nil {
		return Result{}, deps.fail(logger, "source_attribution_failed", Fields{Group: group}, err)
	}

	built, err := snapshot.Build(snapshotID(group, stats.ClassifiedAt), stats.ClassifiedAt, sources, combined)
	if err != nil {
		return Result{}, deps.fail(logger, "snapshot_build_failed", Fields{Group: group}, err)
	}

	stagedAt := deps.now().Truncate(time.Second)
	if err := deps.Store.StageSnapshot(ctx, built.Metadata.SnapshotID, stagedAt, stagedAt.Add(stagingRetention)); err != nil {
		// Nothing has been written yet, so failing here publishes nothing and loses
		// nothing. Writing chunks with no durable record of them is the one outcome
		// worth refusing, because that is the orphan staging exists to prevent.
		return Result{}, deps.fail(logger, "snapshot_stage_failed",
			Fields{Group: group, SnapshotID: built.Metadata.SnapshotID}, err)
	}

	latest, replaced, publishErr := snapshot.Publish(ctx, deps.Store, built, deps.now().Truncate(time.Second))

	result := Result{Group: group, Scanned: len(results), Carried: len(carried)}
	// superseded is the snapshot the pointer write replaced, and is set only once that
	// snapshot's retention is settled. The reclaim pass is told about it so it can drop a
	// leftover marker for it without aiming a second expiry at the same chunks. It stays
	// empty when the expiry did not land, because the run has then put that snapshot back
	// in the staging registry and the pass has to reclaim it like any other set.
	superseded := ""
	if publishErr == nil {
		result.Latest = latest
		// The snapshot is published, so its chunks are live and the marker has done
		// its job. A marker left behind costs one wasted reclaim attempt, which is why
		// this is not worth failing a successful publication over.
		unstage(ctx, deps, logger, group, latest.SnapshotID)
		logger.Log(LevelInfo, "snapshot_published", Fields{
			Group:        group,
			SnapshotID:   latest.SnapshotID,
			Names:        latest.Names,
			Scanned:      len(results),
			Carried:      len(carried),
			Chunks:       latest.ChunkCount,
			Bytes:        latest.CompressedBytes,
			ScannedAt:    latest.ScannedAt.Format(time.RFC3339),
			DurationMill: millis(deps.now().Sub(started)),
		})

		// Retention follows the pointer this publication replaced, which is what the
		// pointer write itself observed and not what the previous-snapshot read saw. The
		// two differ whenever that read failed and was published past, whenever the stored
		// pointer had to be quarantined, and whenever the other group's schedule published
		// between this run's read and its own write. Expiring what was read in those cases
		// would leave a superseded chunk set with no TTL and, because its own publisher
		// unstaged it on success, no marker either: nothing could ever find it again.
		//
		// It happens here, immediately after the pointer write and before the budgeted
		// reclaim pass. Only this run knows what its own write replaced, so a later run
		// cannot repeat the decision; the reclaim pass is the opposite, since every
		// action it takes is driven off a durable marker and is retried on the next
		// schedule. Letting the pass run first would let a throttled table or an
		// expiring deadline spend the retryable work and starve the work that has one
		// chance. When the expiry does not land the run puts the replaced snapshot back
		// in the staging registry, which is what turns it into work a later pass can
		// still do.
		switch {
		case replaced.Previous != nil:
			result.Previous = replaced.Previous.SnapshotID
			if expireSuperseded(ctx, deps, logger, *replaced.Previous, latest) {
				superseded = replaced.Previous.SnapshotID
			}
		case replaced.Unusable:
			// The replaced pointer did not read, so which snapshot it named is unknown and
			// no expiry can be aimed at it. Naming a snapshot on the word of a pointer that
			// failed validation would be worse than leaking one, so this is reported for an
			// operator to reconcile against the preserved pointer instead.
			logger.Log(LevelWarn, "superseded_snapshot_unknown", Fields{Group: group, SnapshotID: latest.SnapshotID})
		}
	}

	// Reclaiming runs after the publication attempt, and after it either way.
	//
	// Before it, best-effort cleanup would sit on the critical path of the write it
	// exists to clean up after: a throttled table could spend the rest of the
	// invocation's deadline here and leave the run publishing nothing, abandoning one
	// more chunk set and making the next pass longer still. On the success path only,
	// it would stop reclaiming exactly when sets are being abandoned, because a run
	// that keeps failing to publish is the run that keeps abandoning them.
	//
	// It is given this run's own snapshot ID either way, so the set this run just
	// published, or just abandoned, is left alone. Nothing it does can fail the run.
	reclaimAbandoned(ctx, deps, logger, group, built.Metadata.SnapshotID, superseded, deps.now())

	if publishErr != nil {
		return Result{}, deps.fail(logger, "publish_failed",
			Fields{Group: group, SnapshotID: built.Metadata.SnapshotID}, publishErr)
	}
	return result, nil
}

// fail logs a run-ending error once, with the payload already redacted, and
// returns it unchanged for the caller to see.
func (d Dependencies) fail(logger *Logger, event string, fields Fields, err error) error {
	logger.LogError(LevelError, event, fields, err)
	return err
}

func parseGroup(group Group) (Group, error) {
	for _, known := range Groups {
		if group == known {
			return group, nil
		}
	}
	// The rejected value is not echoed: it arrives from outside and a log field
	// is not the place to reflect unvalidated input.
	return "", fmt.Errorf("event names an unknown scan group")
}

// snapshotID names a snapshot after the group that produced it and the instant it
// classified against, which is unique per run and satisfies the contract's
// lowercase-and-dashes rule.
func snapshotID(group Group, scannedAt time.Time) string {
	return fmt.Sprintf("%s-%s", group, scannedAt.UTC().Format("20060102t150405"))
}

// listInput is one loaded list and the labels it owns.
type listInput struct {
	Spec   ListSpec
	Labels []string
}

// loadLists loads every list and resolves duplicate labels the way names.Load
// does, giving each label to the first list that declares it.
//
// The lists are loaded one at a time rather than in a single names.Load call,
// because a single call returns a flat deduplicated slice and keeps its own
// record of which path a label came from. Per-list attribution is what the
// published source counts need, and loading in declared order reproduces the
// same first-list-wins outcome.
//
// It returns the per-list labels and a map from the fully-qualified name to the
// owning list ID, which is the form results carry.
func loadLists(dir string) ([]listInput, map[string]string, error) {
	inputs := make([]listInput, 0, len(Lists))
	owner := make(map[string]string)
	for _, spec := range Lists {
		path := filepath.Join(dir, filepath.Base(spec.Path))
		labels, err := names.Load([]string{path}, nil)
		if err != nil {
			return nil, nil, fmt.Errorf("load list %s: %w", spec.ID, err)
		}
		owned := make([]string, 0, len(labels))
		for _, label := range labels {
			qualified := label + ".eth"
			if _, taken := owner[qualified]; taken {
				continue
			}
			owner[qualified] = spec.ID
			owned = append(owned, label)
		}
		inputs = append(inputs, listInput{Spec: spec, Labels: owned})
	}
	if len(owner) == 0 {
		return nil, nil, fmt.Errorf("no input labels were loaded from %s", dir)
	}
	return inputs, owner, nil
}

// freshLabels is every label this run asks the subgraph about.
func freshLabels(inputs []listInput, group Group) []string {
	var fresh []string
	for _, input := range inputs {
		if input.Spec.Group != group {
			continue
		}
		fresh = append(fresh, input.Labels...)
	}
	return fresh
}

// carryForwardResults selects the previously published results this run keeps
// without rescanning: the ones owned by a list some other schedule scans.
//
// A result whose name no longer belongs to any list is dropped, so removing a
// label from a word list removes it from the next snapshot rather than pinning it
// forever.
func carryForwardResults(previous *snapshot.Snapshot, owner map[string]string, group Group) []ens.Result {
	if previous == nil {
		return nil
	}
	carriedGroups := make(map[string]Group, len(Lists))
	for _, spec := range Lists {
		carriedGroups[spec.ID] = spec.Group
	}
	carried := make([]ens.Result, 0, len(previous.Results))
	for _, result := range previous.Results {
		listID, known := owner[result.Name]
		if !known {
			continue
		}
		if carriedGroups[listID] == group {
			continue
		}
		carried = append(carried, result)
	}
	return carried
}

// deriveSources counts what each list contributed to the published results.
//
// Only a list with a contribution becomes a source, because the staleness
// thresholds come from the slowest cadence among the sources: a first run of the
// short group would otherwise advertise the daily list's threshold while holding
// none of its names.
//
// A result no list claims is an error rather than an uncounted extra, because the
// counts are what a client reads without fetching a chunk, and snapshot.Build
// requires them to sum to the result count.
func deriveSources(inputs []listInput, owner map[string]string, results []ens.Result) ([]snapshot.SourceList, error) {
	counts := make(map[string]int, len(inputs))
	for _, result := range results {
		listID, known := owner[result.Name]
		if !known {
			return nil, fmt.Errorf("a result belongs to no declared word list")
		}
		counts[listID]++
	}
	sources := make([]snapshot.SourceList, 0, len(inputs))
	for _, input := range inputs {
		count := counts[input.Spec.ID]
		if count == 0 {
			continue
		}
		sources = append(sources, snapshot.SourceList{
			ID:      input.Spec.ID,
			Path:    input.Spec.Path,
			Cadence: input.Spec.Cadence,
			Names:   count,
		})
	}
	if len(sources) == 0 {
		return nil, fmt.Errorf("no word list contributed a result")
	}
	return sources, nil
}

// readPrevious reads the snapshot this run merges forward from.
//
// A missing pointer is a bootstrap, not a failure: the first run of either group
// publishes only its own lists. An unreadable pointer is retried a bounded number
// of times and then treated the same way, with a warning, because the alternative
// is worse. Refusing to publish would wedge every future run on exactly the
// condition the contract's corrupt-pointer quarantine exists to recover from,
// while publishing the group this run did scan is self-healing: the other group's
// next scheduled run restores its names.
//
// A pointer that resolves but whose chunks are gone is neither of those. It is a
// published snapshot that disappeared, so it is reported at warning level and named:
// the run still publishes past it, and an operator who loses a whole group from the
// site must not have to infer that from an informational record about a bootstrap.
// Retrying it would be pointless, because a strongly consistent read that found no
// chunk found none.
//
// A cancelled or expired context is not a bootstrap. It says nothing about what
// is stored, and treating it as an empty store would publish a snapshot that
// silently dropped the other group.
//
// It returns only the snapshot to merge forward from. What a publication supersedes
// is the pointer its own write replaced, which snapshot.Publish reports, so nothing
// here decides retention: on every path where this read gives up, the pointer it
// could not see is still there for the pointer write to replace.
func readPrevious(ctx context.Context, deps Dependencies, logger *Logger) (*snapshot.Snapshot, error) {
	var lastErr error
	for attempt := 1; attempt <= deps.Config.PreviousReadAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		previous, latest, err := snapshot.Read(ctx, deps.Store)
		if err == nil {
			logger.Log(LevelInfo, "previous_snapshot_read", Fields{
				PreviousID: latest.SnapshotID,
				Names:      latest.Names,
				ScannedAt:  latest.ScannedAt.Format(time.RFC3339),
			})
			return &previous, nil
		}
		if errors.Is(err, snapshot.ErrNotFound) {
			logger.Log(LevelInfo, "previous_snapshot_absent", Fields{Attempt: attempt})
			return nil, nil
		}
		var missing *snapshot.ChunksMissingError
		if errors.As(err, &missing) {
			logger.LogError(LevelWarn, "previous_snapshot_chunks_missing",
				Fields{PreviousID: missing.SnapshotID, Attempt: attempt}, err)
			return nil, nil
		}
		if ctx.Err() != nil {
			return nil, err
		}
		lastErr = err
		logger.LogError(LevelWarn, "previous_snapshot_read_retried", Fields{Attempt: attempt}, err)
		if attempt < deps.Config.PreviousReadAttempts {
			if err := deps.sleep(ctx, previousReadBackoff); err != nil {
				return nil, err
			}
		}
	}
	logger.LogError(LevelWarn, "previous_snapshot_unreadable", Fields{Attempt: deps.Config.PreviousReadAttempts}, lastErr)
	return nil, nil
}

// reclaimAbandoned expires the chunks of snapshots that were staged and never
// published, and removes their markers.
//
// It is what makes the retention story true rather than aspirational. A publication
// that writes every chunk and then fails to move the pointer leaves a full chunk set
// no pointer names, no query finds, and no TTL bounds, and retrying cannot finish it:
// a re-invocation rescans, samples a new classification instant, and mints a
// different snapshot ID, so the contract's per-chunk resume applies within one
// publication and never across two. The set is reclaimed instead.
//
// The rules that keep this from destroying live data:
//
//   - a marker naming the published snapshot means a publisher was interrupted
//     after its pointer write, so only the marker is stale. It is removed and the
//     chunks are left alone. This is judged before keep, because on the success path
//     they are the same snapshot: checking keep first would skip the marker of the
//     snapshot this run just published, and a later run would then see a marker that
//     is neither live nor its own and report a served snapshot as abandoned. Nothing
//     here can place an expiry on the live snapshot either way: this branch only
//     unstages, and ExpireChunks refuses the live ID as well.
//   - superseded is the snapshot this run's own pointer write replaced, and only when
//     its retention is settled. It is then treated exactly like the live one: its marker
//     is removed and its chunks are left alone, because they already carry the window
//     expireSuperseded aimed at them - that snapshot's own stale-after threshold - and a
//     reclaim here would overwrite it with the far cruder abandonedRetention. Just as
//     importantly, a snapshot that was published and has since been superseded is not an
//     abandoned chunk set, and reporting it as one is the same false alarm as reporting
//     the live one. When the expiry did not land the caller passes nothing, so the set
//     falls through to the ordinary rules: restageSuperseded has put its marker back,
//     which is the only thing left that can find those chunks, and the abandoned window
//     is the accurate report, because the retention it was owed is genuinely unknown.
//
// The exclusion reaches only this run's own replacement, so the false report it closes
// stays reachable one run further out: a snapshot an earlier run published and
// superseded, whose marker survived removal across two runs, is neither live nor this
// run's replacement, and once it is past the grace period it is reported as abandoned
// and has its retention shortened to the abandoned window. That is an acknowledged
// residual rather than a rule, because nothing in the store records that a staged
// snapshot was ever published, so no pass can tell one from a set that was written and
// never published.
//   - keep is this run's own snapshot ID, which is otherwise never touched. A set
//     this run goes on to publish must not be carrying an expiry, and a set it just
//     abandoned is left for a later pass rather than expired by the run that lost it.
//   - a pointer that cannot be read defers the whole pass. It says nothing about
//     which snapshot is live, so nothing may be reclaimed against it.
//   - a marker younger than abandonedAfter is left alone, because a publisher may
//     still be writing that set. Staging refreshes the marker, so a publisher that
//     claims a snapshot ID again renews its own grace period.
//   - a marker the registry could not interpret is reported and left alone. It is
//     never returned, so nothing can be expired against it, and the markers that did
//     read are still reclaimed: one unreadable item must not stop the pass that
//     bounds the table.
//
// The budget bounds markers acted on, not markers reclaimed, so a table that refuses
// every expiry costs the same bounded number of calls as one that accepts them all.
// Counting only successes would let a sustained failure turn every later pass into
// work proportional to the whole registry.
//
// The three ways a pass stops short are three different events, because they mean
// different things to whoever is alarming on them. An unreadable pointer and a failed
// registry query are anomalies that reclaimed nothing, and stay at warning level. An
// exhausted budget is the backlog draining exactly as designed, so it is
// informational: raising it as a warning every three hours would train an operator to
// ignore the two records that matter.
//
// Every failure here is logged and none fails the run. This is cleanup after an
// earlier invocation, so refusing to publish over it would turn one failed run into
// a permanently stuck schedule.
func reclaimAbandoned(ctx context.Context, deps Dependencies, logger *Logger, group Group, keep, superseded string, now time.Time) {
	if ctx.Err() != nil {
		// A dead context says nothing about what is staged, and cleanup is never
		// worth reporting a failure the run has already reported.
		return
	}

	live := ""
	switch latest, err := deps.Store.GetLatest(ctx); {
	case err == nil:
		live = latest.SnapshotID
	case errors.Is(err, snapshot.ErrNotFound):
		// Nothing is published, so no staged set can be the live one.
	default:
		logger.LogError(LevelWarn, "abandoned_chunks_pointer_unreadable", Fields{Group: group}, err)
		return
	}

	staged, err := deps.Store.StagedSnapshots(ctx)
	if err != nil {
		var unreadable *snapshot.StagingUnreadableError
		if !errors.As(err, &unreadable) {
			logger.LogError(LevelWarn, "abandoned_chunks_registry_unreadable", Fields{Group: group}, err)
			return
		}
		logger.LogError(LevelWarn, "staging_markers_unreadable",
			Fields{Group: group, Skipped: unreadable.Skipped}, err)
	}

	attempted, reclaimed := 0, 0
	for _, entry := range staged {
		if ctx.Err() != nil {
			return
		}
		// The live snapshot, and one this run superseded whose retention settled, are
		// both accounted for: their chunks already carry the retention they should
		// have, so all that is left of either is a stale marker.
		retained := entry.SnapshotID == live || (superseded != "" && entry.SnapshotID == superseded)
		if !retained {
			if entry.SnapshotID == keep {
				continue
			}
			if now.Sub(entry.StagedAt) < abandonedAfter {
				continue
			}
		}
		if attempted >= maxReclaimsPerRun {
			logger.Log(LevelInfo, "abandoned_chunks_budget_reached", Fields{
				Group:     group,
				Staged:    len(staged),
				Attempted: attempted,
				Reclaimed: reclaimed,
			})
			return
		}
		attempted++

		if retained {
			unstage(ctx, deps, logger, group, entry.SnapshotID)
			continue
		}

		expiresAt := now.Add(abandonedRetention).UTC().Truncate(time.Second)
		fields := Fields{
			Group:      group,
			SnapshotID: entry.SnapshotID,
			StagedAt:   entry.StagedAt.UTC().Format(time.RFC3339),
			ExpiresAt:  expiresAt.Format(time.RFC3339),
		}
		err := deps.Store.ExpireChunks(ctx, entry.SnapshotID, expiresAt)
		switch {
		case err == nil:
			// A warning, not an informational record: an abandoned set means an
			// earlier publication wrote a whole snapshot and never published it.
			logger.Log(LevelWarn, "abandoned_chunks_expired", fields)
			reclaimed++
			unstage(ctx, deps, logger, group, entry.SnapshotID)
		case errors.Is(err, snapshot.ErrNotFound):
			// The chunks are already gone, so the marker is all that is left.
			unstage(ctx, deps, logger, group, entry.SnapshotID)
		default:
			logger.LogError(LevelWarn, "abandoned_chunks_expire_failed", fields, err)
		}
	}
}

// unstage removes one staging marker. A marker that cannot be removed is reported
// and kept: it costs one wasted reclaim attempt on a later run, which is cheaper
// than any of the ways of guessing that it is safe to stop tracking a chunk set.
func unstage(ctx context.Context, deps Dependencies, logger *Logger, group Group, snapshotID string) {
	if err := deps.Store.UnstageSnapshot(ctx, snapshotID); err != nil {
		logger.LogError(LevelWarn, "staging_marker_kept", Fields{Group: group, SnapshotID: snapshotID}, err)
	}
}

// expireSuperseded assigns a TTL to the chunks of the snapshot this run replaced,
// which is the one the pointer write reported replacing.
//
// The window is the superseded snapshot's own staleness threshold, so the chunks
// outlive the point at which a client would already call them stale, and a
// rollback to them stays possible for as long as they were ever worth serving.
// The TTL is a floor and not a deadline: DynamoDB deletes expired items lazily,
// so the recovery window is at least this long.
//
// A failure here is logged, not returned. The snapshot is already published and
// verified; leaving a superseded chunk set in place costs storage, and failing the
// run would report a successful publication as a failure and invite a retry that
// has nothing left to do.
//
// The write is retried a bounded number of times, because a throttled item write is
// exactly the transient failure that would otherwise leak a whole snapshot, and
// ExpireChunks is idempotent so a retry repairs a partly applied expiry as well. A
// cancelled or expired context stops the retries at once and is never read as a
// settled expiry.
//
// It reports whether the replaced set's retention is settled, which is what decides
// whether the reclaim pass may drop a leftover marker for it. A settled set either
// carries its window or has no chunks left to carry one, so the marker is only a
// stale record. An unsettled one has nothing bounding it, so restageSuperseded puts
// it back in the registry and the pass leaves that fresh marker alone until its grace
// period passes.
func expireSuperseded(ctx context.Context, deps Dependencies, logger *Logger, previous, current snapshot.Latest) bool {
	if previous.SnapshotID == current.SnapshotID {
		// The pointer replaced a pointer naming the snapshot this run published, so
		// these chunks are live and must keep no expiry at all.
		return true
	}
	window := time.Duration(previous.ScanAge.StaleAfterSeconds) * time.Second
	if window <= 0 {
		// No window could be derived, so no expiry was ever aimed at these chunks and
		// they are as unbounded as ones whose write failed.
		logger.Log(LevelWarn, "superseded_chunks_kept", Fields{PreviousID: previous.SnapshotID})
		restageSuperseded(ctx, deps, logger, previous.SnapshotID)
		return false
	}
	expiresAt := current.PublishedAt.Add(window).UTC().Truncate(time.Second)
	fields := Fields{
		PreviousID: previous.SnapshotID,
		SnapshotID: current.SnapshotID,
		ExpiresAt:  expiresAt.Format(time.RFC3339),
	}

	var (
		lastErr  error
		attempts int
	)
	for attempts < maxExpireAttempts {
		if err := ctx.Err(); err != nil {
			lastErr = err
			break
		}
		attempts++
		attempted := fields
		attempted.Attempt = attempts

		err := deps.Store.ExpireChunks(ctx, previous.SnapshotID, expiresAt)
		if err == nil {
			logger.Log(LevelInfo, "superseded_chunks_expired", attempted)
			return true
		}
		if errors.Is(err, snapshot.ErrNotFound) {
			// There is nothing left to expire. The superseded snapshot's chunks are
			// already gone, which is the state readPrevious reports as a snapshot that
			// vanished, so a retention window is neither possible nor needed.
			logger.Log(LevelInfo, "superseded_chunks_absent", attempted)
			return true
		}
		lastErr = err
		if attempts == maxExpireAttempts {
			break
		}
		logger.LogError(LevelWarn, "superseded_chunks_expire_retried", attempted, err)
		if sleepErr := deps.sleep(ctx, expireBackoff); sleepErr != nil {
			lastErr = sleepErr
			break
		}
	}

	exhausted := fields
	exhausted.Attempt = attempts
	logger.LogError(LevelWarn, "superseded_chunks_expire_failed", exhausted, lastErr)
	restageSuperseded(ctx, deps, logger, previous.SnapshotID)
	return false
}

// restageSuperseded records the replaced snapshot in the staging registry once its
// TTL write has not landed.
//
// Nothing else in the store can find that chunk set: no pointer names it, its own
// publisher removed its marker when it succeeded, and the reclaim pass iterates
// nothing but markers. A marker is therefore the only thing that can ever bound it,
// and a later pass reclaims it under abandonedRetention and reports it as abandoned.
// That window is cruder than the one aimed at it and the report is accurate, because
// the retention it was owed is genuinely unknown; bounded beats unreachable.
//
// The marker cannot aim retention at what the pointer names: the caller has already
// established that this is not the snapshot it published, and ExpireChunks refuses
// the live ID however a reclaim reaches it.
//
// A failure is logged and never returned. The publication has already been written,
// read back, and verified, and no cleanup may turn it into a reported failure.
func restageSuperseded(ctx context.Context, deps Dependencies, logger *Logger, snapshotID string) {
	stagedAt := deps.now().Truncate(time.Second)
	fields := Fields{
		PreviousID: snapshotID,
		StagedAt:   stagedAt.Format(time.RFC3339),
	}
	if err := deps.Store.StageSnapshot(ctx, snapshotID, stagedAt, stagedAt.Add(stagingRetention)); err != nil {
		logger.LogError(LevelWarn, "superseded_chunks_untracked", fields, err)
		return
	}
	logger.Log(LevelInfo, "superseded_chunks_restaged", fields)
}

func millis(duration time.Duration) int64 {
	if duration < 0 {
		return 0
	}
	return int64(duration / time.Millisecond)
}
