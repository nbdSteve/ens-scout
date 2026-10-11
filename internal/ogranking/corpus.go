package ogranking

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"ens-scrape/internal/names"
)

var CorpusPaths = []string{
	"data/words/3-letters.txt",
	"data/words/4-letters.txt",
	"data/words/5-letters.txt",
}

// Corpus is the canonical fixed input to a ranking generation.
type Corpus struct {
	Labels []string
	SHA256 string
}

// LoadCorpus reads every committed list, uses names.Normalize as the product's
// one normalization rule, refuses duplicates, and returns byte-wise sorted labels.
func LoadCorpus(repositoryRoot string) (Corpus, error) {
	seen := make(map[string]string)
	var labels []string
	for _, relative := range CorpusPaths {
		path := filepath.Join(repositoryRoot, filepath.FromSlash(relative))
		file, err := os.Open(path)
		if err != nil {
			return Corpus{}, fmt.Errorf("open corpus file %s: %w", relative, err)
		}
		scanErr := scanCorpusFile(file, relative, seen, &labels)
		closeErr := file.Close()
		if scanErr != nil {
			return Corpus{}, scanErr
		}
		if closeErr != nil {
			return Corpus{}, fmt.Errorf("close corpus file %s: %w", relative, closeErr)
		}
	}
	if len(labels) == 0 {
		return Corpus{}, fmt.Errorf("corpus contains no labels")
	}
	sort.Strings(labels)
	return Corpus{Labels: labels, SHA256: CorpusSHA256(labels)}, nil
}

func scanCorpusFile(file *os.File, source string, seen map[string]string, labels *[]string) error {
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for lineNumber := 1; scanner.Scan(); lineNumber++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		label, err := names.Normalize(line)
		if err != nil {
			return fmt.Errorf("%s:%d: %w", source, lineNumber, err)
		}
		if err := ValidateCanonicalLabel(label); err != nil {
			return fmt.Errorf("%s:%d: %w", source, lineNumber, err)
		}
		if first, exists := seen[label]; exists {
			return fmt.Errorf("%s:%d: duplicate label %q first seen in %s", source, lineNumber, label, first)
		}
		seen[label] = fmt.Sprintf("%s:%d", source, lineNumber)
		*labels = append(*labels, label)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read corpus file %s: %w", source, err)
	}
	return nil
}

// ValidateCanonicalLabel checks the compact artifact's bare ASCII label form.
// The product normalization has already run before this stricter corpus check.
func ValidateCanonicalLabel(label string) error {
	if len(label) < 3 || len(label) > 5 {
		return fmt.Errorf("label %q is not 3..5 ASCII letters", label)
	}
	for _, character := range []byte(label) {
		if character < 'a' || character > 'z' {
			return fmt.Errorf("label %q is not 3..5 ASCII letters", label)
		}
	}
	normalized, err := names.Normalize(label)
	if err != nil {
		return err
	}
	if normalized != label {
		return fmt.Errorf("label %q is not canonical", label)
	}
	return nil
}

// CorpusSHA256 hashes the newline-terminated canonical label sequence.
func CorpusSHA256(labels []string) string {
	digest := sha256.New()
	for _, label := range labels {
		digest.Write([]byte(label))
		digest.Write([]byte{'\n'})
	}
	return hex.EncodeToString(digest.Sum(nil))
}

func labelSet(labels []string) map[string]struct{} {
	set := make(map[string]struct{}, len(labels))
	for _, label := range labels {
		set[label] = struct{}{}
	}
	return set
}
