# Workload Staggering And Performance Targets

## Purpose

This plan keeps cadence task creation aligned with realistic daily rep capacity
before the workspace adds automated workload distribution.

This is planning-only. It does not create tasks, change cadence state, or alter
assessment webhook behavior.

## Current Targets

| Rep | Outreach task target | New lead target | Notes |
| --- | ---: | ---: | --- |
| Chandler Johnson | 20-30 outreach tasks per day | To be defined | Primary high-volume outreach owner. |
| Darrean Beller | 5 outreach activities per day | 10 new leads per day | Keep follow-up workload smooth enough for part-time execution. |
| Brayson Grider | 5 outreach activities per day | 10 new leads per day | Keep follow-up workload smooth enough for part-time execution. |

## Problem To Avoid

Bulk migration/apply scripts can create many tasks with the same due date. That
makes queues look urgent but does not reflect realistic daily capacity.

The system should treat due dates as an operating plan, not merely a technical
timestamp.

## Recommended Phase 1 Rules

- Keep apply scripts guarded and batch-based.
- Prefer `next_eligible` apply mode for shrinking eligible lists.
- Create initial and follow-up tasks with today or next-business-day due dates
  only when the batch size fits the owner target.
- Preserve the original recommended due date in apply output for audit.
- Do not create tasks for test records by default.
- Do not move overdue tasks into Stale Recovery solely because they are overdue.

## Future Staggering Algorithm

Inputs:

- Person owner email
- cadenceName
- cadenceStage
- task type
- recommended due date
- owner daily target
- existing open tasks due by owner/date
- priority signals such as warm assessment, discovery readiness, stale risk, and
  lead health score

Output:

- assigned due date
- workload bucket date
- adjustment reason
- confidence
- warnings

Candidate date selection:

1. Use the requested due date if the owner is under target.
2. If the owner is over target, move to the next business day with available
   capacity.
3. Keep warm assessment and discovery-ready work ahead of cold relationship
   building.
4. Never auto-schedule LinkedIn automation; only create manual tasks.

## Reporting Targets

Reporting should eventually compare actual work against the same targets:

- tasks created by rep/day
- tasks completed by rep/day
- touches sent by rep/day
- overdue tasks by rep/day
- completion rate versus target
- new leads captured by rep/day

These metrics should use the performance reporting baseline date so retrofit
activity does not look like normal rep productivity.
