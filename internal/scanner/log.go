package scanner

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Level is the severity of one log record. There are three, because a scheduled
// job only ever needs to say "this happened", "this went wrong but the run
// continues", and "the run stopped".
type Level string

const (
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
)

// Logger writes one JSON object per line to a writer, which is how CloudWatch
// Logs turns Lambda output into queryable fields.
//
// Records are a fixed struct rather than a free-form map, so a caller cannot
// attach a candidate label, an endpoint, or a credential to a log line even by
// accident. Everything a record can carry is a count, an identifier, a duration,
// or a redacted error string. That is a deliberate limit on the logger: the way to
// log something new is to add a field here and decide then whether it is safe.
type Logger struct {
	mutex  sync.Mutex
	writer io.Writer
	now    func() time.Time
}

// NewLogger returns a Logger writing to w. A nil writer discards records, so a
// caller that has not configured logging cannot panic in the middle of a scan.
func NewLogger(w io.Writer, now func() time.Time) *Logger {
	if now == nil {
		now = time.Now
	}
	return &Logger{writer: w, now: now}
}

// Fields are the values a record may carry. Every one is either derived from
// configuration the operator set, or a count, so none of them can hold a
// candidate name, a Graph endpoint, or a secret.
type Fields struct {
	Group        Group  `json:"group,omitempty"`
	SnapshotID   string `json:"snapshot_id,omitempty"`
	PreviousID   string `json:"previous_snapshot_id,omitempty"`
	Names        int    `json:"names,omitempty"`
	Scanned      int    `json:"scanned,omitempty"`
	Carried      int    `json:"carried,omitempty"`
	Batches      int    `json:"batches,omitempty"`
	Lists        int    `json:"lists,omitempty"`
	Chunks       int    `json:"chunks,omitempty"`
	Bytes        int    `json:"bytes,omitempty"`
	Attempt      int    `json:"attempt,omitempty"`
	ScannedAt    string `json:"scanned_at,omitempty"`
	ExpiresAt    string `json:"expires_at,omitempty"`
	DurationMill int64  `json:"duration_ms,omitempty"`
}

type record struct {
	Time  string `json:"time"`
	Level Level  `json:"level"`
	Event string `json:"event"`
	Fields
	Error string `json:"error,omitempty"`
}

// Log writes one record. event is a fixed lowercase identifier, so a log query
// can select a stage of the run without matching on free text.
func (l *Logger) Log(level Level, event string, fields Fields) {
	l.write(record{Level: level, Event: event, Fields: fields})
}

// LogError writes one record with a redacted rendering of err.
func (l *Logger) LogError(level Level, event string, fields Fields, err error) {
	l.write(record{Level: level, Event: event, Fields: fields, Error: Redact(err)})
}

func (l *Logger) write(entry record) {
	if l == nil || l.writer == nil {
		return
	}
	entry.Time = l.now().UTC().Format(time.RFC3339)
	encoded, err := json.Marshal(entry)
	if err != nil {
		// A record built from these field types cannot fail to encode. Reporting
		// the failure rather than the record keeps the output valid JSON lines.
		encoded = []byte(fmt.Sprintf(`{"time":%q,"level":%q,"event":"log_encode_failed"}`,
			entry.Time, LevelError))
	}
	l.mutex.Lock()
	defer l.mutex.Unlock()
	l.writer.Write(append(encoded, '\n'))
}

// endpointPattern matches any absolute URL. The Graph gateway carries the API key
// in its path, so an error that quotes a request URL would otherwise publish the
// credential into a log group that is far easier to read than the secret store it
// came from.
var endpointPattern = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.-]*://[^\s"']+`)

// namePattern matches a fully-qualified candidate name. Candidate labels are the
// product this tool exists to find, and a log group is not where they belong.
var namePattern = regexp.MustCompile(`[^\s"']*\.eth\b`)

// Redact renders an error as a log-safe string.
//
// The scanner never puts a candidate name or an endpoint into a field, but it does
// wrap errors from the Graph client and the storage backend, and neither of those
// promises anything about what its messages quote. Redaction is applied to the
// rendered error rather than trusted to the layer that produced it.
func Redact(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	message = endpointPattern.ReplaceAllString(message, "[endpoint]")
	message = namePattern.ReplaceAllString(message, "[name]")
	return strings.TrimSpace(message)
}
