package ogranking

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestDecodeModelBatchAcceptsExactClosedCoverage(t *testing.T) {
	payload := validModelBatchJSON(t, []string{"ace", "vex"})
	batch, err := DecodeModelBatch(payload, []string{"vex", "ace"})
	if err != nil {
		t.Fatalf("DecodeModelBatch: %v", err)
	}
	got := []string{batch.Items[0].Label, batch.Items[1].Label}
	want := []string{"ace", "vex"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("labels = %#v, want %#v", got, want)
	}
}

func TestDecodeModelBatchFailsClosedOnMalformedOrPartialOutput(t *testing.T) {
	base := validModelBatchDocument([]string{"ace", "vex"})
	tests := []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{
			name: "unknown top-level field",
			mutate: func(document map[string]any) {
				document["prose"] = "not accepted"
			},
			want: "unknown field",
		},
		{
			name: "omitted label",
			mutate: func(document map[string]any) {
				document["items"] = document["items"].([]any)[:1]
			},
			want: "want 2",
		},
		{
			name: "invented label",
			mutate: func(document map[string]any) {
				document["items"].([]any)[0].(map[string]any)["label"] = "zzz"
			},
			want: "invented or changed",
		},
		{
			name: "changed case",
			mutate: func(document map[string]any) {
				document["items"].([]any)[0].(map[string]any)["label"] = "ACE"
			},
			want: "ASCII letters",
		},
		{
			name: "duplicate label",
			mutate: func(document map[string]any) {
				document["items"].([]any)[1].(map[string]any)["label"] = "ace"
			},
			want: "duplicated",
		},
		{
			name: "unknown item field",
			mutate: func(document map[string]any) {
				document["items"].([]any)[0].(map[string]any)["reason"] = "prose"
			},
			want: "unknown field",
		},
		{
			name: "missing score field",
			mutate: func(document map[string]any) {
				delete(
					document["items"].([]any)[0].(map[string]any)["scores"].(map[string]any),
					"memorability",
				)
			},
			want: "missing memorability",
		},
		{
			name: "score above bound",
			mutate: func(document map[string]any) {
				document["items"].([]any)[0].(map[string]any)["scores"].(map[string]any)["visual_form"] = 11
			},
			want: "visual_form",
		},
		{
			name: "unknown facet",
			mutate: func(document map[string]any) {
				document["items"].([]any)[0].(map[string]any)["facets"] = []any{"finance"}
			},
			want: "unknown facet",
		},
		{
			name: "duplicate facet",
			mutate: func(document map[string]any) {
				document["items"].([]any)[0].(map[string]any)["facets"] = []any{"internet", "internet"}
			},
			want: "duplicate facet",
		},
		{
			name: "unknown policy signal",
			mutate: func(document map[string]any) {
				document["items"].([]any)[0].(map[string]any)["policy_signal"] = "probably_safe"
			},
			want: "unknown policy signal",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document := cloneDocument(t, base)
			test.mutate(document)
			payload, err := json.Marshal(document)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := DecodeModelBatch(payload, []string{"ace", "vex"}); err == nil {
				t.Fatal("DecodeModelBatch accepted malformed output")
			} else if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}
		})
	}
}

func TestDecodeModelBatchRejectsTrailingDocument(t *testing.T) {
	payload := append(validModelBatchJSON(t, []string{"ace"}), []byte(`{"items":[]}`)...)
	if _, err := DecodeModelBatch(payload, []string{"ace"}); err == nil {
		t.Fatal("DecodeModelBatch accepted trailing JSON")
	}
}

func TestAggregateModelPassesUsesDimensionMedians(t *testing.T) {
	passes := [][]ModelItem{
		{modelItem("vex", 10, []Facet{FacetInternet}, PolicyNone)},
		{modelItem("vex", 24, []Facet{FacetTechnology, FacetInternet}, PolicyReviewRequired)},
		{modelItem("vex", 20, []Facet{FacetInternet}, PolicyNone)},
	}
	aggregated, err := AggregateModelPasses(passes)
	if err != nil {
		t.Fatalf("AggregateModelPasses: %v", err)
	}
	got := aggregated["vex"]
	if got.Scores.Recognizability != 20 {
		t.Fatalf("median recognizability = %d, want 20", got.Scores.Recognizability)
	}
	if !reflect.DeepEqual(got.Facets, []Facet{FacetInternet}) {
		t.Fatalf("facets = %#v, want internet", got.Facets)
	}
	if got.PolicySignal != PolicyNone {
		t.Fatalf("policy = %q, want none", got.PolicySignal)
	}
	if !reflect.DeepEqual(got.ModelRunScores, []int{640, 780, 740}) {
		t.Fatalf("run scores = %#v", got.ModelRunScores)
	}
}

func TestAggregateModelPassesUsesReviewRequiredForThreeWayPolicyTie(t *testing.T) {
	passes := [][]ModelItem{
		{modelItem("vex", 20, []Facet{FacetInternet}, PolicyNone)},
		{modelItem("vex", 20, []Facet{FacetInternet}, PolicyTrademarkOrBrand)},
		{modelItem("vex", 20, []Facet{FacetInternet}, PolicyPersonOrPolitical)},
	}
	aggregated, err := AggregateModelPasses(passes)
	if err != nil {
		t.Fatalf("AggregateModelPasses: %v", err)
	}
	if got := aggregated["vex"].PolicySignal; got != PolicyReviewRequired {
		t.Fatalf("policy = %q, want review_required", got)
	}
}

func validModelBatchJSON(t *testing.T, labels []string) []byte {
	t.Helper()
	payload, err := json.Marshal(validModelBatchDocument(labels))
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func validModelBatchDocument(labels []string) map[string]any {
	items := make([]any, 0, len(labels))
	for _, label := range labels {
		items = append(items, map[string]any{
			"label": label,
			"scores": map[string]any{
				"recognizability":    20,
				"memorability":       16,
				"semantic_density":   12,
				"distinctiveness":    12,
				"visual_form":        8,
				"internet_resonance": 7,
				"versatility":        4,
				"residue_penalty":    1,
				"confusion_penalty":  1,
			},
			"facets":        []any{"internet"},
			"policy_signal": "none",
		})
	}
	return map[string]any{"items": items}
}

func cloneDocument(t *testing.T, input map[string]any) map[string]any {
	t.Helper()
	payload, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var output map[string]any
	if err := json.Unmarshal(payload, &output); err != nil {
		t.Fatal(err)
	}
	return output
}

func modelItem(label string, recognizability int, facets []Facet, policy PolicySignal) ModelItem {
	return ModelItem{
		Label: label,
		Scores: Scores{
			Recognizability:   recognizability,
			Memorability:      15,
			SemanticDensity:   10,
			Distinctiveness:   10,
			VisualForm:        8,
			InternetResonance: 7,
			Versatility:       4,
			ResiduePenalty:    0,
			ConfusionPenalty:  0,
		},
		Facets:       facets,
		PolicySignal: policy,
	}
}
