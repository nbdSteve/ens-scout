package ogranking

import (
	"fmt"
	"os"
	"path/filepath"
)

const (
	CalibrationStrong           = "strong"
	CalibrationOrdinary         = "ordinary"
	CalibrationAwkward          = "awkward"
	CalibrationPolicyIneligible = "policy_ineligible"
)

var calibrationTiers = []string{
	CalibrationStrong,
	CalibrationOrdinary,
	CalibrationAwkward,
	CalibrationPolicyIneligible,
}

type Calibration struct {
	FormatVersion int               `json:"format_version"`
	RubricVersion string            `json:"rubric_version"`
	Items         []CalibrationItem `json:"items"`
}

type CalibrationItem struct {
	Label        string       `json:"label"`
	Tier         string       `json:"tier"`
	PolicySignal PolicySignal `json:"policy_signal"`
}

func LoadCalibration(repositoryRoot string, corpus map[string]struct{}) (Calibration, []byte, error) {
	path := filepath.Join(repositoryRoot, "data", "ranking", "og-v1.calibration.json")
	payload, err := os.ReadFile(path)
	if err != nil {
		return Calibration{}, nil, fmt.Errorf("read calibration: %w", err)
	}
	var calibration Calibration
	if err := decodeClosedJSON(payload, &calibration); err != nil {
		return Calibration{}, nil, fmt.Errorf("decode calibration: %w", err)
	}
	if calibration.FormatVersion != CalibrationFormatVersion {
		return Calibration{}, nil, fmt.Errorf(
			"calibration format_version is %d, want %d",
			calibration.FormatVersion,
			CalibrationFormatVersion,
		)
	}
	if calibration.RubricVersion != RubricVersion {
		return Calibration{}, nil, fmt.Errorf(
			"calibration rubric_version is %q, want %q",
			calibration.RubricVersion,
			RubricVersion,
		)
	}
	if len(calibration.Items) != 80 {
		return Calibration{}, nil, fmt.Errorf("calibration contains %d items, want 80", len(calibration.Items))
	}
	counts := make(map[string]int, len(calibrationTiers))
	seen := make(map[string]struct{}, len(calibration.Items))
	for index, item := range calibration.Items {
		if err := ValidateCanonicalLabel(item.Label); err != nil {
			return Calibration{}, nil, fmt.Errorf("calibration item %d: %w", index, err)
		}
		if _, ok := corpus[item.Label]; !ok {
			return Calibration{}, nil, fmt.Errorf("calibration label %q is not in the corpus", item.Label)
		}
		if _, duplicate := seen[item.Label]; duplicate {
			return Calibration{}, nil, fmt.Errorf("duplicate calibration label %q", item.Label)
		}
		seen[item.Label] = struct{}{}
		if !containsString(calibrationTiers, item.Tier) {
			return Calibration{}, nil, fmt.Errorf("calibration label %q has unknown tier %q", item.Label, item.Tier)
		}
		if !isKnownPolicySignal(item.PolicySignal) {
			return Calibration{}, nil, fmt.Errorf(
				"calibration label %q has unknown policy signal %q",
				item.Label,
				item.PolicySignal,
			)
		}
		if item.Tier == CalibrationPolicyIneligible {
			if item.PolicySignal == PolicyNone || item.PolicySignal == PolicyReviewRequired {
				return Calibration{}, nil, fmt.Errorf(
					"policy calibration label %q has non-policy signal %q",
					item.Label,
					item.PolicySignal,
				)
			}
		} else if item.PolicySignal != PolicyNone {
			return Calibration{}, nil, fmt.Errorf(
				"quality calibration label %q has policy signal %q",
				item.Label,
				item.PolicySignal,
			)
		}
		counts[item.Tier]++
	}
	for _, tier := range calibrationTiers {
		if counts[tier] != 20 {
			return Calibration{}, nil, fmt.Errorf(
				"calibration tier %q contains %d items, want 20",
				tier,
				counts[tier],
			)
		}
	}
	return calibration, payload, nil
}

func StrongCalibrationLabels(calibration Calibration) []string {
	var labels []string
	for _, item := range calibration.Items {
		if item.Tier == CalibrationStrong {
			labels = append(labels, item.Label)
		}
	}
	return labels
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
