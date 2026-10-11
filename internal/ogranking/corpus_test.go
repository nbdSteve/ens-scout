package ogranking

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const committedCorpusSHA256 = "647b9aa913803510f5ab875136771c5cc3e663445524cc77e0dfd7a7cd6251e8"

func TestCommittedCorpusHasCanonicalCountAndHash(t *testing.T) {
	corpus, err := LoadCorpus(testRepositoryRoot(t))
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}
	if len(corpus.Labels) != 19051 {
		t.Fatalf("corpus count = %d, want 19051", len(corpus.Labels))
	}
	if corpus.SHA256 != committedCorpusSHA256 {
		t.Fatalf("corpus SHA-256 = %s, want %s", corpus.SHA256, committedCorpusSHA256)
	}
	for index, label := range corpus.Labels {
		if err := ValidateCanonicalLabel(label); err != nil {
			t.Fatalf("label %d %q: %v", index, label, err)
		}
		if index > 0 && corpus.Labels[index-1] >= label {
			t.Fatalf("corpus is not strictly sorted at %q, %q", corpus.Labels[index-1], label)
		}
	}
}

func TestLoadCorpusRejectsDuplicateAfterProductNormalization(t *testing.T) {
	root := t.TempDir()
	writeCorpusFile(t, root, CorpusPaths[0], "Ace\n")
	writeCorpusFile(t, root, CorpusPaths[1], "ACE.eth\n")
	writeCorpusFile(t, root, CorpusPaths[2], "about\n")

	_, err := LoadCorpus(root)
	if err == nil || !strings.Contains(err.Error(), "duplicate label") {
		t.Fatalf("error = %v, want duplicate refusal", err)
	}
}

func TestLoadCorpusRejectsLabelOutsideCommittedShape(t *testing.T) {
	root := t.TempDir()
	writeCorpusFile(t, root, CorpusPaths[0], "ok\n")
	writeCorpusFile(t, root, CorpusPaths[1], "four\n")
	writeCorpusFile(t, root, CorpusPaths[2], "fives\n")

	_, err := LoadCorpus(root)
	if err == nil || !strings.Contains(err.Error(), "3..5 ASCII letters") {
		t.Fatalf("error = %v, want shape refusal", err)
	}
}

func writeCorpusFile(t *testing.T, root, relative, contents string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
