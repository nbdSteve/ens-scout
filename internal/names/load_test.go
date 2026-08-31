package names

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLoadNormalizesAndDeduplicates(t *testing.T) {
	directory := t.TempDir()
	first := filepath.Join(directory, "first.txt")
	second := filepath.Join(directory, "second.txt")
	if err := os.WriteFile(first, []byte("# candidates\nAlpha\nbeta.eth\n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("ALPHA\ngamma\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := Load([]string{first, second}, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := []string{"alpha", "beta", "gamma"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("labels = %#v, want %#v", got, want)
	}
}

func TestLoadFromStdin(t *testing.T) {
	got, err := Load([]string{"-"}, strings.NewReader("one\ntwo.eth\n"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := []string{"one", "two"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("labels = %#v, want %#v", got, want)
	}
}

func TestLoadRejectsNestedName(t *testing.T) {
	_, err := Load([]string{"-"}, strings.NewReader("sub.name.eth\n"))
	if err == nil || !strings.Contains(err.Error(), "second-level") {
		t.Fatalf("error = %v", err)
	}
}
