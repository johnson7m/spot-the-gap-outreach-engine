# Rep Queue Blueprint

Rep queues turn CRM state, tasks, assessments, and outbound events into a clear
daily work surface. The first read-only queue API pass is implemented in the
outreach engine; UI wiring remains a workspace task.

## Queue Principles

- Queues should be generated from deterministic state.
- A queue item should always show the next recommended human action.
- Assessment-completed leads should be easy to separate from cold outbound.
- Overdue and stale items should be visible without creating duplicate tasks.
- Queue logic should not change protected assessment fields.

## Implemented Read-Only API

Current endpoints:

- `GET /api/queues/fresh-leads`
- `GET /api/queues/follow-ups`
- `GET /api/queues/warm-assessments`
- `GET /api/queues/stale-recovery`
- `GET /api/queues/pipeline-review`
- `GET /api/queues/unassigned-tasks`

All queue endpoints require Supabase workspace JWT auth and role `admin`,
`operator`, or `rep`. Reps default to `ownerScope=mine`; admins and operators
can request `ownerScope=all`.

Supported query params:

- `limit`
- `offset` or `cursor`
- `ownerScope=mine|all`
- `dueBefore`
- `includeOverdue=true|false`

Current data strategy:

- Read People and Tasks from Twenty.
- Join Tasks to People through explicit Person IDs where available.
- Fall back to parsing `Person ID: <id>` in task body markdown while
  relationship writes remain disabled.
- Return warnings when task relationships or owner/assignee mappings are not
  available from Twenty.
- Do not write to CRM, Supabase, or assessment records during queue fetches.

## Fresh Lead Queue

Purpose: newly captured or researched leads that need first action.

Inclusion logic:

- Person `outboundPipelineType` exists.
- Person `cadenceStage=CONNECTION_REQUEST` or `NOT_STARTED`.
- Person `latestTouchStatus=DRAFTED`.
- Open task is attached when the API can link one to the Person.

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

- open Task status `TODO`, `OPEN`, `IN_PROGRESS`, or `NOT_STARTED`
- `dueAt` is today or overdue
- Person cadence is not terminal
- Person or parsed task body includes cadence context
- unresolved due tasks are hidden by default and counted in the response warning
  `N unassigned tasks hidden. Review Unassigned Tasks queue.`
- `includeUnassigned=true` may be used for diagnostics, but the workspace should
  not show unresolved Tasks as "Unknown person" in the normal Follow-Up Queue

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

- mark task complete through `POST /api/tasks/:id/complete`
- reschedule
- skip with reason
- pause cadence
- add note
- mark response received

Task completion behavior:

- The workspace sends `personId`, `taskId`, and completion details.
- The outreach engine records `task_completed` in Supabase.
- The engine updates Person cadence fields in Twenty.
- The engine creates or skips one next Task based on cadence stage.
- Relationship writes can remain disabled; the next Task body includes Person ID
  and cadence context.
- Duplicate next tasks are avoided by a dedupe key built from Person ID,
  cadence name, next cadence stage, and task type.

Legacy task relationship cleanup:

- Queue diagnostics and `npm run legacy:tasks:plan` identify existing Tasks
  that can be safely linked to existing People through `taskTargets`.
- `npm run legacy:tasks:apply` is dry-run by default and prints the planned
  `POST /rest/taskTargets` payloads.
- Live apply is separate from task completion and requires
  `LEGACY_TASK_RETROFIT_APPLY_ENABLED=true` plus `LIVE_TEST=true`.
- The apply path links only eligible `link_task_to_person` candidates, verifies
  the link after writing, avoids duplicate taskTargets, and writes audit/event
  rows.
- It does not create replacement Tasks, reopen completed Tasks, generate
  cadence Tasks, or change assessment webhook behavior.

## Unassigned Tasks Queue

Purpose: task hygiene review for existing Twenty Tasks that cannot be safely
associated with a Person.

Inclusion logic:

- no `taskTarget.targetPersonId`
- no high or medium confidence inferred Person
- not already linked through `taskTargets`

Supported filters:

- `assigneeScope=mine|all`
- `status`
- `dueBefore`
- `limit`
- `offset`

Displayed fields:

- task ID, title, status, due date
- assignee/member resolution
- task body excerpt
- existing taskTargets, including Company-only targets
- suggested resolution actions:
  `associate_person`, `associate_company`, `dismiss_from_my_view`,
  `leave_unassigned`

Rep/operator actions:

- associate a Person after manual review
- associate a Company after manual review
- dismiss from personal view
- intentionally leave unassigned for administrative/non-lead work

## Warm Assessment Queue

Purpose: assessment-completed leads that need human review and discovery
qualification.

Inclusion logic:

- `assessmentCompleted=true`
- `leadstageAuto=ASSESSMENT_COMPLETED`
- `discoveryReadiness=READY`, `REQUESTED`, or `BOOKED`
- current lead state is not disqualified/closed

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
- `staleRisk=STALE` or `HIGH`
- `nextOutboundTouchDate` is older than today
- `latestTouchStatus=NO_RESPONSE` with an active cadence stage

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

- missing key Person fields such as email, LinkedIn URL, company, cadence name,
  or cadence stage
- `enrichmentStatus=NEEDS_REVIEW` or `PARTIAL`
- duplicate warning is present
- no next task despite a non-terminal cadence

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
