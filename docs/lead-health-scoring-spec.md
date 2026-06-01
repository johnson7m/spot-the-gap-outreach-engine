# Lead Health Scoring Spec

This document defines a proposed lead-health scoring model for outbound
workflows and the future internal workspace. It is documentation-only. No
scoring code changes are implemented by this pass.

## Purpose

`leadHealthScore` should estimate whether a lead deserves more attention now.
It is not a replacement for rep judgment. It should support queues, stale
recovery, warm escalation, and Discovery Ready recommendations.

## Scoring Inputs

Confirmed factors:

- total responses
- quality of responses
- business activity
- posting/engagement activity
- touch channel activity
- decision-making power
- ICP fit
- lead age
- last touch date
- long inactivity

Additional useful inputs:

- assessment completion
- assessment score/result band
- source quality
- role/title relevance
- company fit
- opportunity stage
- manual rep evaluation
- disqualification or pause reason

## Proposed Weights

Initial 100-point model:

| Factor | Weight | Notes |
| --- | --- | --- |
| response volume | 15 | More replies indicate engagement, capped to avoid runaway scores. |
| response quality | 20 | Strong business relevance should matter more than raw reply count. |
| decision-making power | 15 | Owner/executive/operator influence increases score. |
| ICP fit | 15 | Draw from `icpFitScore`, company fit, and segment. |
| business activity signal | 10 | Hiring, growth, industry event, operational change, or rep-observed opportunity. |
| touch/channel activity | 10 | Healthy recent manual touches across approved channels. |
| assessment signal | 10 | Completion, score band, or explicit assessment interest. |
| freshness | 5 | Recent capture or recent touch. Decays with age. |

Total: 100.

## Response Quality

Response quality should be evaluated in bands:

| Band | Meaning | Suggested points |
| --- | --- | --- |
| none | no response | 0 |
| low | polite but no business relevance | 4 |
| medium | acknowledges topic or timing | 10 |
| high | names a real operational issue | 16 |
| strong | asks for help, assessment, call, or next step | 20 |

Future AI can recommend a response-quality score, but a human-approved or
deterministic execution layer should own persistence.

## Decision-Maker Influence

Decision-making power proposal:

| Signal | Suggested points |
| --- | --- |
| owner/founder/C-level | 15 |
| VP/head/director of relevant function | 12 |
| manager/operator with process ownership | 8 |
| individual contributor or unclear authority | 3 |
| unknown | 0 |

Title parsing should remain conservative. Do not infer authority from LinkedIn
scraping.

## ICP Fit Influence

Use `icpFitScore` as a major input but not the whole score.

Suggested mapping:

| ICP fit score | Points |
| --- | --- |
| 85-100 | 15 |
| 70-84 | 12 |
| 50-69 | 8 |
| 25-49 | 4 |
| 0-24 | 0 |

High ICP fit can keep a lead visible, but it should not override long inactivity
or explicit disqualification.

## Freshness And Decay

Freshness points:

| Last activity | Points |
| --- | --- |
| 0-14 days | 5 |
| 15-30 days | 3 |
| 31-89 days | 1 |
| 90+ days | 0 |

Decay rules:

- no inbound or outbound activity for 3 months should reduce score below 50
  unless a strong manual override or active opportunity exists.
- no response after a full cadence cycle should reduce score below 50 when
  response quality is none or low.
- stale leads with strong ICP but no engagement should move to Stale Recovery,
  not Discovery Ready.

## Thresholds

Recommended classifications:

| Score | Classification | Queue behavior |
| --- | --- | --- |
| 0-24 | cold/low priority | Nurture, pause, or close if poor fit. |
| 25-50 | cold monitor | Fresh or follow-up only if task exists. |
| 51-75 | warm | Eligible for warm queues and rep review. |
| 76-100 | discovery-ready candidate | Recommend Discovery Ready if other rules pass. |

Confirmed rule:

- `leadHealthScore > 50` can support warm escalation.
- `leadHealthScore > 75` can support Discovery Ready recommendation.

Discovery Ready should require business relevance and should not auto-progress a
cold lead directly to discovery without warm state or manual override.

## Source Quality

Approved `leadSource` values:

- `LINKEDIN`
- `EVENT`
- `DROP_IN`
- `REFERRAL`
- `ASSESSMENT`
- `WEBSITE`
- `EMAIL`
- `PHONE`
- `MANUAL`
- `OTHER`

Source can influence confidence, but should not dominate lead health.

Suggested source modifiers:

| Source | Modifier |
| --- | --- |
| `REFERRAL` | +5 |
| `ASSESSMENT` | +5 |
| `EVENT` | +3 |
| `WEBSITE` | +3 |
| `LINKEDIN` | +1 |
| `EMAIL` | +1 |
| `PHONE` | +1 |
| `DROP_IN` | 0 |
| `MANUAL` | 0 |
| `OTHER` | 0 |

Clamp final score to 0-100.

## Manual Overrides

Reps/operators can override classification when context warrants it.

Override audit should include:

- actor
- prior score/classification
- new classification
- reason
- timestamp
- related lead/person ID

Manual override should not change historical event data. It should add a new
operational event.

## Reporting Uses

Lead-health scoring should support:

- Fresh Lead Queue sorting
- Follow-Up Queue priority
- Warm escalation
- Stale Recovery Queue priority
- Pipeline Review Queue recommendations
- conversion by source and score band

## Non-Goals

- No autonomous outreach.
- No LinkedIn scraping.
- No hidden AI-driven state changes.
- No scoring code changes in this pass.
