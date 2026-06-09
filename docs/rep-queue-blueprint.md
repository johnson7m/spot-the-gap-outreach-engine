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
- `GET /api/queues/summary`

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
- Hide obvious test/synthetic People by default. Use `includeTestRecords=true`
  only for diagnostics.
- Move broad `timelineActivities` pagination noise into diagnostics metadata
  instead of user-facing queue warnings.
- Do not write to CRM, Supabase, or assessment records during queue fetches.
- Return `count`, `totalCount`, `limit`, `offset`, `hasMore`, `nextOffset`,
  and `overdueCount` so the workspace can render collapsed, paginated lists.
- Use `GET /api/queues/summary` for navigation badges and all-queue counts.
- Use `GET /api/queues/summary` coverage fields and
  `npm run queues:coverage-audit` to confirm every non-test Person has exactly
  one final disposition.

## Fresh Lead Queue

Purpose: newly captured or researched leads that need first action.

Inclusion logic:

- Person `outboundPipelineType` exists.
- Person `cadenceStage=CONNECTION_REQUEST` or `NOT_STARTED`.
- Person `latestTouchStatus=DRAFTED`.
- Initial connection/request Task is attached when the API can link one to the
  Person.
- If no open Task exists, keep the Person visible and add
  `suggestedResolutionActions=["create_next_task"]` with the warning
  `No open task exists yet; create the first cadence task.`
- If `latestTouchStatus=SENT`, `RESPONDED`, or `COMPLETED`, exclude the Person
  from Fresh Leads by default.
- `queueClassification=fresh_initial_task`.

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
- due status and overdue days when the first-touch Task is overdue

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
- post-initial cadence stage such as `INTRO_MESSAGE`, `VALUE_TOUCH`,
  `ASSESSMENT_POSITIONING`, `ASSESSMENT_SENT`, `ASSESSMENT_CHECK_IN`,
  `STRATEGIC_CHECK_IN`, or `DISCOVERY_ASK`
- legacy LinkedIn task titles like `LI - Day 2`, `LI - f/u accepted connect`,
  and `LI - final touch` can be included when they show outreach already
  started
- `DRAFTED` `NOT_STARTED` initial connection/request Tasks stay in Fresh Leads
  and are excluded from Follow-Ups by default
- `SENT` `NOT_STARTED` or `CONNECTION_REQUEST` records are treated as first
  touch already sent. If no post-initial open Task exists, include them as
  `queueClassification=follow_up_after_initial_sent` with
  `suggestedResolutionActions=["create_follow_up_task"]`.
- unresolved due tasks are hidden by default and counted in the response warning
  `N unassigned tasks hidden. Review Unassigned Tasks queue.`
- `includeUnassigned=true` may be used for diagnostics, but the workspace should
  not show unresolved Tasks as "Unknown person" in the normal Follow-Up Queue
- `queueClassification=follow_up_post_initial_touch`,
  `follow_up_legacy_task_history`, or `follow_up_after_initial_sent`

Priority logic:

- overdue days, without moving the item to Stale Recovery
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
- queue classification and reasons
- due status and overdue days

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

## Stale Recovery Semantics

Stale Recovery is for stalled relationships, not merely overdue work.

Include when:

- `staleRisk=STALE` or `HIGH`
- explicit stale recovery flag/reason exists
- `cadenceStage=PAUSED` because outreach stalled/no response
- `latestTouchStatus=NO_RESPONSE` and `lastOutboundTouchDate` is older than 30
  days
- `lastOutboundTouchDate` is older than 30 days and no open actionable Task
  exists
- terminal/expired cadence has no response and no next path

Do not include solely because:

- Task due date is today
- Task due date is overdue
- `nextOutboundTouchDate` is old
- a newly generated first-touch or follow-up Task is due now/past

Those records should remain in Fresh Leads, Follow-Ups, Warm Assessments, or
Pipeline Review with `dueStatus`, `isOverdueTask`, and `overdueDays` metadata.

Pipeline Review can be larger than the active queues because it is also the
explicit disposition for People that are not ready for rep action yet:
normalization gaps, enrichment gaps, missing next tasks, manual review records,
and records where a new queue rule may be needed. The coverage audit separates
those reasons so Pipeline Review does not become an opaque catch-all.

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

Missing next-task planning:

- `npm run queues:plan-missing-next-tasks` finds People with active,
  non-terminal cadence state and no open Task resolved through taskTargets or
  Person markers.
- The planner writes `data/missing-next-task-plan.json` and
  `data/missing-next-task-summary.md`.
- It preserves original date context and adjusts missing, past, or same-day
  after-cutoff first-touch due dates to the current or next business day with
  `dueDateAdjusted` and `dueDateAdjustmentReason`.
- It is read-only and does not create Tasks.
- `npm run queues:apply-missing-next-tasks` is implemented as a guarded apply
  path. It is dry-run by default and requires
  `MISSING_NEXT_TASK_APPLY_ENABLED=true`, `LIVE_TEST=true`, and
  `MISSING_NEXT_TASK_BATCH_SIZE=<n>` before any Task creation.
- The apply path creates only missing Tasks for safe plan rows, rechecks for
  existing open Tasks, re-adjusts past due dates unless
  `MISSING_NEXT_TASK_ALLOW_PAST_DUE=true`, creates a Person `taskTarget`,
  verifies the link, writes audit/event rows, and does not update People or
  cadence fields.
- Company taskTarget links remain optional behind
  `MISSING_NEXT_TASK_LINK_COMPANY=true`.
- `npm run queues:plan-sent-initial-follow-ups` handles initial-stage People
  where `latestTouchStatus=SENT` and no post-initial Task exists. It recommends
  `INTRO_MESSAGE` / `Send relationship follow-up / intro message` for
  relationship cadence records and `ASSESSMENT_POSITIONING` /
  `Send assessment positioning follow-up` for assessment cadence records.
- `npm run queues:apply-sent-initial-follow-ups` is a separate guarded apply
  path. It is dry-run by default and requires
  `SENT_INITIAL_FOLLOW_UP_APPLY_ENABLED=true`, `LIVE_TEST=true`, and
  `SENT_INITIAL_FOLLOW_UP_BATCH_SIZE=<n>` before any Task creation.
- Recommended live batching also sets
  `SENT_INITIAL_FOLLOW_UP_APPLY_MODE=next_eligible` so each batch takes the
  first currently eligible safe rows instead of relying on offsets that shift
  after successful writes. Offset mode remains available for diagnostics.
- Sent-initial apply creates only the next follow-up Task, creates a Person
  `taskTarget`, verifies the link, and writes audit/event rows. It does not
  modify old initial Tasks or update Person cadence stage unless
  `SENT_INITIAL_FOLLOW_UP_UPDATE_PERSON_STAGE=true`.
- Sent-initial apply paces live writes with
  `SENT_INITIAL_FOLLOW_UP_WRITE_DELAY_MS` and retries Twenty 429 responses
  before marking an operation failed. Partial batches return
  `partial_success` with a recommended recovery command.
- `npm run queues:recover-sent-initial-follow-ups` resumes failed or
  verification-failed sent-initial operations from the latest apply output. It
  rechecks dedupe markers and existing `taskTargets` so it does not duplicate
  Tasks already created during a partially successful batch.

Queue classification diagnostics:

- `npm run queues:diagnose-classification` explains matched queues, final queue
  after precedence, excluded queues, and classification reasons.
- Optional filters: `PERSON_ID`, `TASK_ID`, and `LIMIT`.
- `includeDiagnostics=true` on queue reads adds per-item classification
  diagnostics for workspace debugging.

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
- open first-touch Tasks generated by missing-next-task apply are kept in Fresh
  Leads when cadence is `NOT_STARTED` or `CONNECTION_REQUEST`; old inherited
  Person next-touch dates alone should not stale newly actionable first-touch
  work
- `SENT` first-touch gaps are protected from Stale Recovery when the only stale
  signal is an old `nextOutboundTouchDate`; they belong in Follow-Ups unless an
  explicit stale flag applies

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
- manually-created Twenty leads with missing outbound fields and enough CRM
  signal for normalization planning
- Company relation exists but Company display fields were not available in
  queue reads
- test/synthetic record when diagnostics include test records

Review reasons:

- `missing_company`
- `missing_email`
- `missing_linkedin`
- `missing_outbound_fields`
- `needs_manual_normalization`
- `ready_for_normalization`
- `company_relation_unresolved`
- `enrichment_partial`
- `missing_next_task`
- `test_record`
- `manual_review`

Suggested resolution actions:

- `normalize_manual_lead`
- `create_first_task`
- `create_follow_up_task`
- `enrich_company`
- `review_company_relation`

`normalize_manual_lead` is backed by the guarded
`queues:apply-manual-lead-normalization` script. It is dry-run by default and,
when live guards are explicitly enabled, updates only missing outbound fields
on People. It does not create Tasks, taskTargets, Companies, owner updates, or
assessment-field changes; first/follow-up task creation remains separate.

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
