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
}

var (
	failureNoSnapshot = failure{
		status:  http.StatusServiceUnavailable,
		code:    CodeNoSnapshot,
		message: "No snapshot has been published yet.",
	}
	failureChunksMissing = failure{
		status:  http.StatusServiceUnavailable,
		code:    CodeChunksMissing,
		message: "The published snapshot is incomplete.",
	}
	failureUnreadable = failure{
		status:  http.StatusServiceUnavailable,
		code:    CodeUnreadable,
		message: "The published snapshot did not verify.",
	}
	failureTooLarge = failure{
		status:  http.StatusServiceUnavailable,
		code:    CodeTooLarge,
		message: "The published snapshot is larger than this endpoint serves.",
	}
	failureUnavailable = failure{
		status:  http.StatusServiceUnavailable,
		code:    CodeUnavailable,
		message: "The snapshot store could not be read.",
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

// failed returns a copy, so a caller can never reach through a returned failure
// and edit the table above.
func failed(f failure) *failure { return &f }

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
// next scheduled scan republishes.
func (h *Handler) writeFailure(w http.ResponseWriter, r *http.Request, f failure) {
	header := w.Header()
	header.Set("Cache-Control", "no-store")
	if f.status == http.StatusServiceUnavailable {
		header.Set("Retry-After", strconv.Itoa(h.config.RetrySeconds))
	}
	body, err := json.Marshal(errorDocument{
		Error:    errorBody{Code: f.code, Message: f.message},
		Advisory: Advisory,
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
