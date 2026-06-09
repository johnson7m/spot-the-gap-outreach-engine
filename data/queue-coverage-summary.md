# Queue Coverage Audit

Generated at: 2026-06-09T05:22:30.425Z

## Summary

- Total People: 324
- Hidden test records: 11
- Expected real People: 313
- Accounted-for People: 313
- Unclassified People: 0
- Duplicate/multi-queue candidate count: 312

## Counts By Final Queue

| Value | Count |
| --- | ---: |
| active_client | 1 |
| follow-ups | 208 |
| fresh-leads | 102 |
| hidden_test_record | 11 |
| pipeline-review | 1 |
| warm-assessments | 1 |

## Counts By Disposition

| Value | Count |
| --- | ---: |
| active_client | 1 |
| follow_up | 208 |
| fresh_lead | 102 |
| hidden_test_record | 11 |
| pipeline_review | 1 |
| warm_assessment | 1 |

## Counts By Exclusion Reason

| Value | Count |
| --- | ---: |
| active_client | 1 |
| enrichment_partial | 1 |
| missing_email | 1 |
| missing_next_task | 1 |

## Pipeline Review Only

| Person | Owner | Reasons | Recommended Fix |
| --- | --- | --- | --- |
| Alejandro Sanchez |  | missing_email, enrichment_partial, missing_next_task | create_first_task |

## Unclassified People

_None._

## Notes

- `accountedForPeople` excludes hidden test records and counts active queues, Pipeline Review, terminal closed records, and active clients as explicit dispositions.
- Pipeline Review can be larger than active work queues because it is the explicit catch-all for data gaps, normalization gaps, missing tasks, and manual review reasons.
