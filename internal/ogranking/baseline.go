package ogranking

import (
	"fmt"
	"sort"
	"strings"
)

// Candidate is one deterministic preselection entry. BaselineScore selects the
// bounded set sent to the model; it is not a model score or an availability claim.
type Candidate struct {
	Label         string `json:"label"`
	BaselineScore int    `json:"baseline_score"`
	Forced        bool   `json:"calibration_anchor,omitempty"`
}

var commonBigrams = map[string]struct{}{
	"ai": {}, "al": {}, "an": {}, "ar": {}, "as": {}, "at": {}, "be": {}, "ch": {},
	"co": {}, "de": {}, "ea": {}, "ed": {}, "en": {}, "er": {}, "es": {}, "ha": {},
	"he": {}, "hi": {}, "ic": {}, "in": {}, "io": {}, "is": {}, "it": {}, "le": {},
	"li": {}, "ll": {}, "ma": {}, "me": {}, "mo": {}, "nd": {}, "ne": {}, "ng": {},
	"nt": {}, "of": {}, "om": {}, "on": {}, "or": {}, "ou": {}, "ra": {}, "re": {},
	"ri": {}, "ro": {}, "se": {}, "si": {}, "st": {}, "te": {}, "th": {}, "ti": {},
	"to": {}, "ur": {}, "ve": {},
}

var awkwardClusters = map[string]struct{}{
	"aa": {}, "ae": {}, "ao": {}, "eu": {}, "ii": {}, "iu": {}, "jj": {}, "qj": {},
	"qx": {}, "qy": {}, "qz": {}, "uu": {}, "ww": {}, "xq": {}, "xx": {}, "zq": {},
	"zx": {}, "zz": {},
}

var residueSuffixes = []struct {
	suffix  string
	penalty int
}{
	{"ings", 12},
	{"ers", 10},
	{"ies", 9},
	{"ied", 9},
	{"est", 7},
	{"ism", 6},
	{"ist", 6},
	{"ous", 6},
	{"ing", 8},
	{"ed", 6},
	{"es", 5},
	{"er", 4},
	{"ly", 5},
	{"al", 3},
	{"ic", 3},
	{"s", 4},
}

// BaselineScores is a deterministic continuity score used for the full corpus
// and for model-candidate preselection. It deliberately measures only features
// the repository can own: brevity, phonotactics, visual form, and word-list
// residue. The bounded model review supplies the semantic judgement at the head.
func BaselineScores(label string) Scores {
	length := len(label)
	vowels := 0
	transitions := 0
	common := 0
	awkward := 0
	rare := 0
	repeats := 0
	unique := make(map[byte]struct{}, length)
	maxVowelRun := 0
	maxConsonantRun := 0
	currentVowelRun := 0
	currentConsonantRun := 0

	for index := 0; index < length; index++ {
		character := label[index]
		unique[character] = struct{}{}
		vowel := isVowel(character)
		if vowel {
			vowels++
			currentVowelRun++
			currentConsonantRun = 0
			if currentVowelRun > maxVowelRun {
				maxVowelRun = currentVowelRun
			}
		} else {
			currentConsonantRun++
			currentVowelRun = 0
			if currentConsonantRun > maxConsonantRun {
				maxConsonantRun = currentConsonantRun
			}
		}
		if strings.ContainsRune("jqvxzk", rune(character)) {
			rare++
		}
		if index > 0 {
			if vowel != isVowel(label[index-1]) {
				transitions++
			}
			if character == label[index-1] {
				repeats++
			}
			pair := label[index-1 : index+1]
			if _, ok := commonBigrams[pair]; ok {
				common++
			}
			if _, ok := awkwardClusters[pair]; ok {
				awkward++
			}
		}
	}

	pronounceable := 0
	if vowels > 0 {
		pronounceable += 3
	}
	if maxConsonantRun <= 2 {
		pronounceable += 3
	}
	if maxVowelRun <= 2 {
		pronounceable += 2
	}
	if transitions >= length/2 {
		pronounceable += 2
	}

	residue := suffixPenalty(label)
	if vowels == 0 {
		residue += 9
	}
	if maxConsonantRun >= 4 {
		residue += 7
	}
	residue += awkward * 2
	residue += repeats

	confusion := 0
	if strings.Contains(label, "q") && !strings.Contains(label, "qu") {
		confusion += 7
	}
	if maxVowelRun >= 3 {
		confusion += 4
	}
	if maxConsonantRun >= 4 {
		confusion += 5
	}
	confusion += repeats * 2
	if strings.HasSuffix(label, "q") || strings.HasSuffix(label, "j") || strings.HasSuffix(label, "v") {
		confusion += 4
	}
	if vowels == 0 && strings.Contains(label, "y") {
		confusion -= 2
	}

	short := 6 - length
	uniqueCount := len(unique)
	recognizability := 6 + common*2 + pronounceable + transitions - awkward*2
	memorability := 6 + short*2 + pronounceable + transitions + rare - repeats*2
	semanticDensity := 4 + short*2 + uniqueCount + rare - residue/4
	distinctiveness := 4 + uniqueCount + rare*2 + short - repeats*2
	visualForm := 3 + short + transitions + uniqueCount/2 - repeats - awkward
	internetResonance := 2 + rare + short
	if strings.Contains(label, "ai") || strings.Contains(label, "io") {
		internetResonance += 2
	}
	if strings.ContainsAny(label, "xzv") {
		internetResonance++
	}
	versatility := 3
	if residue >= 8 {
		versatility--
	}
	if vowels == 0 {
		versatility--
	}

	return Scores{
		Recognizability:   clamp(recognizability, 0, MaxRecognizability),
		Memorability:      clamp(memorability, 0, MaxMemorability),
		SemanticDensity:   clamp(semanticDensity, 0, MaxSemanticDensity),
		Distinctiveness:   clamp(distinctiveness, 0, MaxDistinctiveness),
		VisualForm:        clamp(visualForm, 0, MaxVisualForm),
		InternetResonance: clamp(internetResonance, 0, MaxInternetResonance),
		Versatility:       clamp(versatility, 0, MaxVersatility),
		ResiduePenalty:    clamp(residue, 0, MaxResiduePenalty),
		ConfusionPenalty:  clamp(confusion, 0, MaxConfusionPenalty),
	}
}

// BaselineFacets are intentionally conservative. Every label eligible for the
// feature allowlist is in the model-reviewed candidate set and receives reviewed
// facets there; the rest default to the broad conceptual facet.
func BaselineFacets(string) []Facet {
	return []Facet{FacetAbstractConceptual}
}

func suffixPenalty(label string) int {
	for _, rule := range residueSuffixes {
		if len(label) > len(rule.suffix)+1 && strings.HasSuffix(label, rule.suffix) {
			return rule.penalty
		}
	}
	return 0
}

func isVowel(character byte) bool {
	return strings.ContainsRune("aeiou", rune(character))
}

func clamp(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

// SelectCandidates takes an equal quota from each label length so the model
// review does not collapse into a shortness contest. Calibration anchors are
// guaranteed consideration but receive no score boost.
func SelectCandidates(corpus Corpus, forcedLabels []string, count int) ([]Candidate, error) {
	if count < 3 || count%3 != 0 {
		return nil, fmt.Errorf("candidate count %d is not a positive multiple of three", count)
	}
	corpusSet := labelSet(corpus.Labels)
	forced := make(map[string]struct{}, len(forcedLabels))
	for _, label := range forcedLabels {
		if _, ok := corpusSet[label]; !ok {
			return nil, fmt.Errorf("calibration anchor %q is not in the corpus", label)
		}
		if _, exists := forced[label]; exists {
			return nil, fmt.Errorf("duplicate calibration anchor %q", label)
		}
		forced[label] = struct{}{}
	}

	quota := count / 3
	selected := make(map[string]Candidate, count)
	for length := 3; length <= 5; length++ {
		var ranked []Candidate
		for _, label := range corpus.Labels {
			if len(label) != length {
				continue
			}
			score, err := FinalScore(BaselineScores(label))
			if err != nil {
				return nil, fmt.Errorf("score baseline for %q: %w", label, err)
			}
			_, isForced := forced[label]
			ranked = append(ranked, Candidate{
				Label:         label,
				BaselineScore: score,
				Forced:        isForced,
			})
		}
		sort.Slice(ranked, func(i, j int) bool {
			if ranked[i].Forced != ranked[j].Forced {
				return ranked[i].Forced
			}
			if ranked[i].BaselineScore != ranked[j].BaselineScore {
				return ranked[i].BaselineScore > ranked[j].BaselineScore
			}
			return ranked[i].Label < ranked[j].Label
		})
		if len(ranked) < quota {
			return nil, fmt.Errorf("length %d has %d labels, fewer than quota %d", length, len(ranked), quota)
		}
		for _, candidate := range ranked[:quota] {
			selected[candidate.Label] = candidate
		}
	}
	if len(selected) != count {
		return nil, fmt.Errorf("selected %d candidates, want %d", len(selected), count)
	}
	output := make([]Candidate, 0, len(selected))
	for _, candidate := range selected {
		output = append(output, candidate)
	}
	sort.Slice(output, func(i, j int) bool {
		return output[i].Label < output[j].Label
	})
	return output, nil
}
