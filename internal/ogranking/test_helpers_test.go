package ogranking

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func testRepositoryRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func copyFile(t *testing.T, source, target string) {
	t.Helper()
	payload, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, payload, 0o600); err != nil {
		t.Fatal(err)
	}
}

func copyGenerationInputs(t *testing.T) string {
	t.Helper()
	sourceRoot := testRepositoryRoot(t)
	targetRoot := t.TempDir()
	for _, relative := range append(
		append([]string(nil), CorpusPaths...),
		"data/ranking/og-v1.rubric.md",
		"data/ranking/og-v1.prompt.md",
		"data/ranking/og-v1.calibration.json",
	) {
		copyFile(
			t,
			filepath.Join(sourceRoot, filepath.FromSlash(relative)),
			filepath.Join(targetRoot, filepath.FromSlash(relative)),
		)
	}
	return targetRoot
}

type fakeModelRunner struct {
	calls         int
	malformed     bool
	policyByLabel map[string]PolicySignal
}

func (runner *fakeModelRunner) Identity() ModelIdentity {
	return ModelIdentity{
		Provider:           "amazon-bedrock",
		ModelID:            "test.model-v1",
		ModelRevision:      "test.model-v1",
		CatalogComposition: "test",
		Interface:          "codex-cli",
		InterfaceVersion:   "test",
	}
}

func (runner *fakeModelRunner) Generate(
	_ context.Context,
	_ string,
	schema []byte,
) ([]byte, TokenUsage, error) {
	runner.calls++
	labels := schemaLabels(schema)
	if runner.malformed && len(labels) > 0 {
		labels = labels[:len(labels)-1]
	}
	items := make([]ModelItem, 0, len(labels))
	for _, label := range labels {
		passAdjustment := (runner.calls - 1) / (DefaultCandidateCount / DefaultBatchSize)
		scores := Scores{
			Recognizability:   22 + passAdjustment,
			Memorability:      19,
			SemanticDensity:   14,
			Distinctiveness:   14,
			VisualForm:        9,
			InternetResonance: 9,
			Versatility:       5,
		}
		signal := PolicyNone
		if configured, ok := runner.policyByLabel[label]; ok {
			signal = configured
		}
		items = append(items, ModelItem{
			Label:        label,
			Scores:       scores,
			Facets:       []Facet{FacetAbstractConceptual},
			PolicySignal: signal,
		})
	}
	payload, err := json.Marshal(ModelBatch{Items: items})
	if err != nil {
		panic(err)
	}
	return payload, TokenUsage{InputTokens: 100, OutputTokens: 200}, nil
}

func schemaLabels(schema []byte) []string {
	var document struct {
		Properties struct {
			Items struct {
				Items struct {
					Properties struct {
						Label struct {
							Enum []string `json:"enum"`
						} `json:"label"`
					} `json:"properties"`
				} `json:"items"`
			} `json:"items"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(schema, &document); err != nil {
		panic(err)
	}
	labels := append([]string(nil), document.Properties.Items.Items.Properties.Label.Enum...)
	sort.Strings(labels)
	return labels
}
