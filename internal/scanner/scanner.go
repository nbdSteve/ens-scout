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
	Latest   snapshot.Latest
	Group    Group
	Scanned  int
	Carried  int
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
	previous, previousLatest, err := readPrevious(ctx, deps, logger)
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

	latest, publishErr := snapshot.Publish(ctx, deps.Store, built, deps.now().Truncate(time.Second))
	if publishErr == nil {
		// The snapshot is published, so its chunks are live and the marker has done
		// its job. A marker left behind costs one wasted reclaim attempt, which is why
		// this is not worth failing a successful publication over.
		unstage(ctx, deps, logger, group, latest.SnapshotID)
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
	reclaimAbandoned(ctx, deps, logger, group, built.Metadata.SnapshotID, deps.now())

	if publishErr != nil {
		return Result{}, deps.fail(logger, "publish_failed",
			Fields{Group: group, SnapshotID: built.Metadata.SnapshotID}, publishErr)
	}
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

	result := Result{Latest: latest, Group: group, Scanned: len(results), Carried: len(carried)}
	if previousLatest != nil {
		result.Previous = previousLatest.SnapshotID
		expireSuperseded(ctx, deps, logger, *previousLatest, latest)
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
func readPrevious(ctx context.Context, deps Dependencies, logger *Logger) (*snapshot.Snapshot, *snapshot.Latest, error) {
	var lastErr error
	for attempt := 1; attempt <= deps.Config.PreviousReadAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		previous, latest, err := snapshot.Read(ctx, deps.Store)
		if err == nil {
			logger.Log(LevelInfo, "previous_snapshot_read", Fields{
				PreviousID: latest.SnapshotID,
				Names:      latest.Names,
				ScannedAt:  latest.ScannedAt.Format(time.RFC3339),
			})
			return &previous, &latest, nil
		}
		if errors.Is(err, snapshot.ErrNotFound) {
			logger.Log(LevelInfo, "previous_snapshot_absent", Fields{Attempt: attempt})
			return nil, nil, nil
		}
		var missing *snapshot.ChunksMissingError
		if errors.As(err, &missing) {
			logger.LogError(LevelWarn, "previous_snapshot_chunks_missing",
				Fields{PreviousID: missing.SnapshotID, Attempt: attempt}, err)
			return nil, nil, nil
		}
		if ctx.Err() != nil {
			return nil, nil, err
		}
		lastErr = err
		logger.LogError(LevelWarn, "previous_snapshot_read_retried", Fields{Attempt: attempt}, err)
		if attempt < deps.Config.PreviousReadAttempts {
			if err := deps.sleep(ctx, previousReadBackoff); err != nil {
				return nil, nil, err
			}
		}
	}
	logger.LogError(LevelWarn, "previous_snapshot_unreadable", Fields{Attempt: deps.Config.PreviousReadAttempts}, lastErr)
	return nil, nil, nil
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
//   - keep is this run's own snapshot ID, which is never touched. A set this run
//     goes on to publish must not be carrying an expiry.
//   - a marker naming the published snapshot means a publisher was interrupted
//     after its pointer write, so only the marker is stale. It is removed and the
//     chunks are left alone. Nothing here can place an expiry on the live snapshot:
//     the ID is skipped, and ExpireChunks refuses it as well.
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
// Every failure here is logged and none fails the run. This is cleanup after an
// earlier invocation, so refusing to publish over it would turn one failed run into
// a permanently stuck schedule.
func reclaimAbandoned(ctx context.Context, deps Dependencies, logger *Logger, group Group, keep string, now time.Time) {
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
		logger.LogError(LevelWarn, "abandoned_chunks_deferred", Fields{Group: group}, err)
		return
	}

	staged, err := deps.Store.StagedSnapshots(ctx)
	if err != nil {
		var unreadable *snapshot.StagingUnreadableError
		if !errors.As(err, &unreadable) {
			logger.LogError(LevelWarn, "abandoned_chunks_deferred", Fields{Group: group}, err)
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
		if entry.SnapshotID == keep {
			continue
		}
		actionable := entry.SnapshotID == live || now.Sub(entry.StagedAt) >= abandonedAfter
		if !actionable {
			continue
		}
		if attempted >= maxReclaimsPerRun {
			logger.Log(LevelWarn, "abandoned_chunks_deferred", Fields{
				Group:     group,
				Staged:    len(staged),
				Attempted: attempted,
				Reclaimed: reclaimed,
			})
			return
		}
		attempted++

		if entry.SnapshotID == live {
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

// expireSuperseded assigns a TTL to the chunks of the snapshot this run replaced.
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
func expireSuperseded(ctx context.Context, deps Dependencies, logger *Logger, previous, current snapshot.Latest) {
	if previous.SnapshotID == current.SnapshotID {
		return
	}
	window := time.Duration(previous.ScanAge.StaleAfterSeconds) * time.Second
	if window <= 0 {
		logger.Log(LevelWarn, "superseded_chunks_kept", Fields{PreviousID: previous.SnapshotID})
		return
	}
	expiresAt := current.PublishedAt.Add(window).UTC().Truncate(time.Second)
	fields := Fields{
		PreviousID: previous.SnapshotID,
		SnapshotID: current.SnapshotID,
		ExpiresAt:  expiresAt.Format(time.RFC3339),
	}
	if err := deps.Store.ExpireChunks(ctx, previous.SnapshotID, expiresAt); err != nil {
		logger.LogError(LevelWarn, "superseded_chunks_expire_failed", fields, err)
		return
	}
	logger.Log(LevelInfo, "superseded_chunks_expired", fields)
}

func millis(duration time.Duration) int64 {
	if duration < 0 {
		return 0
	}
	return int64(duration / time.Millisecond)
}
