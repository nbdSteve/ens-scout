package ogranking

import (
	"reflect"
	"strings"
	"testing"
)

func TestDeterministicPolicyBlocksAdversarialCorpusFixtures(t *testing.T) {
	tests := []struct {
		label string
		want  Eligibility
	}{
		{"sex", EligibilityAdult},
		{"cock", EligibilityAdult},
		{"kkk", EligibilityHateOrHarassment},
		{"nazi", EligibilityHateOrHarassment},
		{"apple", EligibilityTrademarkOrBrand},
		{"tesla", EligibilityTrademarkOrBrand},
		{"trump", EligibilityPersonOrPolitical},
		{"admin", EligibilityMisleadingOrImpersonation},
		{"bomb", EligibilityIllegalOrHarmful},
	}
	for _, test := range tests {
		t.Run(test.label, func(t *testing.T) {
			got, _, ok := DeterministicPolicy(test.label)
			if !ok {
				t.Fatal("label had no deterministic policy finding")
			}
			if got != test.want {
				t.Fatalf("eligibility = %q, want %q", got, test.want)
			}
		})
	}
}

func TestUnreviewedLabelFailsClosed(t *testing.T) {
	eligibility, reasons, override, err := applyEligibility(
		"vex",
		PolicyNone,
		nil,
		"reviewer",
		"2026-10-10",
	)
	if err != nil {
		t.Fatalf("applyEligibility: %v", err)
	}
	if eligibility != EligibilityReviewRequired {
		t.Fatalf("eligibility = %q, want review_required", eligibility)
	}
	if !reflect.DeepEqual(reasons, []string{ReasonUnreviewed}) {
		t.Fatalf("reasons = %#v", reasons)
	}
	if override != nil {
		t.Fatalf("override = %#v, want nil", override)
	}
}

func TestExplicitReviewedDecisionMakesSafeLabelFeatureable(t *testing.T) {
	decision := &ReviewDecision{
		Label:       "vex",
		Eligibility: EligibilityFeatureable,
		ReasonCode:  ReasonReviewedFeatureSafe,
		Note:        "Reviewed for featured placement.",
	}
	eligibility, _, override, err := applyEligibility(
		"vex",
		PolicyNone,
		decision,
		"repository review",
		"2026-10-10",
	)
	if err != nil {
		t.Fatalf("applyEligibility: %v", err)
	}
	if eligibility != EligibilityFeatureable {
		t.Fatalf("eligibility = %q, want featureable", eligibility)
	}
	if override == nil || override.ReasonCode != ReasonReviewedFeatureSafe {
		t.Fatalf("override = %#v", override)
	}
}

func TestBlockedLabelRequiresExplicitFalsePositiveClearance(t *testing.T) {
	decision := &ReviewDecision{
		Label:       "apple",
		Eligibility: EligibilityFeatureable,
		ReasonCode:  ReasonReviewedFeatureSafe,
		Note:        "Unsafe attempt.",
	}
	_, _, _, err := applyEligibility(
		"apple",
		PolicyNone,
		decision,
		"repository review",
		"2026-10-10",
	)
	if err == nil || !strings.Contains(err.Error(), "does not explicitly clear") {
		t.Fatalf("error = %v, want hard-gate refusal", err)
	}
}

func TestModelReviewRequiredNeedsExplicitClearanceBeforeFeatureable(t *testing.T) {
	decision := &ReviewDecision{
		Label:       "vex",
		Eligibility: EligibilityFeatureable,
		ReasonCode:  ReasonReviewedFeatureSafe,
		Note:        "Unsafe attempt to bypass advisory uncertainty.",
	}
	_, _, _, err := applyEligibility(
		"vex",
		PolicyReviewRequired,
		decision,
		"repository review",
		"2026-10-10",
	)
	if err == nil || !strings.Contains(err.Error(), "does not explicitly clear model policy") {
		t.Fatalf("error = %v, want model-clearance refusal", err)
	}
}

func TestDeterministicBlockCannotBeRecategorizedWithoutClearance(t *testing.T) {
	decision := &ReviewDecision{
		Label:       "apple",
		Eligibility: EligibilityReviewRequired,
		ReasonCode:  ReasonConservativeExclusion,
		Note:        "Unsafe attempt to discard the deterministic category.",
	}
	_, _, _, err := applyEligibility(
		"apple",
		PolicyNone,
		decision,
		"repository review",
		"2026-10-10",
	)
	if err == nil || !strings.Contains(err.Error(), "changes deterministic eligibility") {
		t.Fatalf("error = %v, want deterministic-category refusal", err)
	}
}

func TestDeterministicFalsePositiveCanBeExplicitlyCleared(t *testing.T) {
	decision := &ReviewDecision{
		Label:       "prone",
		Eligibility: EligibilityFeatureable,
		ReasonCode:  ReasonFalsePositiveCleared,
		Note:        "The pattern matched a neutral dictionary word.",
	}
	eligibility, _, _, err := applyEligibility(
		"prone",
		PolicyNone,
		decision,
		"repository review",
		"2026-10-10",
	)
	if err != nil {
		t.Fatalf("applyEligibility: %v", err)
	}
	if eligibility != EligibilityFeatureable {
		t.Fatalf("eligibility = %q, want featureable", eligibility)
	}
}

func TestDeterministicFalsePositiveCanRemainConservativelyIneligible(t *testing.T) {
	decision := &ReviewDecision{
		Label:       "prone",
		Eligibility: EligibilityReviewRequired,
		ReasonCode:  ReasonFalsePositiveCleared,
		Note:        "The pattern matched a neutral word, which is not otherwise approved.",
	}
	eligibility, reasons, _, err := applyEligibility(
		"prone",
		PolicyNone,
		decision,
		"repository review",
		"2026-10-11",
	)
	if err != nil {
		t.Fatalf("applyEligibility: %v", err)
	}
	if eligibility != EligibilityReviewRequired {
		t.Fatalf("eligibility = %q, want review_required", eligibility)
	}
	if !reflect.DeepEqual(reasons, []string{ReasonFalsePositiveCleared}) {
		t.Fatalf("reasons = %#v", reasons)
	}
}

func TestReviewDateRejectsImpossibleCalendarDate(t *testing.T) {
	if validReviewDate("2026-99-99") {
		t.Fatal("validReviewDate accepted an impossible date")
	}
}

func TestDecisionReasonMustMatchFeatureability(t *testing.T) {
	tests := []ReviewDecision{
		{
			Label:       "vex",
			Eligibility: EligibilityFeatureable,
			ReasonCode:  ReasonConservativeExclusion,
		},
		{
			Label:       "vex",
			Eligibility: EligibilityReviewRequired,
			ReasonCode:  ReasonReviewedFeatureSafe,
		},
	}
	for _, decision := range tests {
		if err := validateDecisionReason(decision); err == nil {
			t.Fatalf("validateDecisionReason accepted %#v", decision)
		}
	}
}
