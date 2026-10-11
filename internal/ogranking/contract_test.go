package ogranking

import (
	"reflect"
	"strings"
	"testing"
)

func TestFinalScoreUsesRepositoryFormula(t *testing.T) {
	scores := Scores{
		Recognizability:   23,
		Memorability:      19,
		SemanticDensity:   14,
		Distinctiveness:   14,
		VisualForm:        10,
		InternetResonance: 8,
		Versatility:       4,
	}
	got, err := FinalScore(scores)
	if err != nil {
		t.Fatalf("FinalScore: %v", err)
	}
	if got != 920 {
		t.Fatalf("score = %d, want 920", got)
	}
}

func TestFinalScoreClampsAfterDeductions(t *testing.T) {
	scores := Scores{
		Recognizability:  1,
		ResiduePenalty:   MaxResiduePenalty,
		ConfusionPenalty: MaxConfusionPenalty,
	}
	got, err := FinalScore(scores)
	if err != nil {
		t.Fatalf("FinalScore: %v", err)
	}
	if got != 0 {
		t.Fatalf("score = %d, want 0", got)
	}
}

func TestScoresRejectOutOfRangeDimension(t *testing.T) {
	scores := Scores{Recognizability: MaxRecognizability + 1}
	if err := scores.Validate(); err == nil {
		t.Fatal("Validate accepted an out-of-range dimension")
	} else if !strings.Contains(err.Error(), "recognizability") {
		t.Fatalf("error %q does not identify the dimension", err)
	}
}

func TestFacetBitsRoundTripInContractOrder(t *testing.T) {
	input := []Facet{FacetTechnology, FacetInternet}
	bits, err := FacetBits(input)
	if err != nil {
		t.Fatalf("FacetBits: %v", err)
	}
	got, err := FacetsFromBits(bits)
	if err != nil {
		t.Fatalf("FacetsFromBits: %v", err)
	}
	want := []Facet{FacetInternet, FacetTechnology}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("facets = %#v, want %#v", got, want)
	}
}

func TestFacetBitsRejectUnknownAndDuplicateFacets(t *testing.T) {
	tests := [][]Facet{
		{Facet("unknown")},
		{FacetInternet, FacetInternet},
	}
	for _, facets := range tests {
		if _, err := FacetBits(facets); err == nil {
			t.Fatalf("FacetBits accepted %#v", facets)
		}
	}
}
