// Package names loads and normalizes candidate ENS labels.
package names

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode"
)

const maxLineSize = 1024 * 1024

// Load reads one candidate per line from paths. A path of "-" reads stdin.
// Blank lines, comments, and duplicate labels are ignored.
func Load(paths []string, stdin io.Reader) ([]string, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("at least one input file is required")
	}

	seen := make(map[string]struct{})
	var labels []string
	stdinUsed := false

	for _, path := range paths {
		var (
			reader io.Reader
			close  func() error
		)

		if path == "-" {
			if stdinUsed {
				return nil, fmt.Errorf("stdin can only be used once")
			}
			if stdin == nil {
				return nil, fmt.Errorf("stdin reader is unavailable")
			}
			stdinUsed = true
			reader = stdin
			close = func() error { return nil }
		} else {
			file, err := os.Open(path)
			if err != nil {
				return nil, fmt.Errorf("open %s: %w", path, err)
			}
			reader = file
			close = file.Close
		}

		loaded, err := loadReader(reader, path, seen)
		closeErr := close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close %s: %w", path, closeErr)
		}
		labels = append(labels, loaded...)
	}

	return labels, nil
}

func loadReader(reader io.Reader, source string, seen map[string]struct{}) ([]string, error) {
	var labels []string
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), maxLineSize)

	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		label, err := Normalize(line)
		if err != nil {
			return nil, fmt.Errorf("%s:%d: %w", source, lineNumber, err)
		}
		if _, exists := seen[label]; exists {
			continue
		}
		seen[label] = struct{}{}
		labels = append(labels, label)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read %s: %w", source, err)
	}
	return labels, nil
}

// Normalize lowercases a label, strips an optional ".eth" suffix, and rejects
// anything that is not a single second-level label. It is the one place that
// decides what a candidate label looks like, so loaders, snapshots, and later
// API request handling all agree.
func Normalize(value string) (string, error) {
	label := strings.ToLower(strings.TrimSpace(value))
	label = strings.TrimSuffix(label, ".eth")
	if label == "" {
		return "", fmt.Errorf("empty ENS label")
	}
	if strings.Contains(label, ".") {
		return "", fmt.Errorf("expected a label or second-level .eth name, got %q", value)
	}
	if strings.IndexFunc(label, unicode.IsSpace) >= 0 {
		return "", fmt.Errorf("ENS label contains whitespace: %q", value)
	}
	if strings.IndexFunc(label, unicode.IsControl) >= 0 {
		return "", fmt.Errorf("ENS label contains control characters")
	}
	return label, nil
}
