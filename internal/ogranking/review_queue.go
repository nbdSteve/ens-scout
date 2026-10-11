package ogranking

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

const ReviewQueuePath = "data/ranking/work/og-v1.review-queue.md"

// BuildReviewQueue produces an ignored, pre-decision review aid. It breaks the
// intentional dependency cycle between validated model output and the reviewed
// decisions without becoming a production artifact.
func BuildReviewQueue(repositoryRoot string, headCount int) ([]byte, error) {
	if headCount < 1 {
		return nil, fmt.Errorf("review head count must be positive")
	}
	inputs, err := loadRankingInputs(repositoryRoot)
	if err != nil {
		return nil, err
	}
	if headCount > len(inputs.Corpus.Labels) {
		return nil, fmt.Errorf(
			"review head count %d exceeds corpus size %d",
			headCount,
			len(inputs.Corpus.Labels),
		)
	}
	records, err := buildRecords(
		inputs.Corpus,
		inputs.Aggregated,
		ReviewDecisions{},
		map[string]ReviewDecision{},
	)
	if err != nil {
		return nil, err
	}
	ranked := rankRecords(records)
	headLabels := make(map[string]struct{}, headCount)

	var output strings.Builder
	output.WriteString("# OG ranking v1 review queue\n\n")
	output.WriteString("This ignored file is a manual review aid, not a committed artifact. ")
	output.WriteString("Scores are editorial quality only and contain no ENS lifecycle or legal claim.\n\n")
	output.WriteString("- Corpus: " + strconv.Itoa(len(inputs.Corpus.Labels)) + " labels, `" + inputs.Corpus.SHA256 + "`\n")
	output.WriteString("- Candidate model review: " + strconv.Itoa(len(inputs.Aggregated)) + " labels across " + strconv.Itoa(len(inputs.Generation.Passes)) + " passes\n")
	output.WriteString("- Model: `" + inputs.Generation.Model.ModelID + "` / `" + inputs.Generation.Model.ModelRevision + "`\n")
	output.WriteString("- Generator commit: `" + inputs.Generation.GeneratorCommit + "`\n\n")
	output.WriteString("Copy reviewed outcomes into `data/ranking/og-v1.decisions.json`. ")
	output.WriteString("Only an explicit `featureable` decision may enter the allowlist.\n\n")

	output.WriteString("## Ranked head\n\n")
	writeReviewQueueHeader(&output)
	for index, record := range ranked[:headCount] {
		headLabels[record.Label] = struct{}{}
		writeReviewQueueRow(&output, index+1, record)
	}

	output.WriteString("\n## Additional policy review\n\n")
	output.WriteString("These model or deterministic findings fall outside the ranked head and also require explicit decisions.\n\n")
	writeReviewQueueHeader(&output)
	additional := 0
	for index, record := range ranked {
		if _, inHead := headLabels[record.Label]; inHead {
			continue
		}
		_, _, deterministic := DeterministicPolicy(record.Label)
		modelConcern := record.ModelPolicySignal != "" &&
			record.ModelPolicySignal != PolicyNone
		if !deterministic && !modelConcern {
			continue
		}
		writeReviewQueueRow(&output, index+1, record)
		additional++
	}
	if additional == 0 {
		output.WriteString("| — | — | — | — | — | — | — | — |\n")
	}
	return []byte(output.String()), nil
}

func writeReviewQueueHeader(output *strings.Builder) {
	output.WriteString("| Rank | Label | Score | Dimensions + deductions | Facets | Deterministic policy | Model policy | Model runs |\n")
	output.WriteString("| ---: | --- | ---: | --- | --- | --- | --- | --- |\n")
}

func writeReviewQueueRow(output *strings.Builder, rank int, record rankedRecord) {
	values := record.Scores.Values()
	dimensions := make([]string, len(values))
	for index, value := range values {
		dimensions[index] = strconv.Itoa(value)
	}
	facets := make([]string, len(record.Facets))
	for index, facet := range record.Facets {
		facets[index] = string(facet)
	}
	deterministic := "none"
	if eligibility, reason, ok := DeterministicPolicy(record.Label); ok {
		deterministic = string(eligibility) + " / " + reason
	}
	model := "not reviewed"
	if record.ModelPolicySignal != "" {
		model = string(record.ModelPolicySignal)
	}
	runs := "baseline"
	if len(record.ModelRunScores) > 0 {
		runValues := make([]string, len(record.ModelRunScores))
		for index, score := range record.ModelRunScores {
			runValues[index] = strconv.Itoa(score)
		}
		runs = strings.Join(runValues, "/")
	}
	fmt.Fprintf(
		output,
		"| %d | `%s` | %d | %s | %s | %s | `%s` | %s |\n",
		rank,
		record.Label,
		record.Score,
		strings.Join(dimensions, "/"),
		strings.Join(facets, ", "),
		deterministic,
		model,
		runs,
	)
}

// WriteReviewQueue writes the fixed ignored review aid.
func WriteReviewQueue(repositoryRoot string, payload []byte) error {
	return writeAtomic(
		filepath.Join(repositoryRoot, filepath.FromSlash(ReviewQueuePath)),
		payload,
	)
}
