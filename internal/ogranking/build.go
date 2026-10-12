package ogranking

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	reviewPath              = "data/ranking/og-v1.review.jsonl"
	manifestPath            = "data/ranking/og-v1.manifest.json"
	headPath                = "data/ranking/og-v1.head.md"
	allowlistPath           = "data/ranking/featured-safe-v1.json"
	selectorFixturePath     = "data/ranking/featured-safe-v1.fixture.json"
	browserRankPath         = "web/public/data/og-rank-v1.json"
	browserAllowlistPath    = "web/src/data/featured-safe-v1.json"
	browserProvenancePath   = "web/src/data/featured-ranking-provenance-v1.json"
	browserArtifactVersion  = "og-rank-v1"
	browserEditorialMethod  = "Global OG score + diversity"
	browserProvenanceFormat = 1
)

// Artifact is one deterministic file derived from the corpus, validated model
// passes, and reviewed decisions.
type Artifact struct {
	Path  string
	Bytes []byte
}

type rankedRecord struct {
	Label             string
	Scores            Scores
	Score             int
	Facets            []Facet
	FacetBits         int
	Eligibility       Eligibility
	PolicyReasons     []string
	ModelRunScores    []int
	ModelPolicySignal PolicySignal
	Decision          *ReviewDecision
	AppliedOverride   *AppliedOverride
}

type corpusReference struct {
	Count  int    `json:"count"`
	SHA256 string `json:"sha256"`
}

type versionedReference struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

type manifestReview struct {
	Reviewer                 string   `json:"reviewer"`
	ReviewedAt               string   `json:"reviewed_at"`
	ReviewedHeadCount        int      `json:"reviewed_head_count"`
	DecisionCount            int      `json:"decision_count"`
	FeatureableCount         int      `json:"featureable_count"`
	DeterministicPolicyCount int      `json:"deterministic_policy_count"`
	ModelPolicySignalCount   int      `json:"model_policy_signal_count"`
	DecisionsSHA256          string   `json:"decisions_sha256"`
	Scope                    []string `json:"scope"`
}

type Manifest struct {
	FormatVersion          int                   `json:"format_version"`
	Corpus                 corpusReference       `json:"corpus"`
	Rubric                 versionedReference    `json:"rubric"`
	PolicyVersion          string                `json:"policy_version"`
	Prompt                 versionedReference    `json:"prompt"`
	CalibrationSHA256      string                `json:"calibration_sha256"`
	Model                  ModelIdentity         `json:"model"`
	GenerationSettings     GenerationSettings    `json:"generation_settings"`
	GenerationPasses       []GeneratedPassRecord `json:"generation_passes"`
	GenerationRecordSHA256 string                `json:"generation_record_sha256"`
	GeneratedAt            string                `json:"generated_at"`
	GeneratorCommit        string                `json:"generator_commit"`
	Review                 manifestReview        `json:"review"`
}

type CompactRank struct {
	FormatVersion           int             `json:"format_version"`
	Corpus                  corpusReference `json:"corpus"`
	RubricVersion           string          `json:"rubric_version"`
	PolicyVersion           string          `json:"policy_version"`
	GeneratorManifestSHA256 string          `json:"generator_manifest_sha256"`
	Items                   [][]any         `json:"items"`
}

type FeatureAllowlist struct {
	FormatVersion           int             `json:"format_version"`
	Corpus                  corpusReference `json:"corpus"`
	PolicyVersion           string          `json:"policy_version"`
	GeneratorManifestSHA256 string          `json:"generator_manifest_sha256"`
	Labels                  []string        `json:"labels"`
}

type SelectorFixture struct {
	FormatVersion           int      `json:"format_version"`
	GeneratorManifestSHA256 string   `json:"generator_manifest_sha256"`
	Labels                  []string `json:"labels"`
}

type browserModelProvenance struct {
	Provider      string `json:"provider"`
	ModelID       string `json:"model_id"`
	ModelRevision string `json:"model_revision"`
	GeneratedAt   string `json:"generated_at"`
	RunsPerLabel  int    `json:"runs_per_label"`
}

type browserReviewProvenance struct {
	ReviewedAt string   `json:"reviewed_at"`
	HeadCount  int      `json:"head_count"`
	Scope      []string `json:"scope"`
}

// BrowserProvenance is the deliberately small, public subset of the generation
// manifest used by the website's Data drawer. It excludes provider envelopes,
// request metadata, usage, reviewer identity, generator paths, and credentials.
type BrowserProvenance struct {
	FormatVersion           int                     `json:"format_version"`
	Method                  string                  `json:"method"`
	ArtifactVersion         string                  `json:"artifact_version"`
	Corpus                  corpusReference         `json:"corpus"`
	RubricVersion           string                  `json:"rubric_version"`
	PolicyVersion           string                  `json:"policy_version"`
	GeneratorManifestSHA256 string                  `json:"generator_manifest_sha256"`
	PromptSHA256            string                  `json:"prompt_sha256"`
	Model                   browserModelProvenance  `json:"model"`
	Review                  browserReviewProvenance `json:"review"`
}

type reviewHeader struct {
	FormatVersion    int             `json:"format_version"`
	RecordFormat     string          `json:"record_format"`
	Fields           []string        `json:"fields"`
	ScoreFields      []string        `json:"score_fields"`
	Corpus           corpusReference `json:"corpus"`
	RubricVersion    string          `json:"rubric_version"`
	PolicyVersion    string          `json:"policy_version"`
	GenerationSHA256 string          `json:"generation_sha256"`
}

type reviewOverride struct {
	EligibilityReason string         `json:"eligibility_reason"`
	Note              string         `json:"note"`
	Reviewer          string         `json:"reviewer"`
	ReviewedAt        string         `json:"reviewed_at"`
	Score             *ScoreOverride `json:"score_override"`
}

// BuildArtifacts validates every source and returns the exact committed
// derived files without writing them.
func BuildArtifacts(repositoryRoot string) ([]Artifact, error) {
	inputs, err := loadRankingInputs(repositoryRoot)
	if err != nil {
		return nil, err
	}
	root := inputs.Root
	corpus := inputs.Corpus
	corpusSet := labelSet(corpus.Labels)
	generation := inputs.Generation
	generationBytes := inputs.GenerationBytes
	rubric := inputs.RubricBytes
	prompt := inputs.PromptBytes
	calibrationBytes := inputs.CalibrationBytes
	aggregated := inputs.Aggregated

	decisions, decisionBytes, err := LoadReviewDecisions(root)
	if err != nil {
		return nil, err
	}
	decisionsByLabel, err := decisionMap(decisions, corpusSet)
	if err != nil {
		return nil, err
	}
	records, err := buildRecords(corpus, aggregated, decisions, decisionsByLabel)
	if err != nil {
		return nil, err
	}
	if err := validateReviewScope(records, decisionsByLabel, decisions.ReviewedHeadCount); err != nil {
		return nil, err
	}

	eligibilityCounts := make(map[Eligibility]int, len(Eligibilities))
	deterministicPolicyCount := 0
	modelPolicyCount := 0
	var allowlisted []string
	for _, record := range records {
		eligibilityCounts[record.Eligibility]++
		if _, _, ok := DeterministicPolicy(record.Label); ok {
			deterministicPolicyCount++
		}
		if record.ModelPolicySignal != "" &&
			record.ModelPolicySignal != PolicyNone {
			modelPolicyCount++
		}
		if record.Eligibility == EligibilityFeatureable {
			allowlisted = append(allowlisted, record.Label)
		}
	}
	sort.Strings(allowlisted)
	if len(allowlisted) == 0 {
		return nil, fmt.Errorf("review produced an empty feature-safe allowlist")
	}

	manifest := Manifest{
		FormatVersion:          ManifestFormatVersion,
		Corpus:                 corpusReference{Count: len(corpus.Labels), SHA256: corpus.SHA256},
		Rubric:                 versionedReference{Version: RubricVersion, SHA256: hashBytes(rubric)},
		PolicyVersion:          PolicyVersion,
		Prompt:                 versionedReference{Version: PromptVersion, SHA256: hashBytes(prompt)},
		CalibrationSHA256:      hashBytes(calibrationBytes),
		Model:                  generation.Model,
		GenerationSettings:     generation.Settings,
		GenerationPasses:       generation.Passes,
		GenerationRecordSHA256: hashBytes(generationBytes),
		GeneratedAt:            generation.GeneratedAt,
		GeneratorCommit:        generation.GeneratorCommit,
		Review: manifestReview{
			Reviewer:                 decisions.Reviewer,
			ReviewedAt:               decisions.ReviewedAt,
			ReviewedHeadCount:        decisions.ReviewedHeadCount,
			DecisionCount:            len(decisions.Decisions),
			FeatureableCount:         len(allowlisted),
			DeterministicPolicyCount: deterministicPolicyCount,
			ModelPolicySignalCount:   modelPolicyCount,
			DecisionsSHA256:          hashBytes(decisionBytes),
			Scope: []string{
				"ranked head",
				"all deterministic policy findings",
				"all model policy signals",
				"all feature-safe labels",
			},
		},
	}
	manifestBytes, err := canonicalIndentedJSON(manifest)
	if err != nil {
		return nil, fmt.Errorf("encode manifest: %w", err)
	}
	manifestSHA := hashBytes(manifestBytes)
	browserProvenanceBytes, err := canonicalIndentedJSON(BrowserProvenance{
		FormatVersion:           browserProvenanceFormat,
		Method:                  browserEditorialMethod,
		ArtifactVersion:         browserArtifactVersion,
		Corpus:                  manifest.Corpus,
		RubricVersion:           manifest.Rubric.Version,
		PolicyVersion:           manifest.PolicyVersion,
		GeneratorManifestSHA256: manifestSHA,
		PromptSHA256:            manifest.Prompt.SHA256,
		Model: browserModelProvenance{
			Provider:      manifest.Model.Provider,
			ModelID:       manifest.Model.ModelID,
			ModelRevision: manifest.Model.ModelRevision,
			GeneratedAt:   manifest.GeneratedAt,
			RunsPerLabel:  manifest.GenerationSettings.RunsPerLabel,
		},
		Review: browserReviewProvenance{
			ReviewedAt: manifest.Review.ReviewedAt,
			HeadCount:  manifest.Review.ReviewedHeadCount,
			Scope:      append([]string(nil), manifest.Review.Scope...),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("encode browser provenance: %w", err)
	}

	reviewBytes, err := encodeReviewSource(records, corpus, generationBytes)
	if err != nil {
		return nil, err
	}
	ranked := rankRecords(records)
	compactBytes, err := encodeCompactRank(ranked, corpus, manifestSHA)
	if err != nil {
		return nil, err
	}
	allowlistBytes, err := canonicalIndentedJSON(FeatureAllowlist{
		FormatVersion:           AllowlistFormatVersion,
		Corpus:                  corpusReference{Count: len(corpus.Labels), SHA256: corpus.SHA256},
		PolicyVersion:           PolicyVersion,
		GeneratorManifestSHA256: manifestSHA,
		Labels:                  allowlisted,
	})
	if err != nil {
		return nil, fmt.Errorf("encode allowlist: %w", err)
	}
	fixtureLabels := featureableRankedLabels(ranked, 12)
	if len(fixtureLabels) < 12 {
		return nil, fmt.Errorf("feature-safe allowlist has fewer than 12 ranked labels")
	}
	fixtureBytes, err := canonicalIndentedJSON(SelectorFixture{
		FormatVersion:           1,
		GeneratorManifestSHA256: manifestSHA,
		Labels:                  fixtureLabels,
	})
	if err != nil {
		return nil, fmt.Errorf("encode selector fixture: %w", err)
	}
	headBytes := encodeHeadReport(
		ranked,
		eligibilityCounts,
		allowlisted,
		decisions,
		corpus,
		generation,
		manifestSHA,
	)

	return []Artifact{
		{Path: reviewPath, Bytes: reviewBytes},
		{Path: manifestPath, Bytes: manifestBytes},
		{Path: headPath, Bytes: headBytes},
		{Path: allowlistPath, Bytes: allowlistBytes},
		{Path: selectorFixturePath, Bytes: fixtureBytes},
		{Path: browserRankPath, Bytes: compactBytes},
		{Path: browserAllowlistPath, Bytes: allowlistBytes},
		{Path: browserProvenancePath, Bytes: browserProvenanceBytes},
	}, nil
}

func buildRecords(
	corpus Corpus,
	aggregated map[string]AggregatedModel,
	decisions ReviewDecisions,
	decisionsByLabel map[string]ReviewDecision,
) ([]rankedRecord, error) {
	records := make([]rankedRecord, 0, len(corpus.Labels))
	for _, label := range corpus.Labels {
		scores := BaselineScores(label)
		score, err := FinalScore(scores)
		if err != nil {
			return nil, fmt.Errorf("baseline label %q: %w", label, err)
		}
		facets := BaselineFacets(label)
		modelSignal := PolicySignal("")
		var runScores []int
		if model, ok := aggregated[label]; ok {
			scores = model.Scores
			score = model.Score
			facets = copyFacets(model.Facets)
			modelSignal = model.PolicySignal
			runScores = append([]int(nil), model.ModelRunScores...)
		}
		decision, hasDecision := decisionsByLabel[label]
		var decisionPointer *ReviewDecision
		if hasDecision {
			decisionPointer = &decision
			if decision.ScoreOverride != nil {
				if decision.ScoreOverride.From != score {
					return nil, fmt.Errorf(
						"score override for %q expects %d but calculated score is %d",
						label,
						decision.ScoreOverride.From,
						score,
					)
				}
				score = decision.ScoreOverride.To
			}
		}
		eligibility, reasons, applied, err := applyEligibility(
			label,
			modelSignal,
			decisionPointer,
			decisions.Reviewer,
			decisions.ReviewedAt,
		)
		if err != nil {
			return nil, err
		}
		bits, err := FacetBits(facets)
		if err != nil {
			return nil, fmt.Errorf("label %q: %w", label, err)
		}
		if score < 0 || score > 1000 {
			return nil, fmt.Errorf("label %q final score %d is outside 0..1000", label, score)
		}
		if eligibility == EligibilityFeatureable {
			if _, modelReviewed := aggregated[label]; !modelReviewed {
				return nil, fmt.Errorf("featureable label %q is outside the model-reviewed candidate set", label)
			}
		}
		records = append(records, rankedRecord{
			Label:             label,
			Scores:            scores,
			Score:             score,
			Facets:            facets,
			FacetBits:         bits,
			Eligibility:       eligibility,
			PolicyReasons:     reasons,
			ModelRunScores:    runScores,
			ModelPolicySignal: modelSignal,
			Decision:          decisionPointer,
			AppliedOverride:   applied,
		})
	}
	return records, nil
}

func validateReviewScope(
	records []rankedRecord,
	decisions map[string]ReviewDecision,
	headCount int,
) error {
	ranked := rankRecords(records)
	if headCount > len(ranked) {
		return fmt.Errorf("reviewed_head_count %d exceeds corpus size", headCount)
	}
	for _, record := range ranked[:headCount] {
		if _, ok := decisions[record.Label]; !ok {
			return fmt.Errorf("ranked-head label %q has no explicit review decision", record.Label)
		}
	}
	for _, record := range records {
		if _, _, deterministic := DeterministicPolicy(record.Label); deterministic {
			if _, ok := decisions[record.Label]; !ok {
				return fmt.Errorf("deterministic policy label %q has no explicit review decision", record.Label)
			}
		}
		if record.ModelPolicySignal != "" &&
			record.ModelPolicySignal != PolicyNone {
			if _, ok := decisions[record.Label]; !ok {
				return fmt.Errorf("model policy label %q has no explicit review decision", record.Label)
			}
		}
		if record.Eligibility == EligibilityFeatureable {
			decision, ok := decisions[record.Label]
			if !ok || decision.Eligibility != EligibilityFeatureable {
				return fmt.Errorf("featureable label %q lacks its reviewed allowlist decision", record.Label)
			}
		}
	}
	return nil
}

func rankRecords(records []rankedRecord) []rankedRecord {
	ranked := append([]rankedRecord(nil), records...)
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].Score != ranked[j].Score {
			return ranked[i].Score > ranked[j].Score
		}
		return ranked[i].Label < ranked[j].Label
	})
	return ranked
}

func encodeReviewSource(records []rankedRecord, corpus Corpus, generation []byte) ([]byte, error) {
	var output bytes.Buffer
	header := reviewHeader{
		FormatVersion: ReviewFormatVersion,
		RecordFormat:  "tuple",
		Fields: []string{
			"label",
			"scores",
			"score",
			"facet_bits",
			"eligibility",
			"policy_reasons",
			"model_run_scores",
			"model_policy_signal",
			"override",
		},
		ScoreFields: []string{
			"recognizability",
			"memorability",
			"semantic_density",
			"distinctiveness",
			"visual_form",
			"internet_resonance",
			"versatility",
			"residue_penalty",
			"confusion_penalty",
		},
		Corpus:           corpusReference{Count: len(corpus.Labels), SHA256: corpus.SHA256},
		RubricVersion:    RubricVersion,
		PolicyVersion:    PolicyVersion,
		GenerationSHA256: hashBytes(generation),
	}
	headerBytes, err := json.Marshal(header)
	if err != nil {
		return nil, fmt.Errorf("encode review header: %w", err)
	}
	output.Write(headerBytes)
	output.WriteByte('\n')
	for _, record := range records {
		var modelSignal any
		if record.ModelPolicySignal != "" {
			modelSignal = record.ModelPolicySignal
		}
		var override any
		if record.Decision != nil {
			override = reviewOverride{
				EligibilityReason: record.Decision.ReasonCode,
				Note:              record.Decision.Note,
				Reviewer:          record.AppliedOverride.Reviewer,
				ReviewedAt:        record.AppliedOverride.ReviewedAt,
				Score:             record.Decision.ScoreOverride,
			}
		}
		tuple := []any{
			record.Label,
			record.Scores.Values(),
			record.Score,
			record.FacetBits,
			record.Eligibility,
			record.PolicyReasons,
			record.ModelRunScores,
			modelSignal,
			override,
		}
		line, err := json.Marshal(tuple)
		if err != nil {
			return nil, fmt.Errorf("encode review label %q: %w", record.Label, err)
		}
		output.Write(line)
		output.WriteByte('\n')
	}
	return output.Bytes(), nil
}

func encodeCompactRank(ranked []rankedRecord, corpus Corpus, manifestSHA string) ([]byte, error) {
	items := make([][]any, len(ranked))
	for index, record := range ranked {
		if record.FacetBits <= 0 || record.FacetBits&^KnownFacetBits != 0 {
			return nil, fmt.Errorf("label %q has invalid facet bits %d", record.Label, record.FacetBits)
		}
		items[index] = []any{record.Label, record.Score, record.FacetBits, 0}
	}
	payload, err := json.Marshal(CompactRank{
		FormatVersion:           CompactFormatVersion,
		Corpus:                  corpusReference{Count: len(corpus.Labels), SHA256: corpus.SHA256},
		RubricVersion:           RubricVersion,
		PolicyVersion:           PolicyVersion,
		GeneratorManifestSHA256: manifestSHA,
		Items:                   items,
	})
	if err != nil {
		return nil, fmt.Errorf("encode compact rank: %w", err)
	}
	return append(payload, '\n'), nil
}

func featureableRankedLabels(ranked []rankedRecord, limit int) []string {
	var labels []string
	for _, record := range ranked {
		if record.Eligibility != EligibilityFeatureable {
			continue
		}
		labels = append(labels, record.Label)
		if len(labels) == limit {
			break
		}
	}
	return labels
}

func encodeHeadReport(
	ranked []rankedRecord,
	counts map[Eligibility]int,
	allowlisted []string,
	decisions ReviewDecisions,
	corpus Corpus,
	generation GenerationRecord,
	manifestSHA string,
) []byte {
	var output strings.Builder
	output.WriteString("# OG ranking v1 review\n\n")
	output.WriteString("This generated summary is the review surface for the ranked head and safety gate. ")
	output.WriteString("Scores are editorial quality only; they contain no availability, registration, expiry, premium, price, or legal claim.\n\n")
	output.WriteString("## Provenance\n\n")
	output.WriteString("- Corpus: " + strconv.Itoa(len(corpus.Labels)) + " labels, `" + corpus.SHA256 + "`\n")
	output.WriteString("- Model: `" + generation.Model.ModelID + "` / `" + generation.Model.ModelRevision + "` through `" + generation.Model.Interface + " " + generation.Model.InterfaceVersion + "`\n")
	output.WriteString("- Generation: " + strconv.Itoa(generation.Settings.RunsPerLabel) + " passes over " + strconv.Itoa(generation.Settings.CandidateCount) + " deterministic candidates, temperature 0\n")
	output.WriteString("- Generator commit: `" + generation.GeneratorCommit + "`\n")
	output.WriteString("- Manifest: `" + manifestSHA + "`\n")
	output.WriteString("- Human review: top " + strconv.Itoa(decisions.ReviewedHeadCount) + ", all deterministic findings, all model policy signals, and every allowlisted label\n\n")

	output.WriteString("## Ranked head\n\n")
	output.WriteString("| Rank | Label | Score | Dimensions + deductions | Facets | Eligibility | Model runs |\n")
	output.WriteString("| ---: | --- | ---: | --- | --- | --- | --- |\n")
	headCount := decisions.ReviewedHeadCount
	if headCount > len(ranked) {
		headCount = len(ranked)
	}
	for index, record := range ranked[:headCount] {
		values := record.Scores.Values()
		dimensions := make([]string, len(values))
		for valueIndex, value := range values {
			dimensions[valueIndex] = strconv.Itoa(value)
		}
		runs := "baseline"
		if len(record.ModelRunScores) > 0 {
			runValues := make([]string, len(record.ModelRunScores))
			for runIndex, score := range record.ModelRunScores {
				runValues[runIndex] = strconv.Itoa(score)
			}
			runs = strings.Join(runValues, "/")
		}
		facets := make([]string, len(record.Facets))
		for facetIndex, facet := range record.Facets {
			facets[facetIndex] = string(facet)
		}
		fmt.Fprintf(
			&output,
			"| %d | `%s` | %d | %s | %s | `%s` | %s |\n",
			index+1,
			record.Label,
			record.Score,
			strings.Join(dimensions, "/"),
			strings.Join(facets, ", "),
			record.Eligibility,
			runs,
		)
	}

	output.WriteString("\n## Safety gate\n\n")
	output.WriteString("| Eligibility | Corpus labels |\n")
	output.WriteString("| --- | ---: |\n")
	for _, eligibility := range Eligibilities {
		fmt.Fprintf(&output, "| `%s` | %d |\n", eligibility, counts[eligibility])
	}
	output.WriteString("\nUnknown and unreviewed labels remain `review_required`; only the separate allowlist is feature-safe.\n\n")
	output.WriteString("## Feature-safe allowlist\n\n")
	output.WriteString("The allowlist contains " + strconv.Itoa(len(allowlisted)) + " explicitly reviewed labels. ")
	output.WriteString("Its canonical order is alphabetical; runtime ranking uses the separate compact score artifact and deterministic diversity selector.\n\n")
	for _, label := range allowlisted {
		output.WriteString("- `" + label + "`\n")
	}
	return []byte(output.String())
}

// WriteArtifacts writes the deterministic derived files.
func WriteArtifacts(repositoryRoot string, artifacts []Artifact) error {
	for _, artifact := range artifacts {
		path := filepath.Join(repositoryRoot, filepath.FromSlash(artifact.Path))
		if err := writeAtomic(path, artifact.Bytes); err != nil {
			return err
		}
	}
	return nil
}

// CheckArtifacts compares every deterministic output with the committed bytes.
func CheckArtifacts(repositoryRoot string, artifacts []Artifact) error {
	for _, artifact := range artifacts {
		path := filepath.Join(repositoryRoot, filepath.FromSlash(artifact.Path))
		committed, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read committed artifact %s: %w", artifact.Path, err)
		}
		if !bytes.Equal(committed, artifact.Bytes) {
			return fmt.Errorf("committed artifact %s is stale; run the ranking build", artifact.Path)
		}
	}
	return nil
}

// GzipSize returns the deterministic gzip size used by unit tests. The browser
// gate additionally measures both gzip and Brotli with Node's standard library.
func GzipSize(payload []byte) (int, error) {
	var output bytes.Buffer
	writer, err := gzip.NewWriterLevel(&output, gzip.BestCompression)
	if err != nil {
		return 0, err
	}
	writer.Header.ModTime = timeZero
	writer.Header.OS = 255
	if _, err := writer.Write(payload); err != nil {
		return 0, err
	}
	if err := writer.Close(); err != nil {
		return 0, err
	}
	return output.Len(), nil
}

var timeZero = func() (value time.Time) { return value }()

func copyFacets(input []Facet) []Facet {
	return append([]Facet(nil), input...)
}
