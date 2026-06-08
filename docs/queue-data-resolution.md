# Queue Data Resolution

This document explains how the outreach engine resolves read-only queue data for
the internal workspace. The goal is to reduce false warnings while keeping queue
fetches non-destructive.

## Read Sources

Queue endpoints read these Twenty objects:

- `people`
- `tasks`
- `taskTargets`
- `noteTargets`
- `timelineActivities`
- `workspaceMembers`

The queue data source separates critical and non-critical read failures. A
missing optional object should not block all queue visibility. A failed critical
read should never be presented as a true empty queue.

Critical reads:

- `people`
- `tasks`
- `taskTargets`
- `workspaceMembers`, when `ownerScope=mine` or `assigneeScope=mine` requires
  owner/assignee enforcement

Non-critical reads:

- `noteTargets`
- `timelineActivities`

Queue read status values:

- `ok`: critical reads succeeded.
- `degraded_rate_limited`: at least one critical read returned Twenty 429. The
  API returns `count=null`, `isPartial=true`,
  `partialReason=twenty_rate_limited`, and `retryAfterSeconds` when available.
- `stale_cache`: a critical read was rate-limited, but a recent successful
  queue source snapshot was available and returned with cache diagnostics.

Workspace UI should show a temporary rate-limit/degraded message for
`degraded_rate_limited` instead of treating `items=[]` as a real empty queue.
The engine can retry transient Twenty `429`, `502`, `503`, and `504` responses
with bounded attempts and can serve a 60-120 second queue cache for read-only
workspace queues. The cache is not used by apply/write scripts.

## Task Relationship Resolution

Task-to-Person resolution uses this priority order:

1. `taskTarget.targetPersonId` for the task ID.
2. Embedded task relation fields, if Twenty includes them in the Task payload.
3. A fallback `Person ID: <id>` marker in the task body.
4. Task title/body Person-name matching.
5. Task title/body Company matching.
6. Owner/assignee matching.
7. Fallback unknown.

Task-to-Company resolution uses:

1. `taskTarget.targetCompanyId` for the task ID.
2. Embedded task relation fields, if available.

When a `taskTarget.targetPersonId` is present, the queue item should not show the
old body-parser fallback warning. If only a Company target exists, the item can
show a warning because Person context is still unavailable.

## Open Task Detection

Open statuses:

- `TODO`
- `OPEN`
- `IN_PROGRESS`
- `NOT_STARTED`

Fresh Lead Queue warnings are only emitted when no open task can be associated
with the Person after taskTarget and fallback resolution. In that case the
queue item remains actionable, includes `suggestedResolutionActions:
["create_next_task"]`, and shows:

`No open task exists yet; create the first cadence task.`

## Test Record Filtering

Queue reads flag obvious test/synthetic People with `isTestRecord` and
`testRecordReasons`. Default queue responses hide those records so staging
tests do not pollute normal rep queues. Diagnostics can include them with:

```text
includeTestRecords=true
```

Synthetic detection currently checks:

- email values containing `example.com`, `webhooktest.com`, `sync-test`,
  `cadence-test`, or `quick-capture-test`
- Person names containing `Test`, `Webhook Test`, `CadenceTest`, `WriteTest`,
  `Joe Schmoe`, or `Scooby Doo`
- company names that clearly contain test, sync-test, quick-capture-test, or
  cadence-test markers, plus a literal placeholder company name of `example`

Hidden test count is returned in `data.diagnostics.hiddenTestRecords`.

## Owner And Assignee Resolution

Person owner resolution uses:

1. Embedded Person `owner` data when present.
2. `ownerId` matched against Twenty `workspaceMembers`.

Task assignee resolution uses:

1. Embedded Task `assignee` data when present.
2. `assigneeId` matched against Twenty `workspaceMembers`.

Queue items merge Person owner and Task assignee context. Rep-scoped queue
filtering uses the resolved owner or assignee email. If no email is available,
the item remains visible with a warning because the engine cannot confidently
enforce ownership from CRM data alone.

Legacy retrofit planning also uses owner resolution, but does not change CRM
ownership. The planner resolves Person owners in this order:

1. `ownerId` matched against Twenty `workspaceMembers`.
2. Embedded owner email/name fields.
3. Known legacy owner-name fallback:

| Legacy owner name | Recommended workspace email |
| --- | --- |
| Chandler Johnson | `chandler@visiblegap.com` |
| Brayson Grider | `brayson.grider@visiblegap.com` |
| Darrean Beller | `darrean.beller@visiblegap.com` |
| Visible Gap | `hello@visiblegap.com` |

Missing or unresolved owner data adds a non-blocking warning to the retrofit
plan. It does not prevent otherwise safe outbound-field recommendations.

For legacy retrofit planning, missing Person owners can also be inferred from
the Person `createdBy` ACTOR field. Existing `ownerId` still wins. Created By
inference is written only to `ownerRecommendation`; it is not included in normal
retrofit `recommendedUpdates`.

The first guarded legacy retrofit apply path does not write owner changes.
Queue owner scoping should therefore continue to rely on existing Twenty Owner
values until a separate owner-specific migration is reviewed and approved.

The separate owner cleanup path can apply missing-owner recommendations after
review. It uses `ownerId` only, skips existing owners by default, and verifies
the Person Owner after each live write before reporting success.

## Queue Warnings

Expected non-blocking warnings include:

| Warning | Meaning |
| --- | --- |
| `Task relationship fallback used...` | The engine parsed a Person ID from task body because no taskTarget Person link was found. |
| `Task relationship inference used Person name matching...` | The Task can be associated only by matching task text to one unique Person name. |
| `Task relationship inference used Company matching only...` | The Task can be associated only through Company context and needs manual review before linking. |
| `Task target exposes Company but no Person...` | The Task is linked to a Company only. |
| `No open task exists yet; create the first cadence task.` | Fresh Lead has no open Task and can be queued for first-task creation. |
| `Initial touch appears sent, but no follow-up task exists.` | The lead should stay out of Fresh Leads and needs a post-initial follow-up task. |
| `Ownership unavailable...` | Neither owner nor assignee email could be resolved. |
| `Some queue items do not expose owner or assignee email data from Twenty.` | One or more items could not be scoped confidently for a rep. |

Warnings should guide cleanup and schema improvements. They should not hide
queue records unless the user role explicitly cannot access the queue.
Noisy `timelineActivities` pagination messages are moved to
`data.diagnostics.timelinePaginationWarning` and should not be shown as normal
queue warnings unless the timeline data was required for a specific queue-item
resolution.

## Queue Definitions

Fresh Leads:

- `outboundPipelineType` present
- `cadenceStage` is `CONNECTION_REQUEST` or `NOT_STARTED`
- `latestTouchStatus=DRAFTED`
- initial connection/request Task remains in Fresh Leads when open
- no open Task keeps the item visible with `create_next_task` as a suggested
  resolution action
- `latestTouchStatus=SENT`, `RESPONDED`, or `COMPLETED` is excluded from Fresh
  Leads by default; a `SENT` initial touch is handled as a follow-up gap
- `queueClassification=fresh_initial_task`

Follow-Ups:

- open task due today or overdue
- non-terminal cadence
- cadence name present
- post-initial cadence stage such as `INTRO_MESSAGE`, `VALUE_TOUCH`,
  `ASSESSMENT_POSITIONING`, `ASSESSMENT_SENT`, `ASSESSMENT_CHECK_IN`,
  `STRATEGIC_CHECK_IN`, or `DISCOVERY_ASK`
- legacy follow-up titles such as `LI - Day 2`, `LI - f/u accepted connect`,
  or `LI - final touch` can be included even when Person cadence fields are
  stale
- `DRAFTED` NOT_STARTED initial connection/request Tasks are excluded by
  default and stay in Fresh Leads
- `SENT` NOT_STARTED or CONNECTION_REQUEST records are treated as first touch
  already sent. If no post-initial open Task exists, Follow-Ups returns
  `queueClassification=follow_up_after_initial_sent`,
  `suggestedResolutionActions=["create_follow_up_task"]`, and the warning
  `Initial touch appears sent, but no follow-up task exists.`
- unresolved due tasks are excluded by default and counted in a warning:
  `N unassigned tasks hidden. Review Unassigned Tasks queue.`
- `includeUnassigned=true` can include unresolved tasks for diagnostics.
- `queueClassification` is `follow_up_post_initial_touch` or
  `follow_up_legacy_task_history`; first-touch sent gaps use
  `follow_up_after_initial_sent`

Overdue handling:

- due dates do not change logical queue membership
- first-touch overdue Tasks remain in Fresh Leads
- post-initial overdue Tasks remain in Follow-Ups
- assessment follow-up overdue Tasks remain in Warm Assessments
- queue items expose `dueStatus`, `isOverdueTask`, and `overdueDays`

Stale Recovery:

- explicit `staleRisk=STALE` or `HIGH`
- explicit stale recovery flag/reason
- `cadenceStage=PAUSED` when outreach has stalled or no response was received
- `latestTouchStatus=NO_RESPONSE` with `lastOutboundTouchDate` older than 30 days
- `lastOutboundTouchDate` older than 30 days and no open actionable Task exists
- terminal/expired cadence with no response and no next path
- every Stale Recovery item includes `staleReason`
- old `nextOutboundTouchDate`, due-today Tasks, and overdue Tasks do not create
  Stale Recovery membership by themselves

Pagination/count contract:

- `count`: items returned in the current page
- `totalCount`: all matching records for the queue after role/test filters
- `limit`, `offset`, `hasMore`, and `nextOffset`: pagination controls for the
  workspace UI
- `overdueCount`: total overdue Tasks in the full matching queue
- `GET /api/queues/summary`: all queue counts, overdue counts by queue, hidden
  test count, and degraded/rate-limit state

Unassigned Tasks:

- no `taskTarget.targetPersonId`
- no high or medium confidence inferred Person
- existing Company taskTargets can be displayed for context
- suggested resolution actions: `associate_person`, `associate_company`,
  `dismiss_from_my_view`, and `leave_unassigned`
- supported filters: `assigneeScope`, `status`, `dueBefore`, `limit`, `offset`

Warm Assessments:

- `assessmentCompleted=true`
- or `leadstageAuto=ASSESSMENT_COMPLETED`
- or `discoveryReadiness` in `READY`, `REQUESTED`, `BOOKED`

Stale Recovery:

- `staleRisk=STALE` or `HIGH`
- or `nextOutboundTouchDate` is older than the query date
- or `latestTouchStatus=NO_RESPONSE`
- exception: open first-touch Tasks generated by the missing next-task planner
  stay in Fresh Leads when cadence is `NOT_STARTED` or `CONNECTION_REQUEST`;
  an old inherited Person `nextOutboundTouchDate` alone should not make those
  newly actionable initial Tasks stale
- exception: first-touch records with `latestTouchStatus=SENT` and no
  post-initial follow-up Task are protected from Stale Recovery when the only
  stale signal is an old `nextOutboundTouchDate`; they belong in Follow-Ups as
  `create_follow_up_task` gaps

Pipeline Review:

- missing key contact/cadence fields
- enrichment status is `NEEDS_REVIEW` or `PARTIAL`
- duplicate warning exists
- non-terminal cadence exists but no next task is found
- manually-created Twenty People with missing outbound fields but enough CRM
  signal are classified as ready for normalization
- Person Company relations are resolved through expanded Person data,
  flattened relation IDs, and fetched Companies; `missing_company` is not used
  when a relation ID exists
- `reviewReasons` separate `missing_company`, `missing_email`,
  `missing_linkedin`, `missing_outbound_fields`,
  `needs_manual_normalization`, `ready_for_normalization`,
  `company_relation_unresolved`, `enrichment_partial`, `missing_next_task`,
  `test_record`, and `manual_review`

Manual lead normalization diagnostics:

```bash
PERSON_ID=<twenty-person-id> npm run queues:inspect-person
npm run queues:plan-manual-lead-normalization
```

`queues:inspect-person` prints raw queue-relevant Person fields, Company
relation resolution, owner/created-by context, associated taskTargets, queue
classification, why Company/cadence fields resolved empty, and a recommended
normalization. `queues:plan-manual-lead-normalization` writes
`data/manual-lead-normalization-plan.json` and
`data/manual-lead-normalization-summary.md`. It is read-only.

Guarded apply:

```bash
npm run queues:apply-manual-lead-normalization
```

This command is dry-run by default. Live apply requires
`MANUAL_LEAD_NORMALIZATION_APPLY_ENABLED=true`, `LIVE_TEST=true`, and
`MANUAL_LEAD_NORMALIZATION_BATCH_SIZE`. It updates only missing outbound fields
on People, skips review/test records by default, excludes protected assessment
fields, and does not create Tasks, taskTargets, Companies, or owner changes.
Task creation remains in separate guarded task apply paths.

## Queue Classification

Every queue item includes:

- `queueClassification`
- `queueClassificationReasons`

When `includeDiagnostics=true`, queue items also include
`classificationDiagnostics` with:

- `matchedQueues`
- `finalQueue`
- `excludedQueues`
- `classificationReasons`
- `staleTriggerMatched`
- `staleReason`
- `dueStatus`
- `isOverdueTask`
- `initialTaskDetected`
- `firstTouchAlreadySent`
- `followUpTaskDetected`
- `recommendedFix`

Default precedence for diagnostics is:

1. Stale Recovery
2. Warm Assessment
3. Follow-Up
4. Fresh Lead
5. Pipeline Review

This prevents an initial Fresh Lead Task from appearing in Follow-Ups by
default. Diagnostics can still explain that Follow-Ups were considered and why
they were excluded.

## Known Limitations

- Queue pages are read-only snapshots from Twenty.
- Relationship writes are feature-flagged elsewhere and are not required for
  queue reads.
- Owner scoping depends on matching Twenty workspace member emails.
- If Twenty pagination omits a related Person, task-based queue items can show a
  warning that the referenced Person was not present in the fetched People page.

## Diagnostics

Inspect relationship reads without writing:

```bash
npm run queues:inspect-task-relationships
```

Optional filters:

```bash
PERSON_ID=<twenty-person-id> TASK_ID=<twenty-task-id> LIMIT=50 npm run queues:inspect-task-relationships
```

The script prints taskTargets, resolved Person/Company, owner, assignee,
resolution path, queue bucket, warnings, and relationship gaps.

If `TASK_RETROFIT_PLAN_PATH` is provided, or the default
`data/legacy-task-retrofit-plan.json` exists, the inspection output also marks
planned task-retrofit candidates as `linked` or `still_unlinked` based on the
current Twenty `taskTargets` read.

Inspect queue classification without writing:

```bash
npm run queues:diagnose-classification
PERSON_ID=<twenty-person-id> npm run queues:diagnose-classification
TASK_ID=<twenty-task-id> npm run queues:diagnose-classification
LIMIT=25 npm run queues:diagnose-classification
```

The output shows Person, Task, cadence state, matched queues before precedence,
final queue, excluded queues, and classification reasons.

Plan missing next-task candidates without writing:

```bash
npm run queues:plan-missing-next-tasks
```

The planner writes:

- `data/missing-next-task-plan.json`
- `data/missing-next-task-summary.md`

It finds People with active, non-terminal cadence state and no open Task
resolved through taskTargets or Person markers. Test records are hidden by
default; set `INCLUDE_TEST_RECORDS=true` for diagnostics.

The missing next-task planner skips initial-stage People where
`latestTouchStatus=SENT`; those records are handled by the sent initial
follow-up planner so the engine does not recommend another connection request.

For safe first-touch rows, the planner preserves
`originalNextOutboundTouchDate` and `originalRecommendedDueDate`. If the chosen
due date is missing, already past, or same-day after the project business
cutoff, it writes a current-or-next-business-day `recommendedDueDate`,
`dueDateAdjusted=true`, and a `dueDateAdjustmentReason`.

Plan sent initial-touch follow-up gaps without writing:

```bash
npm run queues:plan-sent-initial-follow-ups
```

The planner writes:

- `data/sent-initial-follow-up-plan.json`
- `data/sent-initial-follow-up-summary.md`

It finds People where `latestTouchStatus=SENT`,
`cadenceStage=NOT_STARTED` or `CONNECTION_REQUEST`, and no post-initial open
follow-up Task exists. Relationship-building records are recommended for
`INTRO_MESSAGE` with `Send relationship follow-up / intro message`;
assessment-campaign records are recommended for `ASSESSMENT_POSITIONING` with
`Send assessment positioning follow-up`.

Guarded sent-initial follow-up apply path:

```bash
npm run queues:apply-sent-initial-follow-ups
```

This command is implemented but remains dry-run unless every live guard is set:

```bash
SENT_INITIAL_FOLLOW_UP_APPLY_ENABLED=true \
LIVE_TEST=true \
SENT_INITIAL_FOLLOW_UP_BATCH_SIZE=10 \
SENT_INITIAL_FOLLOW_UP_OFFSET=0 \
npm run queues:apply-sent-initial-follow-ups
```

Live sent-initial apply rules:

- Reads `SENT_INITIAL_FOLLOW_UP_PLAN_PATH`, default
  `data/sent-initial-follow-up-plan.json`.
- Uses only `safeToCreate=true` rows by default.
- Skips test/synthetic records unless
  `SENT_INITIAL_FOLLOW_UP_INCLUDE_TEST_RECORDS=true`.
- Skips review records unless explicitly included and forced.
- Rechecks Twenty for an open post-initial follow-up Task before writing.
- Creates the Task first, then creates `taskTargets` with
  `{ "taskId": "<new-task-id>", "targetPersonId": "<person-id>" }`.
- Does not modify the old initial Task or mark it complete.
- Does not update Person `cadenceStage` unless
  `SENT_INITIAL_FOLLOW_UP_UPDATE_PERSON_STAGE=true`.
- Optional Company target linking remains disabled unless
  `SENT_INITIAL_FOLLOW_UP_LINK_COMPANY=true`.
- Writes `crm_sync_logs` and `outbound_events` with
  `event_type=sent_initial_follow_up_created` during live apply.
- Paces live writes with `SENT_INITIAL_FOLLOW_UP_WRITE_DELAY_MS`, default
  `1500`.
- Retries Twenty 429 responses when
  `SENT_INITIAL_FOLLOW_UP_RETRY_AFTER_429=true`; it respects `retry-after`
  and otherwise waits `SENT_INITIAL_FOLLOW_UP_429_FALLBACK_DELAY_MS`, default
  `60000`.
- Writes latest apply output to
  `data/sent-initial-follow-up-apply-latest.json`.
- Returns `partial_success` when some records verify and others fail.

Recovery for a partially successful sent-initial apply:

```bash
npm run queues:recover-sent-initial-follow-ups
```

The recovery script reads the latest apply output, selects failed,
verification-failed, and repeated-failure-skipped operations, rechecks the
Task dedupe key, rechecks existing Person `taskTargets`, and writes only the
missing pieces. It remains dry-run unless the same live guards are enabled.
If `data/sent-initial-follow-up-apply-latest.json` is missing, recovery
attempts to reconstruct failed operations from Supabase `crm_sync_logs` and
`outbound_events`; if neither source exists, it exits with an actionable
missing-output response instead of throwing `ENOENT`.

Guarded apply path:

```bash
npm run queues:apply-missing-next-tasks
```

This command is implemented but remains dry-run unless every live guard is set:

```bash
MISSING_NEXT_TASK_APPLY_ENABLED=true \
LIVE_TEST=true \
MISSING_NEXT_TASK_BATCH_SIZE=10 \
MISSING_NEXT_TASK_OFFSET=0 \
npm run queues:apply-missing-next-tasks
```

Live apply rules:

- Reads `MISSING_NEXT_TASK_PLAN_PATH`, default
  `data/missing-next-task-plan.json`.
- Uses only `safeToCreate=true` rows by default.
- Skips test/synthetic records unless
  `MISSING_NEXT_TASK_INCLUDE_TEST_RECORDS=true`.
- Skips review records unless explicitly included and forced.
- Rechecks Twenty for an open Task linked by taskTarget or `Person ID` body
  marker before creating anything.
- Re-adjusts a missing or past `recommendedDueDate` at apply time. Creating
  generated Tasks with past due dates requires
  `MISSING_NEXT_TASK_ALLOW_PAST_DUE=true`.
- Creates the Task first, then creates `taskTargets` with
  `{ "taskId": "<new-task-id>", "targetPersonId": "<person-id>" }`.
- Creates optional Company taskTargets only when
  `MISSING_NEXT_TASK_LINK_COMPANY=true` and the plan row includes a Company ID.
- Verifies both the Task and Person taskTarget after creation.
- Writes `crm_sync_logs` and `outbound_events` with
  `event_type=missing_next_task_created`.
- Does not patch People, change cadence stages, reopen Tasks, or alter
  assessment webhook behavior.

## Legacy Task Target Apply

Task target cleanup is separate from People retrofit and owner cleanup. It only
links existing Twenty Tasks to existing People through confirmed `taskTargets`
payloads; it does not create replacement Tasks, reopen completed Tasks, create
cadence Tasks, or alter assessment records.

The planner writes these files by default:

```bash
npm run legacy:tasks:plan
```

- `data/legacy-task-retrofit-plan.json`
- `data/legacy-task-retrofit-summary.md`

The dry-run apply path reads the plan and prints the exact `taskTargets` payloads
that would be created:

```bash
npm run legacy:tasks:apply
```

Live apply requires both guards plus an explicit batch:

```bash
LEGACY_TASK_RETROFIT_APPLY_ENABLED=true \
LIVE_TEST=true \
LEGACY_TASK_RETROFIT_BATCH_SIZE=5 \
LEGACY_TASK_RETROFIT_OFFSET=0 \
npm run legacy:tasks:apply
```

Apply rules:

- Applies only `recommendedAction=link_task_to_person`.
- Applies only `safeToUpdate=true` records with high or medium confidence.
- Skips Tasks that already have `currentTargetPersonId`.
- Skips `leave_unassigned`, `link_task_to_company`, and `manual_review`.
- Checks for an existing matching `taskTarget` before creating a new row.
- Uses `POST /rest/taskTargets` with `{ "taskId": "...", "targetPersonId": "..." }`.
- Verifies the link by rereading `taskTargets` for the Task.
- Writes `crm_sync_logs` and `outbound_events` with
  `event_type=legacy_task_retrofit_applied` during live apply.
- Stops after repeated write failures and returns a nonzero exit code for live
  write or verification failures.

Company taskTarget links remain disabled by default. They can only be included
when a high-confidence `inferredTargetCompanyId` exists and
`LEGACY_TASK_LINK_COMPANY_ENABLED=true` is explicitly set.

## Twenty Pagination Note

Twenty People list reads return `totalCount` and `pageInfo` cursors. In this
workspace, `offset` is accepted by the REST endpoint but does not advance the
People page. Full legacy retrofit planning therefore uses cursor pagination with
`starting_after=<pageInfo.endCursor>`.

Before live retrofit batches, regenerate the plan with:

```bash
WRITE_LEGACY_RETROFIT_PLAN=true LEGACY_RETROFIT_ALL=true npm run legacy:retrofit:plan
```

The resulting summary should show `totalFetched` matching Twenty `totalCount`
and `hasMore=false`. Apply offsets are then counted against eligible update
records only, not raw People rows or already-retrofitted records.
