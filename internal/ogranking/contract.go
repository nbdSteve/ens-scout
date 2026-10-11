// Package ogranking builds the repository-owned editorial ranking artifacts.
//
// It has no runtime role in the scanner, read API, or website. The package is
// used only by the manual generator command and by deterministic validation.
package ogranking

import (
	"fmt"
	"sort"
)

const (
	ReviewFormatVersion      = 1
	CompactFormatVersion     = 1
	AllowlistFormatVersion   = 1
	ManifestFormatVersion    = 1
	GenerationFormatVersion  = 1
	CandidateFormatVersion   = 1
	CalibrationFormatVersion = 1
	DecisionsFormatVersion   = 1

	RubricVersion = "og-v1"
	PromptVersion = "og-v1"
	PolicyVersion = "featured-safe-v1"

	DefaultCandidateCount = 384
	DefaultBatchSize      = 128
	DefaultPasses         = 3

	MaxModelAttempts      = 12
	MaxModelInputTokens   = 600_000
	MaxModelOutputTokens  = 180_000
	MaxModelRequestBytes  = 128 << 10
	MaxModelResponseBytes = 1 << 20
	MaxModelEventBytes    = 2 << 20
)

const (
	MaxRecognizability   = 25
	MaxMemorability      = 20
	MaxSemanticDensity   = 15
	MaxDistinctiveness   = 15
	MaxVisualForm        = 10
	MaxInternetResonance = 10
	MaxVersatility       = 5
	MaxResiduePenalty    = 25
	MaxConfusionPenalty  = 15
)

// Scores are the anchored rubric dimensions. The positive dimensions already
// carry their repository-owned weights: their maxima sum to 100.
type Scores struct {
	Recognizability   int `json:"recognizability"`
	Memorability      int `json:"memorability"`
	SemanticDensity   int `json:"semantic_density"`
	Distinctiveness   int `json:"distinctiveness"`
	VisualForm        int `json:"visual_form"`
	InternetResonance int `json:"internet_resonance"`
	Versatility       int `json:"versatility"`
	ResiduePenalty    int `json:"residue_penalty"`
	ConfusionPenalty  int `json:"confusion_penalty"`
}

// Values returns the compact review-source order documented in data/ranking.
func (s Scores) Values() [9]int {
	return [9]int{
		s.Recognizability,
		s.Memorability,
		s.SemanticDensity,
		s.Distinctiveness,
		s.VisualForm,
		s.InternetResonance,
		s.Versatility,
		s.ResiduePenalty,
		s.ConfusionPenalty,
	}
}

// ScoresFromValues reconstructs Scores from the compact review-source order.
func ScoresFromValues(values [9]int) Scores {
	return Scores{
		Recognizability:   values[0],
		Memorability:      values[1],
		SemanticDensity:   values[2],
		Distinctiveness:   values[3],
		VisualForm:        values[4],
		InternetResonance: values[5],
		Versatility:       values[6],
		ResiduePenalty:    values[7],
		ConfusionPenalty:  values[8],
	}
}

// Validate checks every anchored integer range.
func (s Scores) Validate() error {
	values := []struct {
		name  string
		value int
		max   int
	}{
		{"recognizability", s.Recognizability, MaxRecognizability},
		{"memorability", s.Memorability, MaxMemorability},
		{"semantic_density", s.SemanticDensity, MaxSemanticDensity},
		{"distinctiveness", s.Distinctiveness, MaxDistinctiveness},
		{"visual_form", s.VisualForm, MaxVisualForm},
		{"internet_resonance", s.InternetResonance, MaxInternetResonance},
		{"versatility", s.Versatility, MaxVersatility},
		{"residue_penalty", s.ResiduePenalty, MaxResiduePenalty},
		{"confusion_penalty", s.ConfusionPenalty, MaxConfusionPenalty},
	}
	for _, dimension := range values {
		if dimension.value < 0 || dimension.value > dimension.max {
			return fmt.Errorf(
				"%s score %d is outside 0..%d",
				dimension.name,
				dimension.value,
				dimension.max,
			)
		}
	}
	return nil
}

// FinalScore applies the repository-owned formula and returns an integer 0..1000.
// A model supplies dimensions only; it never supplies or changes this formula.
func FinalScore(scores Scores) (int, error) {
	if err := scores.Validate(); err != nil {
		return 0, err
	}
	total := scores.Recognizability +
		scores.Memorability +
		scores.SemanticDensity +
		scores.Distinctiveness +
		scores.VisualForm +
		scores.InternetResonance +
		scores.Versatility -
		scores.ResiduePenalty -
		scores.ConfusionPenalty
	if total < 0 {
		total = 0
	}
	if total > 100 {
		total = 100
	}
	return total * 10, nil
}

// Facet is a compact editorial category. The order is the bit assignment and
// therefore part of the browser artifact contract.
type Facet string

const (
	FacetCultureLanguage    Facet = "culture_language"
	FacetInternet           Facet = "internet"
	FacetTechnology         Facet = "technology"
	FacetArtsMusic          Facet = "arts_music"
	FacetNature             Facet = "nature"
	FacetScience            Facet = "science"
	FacetPlayful            Facet = "playful"
	FacetAbstractConceptual Facet = "abstract_conceptual"
)

var Facets = []Facet{
	FacetCultureLanguage,
	FacetInternet,
	FacetTechnology,
	FacetArtsMusic,
	FacetNature,
	FacetScience,
	FacetPlayful,
	FacetAbstractConceptual,
}

const KnownFacetBits = 255

func facetIndex(facet Facet) (int, bool) {
	for index, known := range Facets {
		if facet == known {
			return index, true
		}
	}
	return 0, false
}

// FacetBits returns the canonical bitset for one to three unique known facets.
func FacetBits(facets []Facet) (int, error) {
	if len(facets) < 1 || len(facets) > 3 {
		return 0, fmt.Errorf("facets contain %d entries, want 1..3", len(facets))
	}
	bits := 0
	for _, facet := range facets {
		index, ok := facetIndex(facet)
		if !ok {
			return 0, fmt.Errorf("unknown facet %q", facet)
		}
		bit := 1 << index
		if bits&bit != 0 {
			return 0, fmt.Errorf("duplicate facet %q", facet)
		}
		bits |= bit
	}
	return bits, nil
}

// FacetsFromBits expands a known bitset in contract order.
func FacetsFromBits(bits int) ([]Facet, error) {
	if bits <= 0 || bits&^KnownFacetBits != 0 {
		return nil, fmt.Errorf("facet bits %d are outside the known mask", bits)
	}
	var facets []Facet
	for index, facet := range Facets {
		if bits&(1<<index) != 0 {
			facets = append(facets, facet)
		}
	}
	if len(facets) > 3 {
		return nil, fmt.Errorf("facet bits %d select more than three facets", bits)
	}
	return facets, nil
}

// PolicySignal is the model's advisory classification. PolicyNone means that
// the model noticed no concern; it is not feature eligibility.
type PolicySignal string

const (
	PolicyNone                      PolicySignal = "none"
	PolicyAdult                     PolicySignal = "adult"
	PolicyHateOrHarassment          PolicySignal = "hate_or_harassment"
	PolicyTrademarkOrBrand          PolicySignal = "trademark_or_brand"
	PolicyPersonOrPolitical         PolicySignal = "person_or_political"
	PolicyMisleadingOrImpersonation PolicySignal = "misleading_or_impersonation"
	PolicyIllegalOrHarmful          PolicySignal = "illegal_or_harmful"
	PolicyReviewRequired            PolicySignal = "review_required"
)

var PolicySignals = []PolicySignal{
	PolicyNone,
	PolicyAdult,
	PolicyHateOrHarassment,
	PolicyTrademarkOrBrand,
	PolicyPersonOrPolitical,
	PolicyMisleadingOrImpersonation,
	PolicyIllegalOrHarmful,
	PolicyReviewRequired,
}

func isKnownPolicySignal(signal PolicySignal) bool {
	for _, known := range PolicySignals {
		if signal == known {
			return true
		}
	}
	return false
}

// Eligibility is the reviewed hard gate. Only EligibilityFeatureable enters
// the separate feature-safe allowlist.
type Eligibility string

const (
	EligibilityFeatureable               Eligibility = "featureable"
	EligibilityAdult                     Eligibility = "adult"
	EligibilityHateOrHarassment          Eligibility = "hate_or_harassment"
	EligibilityTrademarkOrBrand          Eligibility = "trademark_or_brand"
	EligibilityPersonOrPolitical         Eligibility = "person_or_political"
	EligibilityMisleadingOrImpersonation Eligibility = "misleading_or_impersonation"
	EligibilityIllegalOrHarmful          Eligibility = "illegal_or_harmful"
	EligibilityReviewRequired            Eligibility = "review_required"
)

var Eligibilities = []Eligibility{
	EligibilityFeatureable,
	EligibilityAdult,
	EligibilityHateOrHarassment,
	EligibilityTrademarkOrBrand,
	EligibilityPersonOrPolitical,
	EligibilityMisleadingOrImpersonation,
	EligibilityIllegalOrHarmful,
	EligibilityReviewRequired,
}

func isKnownEligibility(eligibility Eligibility) bool {
	for _, known := range Eligibilities {
		if eligibility == known {
			return true
		}
	}
	return false
}

func eligibilityForSignal(signal PolicySignal) Eligibility {
	switch signal {
	case PolicyAdult:
		return EligibilityAdult
	case PolicyHateOrHarassment:
		return EligibilityHateOrHarassment
	case PolicyTrademarkOrBrand:
		return EligibilityTrademarkOrBrand
	case PolicyPersonOrPolitical:
		return EligibilityPersonOrPolitical
	case PolicyMisleadingOrImpersonation:
		return EligibilityMisleadingOrImpersonation
	case PolicyIllegalOrHarmful:
		return EligibilityIllegalOrHarmful
	default:
		return EligibilityReviewRequired
	}
}

// CanonicalFacets returns a sorted, de-duplicated copy in contract order.
func CanonicalFacets(input []Facet) ([]Facet, error) {
	seen := make(map[Facet]struct{}, len(input))
	for _, facet := range input {
		if _, ok := facetIndex(facet); !ok {
			return nil, fmt.Errorf("unknown facet %q", facet)
		}
		if _, exists := seen[facet]; exists {
			return nil, fmt.Errorf("duplicate facet %q", facet)
		}
		seen[facet] = struct{}{}
	}
	output := append([]Facet(nil), input...)
	sort.Slice(output, func(i, j int) bool {
		left, _ := facetIndex(output[i])
		right, _ := facetIndex(output[j])
		return left < right
	})
	return output, nil
}
