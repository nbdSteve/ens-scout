package api

import (
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"
)

// checkLevel is the severity of one check record.
type checkLevel string

const (
	checkLevelInfo  checkLevel = "info"
	checkLevelWarn  checkLevel = "warn"
	checkLevelError checkLevel = "error"
)

// checkLogger writes one JSON object per line, which is how CloudWatch Logs turns
// Lambda output into queryable fields.
//
// Every field is a count, a duration, an HTTP status, or one of the fixed failure
// codes in respond.go. Records are a struct rather than a free-form map, so a
// caller cannot attach a candidate label, an endpoint, a credential, or a client
// address even by accident, and adding a field here is the moment to decide it is
// safe to log.
//
// Nothing derived from a request body or an upstream response is written at all.
// That is a structural guarantee rather than a filter: both are untrusted text,
// and a log group is somewhere text goes and stays. internal/ens folds the request
// URL and a slice of the gateway's response body into its errors, and the
// gateway's URL carries the credential in its path, so an error rendered here
// would be exactly the leak this refuses - and redacting it would only strip the
// patterns somebody thought of. The cost is that an upstream failure is reported
// as its code and nothing more; the scheduled publisher queries the same gateway
// with the same credential, and internal/scanner is where a diagnosable rendering
// of that failure belongs.
type checkLogger struct {
	mutex  sync.Mutex
	writer io.Writer
	now    func() time.Time
}

func newCheckLogger(w io.Writer, now func() time.Time) *checkLogger {
	if now == nil {
		now = time.Now
	}
	return &checkLogger{writer: w, now: now}
}

// checkFields are the values a record may carry.
type checkFields struct {
	// Names is how many distinct labels the request resolved to, not which.
	Names int `json:"names,omitempty"`
	// Batches is how many upstream calls the request was budgeted for.
	Batches int `json:"batches,omitempty"`
	// Outcome is a fixed failure code, or empty on success. It is never derived
	// from an upstream error.
	Outcome string `json:"outcome,omitempty"`
	// Cache is which layer answered: "local" for this instance's copy, "shared" for
	// the durable store, and empty for a request that really read the ENS index. The
	// two hits are distinguished because the copy layer is only ever an optimization
	// over the store, and an operator has to be able to see that it is behaving like
	// one.
	Cache string `json:"cache,omitempty"`
	// CacheWriteFailed reports that an answer was obtained and returned but could not
	// be written to the shared store. It never accompanies a failed request: the
	// answer was honest, and the only cost is the next identical request.
	CacheWriteFailed bool `json:"cache_write_failed,omitempty"`
	// Status is the HTTP status the client received.
	Status int `json:"status,omitempty"`
	// DurationMill is how long the request took.
	DurationMill int64 `json:"duration_ms,omitempty"`
}

// checkLevelFor says how loudly one refusal is reported, and refuses to infer it
// from whether an error value happened to exist behind the refusal.
//
// That inference was wrong in both directions. A malformed body is ordinary
// traffic however it was detected, and detecting it produces a decoder error, so
// it was reported at error level; a timeout is an operator's problem even when
// nothing inside this process errored at all. The level is therefore a property of
// the refusal: error is exactly the failures that mean this instance could not do
// its job, because it obtained no answer, cannot identify a client at all, or
// cannot reach the store that records its limits, and every refusal this API decided
// on its own is a warning.
func checkLevelFor(code string) checkLevel {
	switch code {
	case CodeUpstreamFailed, CodeCheckTimedOut, CodeClientUnidentified, CodeCheckStoreUnavailable:
		return checkLevelError
	}
	return checkLevelWarn
}

// checkEventFor is the event name that goes with a level, so the two cannot
// disagree: a record an operator alarms on at error level is always check_failed.
func checkEventFor(level checkLevel) string {
	if level == checkLevelError {
		return "check_failed"
	}
	return "check_refused"
}

// checkRecord is one line. It carries no error string, by the rule above: the
// severity and the outcome code say which failure happened, and the text that
// described it is the part that cannot be written.
type checkRecord struct {
	Time  string     `json:"time"`
	Level checkLevel `json:"level"`
	Event string     `json:"event"`
	checkFields
}

func (l *checkLogger) log(level checkLevel, event string, fields checkFields) {
	l.write(checkRecord{Level: level, Event: event, checkFields: fields})
}

func (l *checkLogger) write(entry checkRecord) {
	if l == nil || l.writer == nil {
		return
	}
	entry.Time = l.now().UTC().Format(time.RFC3339)
	encoded, err := json.Marshal(entry)
	if err != nil {
		// A record built from these field types cannot fail to encode. Reporting the
		// failure rather than the record keeps the output valid JSON lines.
		encoded = []byte(fmt.Sprintf(`{"time":%q,"level":%q,"event":"log_encode_failed"}`,
			entry.Time, checkLevelError))
	}
	l.mutex.Lock()
	defer l.mutex.Unlock()
	l.writer.Write(append(encoded, '\n'))
}
