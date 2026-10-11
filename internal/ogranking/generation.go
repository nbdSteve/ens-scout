package ogranking

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	DefaultModelID          = "openai.gpt-5.6-sol"
	DefaultModelRevision    = "openai.gpt-5.6-sol"
	DefaultModelComposition = "3000"
	defaultReasoningEffort  = "low"
	defaultCallTimeout      = 8 * time.Minute
)

var orderingSeeds = []string{
	"og-v1-pass-1-7df45c73",
	"og-v1-pass-2-a9136e2b",
	"og-v1-pass-3-c2861f04",
}

type ModelIdentity struct {
	Provider           string `json:"provider"`
	ModelID            string `json:"model_id"`
	ModelRevision      string `json:"model_revision"`
	CatalogComposition string `json:"catalog_composition"`
	Interface          string `json:"interface"`
	InterfaceVersion   string `json:"interface_version"`
}

type GenerationSettings struct {
	Temperature        int    `json:"temperature"`
	ReasoningEffort    string `json:"reasoning_effort"`
	RunsPerLabel       int    `json:"runs_per_label"`
	CandidateCount     int    `json:"candidate_count"`
	BatchSize          int    `json:"batch_size"`
	MaxAttempts        int    `json:"max_attempts"`
	MaxInputTokens     int    `json:"max_input_tokens"`
	MaxOutputTokens    int    `json:"max_output_tokens"`
	MaxRequestBytes    int    `json:"max_request_bytes"`
	MaxResponseBytes   int    `json:"max_response_bytes"`
	MaxEventBytes      int    `json:"max_event_bytes"`
	CallTimeoutSeconds int    `json:"call_timeout_seconds"`
}

type TokenUsage struct {
	InputTokens           int `json:"input_tokens"`
	CachedInputTokens     int `json:"cached_input_tokens"`
	CacheWriteInputTokens int `json:"cache_write_input_tokens"`
	OutputTokens          int `json:"output_tokens"`
	ReasoningOutputTokens int `json:"reasoning_output_tokens"`
}

func (usage *TokenUsage) add(other TokenUsage) {
	usage.InputTokens += other.InputTokens
	usage.CachedInputTokens += other.CachedInputTokens
	usage.CacheWriteInputTokens += other.CacheWriteInputTokens
	usage.OutputTokens += other.OutputTokens
	usage.ReasoningOutputTokens += other.ReasoningOutputTokens
}

type GeneratedBatchRecord struct {
	Index        int        `json:"index"`
	Count        int        `json:"count"`
	LabelsSHA256 string     `json:"labels_sha256"`
	Attempts     int        `json:"attempts"`
	Usage        TokenUsage `json:"usage"`
}

type GeneratedPassRecord struct {
	Index        int                    `json:"index"`
	OrderingSeed string                 `json:"ordering_seed"`
	Batches      []GeneratedBatchRecord `json:"batches"`
	OutputPath   string                 `json:"output_path"`
	OutputSHA256 string                 `json:"output_sha256"`
}

type GenerationRecord struct {
	FormatVersion     int                   `json:"format_version"`
	GeneratedAt       string                `json:"generated_at"`
	GeneratorCommit   string                `json:"generator_commit"`
	CorpusCount       int                   `json:"corpus_count"`
	CorpusSHA256      string                `json:"corpus_sha256"`
	RubricVersion     string                `json:"rubric_version"`
	RubricSHA256      string                `json:"rubric_sha256"`
	PromptVersion     string                `json:"prompt_version"`
	PromptSHA256      string                `json:"prompt_sha256"`
	CalibrationSHA256 string                `json:"calibration_sha256"`
	CandidatesPath    string                `json:"candidates_path"`
	CandidatesSHA256  string                `json:"candidates_sha256"`
	Model             ModelIdentity         `json:"model"`
	Settings          GenerationSettings    `json:"settings"`
	Passes            []GeneratedPassRecord `json:"passes"`
	TotalAttempts     int                   `json:"total_attempts"`
	TotalUsage        TokenUsage            `json:"total_usage"`
}

type CandidateArtifact struct {
	FormatVersion int         `json:"format_version"`
	CorpusCount   int         `json:"corpus_count"`
	CorpusSHA256  string      `json:"corpus_sha256"`
	RubricVersion string      `json:"rubric_version"`
	Count         int         `json:"count"`
	Items         []Candidate `json:"items"`
}

type GeneratorOptions struct {
	RepositoryRoot  string
	GeneratorCommit string
	GeneratedAt     time.Time
	Runner          ModelRunner
}

type ModelRunner interface {
	Generate(context.Context, string, []byte) ([]byte, TokenUsage, error)
	Identity() ModelIdentity
}

// GenerateModelPasses invokes the manual model boundary. It writes only
// validated records and aggregate usage; provider events and request IDs are
// never returned as repository artifacts.
func GenerateModelPasses(ctx context.Context, options GeneratorOptions) (GenerationRecord, error) {
	if options.Runner == nil {
		return GenerationRecord{}, fmt.Errorf("model runner is required")
	}
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(options.GeneratorCommit) {
		return GenerationRecord{}, fmt.Errorf("generator commit must be a full lowercase Git SHA")
	}
	if options.GeneratedAt.IsZero() {
		return GenerationRecord{}, fmt.Errorf("generation time is required")
	}
	root, err := filepath.Abs(options.RepositoryRoot)
	if err != nil {
		return GenerationRecord{}, fmt.Errorf("resolve repository root: %w", err)
	}
	corpus, err := LoadCorpus(root)
	if err != nil {
		return GenerationRecord{}, err
	}
	corpusSet := labelSet(corpus.Labels)
	calibration, calibrationBytes, err := LoadCalibration(root, corpusSet)
	if err != nil {
		return GenerationRecord{}, err
	}
	candidates, err := SelectCandidates(
		corpus,
		StrongCalibrationLabels(calibration),
		DefaultCandidateCount,
	)
	if err != nil {
		return GenerationRecord{}, err
	}
	candidateBytes, err := canonicalIndentedJSON(CandidateArtifact{
		FormatVersion: CandidateFormatVersion,
		CorpusCount:   len(corpus.Labels),
		CorpusSHA256:  corpus.SHA256,
		RubricVersion: RubricVersion,
		Count:         len(candidates),
		Items:         candidates,
	})
	if err != nil {
		return GenerationRecord{}, fmt.Errorf("encode candidates: %w", err)
	}
	candidatePath := filepath.Join(root, "data", "ranking", "og-v1.candidates.json")
	if err := writeAtomic(candidatePath, candidateBytes); err != nil {
		return GenerationRecord{}, err
	}

	rubricPath := filepath.Join(root, "data", "ranking", "og-v1.rubric.md")
	rubric, err := os.ReadFile(rubricPath)
	if err != nil {
		return GenerationRecord{}, fmt.Errorf("read rubric: %w", err)
	}
	promptPath := filepath.Join(root, "data", "ranking", "og-v1.prompt.md")
	prompt, err := os.ReadFile(promptPath)
	if err != nil {
		return GenerationRecord{}, fmt.Errorf("read prompt: %w", err)
	}

	record := GenerationRecord{
		FormatVersion:     GenerationFormatVersion,
		GeneratedAt:       options.GeneratedAt.UTC().Truncate(time.Second).Format(time.RFC3339),
		GeneratorCommit:   options.GeneratorCommit,
		CorpusCount:       len(corpus.Labels),
		CorpusSHA256:      corpus.SHA256,
		RubricVersion:     RubricVersion,
		RubricSHA256:      hashBytes(rubric),
		PromptVersion:     PromptVersion,
		PromptSHA256:      hashBytes(prompt),
		CalibrationSHA256: hashBytes(calibrationBytes),
		CandidatesPath:    filepath.ToSlash(filepath.Join("data", "ranking", "og-v1.candidates.json")),
		CandidatesSHA256:  hashBytes(candidateBytes),
		Model:             options.Runner.Identity(),
		Settings: GenerationSettings{
			Temperature:        0,
			ReasoningEffort:    defaultReasoningEffort,
			RunsPerLabel:       DefaultPasses,
			CandidateCount:     DefaultCandidateCount,
			BatchSize:          DefaultBatchSize,
			MaxAttempts:        MaxModelAttempts,
			MaxInputTokens:     MaxModelInputTokens,
			MaxOutputTokens:    MaxModelOutputTokens,
			MaxRequestBytes:    MaxModelRequestBytes,
			MaxResponseBytes:   MaxModelResponseBytes,
			MaxEventBytes:      MaxModelEventBytes,
			CallTimeoutSeconds: int(defaultCallTimeout / time.Second),
		},
	}
	if err := validateModelIdentity(record.Model); err != nil {
		return GenerationRecord{}, err
	}

	candidateLabels := make([]string, len(candidates))
	for index, candidate := range candidates {
		candidateLabels[index] = candidate.Label
	}
	expectedCalls := DefaultPasses * ((len(candidateLabels) + DefaultBatchSize - 1) / DefaultBatchSize)
	firstUsageChecked := false
	for passIndex, seed := range orderingSeeds {
		ordered := orderLabels(candidateLabels, seed)
		var passItems []ModelItem
		passRecord := GeneratedPassRecord{
			Index:        passIndex + 1,
			OrderingSeed: seed,
		}
		for start := 0; start < len(ordered); start += DefaultBatchSize {
			end := start + DefaultBatchSize
			if end > len(ordered) {
				end = len(ordered)
			}
			batchLabels := append([]string(nil), ordered[start:end]...)
			batchRecord := GeneratedBatchRecord{
				Index:        len(passRecord.Batches) + 1,
				Count:        len(batchLabels),
				LabelsSHA256: CorpusSHA256(batchLabels),
			}
			schema, err := modelBatchSchema(batchLabels)
			if err != nil {
				return GenerationRecord{}, err
			}
			request, err := modelPrompt(prompt, rubric, calibration, passIndex+1, batchLabels)
			if err != nil {
				return GenerationRecord{}, err
			}
			if len(request) > MaxModelRequestBytes {
				return GenerationRecord{}, fmt.Errorf(
					"model request is %d bytes, above %d",
					len(request),
					MaxModelRequestBytes,
				)
			}
			if len(schema) > MaxModelRequestBytes {
				return GenerationRecord{}, fmt.Errorf(
					"model schema is %d bytes, above %d",
					len(schema),
					MaxModelRequestBytes,
				)
			}

			var validated ModelBatch
			var lastErr error
			for attempt := 1; attempt <= 2; attempt++ {
				if record.TotalAttempts >= MaxModelAttempts {
					return GenerationRecord{}, fmt.Errorf("model attempt limit %d exhausted", MaxModelAttempts)
				}
				if record.TotalUsage.InputTokens >= MaxModelInputTokens ||
					record.TotalUsage.OutputTokens >= MaxModelOutputTokens {
					return GenerationRecord{}, fmt.Errorf("model token budget exhausted before batch")
				}
				record.TotalAttempts++
				batchRecord.Attempts++
				callCtx, cancel := context.WithTimeout(ctx, defaultCallTimeout)
				response, usage, callErr := options.Runner.Generate(callCtx, request, schema)
				cancel()
				if err := usage.Validate(); err != nil {
					return GenerationRecord{}, fmt.Errorf(
						"pass %d batch %d returned invalid token usage: %w",
						passIndex+1,
						batchRecord.Index,
						err,
					)
				}
				record.TotalUsage.add(usage)
				batchRecord.Usage.add(usage)
				if callErr != nil {
					lastErr = callErr
					continue
				}
				if usage.InputTokens == 0 || usage.OutputTokens == 0 {
					lastErr = fmt.Errorf("model completion omitted input or output token usage")
					continue
				}
				if len(response) > MaxModelResponseBytes {
					lastErr = fmt.Errorf(
						"model response is %d bytes, above %d",
						len(response),
						MaxModelResponseBytes,
					)
					continue
				}
				validated, lastErr = DecodeModelBatch(response, batchLabels)
				if lastErr == nil {
					break
				}
			}
			if lastErr != nil {
				return GenerationRecord{}, fmt.Errorf(
					"pass %d batch %d failed closed after %d attempts: %w",
					passIndex+1,
					batchRecord.Index,
					batchRecord.Attempts,
					lastErr,
				)
			}
			if !firstUsageChecked {
				firstUsageChecked = true
				projectedInput := batchRecord.Usage.InputTokens * expectedCalls
				projectedOutput := batchRecord.Usage.OutputTokens * expectedCalls
				if projectedInput > MaxModelInputTokens || projectedOutput > MaxModelOutputTokens {
					return GenerationRecord{}, fmt.Errorf(
						"measured first-batch usage projects to %d input and %d output tokens, above generation limits",
						projectedInput,
						projectedOutput,
					)
				}
			}
			if record.TotalUsage.InputTokens > MaxModelInputTokens ||
				record.TotalUsage.OutputTokens > MaxModelOutputTokens {
				return GenerationRecord{}, fmt.Errorf("model token budget exceeded")
			}
			passItems = append(passItems, validated.Items...)
			passRecord.Batches = append(passRecord.Batches, batchRecord)
		}
		sort.Slice(passItems, func(i, j int) bool {
			return passItems[i].Label < passItems[j].Label
		})
		passBytes, err := encodeModelPass(passItems)
		if err != nil {
			return GenerationRecord{}, err
		}
		passRelative := filepath.ToSlash(filepath.Join(
			"data",
			"ranking",
			"generation",
			fmt.Sprintf("og-v1.pass-%d.jsonl", passIndex+1),
		))
		if err := writeAtomic(filepath.Join(root, filepath.FromSlash(passRelative)), passBytes); err != nil {
			return GenerationRecord{}, err
		}
		passRecord.OutputPath = passRelative
		passRecord.OutputSHA256 = hashBytes(passBytes)
		record.Passes = append(record.Passes, passRecord)
	}

	generationBytes, err := canonicalIndentedJSON(record)
	if err != nil {
		return GenerationRecord{}, fmt.Errorf("encode generation record: %w", err)
	}
	generationPath := filepath.Join(root, "data", "ranking", "og-v1.generation.json")
	if err := writeAtomic(generationPath, generationBytes); err != nil {
		return GenerationRecord{}, err
	}
	return record, nil
}

func modelPrompt(
	prompt []byte,
	rubric []byte,
	calibration Calibration,
	pass int,
	labels []string,
) (string, error) {
	calibrationBytes, err := json.Marshal(calibration.Items)
	if err != nil {
		return "", fmt.Errorf("encode calibration for prompt: %w", err)
	}
	labelBytes, err := json.Marshal(labels)
	if err != nil {
		return "", fmt.Errorf("encode labels for prompt: %w", err)
	}
	return fmt.Sprintf(
		"%s\n\nRUBRIC:\n%s\n\nCALIBRATION_DATA:\n%s\n\nPASS_NUMBER: %d\nLABEL_DATA:\n%s\n",
		bytes.TrimSpace(prompt),
		bytes.TrimSpace(rubric),
		calibrationBytes,
		pass,
		labelBytes,
	), nil
}

func modelBatchSchema(labels []string) ([]byte, error) {
	scoreProperties := map[string]any{
		"recognizability":    integerSchema(MaxRecognizability),
		"memorability":       integerSchema(MaxMemorability),
		"semantic_density":   integerSchema(MaxSemanticDensity),
		"distinctiveness":    integerSchema(MaxDistinctiveness),
		"visual_form":        integerSchema(MaxVisualForm),
		"internet_resonance": integerSchema(MaxInternetResonance),
		"versatility":        integerSchema(MaxVersatility),
		"residue_penalty":    integerSchema(MaxResiduePenalty),
		"confusion_penalty":  integerSchema(MaxConfusionPenalty),
	}
	scoreRequired := []string{
		"recognizability",
		"memorability",
		"semantic_density",
		"distinctiveness",
		"visual_form",
		"internet_resonance",
		"versatility",
		"residue_penalty",
		"confusion_penalty",
	}
	facetValues := make([]string, len(Facets))
	for index, facet := range Facets {
		facetValues[index] = string(facet)
	}
	policyValues := make([]string, len(PolicySignals))
	for index, signal := range PolicySignals {
		policyValues[index] = string(signal)
	}
	schema := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []string{"items"},
		"properties": map[string]any{
			"items": map[string]any{
				"type":     "array",
				"minItems": len(labels),
				"maxItems": len(labels),
				"items": map[string]any{
					"type":                 "object",
					"additionalProperties": false,
					"required":             []string{"label", "scores", "facets", "policy_signal"},
					"properties": map[string]any{
						"label": map[string]any{
							"type": "string",
							"enum": labels,
						},
						"scores": map[string]any{
							"type":                 "object",
							"additionalProperties": false,
							"required":             scoreRequired,
							"properties":           scoreProperties,
						},
						"facets": map[string]any{
							"type":     "array",
							"minItems": 1,
							"maxItems": 3,
							"items": map[string]any{
								"type": "string",
								"enum": facetValues,
							},
						},
						"policy_signal": map[string]any{
							"type": "string",
							"enum": policyValues,
						},
					},
				},
			},
		},
	}
	return json.Marshal(schema)
}

func integerSchema(maximum int) map[string]any {
	return map[string]any{"type": "integer", "minimum": 0, "maximum": maximum}
}

func orderLabels(labels []string, seed string) []string {
	output := append([]string(nil), labels...)
	sort.Slice(output, func(i, j int) bool {
		left := sha256.Sum256([]byte(seed + "\x00" + output[i]))
		right := sha256.Sum256([]byte(seed + "\x00" + output[j]))
		if comparison := bytes.Compare(left[:], right[:]); comparison != 0 {
			return comparison < 0
		}
		return output[i] < output[j]
	})
	return output
}

func encodeModelPass(items []ModelItem) ([]byte, error) {
	var output bytes.Buffer
	for _, item := range items {
		line, err := json.Marshal(item)
		if err != nil {
			return nil, fmt.Errorf("encode model pass label %q: %w", item.Label, err)
		}
		output.Write(line)
		output.WriteByte('\n')
	}
	return output.Bytes(), nil
}

// CodexRunner uses the locally configured Bedrock-backed Codex CLI. It is a
// manual generation adapter and is not imported by any production entrypoint.
type CodexRunner struct {
	Command          string
	RepositoryRoot   string
	ModelID          string
	ModelRevision    string
	ModelComposition string
	InterfaceVersion string
}

func (runner CodexRunner) Identity() ModelIdentity {
	return ModelIdentity{
		Provider:           "amazon-bedrock",
		ModelID:            runner.ModelID,
		ModelRevision:      runner.ModelRevision,
		CatalogComposition: runner.ModelComposition,
		Interface:          "codex-cli",
		InterfaceVersion:   runner.InterfaceVersion,
	}
}

func (runner CodexRunner) Generate(
	ctx context.Context,
	prompt string,
	schema []byte,
) ([]byte, TokenUsage, error) {
	if len(prompt) > MaxModelRequestBytes {
		return nil, TokenUsage{}, fmt.Errorf(
			"model request is %d bytes, above %d",
			len(prompt),
			MaxModelRequestBytes,
		)
	}
	if len(schema) > MaxModelRequestBytes {
		return nil, TokenUsage{}, fmt.Errorf(
			"model schema is %d bytes, above %d",
			len(schema),
			MaxModelRequestBytes,
		)
	}
	workRoot := filepath.Join(runner.RepositoryRoot, "data", "ranking", "work")
	if err := os.MkdirAll(workRoot, 0o700); err != nil {
		return nil, TokenUsage{}, fmt.Errorf("create model work directory: %w", err)
	}
	temporary, err := os.MkdirTemp(workRoot, "call-")
	if err != nil {
		return nil, TokenUsage{}, fmt.Errorf("create model call directory: %w", err)
	}
	defer os.RemoveAll(temporary)
	schemaPath := filepath.Join(temporary, "schema.json")
	if err := os.WriteFile(schemaPath, schema, 0o600); err != nil {
		return nil, TokenUsage{}, fmt.Errorf("write model schema: %w", err)
	}

	command := runner.Command
	if command == "" {
		command = "codex"
	}
	args := []string{
		"exec",
		"--ephemeral",
		"--ignore-rules",
		"-s", "read-only",
		"-m", runner.ModelID,
		"-c", `model_reasoning_effort="low"`,
		"-c", "temperature=0",
		"--output-schema", schemaPath,
		"--json",
		"-",
	}
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = runner.RepositoryRoot
	cmd.Stdin = strings.NewReader(prompt)
	stdout := &boundedBuffer{Limit: MaxModelEventBytes}
	stderr := &boundedBuffer{Limit: 64 * 1024}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, TokenUsage{}, fmt.Errorf("model call exceeded %s", defaultCallTimeout)
		}
		if stdout.Truncated {
			return nil, TokenUsage{}, fmt.Errorf("model event stream exceeded %d bytes", MaxModelEventBytes)
		}
		usage, diagnostic := decodeCodexFailure(stdout.Bytes())
		if diagnostic == "" {
			diagnostic = redactProviderError(stderr.String())
		}
		return nil, usage, fmt.Errorf("model command failed: %s", diagnostic)
	}
	if stdout.Truncated {
		return nil, TokenUsage{}, fmt.Errorf("model event stream exceeded %d bytes", MaxModelEventBytes)
	}
	return decodeCodexEvents(stdout.Bytes())
}

type codexEvent struct {
	Type string `json:"type"`
	Item struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"item"`
	Usage TokenUsage `json:"usage"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
	Message string `json:"message"`
}

func decodeCodexEvents(payload []byte) ([]byte, TokenUsage, error) {
	scanner := bufio.NewScanner(bytes.NewReader(payload))
	scanner.Buffer(make([]byte, 64*1024), MaxModelResponseBytes*2)
	var response []byte
	var usage TokenUsage
	completed := false
	for scanner.Scan() {
		var event codexEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return nil, TokenUsage{}, fmt.Errorf("decode model event: %w", err)
		}
		switch event.Type {
		case "item.completed":
			if event.Item.Type == "agent_message" {
				if response != nil {
					return nil, TokenUsage{}, fmt.Errorf("model emitted more than one final message")
				}
				response = []byte(event.Item.Text)
			}
		case "turn.completed":
			if completed {
				return nil, TokenUsage{}, fmt.Errorf("model emitted more than one completion record")
			}
			completed = true
			usage = event.Usage
		case "error":
			return nil, TokenUsage{}, fmt.Errorf("model provider error: %s", redactProviderError(event.Message))
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, TokenUsage{}, fmt.Errorf("read model events: %w", err)
	}
	if response == nil {
		return nil, TokenUsage{}, fmt.Errorf("model emitted no final message")
	}
	if !completed {
		return nil, TokenUsage{}, fmt.Errorf("model emitted no completion usage")
	}
	if len(response) > MaxModelResponseBytes {
		return nil, TokenUsage{}, fmt.Errorf(
			"model final message is %d bytes, above %d",
			len(response),
			MaxModelResponseBytes,
		)
	}
	return response, usage, nil
}

func decodeCodexFailure(payload []byte) (TokenUsage, string) {
	scanner := bufio.NewScanner(bytes.NewReader(payload))
	scanner.Buffer(make([]byte, 64*1024), MaxModelEventBytes)
	var usage TokenUsage
	var diagnostic string
	for scanner.Scan() {
		var event codexEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			continue
		}
		if event.Type == "turn.completed" {
			usage = event.Usage
		}
		if event.Type != "error" && event.Type != "turn.failed" {
			continue
		}
		message := event.Message
		if message == "" {
			message = event.Error.Message
		}
		if message != "" {
			diagnostic = redactProviderError(message)
		}
	}
	return usage, diagnostic
}

type boundedBuffer struct {
	Buffer    bytes.Buffer
	Limit     int
	Truncated bool
}

func (buffer *boundedBuffer) Write(payload []byte) (int, error) {
	remaining := buffer.Limit - buffer.Buffer.Len()
	if remaining > 0 {
		write := payload
		if len(write) > remaining {
			write = write[:remaining]
			buffer.Truncated = true
		}
		_, _ = buffer.Buffer.Write(write)
	} else if len(payload) > 0 {
		buffer.Truncated = true
	}
	return len(payload), nil
}

func (buffer *boundedBuffer) Bytes() []byte {
	return buffer.Buffer.Bytes()
}

func (buffer *boundedBuffer) String() string {
	return buffer.Buffer.String()
}

var requestIDPattern = regexp.MustCompile(`\breq_[a-zA-Z0-9]+\b`)
var providerURLPattern = regexp.MustCompile(`https?://[^\s,]+`)
var awsAccountPattern = regexp.MustCompile(`\b[0-9]{12}\b`)
var awsAccessKeyPattern = regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`)
var awsARNPattern = regexp.MustCompile(`\barn:aws(?:-[a-z]+)?:[^\s,]+`)

func redactProviderError(message string) string {
	message = requestIDPattern.ReplaceAllString(message, "[request-id]")
	message = providerURLPattern.ReplaceAllString(message, "[provider-url]")
	message = awsAccountPattern.ReplaceAllString(message, "[account-id]")
	message = awsAccessKeyPattern.ReplaceAllString(message, "[access-key]")
	message = awsARNPattern.ReplaceAllString(message, "[aws-arn]")
	message = strings.TrimSpace(message)
	if message == "" {
		return "provider returned no diagnostic"
	}
	return message
}

func LoadGenerationRecord(repositoryRoot string) (GenerationRecord, []byte, error) {
	path := filepath.Join(repositoryRoot, "data", "ranking", "og-v1.generation.json")
	payload, err := os.ReadFile(path)
	if err != nil {
		return GenerationRecord{}, nil, fmt.Errorf("read generation record: %w", err)
	}
	var record GenerationRecord
	if err := decodeClosedJSON(payload, &record); err != nil {
		return GenerationRecord{}, nil, fmt.Errorf("decode generation record: %w", err)
	}
	if err := record.Validate(repositoryRoot); err != nil {
		return GenerationRecord{}, nil, err
	}
	return record, payload, nil
}

func (record GenerationRecord) Validate(repositoryRoot string) error {
	if record.FormatVersion != GenerationFormatVersion {
		return fmt.Errorf(
			"generation format_version is %d, want %d",
			record.FormatVersion,
			GenerationFormatVersion,
		)
	}
	generatedAt, err := time.Parse(time.RFC3339, record.GeneratedAt)
	if err != nil {
		return fmt.Errorf("generation generated_at is not RFC3339: %w", err)
	}
	if generatedAt.UTC().Truncate(time.Second).Format(time.RFC3339) != record.GeneratedAt {
		return fmt.Errorf("generation generated_at is not canonical UTC whole-second RFC3339")
	}
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(record.GeneratorCommit) {
		return fmt.Errorf("generation generator_commit is not a full lowercase Git SHA")
	}
	if record.CorpusCount < 1 || len(record.CorpusSHA256) != 64 {
		return fmt.Errorf("generation corpus reference is invalid")
	}
	if record.RubricVersion != RubricVersion || record.PromptVersion != PromptVersion {
		return fmt.Errorf("generation rubric or prompt version is unsupported")
	}
	for _, digest := range []string{
		record.RubricSHA256,
		record.PromptSHA256,
		record.CalibrationSHA256,
		record.CandidatesSHA256,
	} {
		if !validSHA256(digest) {
			return fmt.Errorf("generation contains an invalid SHA-256")
		}
	}
	if err := validateModelIdentity(record.Model); err != nil {
		return err
	}
	settings := record.Settings
	if settings.Temperature != 0 ||
		settings.ReasoningEffort != defaultReasoningEffort ||
		settings.RunsPerLabel != DefaultPasses ||
		settings.CandidateCount != DefaultCandidateCount ||
		settings.BatchSize != DefaultBatchSize ||
		settings.MaxAttempts != MaxModelAttempts ||
		settings.MaxInputTokens != MaxModelInputTokens ||
		settings.MaxOutputTokens != MaxModelOutputTokens ||
		settings.MaxRequestBytes != MaxModelRequestBytes ||
		settings.MaxResponseBytes != MaxModelResponseBytes ||
		settings.MaxEventBytes != MaxModelEventBytes ||
		settings.CallTimeoutSeconds != int(defaultCallTimeout/time.Second) {
		return fmt.Errorf("generation settings do not match the repository bounds")
	}
	minimumAttempts := DefaultPasses * ((DefaultCandidateCount + DefaultBatchSize - 1) / DefaultBatchSize)
	if record.TotalAttempts < minimumAttempts || record.TotalAttempts > MaxModelAttempts {
		return fmt.Errorf("generation attempts %d are outside the configured bounds", record.TotalAttempts)
	}
	if err := record.TotalUsage.Validate(); err != nil {
		return fmt.Errorf("generation total usage: %w", err)
	}
	if record.TotalUsage.InputTokens > MaxModelInputTokens ||
		record.TotalUsage.OutputTokens > MaxModelOutputTokens {
		return fmt.Errorf("generation token usage exceeds the configured bounds")
	}
	if record.CandidatesPath != "data/ranking/og-v1.candidates.json" {
		return fmt.Errorf("generation candidates path is not canonical")
	}
	candidatePayload, err := os.ReadFile(filepath.Join(repositoryRoot, filepath.FromSlash(record.CandidatesPath)))
	if err != nil {
		return fmt.Errorf("read generation candidates: %w", err)
	}
	if hashBytes(candidatePayload) != record.CandidatesSHA256 {
		return fmt.Errorf("generation candidates checksum mismatch")
	}
	var candidates CandidateArtifact
	if err := decodeClosedJSON(candidatePayload, &candidates); err != nil {
		return fmt.Errorf("decode generation candidates: %w", err)
	}
	if err := candidates.Validate(); err != nil {
		return err
	}
	if candidates.CorpusCount != record.CorpusCount ||
		candidates.CorpusSHA256 != record.CorpusSHA256 ||
		candidates.RubricVersion != record.RubricVersion {
		return fmt.Errorf("generation candidates do not match the generation inputs")
	}
	candidateLabels := make([]string, len(candidates.Items))
	for index, candidate := range candidates.Items {
		candidateLabels[index] = candidate.Label
	}
	if len(record.Passes) != DefaultPasses {
		return fmt.Errorf("generation contains %d passes, want %d", len(record.Passes), DefaultPasses)
	}
	var summedUsage TokenUsage
	summedAttempts := 0
	for passIndex, pass := range record.Passes {
		if pass.Index != passIndex+1 || pass.OrderingSeed != orderingSeeds[passIndex] {
			return fmt.Errorf("generation pass %d identity is not canonical", passIndex+1)
		}
		expectedOrder := orderLabels(candidateLabels, orderingSeeds[passIndex])
		expectedBatchCount := (len(expectedOrder) + DefaultBatchSize - 1) / DefaultBatchSize
		if len(pass.Batches) != expectedBatchCount {
			return fmt.Errorf("generation pass %d has the wrong batch count", passIndex+1)
		}
		for batchIndex, batch := range pass.Batches {
			start := batchIndex * DefaultBatchSize
			end := start + DefaultBatchSize
			if end > len(expectedOrder) {
				end = len(expectedOrder)
			}
			expectedLabels := expectedOrder[start:end]
			if batch.Index != batchIndex+1 ||
				batch.Count != len(expectedLabels) ||
				batch.LabelsSHA256 != CorpusSHA256(expectedLabels) {
				return fmt.Errorf(
					"generation pass %d batch %d order record is not canonical",
					passIndex+1,
					batchIndex+1,
				)
			}
			if batch.Attempts < 1 || batch.Attempts > 2 {
				return fmt.Errorf(
					"generation pass %d batch %d attempts are outside 1..2",
					passIndex+1,
					batchIndex+1,
				)
			}
			if err := batch.Usage.Validate(); err != nil {
				return fmt.Errorf(
					"generation pass %d batch %d usage: %w",
					passIndex+1,
					batchIndex+1,
					err,
				)
			}
			if batch.Usage.InputTokens == 0 || batch.Usage.OutputTokens == 0 {
				return fmt.Errorf(
					"generation pass %d batch %d has incomplete token usage",
					passIndex+1,
					batchIndex+1,
				)
			}
			summedAttempts += batch.Attempts
			summedUsage.add(batch.Usage)
		}
		if !validSHA256(pass.OutputSHA256) {
			return fmt.Errorf("generation pass %d has an invalid output SHA-256", passIndex+1)
		}
		expectedPath := fmt.Sprintf("data/ranking/generation/og-v1.pass-%d.jsonl", passIndex+1)
		if pass.OutputPath != expectedPath {
			return fmt.Errorf("generation pass %d output path is not canonical", passIndex+1)
		}
		path := filepath.Join(repositoryRoot, filepath.FromSlash(pass.OutputPath))
		payload, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read generation pass %d: %w", passIndex+1, err)
		}
		if hashBytes(payload) != pass.OutputSHA256 {
			return fmt.Errorf("generation pass %d checksum mismatch", passIndex+1)
		}
		if _, err := loadModelPass(repositoryRoot, pass, candidateLabels); err != nil {
			return err
		}
	}
	if summedAttempts != record.TotalAttempts {
		return fmt.Errorf(
			"generation total attempts %d do not match batch total %d",
			record.TotalAttempts,
			summedAttempts,
		)
	}
	if summedUsage != record.TotalUsage {
		return fmt.Errorf("generation total usage does not match batch totals")
	}
	return nil
}

func (usage TokenUsage) Validate() error {
	values := []struct {
		name  string
		value int
	}{
		{"input_tokens", usage.InputTokens},
		{"cached_input_tokens", usage.CachedInputTokens},
		{"cache_write_input_tokens", usage.CacheWriteInputTokens},
		{"output_tokens", usage.OutputTokens},
		{"reasoning_output_tokens", usage.ReasoningOutputTokens},
	}
	for _, field := range values {
		if field.value < 0 {
			return fmt.Errorf("%s is negative", field.name)
		}
	}
	return nil
}

func validateModelIdentity(identity ModelIdentity) error {
	if identity.Provider != "amazon-bedrock" ||
		strings.TrimSpace(identity.ModelID) == "" ||
		strings.TrimSpace(identity.ModelRevision) == "" ||
		strings.TrimSpace(identity.CatalogComposition) == "" ||
		identity.Interface != "codex-cli" ||
		strings.TrimSpace(identity.InterfaceVersion) == "" {
		return fmt.Errorf("generation model identity is incomplete")
	}
	for _, value := range []string{
		identity.ModelID,
		identity.ModelRevision,
		identity.CatalogComposition,
		identity.InterfaceVersion,
	} {
		if len(value) > 200 || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("generation model identity contains an invalid value")
		}
	}
	return nil
}

func (artifact CandidateArtifact) Validate() error {
	if artifact.FormatVersion != CandidateFormatVersion {
		return fmt.Errorf(
			"candidate format_version is %d, want %d",
			artifact.FormatVersion,
			CandidateFormatVersion,
		)
	}
	if artifact.CorpusCount < artifact.Count ||
		!validSHA256(artifact.CorpusSHA256) ||
		artifact.RubricVersion != RubricVersion ||
		artifact.Count != DefaultCandidateCount ||
		len(artifact.Items) != artifact.Count {
		return fmt.Errorf("candidate artifact metadata is invalid")
	}
	previous := ""
	for index, candidate := range artifact.Items {
		if err := ValidateCanonicalLabel(candidate.Label); err != nil {
			return fmt.Errorf("candidate %d: %w", index, err)
		}
		if index > 0 && candidate.Label <= previous {
			return fmt.Errorf("candidate artifact is not strictly label-sorted")
		}
		if candidate.BaselineScore < 0 || candidate.BaselineScore > 1000 {
			return fmt.Errorf("candidate %q baseline score is outside 0..1000", candidate.Label)
		}
		previous = candidate.Label
	}
	return nil
}

func loadModelPass(repositoryRoot string, pass GeneratedPassRecord, expected []string) ([]ModelItem, error) {
	path := filepath.Join(repositoryRoot, filepath.FromSlash(pass.OutputPath))
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open model pass %d: %w", pass.Index, err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), MaxModelResponseBytes)
	var items []ModelItem
	for scanner.Scan() {
		var raw rawModelItem
		if err := decodeClosedJSON(scanner.Bytes(), &raw); err != nil {
			return nil, fmt.Errorf("decode model pass %d line %d: %w", pass.Index, len(items)+1, err)
		}
		item, err := raw.item()
		if err != nil {
			return nil, fmt.Errorf("model pass %d line %d: %w", pass.Index, len(items)+1, err)
		}
		items = append(items, item)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read model pass %d: %w", pass.Index, err)
	}
	labels := make([]string, len(items))
	for index, item := range items {
		labels[index] = item.Label
	}
	if !sort.StringsAreSorted(labels) {
		return nil, fmt.Errorf("model pass %d is not label-sorted", pass.Index)
	}
	if !equalStrings(labels, expected) {
		return nil, fmt.Errorf("model pass %d does not exactly cover candidates", pass.Index)
	}
	return items, nil
}

func canonicalIndentedJSON(value any) ([]byte, error) {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(payload, '\n'), nil
}

func writeAtomic(path string, payload []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create directory for %s: %w", path, err)
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, payload, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", temporary, err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}

func hashBytes(payload []byte) string {
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

func copyStrings(values []string) []string {
	return append([]string(nil), values...)
}

var _ io.Writer = (*boundedBuffer)(nil)
