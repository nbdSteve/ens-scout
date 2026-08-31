// Package report filters and writes scan results.
package report

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"ens-scrape/internal/ens"
)

const DefaultSelection = "available,premium,expiring-soon,grace-ending-soon"

// Selection is a set of statuses to include in a report.
type Selection map[ens.Status]bool

// ParseSelection parses a comma-separated list of statuses, or "all".
func ParseSelection(value string) (Selection, error) {
	selection := make(Selection)
	if strings.EqualFold(strings.TrimSpace(value), "all") {
		for _, status := range ens.Statuses {
			selection[status] = true
		}
		return selection, nil
	}

	valid := make(map[ens.Status]bool, len(ens.Statuses))
	for _, status := range ens.Statuses {
		valid[status] = true
	}
	for _, item := range strings.Split(value, ",") {
		status := ens.Status(strings.ToLower(strings.TrimSpace(item)))
		if status == "" {
			continue
		}
		if !valid[status] {
			return nil, fmt.Errorf("unknown status %q", item)
		}
		selection[status] = true
	}
	if len(selection) == 0 {
		return nil, fmt.Errorf("at least one status must be selected")
	}
	return selection, nil
}

// ValidateFormat checks whether format is supported without writing output.
func ValidateFormat(format string) error {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "text", "jsonl", "csv":
		return nil
	default:
		return fmt.Errorf("unsupported output format %q (use text, jsonl, or csv)", format)
	}
}

// Write emits selected results as text, JSON Lines, or CSV and returns the
// number of records written.
func Write(writer io.Writer, results []ens.Result, format string, selection Selection) (int, error) {
	if err := ValidateFormat(format); err != nil {
		return 0, err
	}
	format = strings.ToLower(strings.TrimSpace(format))
	selected := make([]ens.Result, 0, len(results))
	for _, result := range results {
		if selection[result.Status] {
			selected = append(selected, result)
		}
	}

	switch format {
	case "text":
		return writeText(writer, selected)
	case "jsonl":
		return writeJSONLines(writer, selected)
	case "csv":
		return writeCSV(writer, selected)
	default:
		return 0, fmt.Errorf("unsupported output format %q (use text, jsonl, or csv)", format)
	}
}

func writeText(writer io.Writer, results []ens.Result) (int, error) {
	for i, result := range results {
		if _, err := fmt.Fprintf(writer, "%s <- %s\n", result.Name, description(result)); err != nil {
			return i, err
		}
	}
	return len(results), nil
}

func writeJSONLines(writer io.Writer, results []ens.Result) (int, error) {
	encoder := json.NewEncoder(writer)
	for i, result := range results {
		if err := encoder.Encode(result); err != nil {
			return i, err
		}
	}
	return len(results), nil
}

func writeCSV(writer io.Writer, results []ens.Result) (int, error) {
	csvWriter := csv.NewWriter(writer)
	if err := csvWriter.Write([]string{"name", "status", "expiry", "grace_ends", "premium_ends"}); err != nil {
		return 0, err
	}
	for i, result := range results {
		record := []string{
			result.Name,
			string(result.Status),
			formatTime(result.Expiry),
			formatTime(result.GraceEnds),
			formatTime(result.PremiumEnds),
		}
		if err := csvWriter.Write(record); err != nil {
			return i, err
		}
	}
	csvWriter.Flush()
	if err := csvWriter.Error(); err != nil {
		return 0, err
	}
	return len(results), nil
}

func description(result ens.Result) string {
	switch result.Status {
	case ens.StatusRegistered:
		return "REGISTERED UNTIL " + formatTime(result.Expiry)
	case ens.StatusExpiringSoon:
		return "EXPIRING SOON AT " + formatTime(result.Expiry)
	case ens.StatusGracePeriod:
		return "IN GRACE PERIOD UNTIL " + formatTime(result.GraceEnds)
	case ens.StatusGraceEndingSoon:
		return "GRACE PERIOD ENDING SOON AT " + formatTime(result.GraceEnds)
	case ens.StatusPremium:
		return "AVAILABLE WITH TEMPORARY PREMIUM UNTIL " + formatTime(result.PremiumEnds)
	case ens.StatusAvailable:
		return "AVAILABLE AT STANDARD PRICE"
	default:
		return "STATUS UNKNOWN"
	}
}

func formatTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}
