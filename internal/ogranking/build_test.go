package ogranking

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestBuildArtifactsCoversCorpusAndIsDeterministic(t *testing.T) {
	root := prepareReviewedFixture(t)
	first, err := BuildArtifacts(root)
	if err != nil {
		t.Fatalf("BuildArtifacts: %v", err)
	}
	if len(first) != 7 {
		t.Fatalf("artifact count = %d, want 7", len(first))
	}
	if err := WriteArtifacts(root, first); err != nil {
		t.Fatalf("WriteArtifacts: %v", err)
	}
	second, err := BuildArtifacts(root)
	if err != nil {
		t.Fatalf("second BuildArtifacts: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("deterministic rebuild produced different artifacts")
	}
	if err := CheckArtifacts(root, second); err != nil {
		t.Fatalf("CheckArtifacts: %v", err)
	}

	byPath := make(map[string][]byte, len(first))
	for _, artifact := range first {
		byPath[artifact.Path] = artifact.Bytes
	}
	corpus, err := LoadCorpus(root)
	if err != nil {
		t.Fatal(err)
	}
	assertCompactRank(t, byPath[browserRankPath], corpus)
	allowlist := decodeAllowlist(t, byPath[allowlistPath])
	fixture := decodeFixture(t, byPath[selectorFixturePath])
	allowlisted := labelSet(allowlist.Labels)
	for _, label := range fixture.Labels {
		if _, ok := allowlisted[label]; !ok {
			t.Fatalf("selector fixture label %q is not allowlisted", label)
		}
		if eligibility, reason, blocked := DeterministicPolicy(label); blocked {
			t.Fatalf(
				"selector fixture label %q is deterministically %q (%s)",
				label,
				eligibility,
				reason,
			)
		}
	}
	if !bytes.Equal(byPath[allowlistPath], byPath[browserAllowlistPath]) {
		t.Fatal("browser allowlist differs from reviewed source allowlist")
	}
	assertReviewSource(t, byPath[reviewPath], corpus)
	gzipBytes, err := GzipSize(byPath[browserRankPath])
	if err != nil {
		t.Fatal(err)
	}
	if gzipBytes > 130*1024 {
		t.Fatalf("compact rank gzip size = %d, above 130 KiB", gzipBytes)
	}
}

func TestCommittedArtifactsAreCurrentAndWithinContract(t *testing.T) {
	root := testRepositoryRoot(t)
	artifacts, err := BuildArtifacts(root)
	if err != nil {
		t.Fatalf("BuildArtifacts: %v", err)
	}
	if err := CheckArtifacts(root, artifacts); err != nil {
		t.Fatalf("CheckArtifacts: %v", err)
	}
	byPath := make(map[string][]byte, len(artifacts))
	for _, artifact := range artifacts {
		byPath[artifact.Path] = artifact.Bytes
	}
	corpus, err := LoadCorpus(root)
	if err != nil {
		t.Fatal(err)
	}
	assertCompactRank(t, byPath[browserRankPath], corpus)
	assertReviewSource(t, byPath[reviewPath], corpus)
	allowlist := decodeAllowlist(t, byPath[allowlistPath])
	fixture := decodeFixture(t, byPath[selectorFixturePath])
	rankedLabels := compactLabelSet(t, byPath[browserRankPath])
	allowlisted := make(map[string]struct{}, len(allowlist.Labels))
	for _, label := range allowlist.Labels {
		if _, duplicate := allowlisted[label]; duplicate {
			t.Fatalf("allowlist duplicates %q", label)
		}
		allowlisted[label] = struct{}{}
		if _, ok := rankedLabels[label]; !ok {
			t.Fatalf("allowlisted label %q has no ranking record", label)
		}
	}
	for _, label := range fixture.Labels {
		if _, ok := allowlisted[label]; !ok {
			t.Fatalf("selector fixture label %q is not allowlisted", label)
		}
	}
	if !bytes.Equal(byPath[allowlistPath], byPath[browserAllowlistPath]) {
		t.Fatal("browser allowlist differs from reviewed source allowlist")
	}
	gzipBytes, err := GzipSize(byPath[browserRankPath])
	if err != nil {
		t.Fatal(err)
	}
	if gzipBytes > 130*1024 {
		t.Fatalf("compact rank gzip size = %d, above 130 KiB", gzipBytes)
	}
}

func TestCorpusChangeInvalidatesGeneratedInputs(t *testing.T) {
	root := copyGenerationInputs(t)
	generateFakeInputs(t, root, &fakeModelRunner{})
	path := filepath.Join(root, filepath.FromSlash(CorpusPaths[2]))
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("\nblorf\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildReviewQueue(root, 12); err == nil ||
		!strings.Contains(err.Error(), "candidate artifact is stale") {
		t.Fatalf("BuildReviewQueue error = %v, want deliberate-regeneration refusal", err)
	}
}

func TestGenerationRecordRejectsTamperedBatchOrderAndTotals(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*GenerationRecord)
		want   string
	}{
		{
			name: "batch order hash",
			mutate: func(record *GenerationRecord) {
				record.Passes[0].Batches[0].LabelsSHA256 = strings.Repeat("0", 64)
			},
			want: "order record is not canonical",
		},
		{
			name: "attempt total",
			mutate: func(record *GenerationRecord) {
				record.TotalAttempts++
			},
			want: "do not match batch total",
		},
		{
			name: "usage total",
			mutate: func(record *GenerationRecord) {
				record.TotalUsage.InputTokens++
			},
			want: "does not match batch totals",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := copyGenerationInputs(t)
			generateFakeInputs(t, root, &fakeModelRunner{})
			path := filepath.Join(root, "data", "ranking", "og-v1.generation.json")
			payload, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var record GenerationRecord
			if err := json.Unmarshal(payload, &record); err != nil {
				t.Fatal(err)
			}
			test.mutate(&record)
			tampered, err := canonicalIndentedJSON(record)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, tampered, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, _, err := LoadGenerationRecord(root); err == nil ||
				!strings.Contains(err.Error(), test.want) {
				t.Fatalf("LoadGenerationRecord error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestBuildRecordsAppliesOnlyExactScoreOverride(t *testing.T) {
	scores := modelItem("vex", 20, []Facet{FacetInternet}, PolicyNone).Scores
	calculated, err := FinalScore(scores)
	if err != nil {
		t.Fatal(err)
	}
	decision := ReviewDecision{
		Label:       "vex",
		Eligibility: EligibilityFeatureable,
		ReasonCode:  ReasonReviewedFeatureSafe,
		Note:        "Reviewed for featured placement.",
		ScoreOverride: &ScoreOverride{
			From:       calculated,
			To:         500,
			ReasonCode: ReasonEditorialCalibration,
			Note:       "Calibrated against adjacent reviewed labels.",
		},
	}
	records, err := buildRecords(
		Corpus{Labels: []string{"vex"}, SHA256: CorpusSHA256([]string{"vex"})},
		map[string]AggregatedModel{
			"vex": {
				Label:          "vex",
				Scores:         scores,
				Score:          calculated,
				Facets:         []Facet{FacetInternet},
				PolicySignal:   PolicyNone,
				ModelRunScores: []int{calculated, calculated, calculated},
			},
		},
		ReviewDecisions{Reviewer: "reviewer", ReviewedAt: "2026-10-11"},
		map[string]ReviewDecision{"vex": decision},
	)
	if err != nil {
		t.Fatalf("buildRecords: %v", err)
	}
	if records[0].Score != 500 {
		t.Fatalf("overridden score = %d, want 500", records[0].Score)
	}

	decision.ScoreOverride.From--
	if _, err := buildRecords(
		Corpus{Labels: []string{"vex"}, SHA256: CorpusSHA256([]string{"vex"})},
		map[string]AggregatedModel{
			"vex": {
				Label:        "vex",
				Scores:       scores,
				Score:        calculated,
				Facets:       []Facet{FacetInternet},
				PolicySignal: PolicyNone,
			},
		},
		ReviewDecisions{Reviewer: "reviewer", ReviewedAt: "2026-10-11"},
		map[string]ReviewDecision{"vex": decision},
	); err == nil || !strings.Contains(err.Error(), "expects") {
		t.Fatalf("mismatched override error = %v", err)
	}
}

func TestReviewQueueProvidesHeadAndPolicyWorkBeforeDecisions(t *testing.T) {
	root := copyGenerationInputs(t)
	generateFakeInputs(t, root, &fakeModelRunner{})
	payload, err := BuildReviewQueue(root, 12)
	if err != nil {
		t.Fatalf("BuildReviewQueue: %v", err)
	}
	for _, wanted := range []string{
		"# OG ranking v1 review queue",
		"## Ranked head",
		"## Additional policy review",
		"Deterministic policy",
		"Generator commit",
	} {
		if !bytes.Contains(payload, []byte(wanted)) {
			t.Fatalf("review queue does not contain %q", wanted)
		}
	}
}

func prepareReviewedFixture(t *testing.T) string {
	t.Helper()
	root := copyGenerationInputs(t)
	generateFakeInputs(t, root, &fakeModelRunner{})
	inputs, err := loadRankingInputs(root)
	if err != nil {
		t.Fatal(err)
	}
	records, err := buildRecords(
		inputs.Corpus,
		inputs.Aggregated,
		ReviewDecisions{},
		map[string]ReviewDecision{},
	)
	if err != nil {
		t.Fatal(err)
	}
	ranked := rankRecords(records)
	const headCount = 24
	decisions := make(map[string]ReviewDecision)
	featureable := 0
	for _, record := range ranked[:headCount] {
		eligibility, reason, blocked := DeterministicPolicy(record.Label)
		decision := ReviewDecision{
			Label:       record.Label,
			Eligibility: EligibilityReviewRequired,
			ReasonCode:  ReasonConservativeExclusion,
			Note:        "Fixture review conservatively excludes this ranked-head label.",
		}
		if blocked {
			decision.Eligibility = eligibility
			decision.ReasonCode = reason
			decision.Note = "Fixture review confirms the deterministic policy finding."
		} else if record.ModelPolicySignal != "" && record.ModelPolicySignal != PolicyNone {
			decision.Eligibility = eligibilityForSignal(record.ModelPolicySignal)
			decision.ReasonCode = ReasonModelAdvisory
			decision.Note = "Fixture review confirms the model policy signal."
		} else if featureable < 12 {
			decision.Eligibility = EligibilityFeatureable
			decision.ReasonCode = ReasonReviewedFeatureSafe
			decision.Note = "Fixture review approves this label for featured-placement tests."
			featureable++
		}
		decisions[record.Label] = decision
	}
	for _, record := range records {
		eligibility, reason, blocked := DeterministicPolicy(record.Label)
		if !blocked {
			continue
		}
		if _, exists := decisions[record.Label]; exists {
			continue
		}
		decisions[record.Label] = ReviewDecision{
			Label:       record.Label,
			Eligibility: eligibility,
			ReasonCode:  reason,
			Note:        "Fixture review confirms the deterministic policy finding.",
		}
	}
	if featureable < 12 {
		t.Fatalf("fixture selected only %d safe featureable labels", featureable)
	}
	ordered := make([]ReviewDecision, 0, len(decisions))
	for _, decision := range decisions {
		ordered = append(ordered, decision)
	}
	sort.Slice(ordered, func(i, j int) bool {
		return ordered[i].Label < ordered[j].Label
	})
	payload, err := canonicalIndentedJSON(ReviewDecisions{
		FormatVersion:     DecisionsFormatVersion,
		PolicyVersion:     PolicyVersion,
		Reviewer:          "fixture review",
		ReviewedAt:        "2026-10-11",
		ReviewedHeadCount: headCount,
		Decisions:         ordered,
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "data", "ranking", "og-v1.decisions.json")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func generateFakeInputs(t *testing.T, root string, runner ModelRunner) {
	t.Helper()
	if _, err := GenerateModelPasses(context.Background(), GeneratorOptions{
		RepositoryRoot:  root,
		GeneratorCommit: strings.Repeat("a", 40),
		GeneratedAt:     time.Date(2026, time.October, 11, 0, 0, 0, 0, time.UTC),
		Runner:          runner,
	}); err != nil {
		t.Fatal(err)
	}
}

func assertCompactRank(t *testing.T, payload []byte, corpus Corpus) {
	t.Helper()
	var compact CompactRank
	if err := decodeClosedJSON(payload, &compact); err != nil {
		t.Fatalf("decode compact rank: %v", err)
	}
	if compact.FormatVersion != CompactFormatVersion ||
		compact.Corpus.Count != len(corpus.Labels) ||
		compact.Corpus.SHA256 != corpus.SHA256 ||
		len(compact.Items) != len(corpus.Labels) {
		t.Fatalf("compact metadata = %#v", compact)
	}
	seen := make(map[string]struct{}, len(compact.Items))
	previousScore := 1001
	previousLabel := ""
	for index, tuple := range compact.Items {
		if len(tuple) != 4 {
			t.Fatalf("compact tuple %d has %d fields", index, len(tuple))
		}
		label, ok := tuple[0].(string)
		if !ok {
			t.Fatalf("compact tuple %d label = %#v", index, tuple[0])
		}
		score, scoreOK := tuple[1].(float64)
		facets, facetsOK := tuple[2].(float64)
		flags, flagsOK := tuple[3].(float64)
		if !scoreOK || score < 0 || score > 1000 || score != float64(int(score)) {
			t.Fatalf("compact tuple %q score = %#v", label, tuple[1])
		}
		if !facetsOK || facets <= 0 || int(facets)&^KnownFacetBits != 0 {
			t.Fatalf("compact tuple %q facets = %#v", label, tuple[2])
		}
		if !flagsOK || flags != 0 {
			t.Fatalf("compact tuple %q flags = %#v", label, tuple[3])
		}
		if _, duplicate := seen[label]; duplicate {
			t.Fatalf("compact rank duplicates %q", label)
		}
		seen[label] = struct{}{}
		currentScore := int(score)
		if currentScore > previousScore ||
			(currentScore == previousScore && previousLabel != "" && label <= previousLabel) {
			t.Fatalf("compact rank is not canonical at %q", label)
		}
		previousScore = currentScore
		previousLabel = label
	}
	for _, label := range corpus.Labels {
		if _, ok := seen[label]; !ok {
			t.Fatalf("compact rank omitted %q", label)
		}
	}
}

func compactLabelSet(t *testing.T, payload []byte) map[string]struct{} {
	t.Helper()
	var compact CompactRank
	if err := decodeClosedJSON(payload, &compact); err != nil {
		t.Fatal(err)
	}
	labels := make(map[string]struct{}, len(compact.Items))
	for index, tuple := range compact.Items {
		if len(tuple) != 4 {
			t.Fatalf("compact tuple %d has %d fields", index, len(tuple))
		}
		label, ok := tuple[0].(string)
		if !ok {
			t.Fatalf("compact tuple %d label = %#v", index, tuple[0])
		}
		labels[label] = struct{}{}
	}
	return labels
}

func decodeAllowlist(t *testing.T, payload []byte) FeatureAllowlist {
	t.Helper()
	var allowlist FeatureAllowlist
	if err := decodeClosedJSON(payload, &allowlist); err != nil {
		t.Fatalf("decode allowlist: %v", err)
	}
	if allowlist.FormatVersion != AllowlistFormatVersion ||
		allowlist.PolicyVersion != PolicyVersion ||
		len(allowlist.Labels) < 12 ||
		!sort.StringsAreSorted(allowlist.Labels) {
		t.Fatalf("allowlist = %#v", allowlist)
	}
	return allowlist
}

func decodeFixture(t *testing.T, payload []byte) SelectorFixture {
	t.Helper()
	var fixture SelectorFixture
	if err := decodeClosedJSON(payload, &fixture); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	if fixture.FormatVersion != 1 || len(fixture.Labels) != 12 {
		t.Fatalf("fixture = %#v", fixture)
	}
	return fixture
}

func assertReviewSource(t *testing.T, payload []byte, corpus Corpus) {
	t.Helper()
	scanner := bufio.NewScanner(bytes.NewReader(payload))
	scanner.Buffer(make([]byte, 64*1024), MaxModelResponseBytes)
	if !scanner.Scan() {
		t.Fatal("review source has no header")
	}
	var header reviewHeader
	if err := decodeClosedJSON(scanner.Bytes(), &header); err != nil {
		t.Fatalf("decode review header: %v", err)
	}
	if header.FormatVersion != ReviewFormatVersion ||
		header.RecordFormat != "tuple" ||
		header.Corpus.Count != len(corpus.Labels) ||
		header.Corpus.SHA256 != corpus.SHA256 {
		t.Fatalf("review header = %#v", header)
	}
	index := 0
	for scanner.Scan() {
		var tuple []any
		if err := json.Unmarshal(scanner.Bytes(), &tuple); err != nil {
			t.Fatalf("decode review line %d: %v", index+2, err)
		}
		if len(tuple) != len(header.Fields) {
			t.Fatalf("review line %d has %d fields", index+2, len(tuple))
		}
		if index >= len(corpus.Labels) || tuple[0] != corpus.Labels[index] {
			t.Fatalf("review line %d label = %#v", index+2, tuple[0])
		}
		index++
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if index != len(corpus.Labels) {
		t.Fatalf("review record count = %d, want %d", index, len(corpus.Labels))
	}
}
