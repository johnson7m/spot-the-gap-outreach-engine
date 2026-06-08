# Manual Lead Normalization Dry-Run Summary

Generated at: 2026-06-08T22:25:49.712Z

## Status

- Mode: dry_run
- Dry run: yes
- Include test records: no
- Manual lead normalization candidates: 0
- Safe to normalize: 0
- Requires review: 0
- Test records hidden: 11
- Test records included: 0

## By Lead Stage

_None._

## By Recommended Pipeline

_None._

## By Recommended Cadence Stage

_None._

## By Recommended Task Action

_None._

## Safe Candidates

_None._

## Guarded Apply

`queues:apply-manual-lead-normalization` is dry-run by default. Live apply requires `MANUAL_LEAD_NORMALIZATION_APPLY_ENABLED=true`, `LIVE_TEST=true`, and `MANUAL_LEAD_NORMALIZATION_BATCH_SIZE`. The guarded apply path updates only missing outbound fields, excludes protected assessment fields, and keeps Task creation in separate explicit task apply flows.
