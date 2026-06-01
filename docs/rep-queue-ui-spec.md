# Rep Queue UI Spec

This document defines queue screens for the future `visible-gap-workspace`.
It is a planning document only.

## Queue Purpose

Queues should turn CRM and Supabase state into the next clear human action.
They should not become generic CRM list views.

Initial queues:

- Fresh Lead Queue
- Follow-Up Queue
- Warm Assessment Queue
- Stale Recovery Queue
- Pipeline Review Queue

## Shared Queue Item Fields

Each queue item should display:

| Field | Source |
| --- | --- |
| person | Twenty Person |
| title | Twenty Person `jobTitle` |
| company | Twenty Company or Person company display |
| pipeline type | Person `outboundPipelineType` |
| cadence stage | Person `cadenceStage` |
| lead health score | Person `leadHealthScore` |
| ICP fit score | Person `icpFitScore` |
| next action | Task title or cadence planner |
| due date | Task `dueAt` or Person `nextOutboundTouchDate` |
| outreach angle | Person `outreachAngle` or task body summary |
| latest touch status | Person `latestTouchStatus` |
| Twenty link | Generated from CRM record ID/config |
| LinkedIn URL | Person `linkedinLink` or `quickCaptureUrl` |

Optional display:

- assessment score
- assessment completion date
- stale risk
- discovery readiness
- assigned rep
- source
- latest error or blocked relationship status

## Shared Actions

Allowed MVP actions:

- open Twenty record
- open LinkedIn URL in a new tab
- preview task details
- mark task complete
- log manual touch
- snooze or pause lead, if backend supports it later
- open recovery item if the lead has a retryable CRM failure

Do not include "send LinkedIn message" or "send connection request" automation.

## Confirmed State Model

Manual/general lead stages:

- `IDENTIFIED`
- `OUTREACH_INITIATED`
- `ENGAGED`
- `ACTIVE_CONVERSATION`
- `DISCOVERY_READY`
- `UNQUALIFIED_CLOSED`
- `ACTIVE_CLIENT`

Cadence stages:

- `NOT_STARTED`
- `CONNECTION_REQUEST`
- `INTRO_MESSAGE`
- `ASSESSMENT_POSITIONING`
- `ASSESSMENT_SENT`
- `ASSESSMENT_CHECK_IN`
- `VALUE_TOUCH`
- `STRATEGIC_CHECK_IN`
- `DISCOVERY_ASK`
- `PAUSED`
- `COMPLETED`

The existing assessment webhook field `leadstageAuto` remains protected and
should not be edited from queue actions.

## Task Completion Rules

Queue actions should support these completion rules:

- Review Fresh Leads
- Lead Research Completed
- Message Sent
- Assessment Sent
- Connection Request Sent
- Add to Pipeline

Completing a task may generate exactly one next task. The next task should be
based on cadence stage and should not duplicate an existing open task for the
same Person/cadence/stage.

## Fresh Lead Queue

Purpose:

Newly captured or imported leads that need first human touch.

Primary sort:

1. due today or overdue
2. highest `leadHealthScore`
3. highest `icpFitScore`
4. newest capture date

Item emphasis:

- first task
- dedupe strategy
- capture notes
- outreach angle

Empty state:

```text
No fresh leads need first touch.
```

## Follow-Up Queue

Purpose:

Open tasks due now or overdue.

Primary sort:

1. overdue first
2. due date ascending
3. warmest lead state
4. highest lead health score

Item emphasis:

- due date
- days overdue
- last touch status
- next cadence step
- previous note or event summary

Suggested action:

- complete task after manual action
- log touch outcome
- create next task if cadence continues

## Warm Assessment Queue

Purpose:

Assessment completions that deserve human review or discovery consideration.

Criteria draft:

- `assessmentCompleted=true`
- assessment completions become warm immediately
- assessment score in warm bands or high operational pain
- no completed discovery request/review task

Item emphasis:

- assessment score
- grade/result band
- top operational pain category
- company
- discovery readiness
- opportunity status

Suggested action:

- review assessment
- request discovery conversation
- create/update opportunity if backend policy allows

## Stale Recovery Queue

Purpose:

Leads at risk of being forgotten.

Criteria draft:

- `staleRisk=HIGH` or `STALE`
- no inbound/outbound activity for 3 months
- no response after full cadence cycle
- `nextOutboundTouchDate` has passed
- open task overdue
- no recent outbound event

Item emphasis:

- stale risk
- days since last touch
- last outbound touch date
- latest touch status
- recommended recovery action

Suggested action:

- revive with manual follow-up
- pause
- disqualify/nurture
- create recovery task

## Pipeline Review Queue

Purpose:

Leads that need judgment about discovery, opportunity, or next sales step.

Criteria draft:

- `discoveryReadiness=READY` or `REQUESTED`
- `leadHealthScore > 75` supports Discovery Ready recommendation
- Opportunity exists or should be considered
- warm assessment completion exists
- response or manual signal indicates interest

Item emphasis:

- readiness reason
- opportunity stage
- assessment score
- source
- owner

Suggested action:

- request discovery
- update Opportunity
- pause cadence
- assign owner

## Queue Page Layout

Recommended layout:

- left or top tabs for queues
- compact filter bar
- dense table/list rows
- right-side detail panel on row selection
- sticky action footer inside detail panel

Filters:

- assigned rep
- pipeline type
- source
- due date
- score range
- cadence stage
- stale risk
- discovery readiness

## Completion Flow

When a rep completes a task:

1. Open queue item.
2. Review task body and CRM links.
3. Perform manual action outside the workspace.
4. Click "Complete task".
5. Select touch channel and outcome.
6. Add optional note.
7. Backend updates CRM task and writes outbound event.
8. Queue refreshes.

## Error States

Queue pages should display:

- API unavailable
- auth expired
- partial data warning
- CRM link unavailable
- no items
- failed task completion
- recovery item exists for this lead

Errors should include correlation IDs when returned by the engine.
