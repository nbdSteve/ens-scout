package report

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"ens-scrape/internal/ens"
)

func TestWriteFiltersText(t *testing.T) {
	expiry := time.Date(2030, time.January, 1, 0, 0, 0, 0, time.UTC)
	results := []ens.Result{
		{Name: "free.eth", Status: ens.StatusAvailable},
		{Name: "held.eth", Status: ens.StatusRegistered, Expiry: &expiry},
	}
	selection, err := ParseSelection("available")
	if err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	count, err := Write(&output, results, "text", selection)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}
	if got := output.String(); got != "free.eth <- AVAILABLE AT STANDARD PRICE\n" {
		t.Fatalf("output = %q", got)
	}
}

func TestWriteCSV(t *testing.T) {
	results := []ens.Result{{Name: "free.eth", Status: ens.StatusAvailable}}
	selection, _ := ParseSelection("all")
	var output bytes.Buffer
	if _, err := Write(&output, results, "csv", selection); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if !strings.HasPrefix(output.String(), "name,status,expiry,grace_ends,premium_ends\nfree.eth,available") {
		t.Fatalf("unexpected CSV: %q", output.String())
	}
}

func TestParseSelectionRejectsUnknownStatus(t *testing.T) {
	if _, err := ParseSelection("available,wat"); err == nil {
		t.Fatal("expected an error")
	}
}

func TestValidateFormatRejectsUnknownFormat(t *testing.T) {
	if err := ValidateFormat("yaml"); err == nil {
		t.Fatal("expected an error")
	}
}
