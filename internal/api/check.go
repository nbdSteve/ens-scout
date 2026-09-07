package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"ens-scrape/internal/checker"
	"ens-scrape/internal/checkstore"
	"ens-scrape/internal/ens"
	"ens-scrape/internal/names"
	"ens-scrape/internal/snapshot"
)

// checkRequest is the whole request body. It is closed: an unknown field is a
// malformed request rather than something to ignore, so no future field can be
// smuggled past a deployment that does not implement it, and nothing a client
// sends can select an endpoint, a query, a retry policy, or an authorization.
type checkRequest struct {
	Names []string `json:"names"`
}

// checkDocument is the whole success body.
//
// It states three distinct things and keeps them apart. Source says what produced
// these statuses: one live read of the subgraph index. Authority says what decides
// registration, which is not this and not the index. CheckedAt says when the read
// really happened, and ExpiresAt when it stops counting as fresh, so a client can
// refuse its own stale copy rather than presenting it as verified.
type checkDocument struct {
	FormatVersion int    `json:"format_version"`
	Source        string `json:"source"`
	Authority     string `json:"authority"`

	// CheckedAt is checker.Stats.ClassifiedAt: the single instant every status here
	// was classified against, sampled once before the first lookup.
	CheckedAt time.Time `json:"checked_at"`

	// ExpiresAt is when this answer stops being a fresh check.
	ExpiresAt time.Time `json:"expires_at"`

	// Names are the exact normalized, fully-qualified names this result covers, in
	// the same order as Results. A client asked about labels it wrote itself; this
	// is what was really queried, which is the only set the statuses below say
	// anything about.
	Names []string `json:"names"`

	Results  []ens.Result `json:"results"`
	Advisory string       `json:"advisory"`
}

// checkResult is what one request produced, or nothing when it failed.
type checkResult struct {
	body []byte

	// cache is which layer answered: cacheLocal, cacheShared, or empty for a
	// request that really read the index. The distinction is the whole evidence that
	// the process-local layer is an optimization rather than an authority, so it is
	// observable rather than inferred.
	cache string

	// cacheWriteFailed records that an answer was obtained and returned but could not
	// be cached. It never fails the request: the answer is honest either way, and the
	// only cost is that the next identical request pays for the index again.
	cacheWriteFailed bool

	// names and batches are counts for the log. They are never the labels.
	names   int
	batches int
}

// Which layer answered a cached request. They are two values rather than a boolean
// because a shared hit proves the store is the authority and a local hit proves the
// copy layer works, and an operator watching the ratio is watching two things.
const (
	cacheLocal  = "local"
	cacheShared = "shared"
)

// serveCheck answers one fresh-check request.
func (h *Handler) serveCheck(w http.ResponseWriter, r *http.Request) {
	started := h.config.Now()

	result, refusal := h.runCheck(r)
	elapsed := h.config.Now().Sub(started)

	fields := checkFields{
		Names:            result.names,
		Batches:          result.batches,
		Cache:            result.cache,
		CacheWriteFailed: result.cacheWriteFailed,
		DurationMill:     elapsed.Milliseconds(),
	}
	if refusal != nil {
		fields.Outcome = refusal.code
		fields.Status = refusal.status
		// The code is the whole record of what went wrong. Nothing that produced the
		// refusal is carried here, not even to choose a severity: see checkLevelFor for
		// why the level is a property of the refusal, and checkLogger for why an
		// upstream error's text must not reach a log group at all.
		level := checkLevelFor(refusal.code)
		h.checkLog.log(level, checkEventFor(level), fields)
		h.writeFailure(w, r, *refusal)
		return
	}

	fields.Status = http.StatusOK
	h.checkLog.log(checkLevelInfo, "check_completed", fields)

	header := w.Header()
	// A fresh check is never cacheable by anything in between. Its whole value is
	// the instant in its body, and a cache would keep answering with an instant
	// that has moved on.
	header.Set("Cache-Control", "no-store")
	header.Set("Content-Type", contentTypeJSON)
	header.Set("Content-Length", strconv.Itoa(len(result.body)))
	w.WriteHeader(http.StatusOK)
	w.Write(result.body)
}

// runCheck charges every allowance and then, only if all of them were paid, does
// the work.
//
// The order is deliberate and is the point of the function: the cheapest refusals
// come first, and nothing that costs bytes, memory, or an upstream call happens
// before the allowance that bounds it has been charged. A flooding client is
// refused before its body is read, and no request reaches The Graph before both
// its own identity's allowance and the deployment's shared allowance have paid for
// the call.
//
// Both allowances are charged against h.checkStore, which is shared and durable, so
// a cold instance charges the same window a warm one does and a caller reaching many
// instances at once still spends one allowance. Only the concurrency slot and the
// cache copy layer are per instance, and neither is an allowance: see gate and
// localCache.
//
// Nothing that went wrong leaves this function except a fixed failure. An upstream
// error's text is not returned, not logged, and not rendered anywhere, so the
// gateway URL and the response slice internal/ens folds into its errors cannot
// escape by any path. A store error is the same: it selects a code and is discarded.
func (h *Handler) runCheck(r *http.Request) (checkResult, *failure) {
	check := h.check
	// One instant for every window and every expiry this request resolves, so a
	// request cannot be charged against one window and cached against another.
	now := h.config.Now()

	if refusal := checkContentType(r.Header.Get("Content-Type")); refusal != nil {
		return checkResult{}, refusal
	}
	// The declared length is checked before the body is touched, so an oversized
	// request costs nothing to refuse. It is advisory, which is why the read below
	// bounds itself again.
	if r.ContentLength > int64(check.MaxRequestBytes) {
		return checkResult{}, failed(failureRequestTooLarge)
	}

	identity, ok := h.clientKey(r)
	if !ok {
		return checkResult{}, failed(failureClientUnidentified)
	}
	// The raw identity is hashed here and never stored, logged, or returned. From
	// this line on, only the keyed digest exists, and the key it is keyed under is the
	// deployment's stable secret, so this digest is the same identity on every
	// instance and after every replacement.
	key := h.clientHash.hash(identity)
	charge, err := h.checkStore.Charge(r.Context(), checkstore.KindClient, key, 1, now, check.clientWindow())
	if err != nil {
		return checkResult{}, h.classifyStoreError(r.Context(), err)
	}
	if !charge.OK {
		return checkResult{}, failed(retryIn(failureClientThrottled, retryWait(now, charge, check.ClientWindow)))
	}

	requested, refusal := h.readNames(r)
	if refusal != nil {
		return checkResult{}, refusal
	}

	labels, qualified := normalizeCheckNames(requested, check.MaxLabelBytes)
	if labels == nil {
		return checkResult{}, failed(failureInvalidName)
	}

	batches := (len(labels) + check.BatchSize - 1) / check.BatchSize
	counts := checkResult{names: len(labels), batches: batches}

	// The local copy first, then the shared store. A local hit saves a store read and
	// nothing else: it is the same bytes with the same expiry the store holds, because
	// that is the only thing ever put there.
	cacheKey := checkCacheKey(CheckFormatVersion, qualified)
	if body, hit := h.localResults.get(cacheKey, now); hit {
		counts.body = body
		counts.cache = cacheLocal
		return counts, nil
	}
	entry, hit, err := h.checkStore.Load(r.Context(), cacheKey, now)
	if err != nil {
		return counts, h.classifyStoreError(r.Context(), err)
	}
	if hit {
		// The copy expires when the shared entry does, not a lifetime from now.
		h.localResults.put(cacheKey, entry.Body, entry.ExpiresAt, now)
		counts.body = entry.Body
		counts.cache = cacheShared
		return counts, nil
	}

	// A slot first, then the budget: a refused slot must not have spent budget it
	// then cannot use, and taking a slot costs nothing that has to be given back
	// beyond the release below. A slot frees within one deadline at the latest, which
	// is what it advertises rather than the far longer budget window.
	if !h.upstreamGate.acquire() {
		return counts, failed(retryIn(failureUpstreamBusy, check.Timeout))
	}
	defer h.upstreamGate.release()

	// The budget is charged in upstream calls, not in requests, and it is charged
	// before the first one is made. It is one shared counter for every client
	// identity together, which is what stops many identities from adding up to
	// unbounded Graph load.
	budget, err := h.checkStore.Charge(r.Context(), checkstore.KindUpstream, checkstore.UpstreamKey,
		int64(batches), now, check.upstreamWindow())
	if err != nil {
		return counts, h.classifyStoreError(r.Context(), err)
	}
	if !budget.OK {
		return counts, failed(retryIn(failureUpstreamBudget, retryWait(now, budget, check.UpstreamWindow)))
	}

	ctx, cancel := context.WithTimeout(r.Context(), check.Timeout)
	defer cancel()

	results, stats, err := checker.Run(ctx, check.Upstream, labels, checker.Options{
		Workers:   check.Workers,
		BatchSize: check.BatchSize,
		Soon:      check.Soon,
		Now:       h.config.Now,
	})
	if err != nil {
		return counts, classifyCheckError(r.Context(), ctx, check.Timeout)
	}
	if err := sameNames(results, qualified); err != nil {
		// A truncated, padded, or reordered answer is not evidence about any name in
		// it. Failing closed here is what stops a partial upstream answer from being
		// presented as a complete verification.
		return counts, failed(retryIn(failureUpstreamFailed, check.Timeout))
	}

	// The instant is truncated to the second, which is how every other timestamp
	// this project publishes is written. Truncation moves it earlier, so a client
	// treats the answer as very slightly older than it is rather than newer.
	checkedAt := stats.ClassifiedAt.UTC().Truncate(time.Second)
	expiresAt := checkedAt.Add(check.CacheLifetime)
	body, err := json.Marshal(checkDocument{
		FormatVersion: CheckFormatVersion,
		Source:        CheckSource,
		Authority:     CheckAuthority,
		CheckedAt:     checkedAt,
		ExpiresAt:     expiresAt,
		Names:         qualified,
		Results:       results,
		Advisory:      CheckAdvisory,
	})
	if err != nil {
		// A document of these field types cannot fail to encode. Reporting it as an
		// upstream failure rather than panicking keeps the one guarantee that matters:
		// a client is never told about a name this API did not really verify.
		return counts, failed(retryIn(failureUpstreamFailed, check.Timeout))
	}
	counts.body = body

	// The answer is already obtained, so nothing from here on may fail the request.
	// An expiry the answer itself has outlived is not stored at all: the response
	// still carries its own honest instants, and caching something no reader could
	// serve would only cost a write.
	if !now.Before(expiresAt) {
		return counts, nil
	}
	// The shared store is written first, and only an accepted write is copied
	// locally. That is what keeps the copy layer exactly a copy: a local entry the
	// store never accepted would be an answer one instance could serve and no other
	// could, which is the per-instance cache this path deliberately does not have.
	if err := h.checkStore.Store(r.Context(), cacheKey, checkstore.Entry{Body: body, ExpiresAt: expiresAt}); err != nil {
		counts.cacheWriteFailed = true
		return counts, nil
	}
	h.localResults.put(cacheKey, body, expiresAt, now)
	return counts, nil
}

// classifyStoreError says whether the store failed or the request went away.
//
// A cancelled or expired context is never evidence about the store: it did not
// refuse an allowance, it did not report an empty cache, and it did not fail. The
// three are three codes. Anything else fails closed, because a store that cannot be
// charged cannot bound anything, and serving a request whose allowance nothing
// recorded is exactly the bypass a shared store exists to close.
//
// The error itself selects nothing but the code and is then discarded, so a table
// name, a key, or a wrapped AWS message cannot reach a client or a log group.
func (h *Handler) classifyStoreError(ctx context.Context, err error) *failure {
	if refusal, lost := checkContextFailure(ctx, h.check.Timeout); lost {
		return refusal
	}
	return failed(retryIn(failureCheckStoreUnavailable, h.check.Timeout))
}

// retryWait turns a refused charge into the wait a client is advised to take.
//
// The store reports the instant the window rolls over, which is the earliest a
// retry can succeed. A window that has already rolled over, or a store that
// reported no instant at all, falls back to the whole period rather than advising
// an immediate retry: telling a client it may retry now is how a refusal becomes a
// tight loop.
func retryWait(now time.Time, charge checkstore.Charge, period time.Duration) time.Duration {
	if charge.RetryAt.IsZero() {
		return period
	}
	wait := charge.RetryAt.Sub(now)
	if wait <= 0 {
		return period
	}
	if wait > period {
		return period
	}
	return wait
}

// clientKey resolves the configured identity function. Neither it nor its default
// reads a caller-controlled header: see DefaultClientKey.
func (h *Handler) clientKey(r *http.Request) (string, bool) {
	if h.check.ClientKey != nil {
		return h.check.ClientKey(r)
	}
	return DefaultClientKey(r)
}

// checkContentType requires JSON. An absent or wrong type is refused rather than
// sniffed: a request whose type does not say JSON was not written for this
// endpoint, and guessing at one is how a form post becomes an API call.
func checkContentType(value string) *failure {
	if strings.TrimSpace(value) == "" {
		return failed(failureUnsupportedMedia)
	}
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil || mediaType != "application/json" {
		return failed(failureUnsupportedMedia)
	}
	return nil
}

// readNames reads and decodes the body under the byte bound, then charges the
// count bound against the raw list.
//
// The count is charged before duplicates are removed. That is what bounds
// duplicate expansion: a caller cannot send a thousand copies of one label and
// have the limit apply only to the one that survives deduplication.
func (h *Handler) readNames(r *http.Request) ([]string, *failure) {
	check := h.check

	if r.Body == nil {
		return nil, failed(failureMalformedRequest)
	}
	// One byte past the bound is read, so an oversized body is detected rather than
	// silently truncated into something that happens to parse.
	raw, err := io.ReadAll(io.LimitReader(r.Body, int64(check.MaxRequestBytes)+1))
	if err != nil {
		// A body that stopped arriving because the request went away is not a
		// malformed document, and it is classified exactly as a lost context is
		// classified after the upstream call: a hang-up and an expired deadline are
		// different answers, and reporting both as one was wrong in the same way here.
		if refusal, lost := checkContextFailure(r.Context(), check.Timeout); lost {
			return nil, refusal
		}
		return nil, failed(failureMalformedRequest)
	}
	if len(raw) > check.MaxRequestBytes {
		return nil, failed(failureRequestTooLarge)
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var request checkRequest
	if err := decoder.Decode(&request); err != nil {
		return nil, failed(failureMalformedRequest)
	}
	// A second JSON value after the first is a malformed request, not a body with
	// something appended that can be ignored.
	if _, err := decoder.Token(); err != io.EOF {
		return nil, failed(failureMalformedRequest)
	}

	if len(request.Names) == 0 {
		return nil, failed(failureNoNames)
	}
	if len(request.Names) > check.MaxNames {
		return nil, failed(failureTooManyNames)
	}
	return request.Names, nil
}

// normalizeCheckNames normalizes, bounds, deduplicates, and orders the request.
//
// names.Normalize is the one definition of a valid label in this repository, so
// this adds a byte bound and nothing else. It returns nil for any label that is
// not one, because a request that names something invalid is refused whole: a
// silently dropped label would make the answer cover a set the client never asked
// for and cannot see.
//
// The order is by fully-qualified name, which is what checker.Run sorts its
// results by. Sorting the bare labels instead would disagree for a label ending in
// a byte below '.', so the two lists would not line up.
func normalizeCheckNames(requested []string, maxLabelBytes int) (labels, qualified []string) {
	seen := make(map[string]struct{}, len(requested))
	for _, value := range requested {
		if len(value) > maxLabelBytes+len(snapshot.NameSuffix) {
			// Bounded before normalization too, so an enormous string is refused
			// without being lowercased and copied first.
			return nil, nil
		}
		label, err := names.Normalize(value)
		if err != nil {
			return nil, nil
		}
		if len(label) > maxLabelBytes {
			return nil, nil
		}
		seen[label] = struct{}{}
	}

	qualified = make([]string, 0, len(seen))
	for label := range seen {
		qualified = append(qualified, label+snapshot.NameSuffix)
	}
	sort.Strings(qualified)

	labels = make([]string, 0, len(qualified))
	for _, name := range qualified {
		labels = append(labels, strings.TrimSuffix(name, snapshot.NameSuffix))
	}
	return labels, qualified
}

// checkCacheKey is a digest of the wire version and the exact set that was queried.
// The set is already deduplicated and ordered, so two requests naming the same
// labels in any order and with any repetition produce one key.
//
// The version is part of the key because an entry is the rendered response body and
// is returned unchanged. A bumped version therefore has to orphan every key the
// previous one wrote: a rolling deployment runs both versions over the one store at
// once, and an instance that served the other version's bytes verbatim would hand a
// client a document its own parser refuses, for as long as the entry lives. The
// browser's own stored copy is keyed the same way and for the same reason - see
// web/src/state/cache.ts.
func checkCacheKey(version int, qualified []string) string {
	digest := sha256.New()
	digest.Write([]byte(strconv.Itoa(version)))
	digest.Write([]byte{0})
	for _, name := range qualified {
		digest.Write([]byte(name))
		// A separator no label can contain, so no two different sets can join into the
		// same bytes.
		digest.Write([]byte{0})
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// sameNames proves the answer covers exactly the set that was asked about.
//
// Both lists are sorted by fully-qualified name with the same comparison -
// checker.Run sorts its results, and normalizeCheckNames sorts the request - so
// this is an index comparison rather than a membership test, and it catches a
// short answer, a padded one, and one that substitutes a name. It cannot catch a
// reordered answer, because checker.Run has already sorted one back into place;
// what it proves is the set, and the index comparison is only how.
func sameNames(results []ens.Result, qualified []string) error {
	if len(results) != len(qualified) {
		return errors.New("upstream answered a different number of names than were asked about")
	}
	for i := range results {
		if results[i].Name != qualified[i] {
			return errors.New("upstream answered about a name that was not asked about")
		}
	}
	return nil
}

// classifyCheckError says which of three things happened, and refuses to guess
// between them.
//
// A lost request context is judged first, because it is not evidence about the
// upstream at all. Then this API's own deadline. Anything else is an upstream
// failure: a transport error, a rate-limited or challenged response, a truncated or
// oversized body, or a GraphQL error document. Those are one code deliberately,
// because the only honest thing to say about all of them is that no fresh answer
// was obtained.
func classifyCheckError(request, bounded context.Context, timeout time.Duration) *failure {
	if refusal, lost := checkContextFailure(request, timeout); lost {
		return refusal
	}
	if errors.Is(bounded.Err(), context.DeadlineExceeded) {
		return failed(retryIn(failureCheckTimedOut, timeout))
	}
	return failed(retryIn(failureUpstreamFailed, timeout))
}

// checkContextFailure classifies a lost context, and reports whether it was lost
// at all.
//
// A cancelled request is the client going away. It says nothing about the upstream,
// and there is nobody left to advise about a retry. An expired deadline is a
// timeout whoever owns it, this API's own or the one the platform gave the request,
// because the honest statement is the same either way: no answer arrived in the
// time that was available.
func checkContextFailure(ctx context.Context, timeout time.Duration) (*failure, bool) {
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		return failed(failureCheckCancelled), true
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return failed(retryIn(failureCheckTimedOut, timeout)), true
	}
	return nil, false
}
