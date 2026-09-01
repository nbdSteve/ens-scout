package scanner

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
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
	redact *Redactor
}

// NewLogger returns a Logger writing to w. A nil writer discards records, so a
// caller that has not configured logging cannot panic in the middle of a scan.
//
// The logger starts with the pattern-only redactor, because the first records of a
// cold start are written before the configuration that names the credential has
// been read. UseRedactor installs the configuration-aware one.
func NewLogger(w io.Writer, now func() time.Time) *Logger {
	if now == nil {
		now = time.Now
	}
	return &Logger{writer: w, now: now}
}

// UseRedactor installs the redactor every later error is rendered with. A nil
// redactor selects the pattern-only default.
func (l *Logger) UseRedactor(redactor *Redactor) {
	if l == nil {
		return
	}
	l.mutex.Lock()
	defer l.mutex.Unlock()
	l.redact = redactor
}

// redactor is the installed redactor, or nil, which renders the same way as one
// with no configured secret.
func (l *Logger) redactor() *Redactor {
	if l == nil {
		return nil
	}
	l.mutex.Lock()
	defer l.mutex.Unlock()
	return l.redact
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
	Staged       int    `json:"staged,omitempty"`
	Attempted    int    `json:"attempted,omitempty"`
	Reclaimed    int    `json:"reclaimed,omitempty"`
	Skipped      int    `json:"skipped,omitempty"`
	ScannedAt    string `json:"scanned_at,omitempty"`
	StagedAt     string `json:"staged_at,omitempty"`
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
	l.write(record{Level: level, Event: event, Fields: fields, Error: l.redactor().Error(err)})
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

// secretPlaceholder replaces a configured secret literal.
const secretPlaceholder = "[redacted]"

// minRedactedSecret is the shortest literal a Redactor will strip. Anything
// shorter cannot be a Graph API key, and replacing a two-character literal
// everywhere it occurs would mangle ordinary messages instead of protecting
// anything.
const minRedactedSecret = 8

// Redactor renders error text log-safe.
//
// It strips three things: any absolute URL, because the Graph gateway carries the
// API key in its path; any fully-qualified candidate name; and any secret literal
// it was configured with.
//
// The configured literals are what the patterns cannot cover. The layer that
// produced an error promises nothing about what it quotes, and the Graph client
// folds a slice of the gateway's response body into its error, so a gateway that
// echoed the credential back in an authentication failure would put a bare key in a
// log group with no URL for the endpoint pattern to match. Redaction is applied to
// the rendered text at the boundary rather than trusted to the layer that produced
// it, and that principle only holds if the credential itself is one of the things
// being stripped.
//
// A nil *Redactor strips the patterns and no literal, which is what a caller that
// has not read its configuration yet gets.
type Redactor struct {
	secrets []string
}

// NewRedactor returns a Redactor that strips the given literals. Empty and
// implausibly short values are ignored, so a store with no credential configured
// behaves exactly like the pattern-only default.
func NewRedactor(secrets ...string) *Redactor {
	kept := make([]string, 0, len(secrets))
	for _, secret := range secrets {
		secret = strings.TrimSpace(secret)
		if len(secret) < minRedactedSecret {
			continue
		}
		kept = append(kept, secret)
	}
	// Longest first, so a literal that contains another - the resolved endpoint
	// contains the API key - is replaced whole rather than in pieces.
	sort.SliceStable(kept, func(i, j int) bool { return len(kept[i]) > len(kept[j]) })
	return &Redactor{secrets: kept}
}

// Error renders an error as a log-safe string. A nil error renders as empty.
func (r *Redactor) Error(err error) string {
	if err == nil {
		return ""
	}
	return r.Text(err.Error())
}

// Text renders any string log-safe.
func (r *Redactor) Text(message string) string {
	if r != nil {
		// Literals go first: after a URL becomes a placeholder there is nothing left
		// of the key it carried, and a bare key is only ever caught here.
		for _, secret := range r.secrets {
			message = strings.ReplaceAll(message, secret, secretPlaceholder)
		}
	}
	message = endpointPattern.ReplaceAllString(message, "[endpoint]")
	message = namePattern.ReplaceAllString(message, "[name]")
	return strings.TrimSpace(message)
}
