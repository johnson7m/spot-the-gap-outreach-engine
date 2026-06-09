# Missing Next-Task Dry-Run Summary

Generated at: 2026-06-09T05:20:36.839Z

## Status

- Mode: dry_run
- Dry run: yes
- Include test records: no
- Missing next-task candidates: 7
- Safe task creation candidates: 0
- Requires review: 7
- Test records hidden: 11
- Test records included: 0
- Due dates adjusted: 7

## By Due Date Adjustment Reason

| Value | Count |
| --- | ---: |
| past_due_date:2026-06-05<2026-06-09 | 7 |

## By Cadence

| Value | Count |
| --- | ---: |
| RELATIONSHIP_BUILDING_V1 | 7 |

## By Cadence Stage

| Value | Count |
| --- | ---: |
| CONNECTION_REQUEST | 5 |
| INTRO_MESSAGE | 1 |
| NOT_STARTED | 1 |

## By Confidence

| Value | Count |
| --- | ---: |
| medium | 7 |

## Safe Candidates

_None._

## Future Apply Stub

`queues:apply-missing-next-tasks` is implemented as a guarded apply path. It remains dry-run by default and requires explicit live guards plus a batch size before any Task creation.
