# Rep Queue Blueprint

Rep queues turn CRM state, tasks, assessments, and outbound events into a clear
daily work surface. This document is design-only.

## Queue Principles

- Queues should be generated from deterministic state.
- A queue item should always show the next recommended human action.
- Assessment-completed leads should be easy to separate from cold outbound.
- Overdue and stale items should be visible without creating duplicate tasks.
- Queue logic should not change protected assessment fields.

## Fresh Lead Queue

Purpose: newly captured or researched leads that need first action.

Inclusion logic:

- Person exists.
- No completed first outbound touch.
- Not disqualified.
- Not active client.
- `assessmentCompleted` is false or empty.

Priority logic:

- higher ICP fit or Company `idealCustomerProfile=true`
- lead source quality
- recent capture date
- owner assigned
- complete contact data
- high lead health

Displayed fields:

- person name, title, company
- lead source
- pipeline type
- LinkedIn URL if provided
- email if available
- owner
- recommended first task
- captured context/reason

Rep actions:

- accept/assign lead
- complete first-touch task
- request enrichment
- disqualify/nurture
- switch pipeline type

## Follow-Up Queue

Purpose: due or overdue cadence and assessment follow-up tasks.

Inclusion logic:

- open Task status `TODO` or `IN_PROGRESS`
- `dueAt` is today or overdue
- Person or Opportunity is not disqualified/closed

Priority logic:

- overdue days
- warm response present
- assessment completed
- discovery-ready stage
- high lead health/ICP

Displayed fields:

- task title and due date
- task body preview
- person/company
- latest touch summary
- cadence stage
- owner/assignee

Rep actions:

- mark task done
- reschedule
- skip with reason
- pause cadence
- add note
- mark response received

## Warm Assessment Queue

Purpose: assessment-completed leads that need human review and discovery
qualification.

Inclusion logic:

- `assessmentCompleted=true`
- assessment score exists
- current lead state is not disqualified/closed
- recent assessment or no completed review task

Priority logic:

- lower assessment score with high business fit
- grade `C` or `D`
- high-value company segment
- recent submission
- existing Opportunity stage near discovery

Displayed fields:

- score and grade
- top weaknesses from task/note or Supabase payload
- company and role
- message angle
- next follow-up date
- Opportunity stage, if present

Rep actions:

- review assessment
- request discovery
- add note
- update opportunity stage
- create follow-up task
- disqualify/nurture

## Stale Recovery Queue

Purpose: leads with no recent touch or no next task.

Inclusion logic:

- not disqualified
- no open due task, or next touch date is overdue beyond threshold
- no response/discovery activity in approved window

Suggested thresholds:

- assessment campaign: stale after 14 days without next action
- relationship building: stale after 45 days without next action
- discovery-ready: stale after 7 days without next action

Priority logic:

- prior engagement
- assessment completed
- high ICP fit
- high company value
- overdue age

Displayed fields:

- last touch date
- next touch date if present
- stale reason
- previous cadence stage
- owner
- suggested recovery action

Rep actions:

- reactivate
- create recovery task
- defer/nurture
- disqualify
- reassign

## Pipeline Review Queue

Purpose: opportunities and discovery-ready leads that need stage hygiene.

Inclusion logic:

- Opportunity exists, or Person `leadStage=DISCOVERY_READY`
- no next task, stale opportunity stage, or missing owner
- not closed won/lost

Priority logic:

- stage closeness to discovery
- stale stage age
- amount/deal value
- assessment score and fit
- owner missing

Displayed fields:

- Opportunity name and stage
- company and point of contact
- owner
- amount/deal value
- close date
- latest note/timeline activity
- next task status

Rep actions:

- update stage
- create next task
- assign owner
- add note
- close lost/deferred
- request discovery

## Queue Data Sources

Twenty:

- People, Companies, Tasks, Opportunities, Notes.

Supabase:

- `assessment_submissions`
- `workflow_jobs`
- `crm_sync_logs`
- `outbound_events`

Recommended approach:

- Build queue summaries from read-only queries first.
- Add denormalized fields only when the queue needs CRM-native sorting/filtering.
- Keep durable event counts in Supabase until reporting requirements prove which
  fields need to be copied into Twenty.
