package ogranking

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

// ModelItem is the complete accepted output for one supplied label.
type ModelItem struct {
	Label        string       `json:"label"`
	Scores       Scores       `json:"scores"`
	Facets       []Facet      `json:"facets"`
	PolicySignal PolicySignal `json:"policy_signal"`
}

// ModelBatch is the only document accepted from a generator.
type ModelBatch struct {
	Items []ModelItem `json:"items"`
}

type rawModelBatch struct {
	Items *[]rawModelItem `json:"items"`
}

type rawModelItem struct {
	Label        *string       `json:"label"`
	Scores       *rawScores    `json:"scores"`
	Facets       *[]Facet      `json:"facets"`
	PolicySignal *PolicySignal `json:"policy_signal"`
}

type rawScores struct {
	Recognizability   *int `json:"recognizability"`
	Memorability      *int `json:"memorability"`
	SemanticDensity   *int `json:"semantic_density"`
	Distinctiveness   *int `json:"distinctiveness"`
	VisualForm        *int `json:"visual_form"`
	InternetResonance *int `json:"internet_resonance"`
	Versatility       *int `json:"versatility"`
	ResiduePenalty    *int `json:"residue_penalty"`
	ConfusionPenalty  *int `json:"confusion_penalty"`
}

// DecodeModelBatch refuses anything except one closed document covering the
// exact supplied labels once each.
func DecodeModelBatch(payload []byte, supplied []string) (ModelBatch, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var raw rawModelBatch
	if err := decoder.Decode(&raw); err != nil {
		return ModelBatch{}, fmt.Errorf("decode model batch: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return ModelBatch{}, fmt.Errorf("decode model batch: unexpected trailing JSON value")
		}
		return ModelBatch{}, fmt.Errorf("decode model batch trailing data: %w", err)
	}
	if raw.Items == nil {
		return ModelBatch{}, fmt.Errorf("model batch is missing items")
	}
	if len(*raw.Items) != len(supplied) {
		return ModelBatch{}, fmt.Errorf(
			"model batch contains %d items, want %d",
			len(*raw.Items),
			len(supplied),
		)
	}

	expected := labelSet(supplied)
	seen := make(map[string]struct{}, len(supplied))
	items := make([]ModelItem, 0, len(supplied))
	for index, rawItem := range *raw.Items {
		item, err := rawItem.item()
		if err != nil {
			return ModelBatch{}, fmt.Errorf("model batch item %d: %w", index, err)
		}
		if _, ok := expected[item.Label]; !ok {
			return ModelBatch{}, fmt.Errorf("model batch invented or changed label %q", item.Label)
		}
		if _, duplicate := seen[item.Label]; duplicate {
			return ModelBatch{}, fmt.Errorf("model batch duplicated label %q", item.Label)
		}
		seen[item.Label] = struct{}{}
		items = append(items, item)
	}
	for _, label := range supplied {
		if _, ok := seen[label]; !ok {
			return ModelBatch{}, fmt.Errorf("model batch omitted label %q", label)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].Label < items[j].Label
	})
	return ModelBatch{Items: items}, nil
}

func (raw rawModelItem) item() (ModelItem, error) {
	if raw.Label == nil {
		return ModelItem{}, fmt.Errorf("missing label")
	}
	if err := ValidateCanonicalLabel(*raw.Label); err != nil {
		return ModelItem{}, err
	}
	if raw.Scores == nil {
		return ModelItem{}, fmt.Errorf("label %q is missing scores", *raw.Label)
	}
	scores, err := raw.Scores.scores()
	if err != nil {
		return ModelItem{}, fmt.Errorf("label %q: %w", *raw.Label, err)
	}
	if raw.Facets == nil {
		return ModelItem{}, fmt.Errorf("label %q is missing facets", *raw.Label)
	}
	facets, err := CanonicalFacets(*raw.Facets)
	if err != nil {
		return ModelItem{}, fmt.Errorf("label %q: %w", *raw.Label, err)
	}
	if _, err := FacetBits(facets); err != nil {
		return ModelItem{}, fmt.Errorf("label %q: %w", *raw.Label, err)
	}
	if raw.PolicySignal == nil {
		return ModelItem{}, fmt.Errorf("label %q is missing policy_signal", *raw.Label)
	}
	if !isKnownPolicySignal(*raw.PolicySignal) {
		return ModelItem{}, fmt.Errorf("label %q has unknown policy signal %q", *raw.Label, *raw.PolicySignal)
	}
	return ModelItem{
		Label:        *raw.Label,
		Scores:       scores,
		Facets:       facets,
		PolicySignal: *raw.PolicySignal,
	}, nil
}

func (raw rawScores) scores() (Scores, error) {
	values := []struct {
		name  string
		value *int
	}{
		{"recognizability", raw.Recognizability},
		{"memorability", raw.Memorability},
		{"semantic_density", raw.SemanticDensity},
		{"distinctiveness", raw.Distinctiveness},
		{"visual_form", raw.VisualForm},
		{"internet_resonance", raw.InternetResonance},
		{"versatility", raw.Versatility},
		{"residue_penalty", raw.ResiduePenalty},
		{"confusion_penalty", raw.ConfusionPenalty},
	}
	for _, dimension := range values {
		if dimension.value == nil {
			return Scores{}, fmt.Errorf("scores are missing %s", dimension.name)
		}
	}
	scores := Scores{
		Recognizability:   *raw.Recognizability,
		Memorability:      *raw.Memorability,
		SemanticDensity:   *raw.SemanticDensity,
		Distinctiveness:   *raw.Distinctiveness,
		VisualForm:        *raw.VisualForm,
		InternetResonance: *raw.InternetResonance,
		Versatility:       *raw.Versatility,
		ResiduePenalty:    *raw.ResiduePenalty,
		ConfusionPenalty:  *raw.ConfusionPenalty,
	}
	if err := scores.Validate(); err != nil {
		return Scores{}, err
	}
	return scores, nil
}

// AggregatedModel is the deterministic median result for one candidate.
type AggregatedModel struct {
	Label          string
	Scores         Scores
	Score          int
	Facets         []Facet
	PolicySignal   PolicySignal
	ModelRunScores []int
}

// AggregateModelPasses takes exactly three independently ordered validated
// passes, calculates dimension medians, and applies the repository formula.
func AggregateModelPasses(passes [][]ModelItem) (map[string]AggregatedModel, error) {
	if len(passes) != DefaultPasses {
		return nil, fmt.Errorf("got %d model passes, want %d", len(passes), DefaultPasses)
	}
	if len(passes[0]) == 0 {
		return nil, fmt.Errorf("model passes contain no items")
	}
	expected := make([]string, len(passes[0]))
	for index, item := range passes[0] {
		expected[index] = item.Label
	}
	sort.Strings(expected)
	for passIndex, pass := range passes {
		labels := make([]string, len(pass))
		for index, item := range pass {
			if err := item.Scores.Validate(); err != nil {
				return nil, fmt.Errorf("pass %d label %q: %w", passIndex+1, item.Label, err)
			}
			if _, err := FacetBits(item.Facets); err != nil {
				return nil, fmt.Errorf("pass %d label %q: %w", passIndex+1, item.Label, err)
			}
			if !isKnownPolicySignal(item.PolicySignal) {
				return nil, fmt.Errorf(
					"pass %d label %q has unknown policy signal %q",
					passIndex+1,
					item.Label,
					item.PolicySignal,
				)
			}
			labels[index] = item.Label
		}
		sort.Strings(labels)
		if !equalStrings(labels, expected) {
			return nil, fmt.Errorf("model pass %d does not cover the same labels", passIndex+1)
		}
	}

	byPass := make([]map[string]ModelItem, len(passes))
	for passIndex, pass := range passes {
		byPass[passIndex] = make(map[string]ModelItem, len(pass))
		for _, item := range pass {
			byPass[passIndex][item.Label] = item
		}
	}

	aggregated := make(map[string]AggregatedModel, len(expected))
	for _, label := range expected {
		items := make([]ModelItem, len(passes))
		runScores := make([]int, len(passes))
		for passIndex := range passes {
			items[passIndex] = byPass[passIndex][label]
			score, err := FinalScore(items[passIndex].Scores)
			if err != nil {
				return nil, fmt.Errorf("pass %d label %q: %w", passIndex+1, label, err)
			}
			runScores[passIndex] = score
		}
		scores := medianScores(items)
		score, err := FinalScore(scores)
		if err != nil {
			return nil, fmt.Errorf("aggregate label %q: %w", label, err)
		}
		facets, err := aggregateFacets(items)
		if err != nil {
			return nil, fmt.Errorf("aggregate label %q: %w", label, err)
		}
		aggregated[label] = AggregatedModel{
			Label:          label,
			Scores:         scores,
			Score:          score,
			Facets:         facets,
			PolicySignal:   aggregatePolicy(items),
			ModelRunScores: runScores,
		}
	}
	return aggregated, nil
}

func medianScores(items []ModelItem) Scores {
	values := make([][9]int, len(items))
	for index, item := range items {
		values[index] = item.Scores.Values()
	}
	var medians [9]int
	for dimension := range medians {
		column := make([]int, len(values))
		for index := range values {
			column[index] = values[index][dimension]
		}
		sort.Ints(column)
		medians[dimension] = column[len(column)/2]
	}
	return ScoresFromValues(medians)
}

func aggregateFacets(items []ModelItem) ([]Facet, error) {
	counts := make(map[Facet]int, len(Facets))
	for _, item := range items {
		for _, facet := range item.Facets {
			counts[facet]++
		}
	}
	type countedFacet struct {
		facet Facet
		count int
		index int
	}
	ranked := make([]countedFacet, 0, len(counts))
	for facet, count := range counts {
		index, ok := facetIndex(facet)
		if !ok {
			return nil, fmt.Errorf("unknown facet %q", facet)
		}
		ranked = append(ranked, countedFacet{facet: facet, count: count, index: index})
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].count != ranked[j].count {
			return ranked[i].count > ranked[j].count
		}
		return ranked[i].index < ranked[j].index
	})
	var selected []Facet
	for _, candidate := range ranked {
		if candidate.count >= 2 {
			selected = append(selected, candidate.facet)
		}
		if len(selected) == 3 {
			break
		}
	}
	if len(selected) == 0 && len(ranked) > 0 {
		selected = append(selected, ranked[0].facet)
	}
	return CanonicalFacets(selected)
}

func aggregatePolicy(items []ModelItem) PolicySignal {
	counts := make(map[PolicySignal]int, len(PolicySignals))
	for _, item := range items {
		counts[item.PolicySignal]++
	}
	for _, signal := range PolicySignals {
		if counts[signal] >= 2 {
			return signal
		}
	}
	return PolicyReviewRequired
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
