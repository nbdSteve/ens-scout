# OG editorial rubric v1

`og-v1` scores whether a short standalone label already feels like an identity:
legible, sayable, memorable, semantically dense, distinctive, broadly useful,
and culturally or internet resonant.

The rubric makes no availability, registration, expiry, premium, price, or legal
claim. Those concepts are not model fields and must not be inferred while scoring.

## Positive dimensions

The dimensions are integer points whose maxima are their repository-owned
weights. Their maxima sum to 100.

| Dimension | Range | 0 anchor | Midpoint anchor | Maximum anchor |
| --- | ---: | --- | --- | --- |
| Cultural / lexical recognizability (`recognizability`) | 0–25 | Looks like debris, an unexplained fragment, or an unreadable abbreviation. | Understandable or word-like, but ordinary or dependent on context. | Understood on sight and culturally, linguistically, or conceptually present without explanation. |
| Memorability and sayability (`memorability`) | 0–20 | Hard to pronounce, hear, repeat, type, or recall. | Clear enough to say and remember, with no special stickiness. | Effortless to pronounce and recall after hearing once; the sound and spelling reinforce each other. |
| Semantic density / identity potential (`semantic_density`) | 0–15 | Carries no useful concept or persona as a standalone label. | Has one clear meaning but weak identity energy. | Conveys a vivid concept, stance, persona, or world in very few characters. |
| Originality / distinctiveness (`distinctiveness`) | 0–15 | Generic, derivative, or indistinguishable from word-list residue. | Some character, but adjacent to many interchangeable labels. | Immediately ownable and unusual without becoming obscure or awkward. |
| Brevity and visual form (`visual_form`) | 0–10 | Visually awkward, lopsided, or weak as `label.eth`. | Compact and readable with an ordinary silhouette. | Exceptionally compact, balanced, and visually strong as `label.eth`. |
| Internet / ENS resonance (`internet_resonance`) | 0–10 | Has no natural online-identity, creator, community, technology, or project use. | Plausible online use, but no particular resonance. | Naturally reads as an online identity, protocol, project, culture, or creator name. |
| Versatility (`versatility`) | 0–5 | Useful only for one narrow definition or context. | Supports two credible uses. | Supports several credible identities or projects without losing meaning. |

## Quality deductions

These remain editorial quality dimensions. Safety is never expressed as a
deduction.

| Deduction | Range | 0 anchor | Midpoint anchor | Maximum anchor |
| --- | ---: | --- | --- | --- |
| Non-standalone / word-list residue (`residue_penalty`) | 0–25 | A clean standalone identity. | Noticeable inflection, fragment, awkward plural, function-word quality, or specialist residue. | Primarily a fragment, obscure game word, malformed inflection, or dictionary-list artifact. |
| Confusion / awkwardness (`confusion_penalty`) | 0–15 | Spelling and pronunciation are immediate. | One plausible hearing, spelling, or abbreviation ambiguity. | Persistently hard to hear, spell, distinguish, or trust as an identity. |

## Repository-owned calculation

For each record:

```text
positive = recognizability
         + memorability
         + semantic_density
         + distinctiveness
         + visual_form
         + internet_resonance
         + versatility

quality = clamp(positive - residue_penalty - confusion_penalty, 0, 100)
score   = quality * 10
```

The final score is therefore an integer from `0` through `1000`. The model
returns only the nine anchored dimensions, facets, and an advisory policy
signal. It cannot return or override `score`.

## Facets

Every model-reviewed label receives one to three enums:

- `culture_language`
- `internet`
- `technology`
- `arts_music`
- `nature`
- `science`
- `playful`
- `abstract_conceptual`

## Featured safety gate

Safety is a separate hard gate under `featured-safe-v1`. A quality score never
offsets a safety concern. The advisory model signal is one of:

- `none`
- `adult`
- `hate_or_harassment`
- `trademark_or_brand`
- `person_or_political`
- `misleading_or_impersonation`
- `illegal_or_harmful`
- `review_required`

Only an explicit repository review decision of `featureable` enters the
feature-safe allowlist. An absent decision remains `review_required`.
