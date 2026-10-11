package ogranking

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
)

type rankingInputs struct {
	Root             string
	Corpus           Corpus
	Calibration      Calibration
	CalibrationBytes []byte
	Candidates       []Candidate
	CandidateBytes   []byte
	Generation       GenerationRecord
	GenerationBytes  []byte
	RubricBytes      []byte
	PromptBytes      []byte
	Aggregated       map[string]AggregatedModel
}

func loadRankingInputs(repositoryRoot string) (rankingInputs, error) {
	root, err := filepath.Abs(repositoryRoot)
	if err != nil {
		return rankingInputs{}, fmt.Errorf("resolve repository root: %w", err)
	}
	corpus, err := LoadCorpus(root)
	if err != nil {
		return rankingInputs{}, err
	}
	corpusSet := labelSet(corpus.Labels)
	calibration, calibrationBytes, err := LoadCalibration(root, corpusSet)
	if err != nil {
		return rankingInputs{}, err
	}
	candidates, err := SelectCandidates(
		corpus,
		StrongCalibrationLabels(calibration),
		DefaultCandidateCount,
	)
	if err != nil {
		return rankingInputs{}, err
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
		return rankingInputs{}, fmt.Errorf("encode expected candidates: %w", err)
	}
	candidateFile := filepath.Join(root, "data", "ranking", "og-v1.candidates.json")
	committedCandidates, err := os.ReadFile(candidateFile)
	if err != nil {
		return rankingInputs{}, fmt.Errorf("read candidates: %w", err)
	}
	if !bytes.Equal(committedCandidates, candidateBytes) {
		return rankingInputs{}, fmt.Errorf(
			"candidate artifact is stale; regenerate after the corpus or rubric changed",
		)
	}

	generation, generationBytes, err := LoadGenerationRecord(root)
	if err != nil {
		return rankingInputs{}, err
	}
	if generation.CorpusCount != len(corpus.Labels) || generation.CorpusSHA256 != corpus.SHA256 {
		return rankingInputs{}, fmt.Errorf(
			"generation corpus count or hash does not match the committed word lists",
		)
	}
	if generation.CalibrationSHA256 != hashBytes(calibrationBytes) {
		return rankingInputs{}, fmt.Errorf("generation calibration checksum does not match")
	}
	if generation.CandidatesSHA256 != hashBytes(committedCandidates) {
		return rankingInputs{}, fmt.Errorf("generation candidate checksum does not match")
	}
	rubricBytes, err := os.ReadFile(filepath.Join(root, "data", "ranking", "og-v1.rubric.md"))
	if err != nil {
		return rankingInputs{}, fmt.Errorf("read rubric: %w", err)
	}
	promptBytes, err := os.ReadFile(filepath.Join(root, "data", "ranking", "og-v1.prompt.md"))
	if err != nil {
		return rankingInputs{}, fmt.Errorf("read prompt: %w", err)
	}
	if generation.RubricSHA256 != hashBytes(rubricBytes) ||
		generation.PromptSHA256 != hashBytes(promptBytes) {
		return rankingInputs{}, fmt.Errorf("generation rubric or prompt checksum does not match")
	}

	candidateLabels := make([]string, len(candidates))
	for index, candidate := range candidates {
		candidateLabels[index] = candidate.Label
	}
	passes := make([][]ModelItem, len(generation.Passes))
	for index, pass := range generation.Passes {
		items, err := loadModelPass(root, pass, candidateLabels)
		if err != nil {
			return rankingInputs{}, err
		}
		passes[index] = items
	}
	aggregated, err := AggregateModelPasses(passes)
	if err != nil {
		return rankingInputs{}, err
	}

	return rankingInputs{
		Root:             root,
		Corpus:           corpus,
		Calibration:      calibration,
		CalibrationBytes: calibrationBytes,
		Candidates:       candidates,
		CandidateBytes:   committedCandidates,
		Generation:       generation,
		GenerationBytes:  generationBytes,
		RubricBytes:      rubricBytes,
		PromptBytes:      promptBytes,
		Aggregated:       aggregated,
	}, nil
}
