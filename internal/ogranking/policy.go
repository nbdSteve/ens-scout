package ogranking

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	ReasonUnreviewed                = "unreviewed"
	ReasonReviewedFeatureSafe       = "reviewed_feature_safe"
	ReasonExactAdult                = "exact_adult"
	ReasonExactHate                 = "exact_hate_or_harassment"
	ReasonExactBrand                = "exact_trademark_or_brand"
	ReasonExactPerson               = "exact_person_or_political"
	ReasonExactImpersonation        = "exact_misleading_or_impersonation"
	ReasonExactHarmful              = "exact_illegal_or_harmful"
	ReasonPatternAdult              = "pattern_adult"
	ReasonPatternHate               = "pattern_hate_or_harassment"
	ReasonPatternImpersonation      = "pattern_misleading_or_impersonation"
	ReasonModelAdvisory             = "model_advisory"
	ReasonConservativeExclusion     = "conservative_exclusion"
	ReasonBrandPrimaryMeaning       = "brand_primary_meaning"
	ReasonPublicFigure              = "public_figure_or_political"
	ReasonImpersonationRisk         = "impersonation_risk"
	ReasonFalsePositiveCleared      = "deterministic_false_positive_cleared"
	ReasonModelFalsePositiveCleared = "model_false_positive_cleared"
	ReasonEditorialCalibration      = "editorial_calibration"
)

var knownReasonCodes = map[string]struct{}{
	ReasonUnreviewed:                {},
	ReasonReviewedFeatureSafe:       {},
	ReasonExactAdult:                {},
	ReasonExactHate:                 {},
	ReasonExactBrand:                {},
	ReasonExactPerson:               {},
	ReasonExactImpersonation:        {},
	ReasonExactHarmful:              {},
	ReasonPatternAdult:              {},
	ReasonPatternHate:               {},
	ReasonPatternImpersonation:      {},
	ReasonModelAdvisory:             {},
	ReasonConservativeExclusion:     {},
	ReasonBrandPrimaryMeaning:       {},
	ReasonPublicFigure:              {},
	ReasonImpersonationRisk:         {},
	ReasonFalsePositiveCleared:      {},
	ReasonModelFalsePositiveCleared: {},
	ReasonEditorialCalibration:      {},
}

type policyFinding struct {
	Eligibility Eligibility
	ReasonCode  string
}

var exactPolicy = map[string]policyFinding{
	// Adult and sexual content.
	"anal":  {EligibilityAdult, ReasonExactAdult},
	"boob":  {EligibilityAdult, ReasonExactAdult},
	"cock":  {EligibilityAdult, ReasonExactAdult},
	"cunt":  {EligibilityAdult, ReasonExactAdult},
	"dick":  {EligibilityAdult, ReasonExactAdult},
	"fuck":  {EligibilityAdult, ReasonExactAdult},
	"nude":  {EligibilityAdult, ReasonExactAdult},
	"porn":  {EligibilityAdult, ReasonExactAdult},
	"rape":  {EligibilityAdult, ReasonExactAdult},
	"sex":   {EligibilityAdult, ReasonExactAdult},
	"slut":  {EligibilityAdult, ReasonExactAdult},
	"whore": {EligibilityAdult, ReasonExactAdult},

	// Hate, harassment, and dehumanising language.
	"kkk":   {EligibilityHateOrHarassment, ReasonExactHate},
	"nazi":  {EligibilityHateOrHarassment, ReasonExactHate},
	"slave": {EligibilityHateOrHarassment, ReasonExactHate},

	// Exact globally prominent marks whose primary modern reading is the brand.
	"adobe": {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"apple": {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"coke":  {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"ebay":  {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"gucci": {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"intel": {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"lego":  {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"meta":  {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"nike":  {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"pepsi": {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"sony":  {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"tesla": {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"uber":  {EligibilityTrademarkOrBrand, ReasonExactBrand},
	"visa":  {EligibilityTrademarkOrBrand, ReasonExactBrand},

	// Public figures and political identities.
	"biden": {EligibilityPersonOrPolitical, ReasonExactPerson},
	"elon":  {EligibilityPersonOrPolitical, ReasonExactPerson},
	"kanye": {EligibilityPersonOrPolitical, ReasonExactPerson},
	"musk":  {EligibilityPersonOrPolitical, ReasonExactPerson},
	"obama": {EligibilityPersonOrPolitical, ReasonExactPerson},
	"putin": {EligibilityPersonOrPolitical, ReasonExactPerson},
	"trump": {EligibilityPersonOrPolitical, ReasonExactPerson},

	// Official-looking or account-recovery terms.
	"admin": {EligibilityMisleadingOrImpersonation, ReasonExactImpersonation},
	"ceo":   {EligibilityMisleadingOrImpersonation, ReasonExactImpersonation},
	"gov":   {EligibilityMisleadingOrImpersonation, ReasonExactImpersonation},
	"login": {EligibilityMisleadingOrImpersonation, ReasonExactImpersonation},
	"mod":   {EligibilityMisleadingOrImpersonation, ReasonExactImpersonation},
	"staff": {EligibilityMisleadingOrImpersonation, ReasonExactImpersonation},

	// Clear harmful or illegal-use readings.
	"bomb": {EligibilityIllegalOrHarmful, ReasonExactHarmful},
	"meth": {EligibilityIllegalOrHarmful, ReasonExactHarmful},
}

var adultPatterns = []string{"fuk", "pron"}
var hatePatterns = []string{"naz"}
var impersonationPatterns = []string{"adm", "login", "staff"}

// DeterministicPolicy applies conservative exact and ASCII-pattern checks. A
// missing finding never means safe; the default remains review_required.
func DeterministicPolicy(label string) (Eligibility, string, bool) {
	if finding, ok := exactPolicy[label]; ok {
		return finding.Eligibility, finding.ReasonCode, true
	}
	for _, pattern := range adultPatterns {
		if strings.Contains(label, pattern) {
			return EligibilityAdult, ReasonPatternAdult, true
		}
	}
	for _, pattern := range hatePatterns {
		if strings.Contains(label, pattern) {
			return EligibilityHateOrHarassment, ReasonPatternHate, true
		}
	}
	for _, pattern := range impersonationPatterns {
		if strings.Contains(label, pattern) {
			return EligibilityMisleadingOrImpersonation, ReasonPatternImpersonation, true
		}
	}
	return "", "", false
}

// ReviewDecisions is the repository-owned human review layer.
type ReviewDecisions struct {
	FormatVersion     int              `json:"format_version"`
	PolicyVersion     string           `json:"policy_version"`
	Reviewer          string           `json:"reviewer"`
	ReviewedAt        string           `json:"reviewed_at"`
	ReviewedHeadCount int              `json:"reviewed_head_count"`
	Decisions         []ReviewDecision `json:"decisions"`
}

type ReviewDecision struct {
	Label         string         `json:"label"`
	Eligibility   Eligibility    `json:"eligibility"`
	ReasonCode    string         `json:"reason_code"`
	Note          string         `json:"note"`
	ScoreOverride *ScoreOverride `json:"score_override"`
}

type ScoreOverride struct {
	From       int    `json:"from"`
	To         int    `json:"to"`
	ReasonCode string `json:"reason_code"`
	Note       string `json:"note"`
}

type AppliedOverride struct {
	ReasonCode string `json:"reason_code"`
	Note       string `json:"note"`
	Reviewer   string `json:"reviewer"`
	ReviewedAt string `json:"reviewed_at"`
}

// LoadReviewDecisions reads the closed review document and validates labels
// independently from the corpus membership check performed by the builder.
func LoadReviewDecisions(repositoryRoot string) (ReviewDecisions, []byte, error) {
	path := filepath.Join(repositoryRoot, "data", "ranking", "og-v1.decisions.json")
	payload, err := os.ReadFile(path)
	if err != nil {
		return ReviewDecisions{}, nil, fmt.Errorf("read review decisions: %w", err)
	}
	var decisions ReviewDecisions
	if err := decodeClosedJSON(payload, &decisions); err != nil {
		return ReviewDecisions{}, nil, fmt.Errorf("decode review decisions: %w", err)
	}
	if decisions.FormatVersion != DecisionsFormatVersion {
		return ReviewDecisions{}, nil, fmt.Errorf(
			"review decisions format_version is %d, want %d",
			decisions.FormatVersion,
			DecisionsFormatVersion,
		)
	}
	if decisions.PolicyVersion != PolicyVersion {
		return ReviewDecisions{}, nil, fmt.Errorf(
			"review decisions policy_version is %q, want %q",
			decisions.PolicyVersion,
			PolicyVersion,
		)
	}
	if strings.TrimSpace(decisions.Reviewer) == "" {
		return ReviewDecisions{}, nil, fmt.Errorf("review decisions have no reviewer")
	}
	if !validReviewDate(decisions.ReviewedAt) {
		return ReviewDecisions{}, nil, fmt.Errorf("reviewed_at %q is not YYYY-MM-DD", decisions.ReviewedAt)
	}
	if decisions.ReviewedHeadCount < 1 {
		return ReviewDecisions{}, nil, fmt.Errorf("reviewed_head_count must be positive")
	}
	seen := make(map[string]struct{}, len(decisions.Decisions))
	for index, decision := range decisions.Decisions {
		if err := ValidateCanonicalLabel(decision.Label); err != nil {
			return ReviewDecisions{}, nil, fmt.Errorf("decision %d: %w", index, err)
		}
		if _, duplicate := seen[decision.Label]; duplicate {
			return ReviewDecisions{}, nil, fmt.Errorf("duplicate review decision for %q", decision.Label)
		}
		seen[decision.Label] = struct{}{}
		if !isKnownEligibility(decision.Eligibility) {
			return ReviewDecisions{}, nil, fmt.Errorf(
				"decision for %q has unknown eligibility %q",
				decision.Label,
				decision.Eligibility,
			)
		}
		if _, ok := knownReasonCodes[decision.ReasonCode]; !ok {
			return ReviewDecisions{}, nil, fmt.Errorf(
				"decision for %q has unknown reason code %q",
				decision.Label,
				decision.ReasonCode,
			)
		}
		if strings.TrimSpace(decision.Note) == "" {
			return ReviewDecisions{}, nil, fmt.Errorf("decision for %q has no review note", decision.Label)
		}
		if err := validateDecisionReason(decision); err != nil {
			return ReviewDecisions{}, nil, err
		}
		if decision.ScoreOverride != nil {
			override := decision.ScoreOverride
			if override.From < 0 || override.From > 1000 || override.To < 0 || override.To > 1000 {
				return ReviewDecisions{}, nil, fmt.Errorf("score override for %q is outside 0..1000", decision.Label)
			}
			if override.From == override.To {
				return ReviewDecisions{}, nil, fmt.Errorf("score override for %q changes nothing", decision.Label)
			}
			if override.ReasonCode != ReasonEditorialCalibration {
				return ReviewDecisions{}, nil, fmt.Errorf(
					"score override for %q has unsupported reason %q",
					decision.Label,
					override.ReasonCode,
				)
			}
			if strings.TrimSpace(override.Note) == "" {
				return ReviewDecisions{}, nil, fmt.Errorf("score override for %q has no note", decision.Label)
			}
		}
	}
	return decisions, payload, nil
}

func validReviewDate(value string) bool {
	parsed, err := time.Parse("2006-01-02", value)
	return err == nil && parsed.Format("2006-01-02") == value
}

func validateDecisionReason(decision ReviewDecision) error {
	switch decision.Eligibility {
	case EligibilityFeatureable:
		if decision.ReasonCode != ReasonReviewedFeatureSafe &&
			decision.ReasonCode != ReasonFalsePositiveCleared &&
			decision.ReasonCode != ReasonModelFalsePositiveCleared {
			return fmt.Errorf(
				"featureable decision for %q has non-clearance reason %q",
				decision.Label,
				decision.ReasonCode,
			)
		}
	case EligibilityReviewRequired:
		if decision.ReasonCode == ReasonReviewedFeatureSafe {
			return fmt.Errorf(
				"review-required decision for %q has feature-safe reason %q",
				decision.Label,
				decision.ReasonCode,
			)
		}
	default:
		if decision.ReasonCode == ReasonReviewedFeatureSafe ||
			decision.ReasonCode == ReasonFalsePositiveCleared ||
			decision.ReasonCode == ReasonModelFalsePositiveCleared {
			return fmt.Errorf(
				"ineligible decision for %q has feature-safe reason %q",
				decision.Label,
				decision.ReasonCode,
			)
		}
	}
	return nil
}

func decodeClosedJSON(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

func decisionMap(decisions ReviewDecisions, corpus map[string]struct{}) (map[string]ReviewDecision, error) {
	output := make(map[string]ReviewDecision, len(decisions.Decisions))
	for _, decision := range decisions.Decisions {
		if _, ok := corpus[decision.Label]; !ok {
			return nil, fmt.Errorf("review decision label %q is not in the corpus", decision.Label)
		}
		output[decision.Label] = decision
	}
	return output, nil
}

func applyEligibility(
	label string,
	modelSignal PolicySignal,
	decision *ReviewDecision,
	reviewer string,
	reviewedAt string,
) (Eligibility, []string, *AppliedOverride, error) {
	baseEligibility := EligibilityReviewRequired
	baseReason := ReasonUnreviewed
	baseSource := "default"
	if deterministic, reason, ok := DeterministicPolicy(label); ok {
		baseEligibility = deterministic
		baseReason = reason
		baseSource = "deterministic"
	} else if modelSignal != "" && modelSignal != PolicyNone {
		baseEligibility = eligibilityForSignal(modelSignal)
		baseReason = ReasonModelAdvisory
		baseSource = "model"
	}
	if decision == nil {
		return baseEligibility, []string{baseReason}, nil, nil
	}
	if decision.Eligibility == EligibilityFeatureable {
		switch baseSource {
		case "deterministic":
			if decision.ReasonCode != ReasonFalsePositiveCleared {
				return "", nil, nil, fmt.Errorf(
					"featureable decision for %q does not explicitly clear deterministic policy %q",
					label,
					baseEligibility,
				)
			}
		case "model":
			if decision.ReasonCode != ReasonModelFalsePositiveCleared {
				return "", nil, nil, fmt.Errorf(
					"featureable decision for %q does not explicitly clear model policy %q",
					label,
					baseEligibility,
				)
			}
		default:
			if decision.ReasonCode != ReasonReviewedFeatureSafe {
				return "", nil, nil, fmt.Errorf(
					"featureable decision for %q does not carry reviewed feature-safe evidence",
					label,
				)
			}
		}
	} else if baseSource == "deterministic" &&
		decision.Eligibility != baseEligibility &&
		!(decision.Eligibility == EligibilityReviewRequired &&
			decision.ReasonCode == ReasonFalsePositiveCleared) {
		return "", nil, nil, fmt.Errorf(
			"decision for %q changes deterministic eligibility %q to %q without clearing it",
			label,
			baseEligibility,
			decision.Eligibility,
		)
	} else if baseSource == "model" &&
		decision.ReasonCode == ReasonModelAdvisory &&
		decision.Eligibility != baseEligibility {
		return "", nil, nil, fmt.Errorf(
			"model-advisory decision for %q does not match signal eligibility %q",
			label,
			baseEligibility,
		)
	}
	override := &AppliedOverride{
		ReasonCode: decision.ReasonCode,
		Note:       decision.Note,
		Reviewer:   reviewer,
		ReviewedAt: reviewedAt,
	}
	return decision.Eligibility, []string{decision.ReasonCode}, override, nil
}
