package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Failure codes. A code is a fixed token a client or an alarm can branch on
// without matching free text, and it says exactly as much as the API knows.
const (
	// CodeNoSnapshot means the store holds no latest pointer: nothing has been
	// published yet. It is not the same as a snapshot that disappeared.
	CodeNoSnapshot = "no_snapshot_published"

	// CodeChunksMissing means the latest pointer resolved but the chunks it names
	// are gone, so a published snapshot vanished under it.
	CodeChunksMissing = "snapshot_chunks_missing"

	// CodeUnreadable means the stored payload did not verify: a missing,
	// duplicated, reordered, corrupt, checksum-mismatched, or non-canonical chunk
	// set, or one that disagrees with the pointer that names it.
	CodeUnreadable = "snapshot_unreadable"

	// CodeTooLarge means the published snapshot is larger than this API will serve.
	CodeTooLarge = "snapshot_too_large"

	// CodeUnavailable means the store could not be read. A failed read is not
	// evidence of an empty store or of corruption, so it says neither.
	CodeUnavailable = "snapshot_unavailable"

	// CodeMethodNotAllowed and CodeNotFound are ordinary request errors.
	CodeMethodNotAllowed = "method_not_allowed"
	CodeNotFound         = "not_found"
)

// Failure codes for PathCheck. They are separate from the snapshot codes above
// because a client acts on them differently: a snapshot failure is something only
// the publisher or an operator can clear, and most of these are something the
// client itself did, or a limit it can wait out.
const (
	// CodeUnsupportedMedia means the request did not declare a JSON body. The type
	// is required rather than sniffed.
	CodeUnsupportedMedia = "unsupported_media_type"

	// CodeRequestTooLarge means the request body is over this endpoint's bound.
	CodeRequestTooLarge = "request_too_large"

	// CodeMalformedRequest means the body is not the closed document this endpoint
	// accepts: not JSON, an unknown field, or something after the document.
	CodeMalformedRequest = "malformed_request"

	// CodeNoNames means the request named nothing to check.
	CodeNoNames = "no_names_requested"

	// CodeTooManyNames means the request named more labels than one check may cover.
	// It is counted before duplicates are removed.
	CodeTooManyNames = "too_many_names"

	// CodeInvalidName means at least one entry is not a second-level .eth label. The
	// message says what a label must be and never repeats what was sent, because a
	// reflected value is how a payload reaches somebody else's screen.
	CodeInvalidName = "invalid_name"

	// CodeClientUnidentified means the request carries no trusted identity to
	// throttle against. It fails closed rather than joining one shared allowance,
	// which an attacker could empty on everybody else's behalf.
	CodeClientUnidentified = "client_unidentified"

	// CodeClientThrottled means this client has spent its allowance. The allowance is
	// shared and durable, so this is the deployment's answer and not one instance's.
	CodeClientThrottled = "client_throttled"

	// CodeCheckStoreUnavailable means the shared store that holds the allowances and
	// the cache could not be reached, so nothing could be charged.
	//
	// It fails closed. A store that cannot be charged cannot bound anything, and
	// serving a request whose allowance nothing recorded is exactly the bypass the
	// shared store exists to close. Nothing about the store reaches the client: not
	// the table, not the key, not the wrapped message.
	CodeCheckStoreUnavailable = "check_store_unavailable"

	// CodeUpstreamBusy means this instance already has as many checks in the
	// subgraph as it permits at once. It is the one refusal here that really is per
	// instance, because an in-flight request cannot be counted anywhere else.
	CodeUpstreamBusy = "upstream_busy"

	// CodeUpstreamBudget means the deployment has spent its subgraph allowance across
	// every client together.
	CodeUpstreamBudget = "upstream_budget_exhausted"

	// CodeCheckTimedOut means the subgraph did not answer inside this endpoint's
	// deadline.
	CodeCheckTimedOut = "check_timed_out"

	// CodeUpstreamFailed means no fresh answer was obtained. Every upstream way of
	// failing collapses here on purpose: a transport error, a rate-limited or
	// challenged response, a truncated or oversized body, an error document, and an
	// answer that did not cover the names asked about are one code, because the only
	// honest thing to say about all of them is that nothing was verified. Nothing
	// derived from the upstream reaches the client.
	CodeUpstreamFailed = "upstream_unavailable"

	// CodeCheckCancelled means the client went away before the answer was ready. It
	// is not retryable advice from this API: the client already decided.
	CodeCheckCancelled = "check_cancelled"
)

// failure is one response this API can give instead of a snapshot.
//
// Both the code and the message are fixed literals declared below. Nothing in a
// failure response is ever derived from an upstream error, so no store detail, no
// endpoint, no candidate name, and no credential can reach a client through one,
// and the body is bounded by construction rather than by truncation.
type failure struct {
	status  int
	code    string
	message string

	// retryable says whether waiting and asking again can clear this failure, and
	// it is declared per failure rather than inferred from the status. A 503 here
	// means only that there is no snapshot to serve now: most of these are fixed by
	// the next scheduled scan, but an oversized snapshot persists until an operator
	// raises ENS_API_MAX_BODY_BYTES, so a client told to retry that one would poll
	// forever. Retry-After is the only thing that separates the two.
	retryable bool

	// retryAfter overrides how long a retryable failure advertises. Zero selects
	// Config.RetrySeconds, which is a scan cadence and is the right answer for a
	// snapshot that is not there yet. A spent allowance is clear at the end of the
	// window that refused it instead, and telling a throttled client to wait a scan
	// cadence would be a wait far longer than the one it is really serving.
	retryAfter time.Duration

	// advisory overrides the body's advisory line. Empty selects Advisory, the
	// snapshot one. A check failure carries CheckAdvisory instead, because a client
	// that only ever sees a failed fresh check is exactly the one that must not read
	// a snapshot status as verification.
	advisory string
}

var (
	failureNoSnapshot = failure{
		status:    http.StatusServiceUnavailable,
		code:      CodeNoSnapshot,
		message:   "No snapshot has been published yet.",
		retryable: true,
	}
	failureChunksMissing = failure{
		status:    http.StatusServiceUnavailable,
		code:      CodeChunksMissing,
		message:   "The published snapshot is incomplete.",
		retryable: true,
	}
	failureUnreadable = failure{
		status:    http.StatusServiceUnavailable,
		code:      CodeUnreadable,
		message:   "The published snapshot did not verify.",
		retryable: true,
	}
	failureTooLarge = failure{
		status:  http.StatusServiceUnavailable,
		code:    CodeTooLarge,
		message: "The published snapshot is larger than this endpoint serves.",
		// No scan can shrink a published snapshot below a limit this deployment
		// chose, so this one is not retryable.
		retryable: false,
	}
	failureUnavailable = failure{
		status:    http.StatusServiceUnavailable,
		code:      CodeUnavailable,
		message:   "The snapshot store could not be read.",
		retryable: true,
	}
	failureMethodNotAllowed = failure{
		status:  http.StatusMethodNotAllowed,
		code:    CodeMethodNotAllowed,
		message: "This endpoint accepts GET, HEAD, and OPTIONS.",
	}
	failureNotFound = failure{
		status:  http.StatusNotFound,
		code:    CodeNotFound,
		message: "No such endpoint.",
	}
)

// The PathCheck failures. Every message is a fixed literal like the ones above,
// and deliberately says nothing a client sent back to it: an entry this endpoint
// refused is refused by description, because reflecting the value is how a payload
// somebody else wrote reaches a third party's screen. The bounds the messages
// refer to are in docs/read-api.md rather than interpolated here, so a response
// body cannot vary with configuration either.
var (
	failureUnsupportedMedia = failure{
		status:   http.StatusUnsupportedMediaType,
		code:     CodeUnsupportedMedia,
		message:  "This endpoint accepts a JSON request body.",
		advisory: CheckAdvisory,
	}
	failureRequestTooLarge = failure{
		status:   http.StatusRequestEntityTooLarge,
		code:     CodeRequestTooLarge,
		message:  "The request body is larger than this endpoint accepts.",
		advisory: CheckAdvisory,
	}
	failureMalformedRequest = failure{
		status:   http.StatusBadRequest,
		code:     CodeMalformedRequest,
		message:  "The request body is not the document this endpoint accepts.",
		advisory: CheckAdvisory,
	}
	failureNoNames = failure{
		status:   http.StatusBadRequest,
		code:     CodeNoNames,
		message:  "The request named nothing to check.",
		advisory: CheckAdvisory,
	}
	failureTooManyNames = failure{
		status:   http.StatusBadRequest,
		code:     CodeTooManyNames,
		message:  "The request named more labels than one check covers.",
		advisory: CheckAdvisory,
	}
	failureInvalidName = failure{
		status:   http.StatusBadRequest,
		code:     CodeInvalidName,
		message:  "Every entry must be one second-level .eth label.",
		advisory: CheckAdvisory,
	}
	failureClientUnidentified = failure{
		status:  http.StatusServiceUnavailable,
		code:    CodeClientUnidentified,
		message: "The request carries no trusted identity to rate limit against.",
		// Waiting cannot add a trusted identity to a request, so this is not retryable.
		retryable: false,
		advisory:  CheckAdvisory,
	}
	failureClientThrottled = failure{
		status:    http.StatusTooManyRequests,
		code:      CodeClientThrottled,
		message:   "This client has made too many fresh checks. Wait and try again.",
		retryable: true,
		advisory:  CheckAdvisory,
	}
	failureCheckStoreUnavailable = failure{
		status:  http.StatusServiceUnavailable,
		code:    CodeCheckStoreUnavailable,
		message: "This endpoint could not reach the store that records its rate limits.",
		// Retryable, because the usual cause is a throttled or briefly unreachable
		// table and the next request may well be charged. It is not, however, the
		// client's fault, and it is deliberately not silently allowed: see the code.
		retryable: true,
		advisory:  CheckAdvisory,
	}
	failureUpstreamBusy = failure{
		status:    http.StatusServiceUnavailable,
		code:      CodeUpstreamBusy,
		message:   "This endpoint already has as many fresh checks running as it allows.",
		retryable: true,
		advisory:  CheckAdvisory,
	}
	failureUpstreamBudget = failure{
		status:    http.StatusServiceUnavailable,
		code:      CodeUpstreamBudget,
		message:   "This endpoint has spent its ENS index allowance. Wait and try again.",
		retryable: true,
		advisory:  CheckAdvisory,
	}
	failureCheckTimedOut = failure{
		status:    http.StatusGatewayTimeout,
		code:      CodeCheckTimedOut,
		message:   "The ENS index did not answer in time.",
		retryable: true,
		advisory:  CheckAdvisory,
	}
	failureUpstreamFailed = failure{
		status:    http.StatusBadGateway,
		code:      CodeUpstreamFailed,
		message:   "No fresh answer could be obtained from the ENS index.",
		retryable: true,
		advisory:  CheckAdvisory,
	}
	failureCheckMethodNotAllowed = failure{
		status:   http.StatusMethodNotAllowed,
		code:     CodeMethodNotAllowed,
		message:  "This endpoint accepts POST and OPTIONS.",
		advisory: CheckAdvisory,
	}
	failureCheckCancelled = failure{
		status:  http.StatusServiceUnavailable,
		code:    CodeCheckCancelled,
		message: "The request ended before the fresh check finished.",
		// The client is already gone, and it decided that itself. There is nobody to
		// advise about a retry, so this carries no Retry-After. The status is 503
		// because net/http has no code for a client that hung up, and the record that
		// matters is the log line rather than this response.
		retryable: false,
		advisory:  CheckAdvisory,
	}
)

// failed returns a copy, so a caller can never reach through a returned failure
// and edit the table above.
func failed(f failure) *failure { return &f }

// retryIn returns a copy of f advertising d rather than the scan cadence.
//
// It exists because the two are different kinds of wait. Config.RetrySeconds says
// how long until the next scan might publish something, which is the honest hint
// for a snapshot that is not there. A spent allowance is clear at the end of the
// window that refused it, and a busy instance frees a slot within one request
// deadline, so those advertise what they will really take. A non-retryable failure is returned unchanged: a
// caller must not be able to attach a wait to a failure that waiting cannot clear.
func retryIn(f failure, d time.Duration) failure {
	if !f.retryable || d <= 0 {
		return f
	}
	f.retryAfter = d
	return f
}

// errorDocument is the body of every failure response.
type errorDocument struct {
	Error errorBody `json:"error"`
	// Advisory is repeated here because a client that only ever sees failures is
	// exactly the one that must not treat this API as an availability authority.
	Advisory string `json:"advisory"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

const contentTypeJSON = "application/json; charset=utf-8"

// writeFailure sends one failure.
//
// A failure is never cacheable. A 503 that a shared cache kept would outlive the
// scan that fixes it, so every one of these carries no-store, and the ones a
// client should retry carry Retry-After: nothing valid is published now, and the
// next scheduled scan republishes. A failure that no scan can clear carries no
// Retry-After, so the header never advertises a wait that would not help.
func (h *Handler) writeFailure(w http.ResponseWriter, r *http.Request, f failure) {
	header := w.Header()
	header.Set("Cache-Control", "no-store")
	if f.retryable {
		header.Set("Retry-After", strconv.Itoa(retrySeconds(f, h.config.RetrySeconds)))
	}
	advisory := f.advisory
	if advisory == "" {
		advisory = Advisory
	}
	body, err := json.Marshal(errorDocument{
		Error:    errorBody{Code: f.code, Message: f.message},
		Advisory: advisory,
	})
	if err != nil {
		// The document is fixed literals, so this cannot happen. Sending the status
		// without a body still keeps the response bounded and well formed.
		w.WriteHeader(f.status)
		return
	}
	header.Set("Content-Type", contentTypeJSON)
	header.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(f.status)
	if r.Method != http.MethodHead {
		w.Write(body)
	}
}

// retrySeconds renders a failure's wait. A sub-second wait rounds up to one
// second, because Retry-After has no finer unit and rounding down would render
// zero, which tells a client to retry at once.
func retrySeconds(f failure, fallback int) int {
	if f.retryAfter <= 0 {
		return fallback
	}
	seconds := int((f.retryAfter + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	return seconds
}

// writeCached sends one cacheable document, or a 304 when the client already
// holds it.
//
// Both validators are deterministic functions of the snapshot. The entity tag is
// the snapshot ID, and every document this serves is fully determined by that ID:
// the snapshot body is the published canonical JSON, and the metadata document
// carries only fields the ID fixes. Last-Modified is the scan time, which is UTC
// with second precision, so it is exact rather than rounded.
func (h *Handler) writeCached(w http.ResponseWriter, r *http.Request, cached *cachedSnapshot, body []byte) {
	header := w.Header()
	header.Set("ETag", cached.etag)
	header.Set("Last-Modified", cached.latest.ScannedAt.UTC().Format(http.TimeFormat))
	header.Set("Cache-Control", h.cacheControl)

	if notModified(r, cached) {
		// A 304 carries the validators and the caching policy and nothing that
		// describes a body, because there is no body to describe.
		w.WriteHeader(http.StatusNotModified)
		return
	}

	header.Set("Content-Type", contentTypeJSON)
	header.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		w.Write(body)
	}
}

// notModified applies the conditional request rules. If-None-Match wins whenever
// it is present, as RFC 7232 requires, and If-Modified-Since is honored only in
// its absence so a client that has only the weaker validator still avoids
// downloading a snapshot it already holds.
func notModified(r *http.Request, cached *cachedSnapshot) bool {
	if match := r.Header.Get("If-None-Match"); match != "" {
		return entityTagMatches(match, cached.etag)
	}
	return notModifiedSince(r.Header.Get("If-Modified-Since"), cached.latest.ScannedAt)
}

// entityTag renders a strong entity tag. A snapshot ID is lowercase letters,
// digits, and inner dashes, so it needs no escaping and can hold no quote,
// comma, or space that would change how a client parses the header.
func entityTag(snapshotID string) string {
	return `"` + snapshotID + `"`
}

// entityTagMatches applies the weak comparison If-None-Match calls for: a
// client's W/"id" matches the "id" this API sent, because both name the same
// snapshot. Splitting on commas is safe for the same reason entityTag needs no
// escaping.
func entityTagMatches(header, etag string) bool {
	header = strings.TrimSpace(header)
	if header == "*" {
		// "*" matches whenever the resource exists, and by this point it does.
		return true
	}
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" {
			return true
		}
		if strings.HasPrefix(candidate, "W/") {
			candidate = strings.TrimSpace(strings.TrimPrefix(candidate, "W/"))
		}
		if candidate == etag {
			return true
		}
	}
	return false
}

// notModifiedSince reports whether the client's copy is at least as new as the
// scan. An unparseable date is ignored rather than guessed at, which costs one
// full response and never serves a snapshot the client does not have.
func notModifiedSince(header string, scannedAt time.Time) bool {
	if header == "" {
		return false
	}
	since, err := http.ParseTime(header)
	if err != nil {
		return false
	}
	return !scannedAt.UTC().After(since.UTC())
}
