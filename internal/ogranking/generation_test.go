package ogranking

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSelectCandidatesIsLengthBalancedAndIncludesStrongCalibration(t *testing.T) {
	root := testRepositoryRoot(t)
	corpus, err := LoadCorpus(root)
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}
	calibration, _, err := LoadCalibration(root, labelSet(corpus.Labels))
	if err != nil {
		t.Fatalf("LoadCalibration: %v", err)
	}
	candidates, err := SelectCandidates(corpus, StrongCalibrationLabels(calibration), DefaultCandidateCount)
	if err != nil {
		t.Fatalf("SelectCandidates: %v", err)
	}
	counts := map[int]int{}
	selected := make(map[string]Candidate, len(candidates))
	for _, candidate := range candidates {
		counts[len(candidate.Label)]++
		selected[candidate.Label] = candidate
	}
	if !reflect.DeepEqual(counts, map[int]int{3: 128, 4: 128, 5: 128}) {
		t.Fatalf("length counts = %#v", counts)
	}
	for _, label := range StrongCalibrationLabels(calibration) {
		candidate, ok := selected[label]
		if !ok || !candidate.Forced {
			t.Fatalf("strong calibration label %q was not anchored into candidates", label)
		}
	}
}

func TestOrderLabelsIsDeterministicAndSeeded(t *testing.T) {
	labels := []string{"ace", "vex", "zine", "moth", "nova", "rune", "flux", "saga", "quad", "pyre"}
	first := orderLabels(labels, orderingSeeds[0])
	second := orderLabels(labels, orderingSeeds[0])
	other := orderLabels(labels, orderingSeeds[1])
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("same seed produced %#v and %#v", first, second)
	}
	if want := []string{"flux", "ace", "saga", "vex", "rune", "pyre", "moth", "quad", "nova", "zine"}; !reflect.DeepEqual(first, want) {
		t.Fatalf("first order = %#v, want %#v", first, want)
	}
	if want := []string{"rune", "saga", "nova", "ace", "flux", "pyre", "quad", "vex", "moth", "zine"}; !reflect.DeepEqual(other, want) {
		t.Fatalf("second order = %#v, want %#v", other, want)
	}
	if !reflect.DeepEqual(labels, []string{"ace", "vex", "zine", "moth", "nova", "rune", "flux", "saga", "quad", "pyre"}) {
		t.Fatalf("orderLabels mutated its input: %#v", labels)
	}
}

func TestModelSchemaClosesEveryObjectAndBoundsEveryArray(t *testing.T) {
	schema, err := modelBatchSchema([]string{"ace", "vex"})
	if err != nil {
		t.Fatalf("modelBatchSchema: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(schema, &document); err != nil {
		t.Fatal(err)
	}
	text := string(schema)
	for _, forbidden := range []string{"availability", "registration", "expiry", "premium", "price"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("schema contains forbidden lifecycle field %q", forbidden)
		}
	}
	if document["additionalProperties"] != false {
		t.Fatal("top-level schema permits unknown fields")
	}
	items := document["properties"].(map[string]any)["items"].(map[string]any)
	if items["minItems"] != float64(2) || items["maxItems"] != float64(2) {
		t.Fatalf("item bounds = %#v", items)
	}
}

func TestGenerateModelPassesWritesOnlyValidatedBoundedRecords(t *testing.T) {
	root := copyGenerationInputs(t)
	runner := &fakeModelRunner{}
	record, err := GenerateModelPasses(context.Background(), GeneratorOptions{
		RepositoryRoot:  root,
		GeneratorCommit: strings.Repeat("a", 40),
		GeneratedAt:     time.Date(2026, time.October, 10, 12, 0, 0, 0, time.UTC),
		Runner:          runner,
	})
	if err != nil {
		t.Fatalf("GenerateModelPasses: %v", err)
	}
	if runner.calls != 9 || record.TotalAttempts != 9 {
		t.Fatalf("calls = %d, attempts = %d, want 9", runner.calls, record.TotalAttempts)
	}
	if record.TotalUsage.InputTokens != 900 || record.TotalUsage.OutputTokens != 1800 {
		t.Fatalf("usage = %#v", record.TotalUsage)
	}
	if err := record.Validate(root); err != nil {
		t.Fatalf("Validate generation: %v", err)
	}
	for _, pass := range record.Passes {
		payload, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(pass.OutputPath)))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(payload, []byte("request")) || bytes.Contains(payload, []byte("provider")) {
			t.Fatalf("pass %d retained provider envelope data", pass.Index)
		}
	}
}

func TestGenerateModelPassesFailsClosedAfterPartialBatchRetry(t *testing.T) {
	root := copyGenerationInputs(t)
	runner := &fakeModelRunner{malformed: true}
	_, err := GenerateModelPasses(context.Background(), GeneratorOptions{
		RepositoryRoot:  root,
		GeneratorCommit: strings.Repeat("b", 40),
		GeneratedAt:     time.Date(2026, time.October, 10, 12, 0, 0, 0, time.UTC),
		Runner:          runner,
	})
	if err == nil || !strings.Contains(err.Error(), "failed closed after 2 attempts") {
		t.Fatalf("error = %v, want bounded partial-batch refusal", err)
	}
	if runner.calls != 2 {
		t.Fatalf("calls = %d, want 2", runner.calls)
	}
	if _, statErr := os.Stat(filepath.Join(root, "data", "ranking", "og-v1.generation.json")); !os.IsNotExist(statErr) {
		t.Fatalf("partial generation record exists: %v", statErr)
	}
}

func TestDecodeCodexEventsKeepsOnlyFinalStructuredMessageAndUsage(t *testing.T) {
	events := strings.Join([]string{
		`{"type":"thread.started","thread_id":"transient"}`,
		`{"type":"item.completed","item":{"type":"agent_message","text":"{\"items\":[]}"}}`,
		`{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":3,"cache_write_input_tokens":4,"output_tokens":5,"reasoning_output_tokens":1}}`,
		"",
	}, "\n")
	response, usage, err := decodeCodexEvents([]byte(events))
	if err != nil {
		t.Fatalf("decodeCodexEvents: %v", err)
	}
	if string(response) != `{"items":[]}` {
		t.Fatalf("response = %q", response)
	}
	if usage.InputTokens != 12 || usage.OutputTokens != 5 {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestDecodeCodexFailureReadsStructuredDiagnosticAndUsage(t *testing.T) {
	events := strings.Join([]string{
		`{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":5}}`,
		`{"type":"turn.failed","error":{"message":"request req_abcdefghijklmnopqrstuvwxyz failed at https://provider.example/path"}}`,
		"",
	}, "\n")
	usage, diagnostic := decodeCodexFailure([]byte(events))
	if usage.InputTokens != 12 || usage.OutputTokens != 5 {
		t.Fatalf("usage = %#v", usage)
	}
	if diagnostic == "" ||
		strings.Contains(diagnostic, "req_") ||
		strings.Contains(diagnostic, "provider.example") {
		t.Fatalf("diagnostic = %q", diagnostic)
	}
}

func TestProviderErrorsRedactTransientRequestIdentityAndURL(t *testing.T) {
	message := redactProviderError(
		"request req_abcdefghijklmnopqrstuvwxyz failed at https://provider.example/path",
	)
	if strings.Contains(message, "req_") || strings.Contains(message, "provider.example") {
		t.Fatalf("redacted message = %q", message)
	}
}
