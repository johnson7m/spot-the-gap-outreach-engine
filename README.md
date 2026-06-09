# Spot the Gap Outreach Engine

Internal Visible Gap platform for turning Spot the Gap assessment submissions into operationally useful CRM records, follow-up tasks, opportunity context, and future AI-assisted outreach workflows.

This project is intentionally separate from the production website. The website owns the public assessment experience. This engine owns ingestion, normalization, CRM synchronization, lead intelligence, and future outbound automation.

## Current Scope

- Receive Spot the Gap assessment submissions from the existing website or Netlify form flow.
- Normalize form payloads into a stable internal assessment shape.
- Calculate an initial operational maturity score.
- Persist assessment submissions, workflow jobs, and CRM sync logs through Supabase/Postgres.
- Prepare or execute People, Companies, Tasks, and Opportunities through the CRM adapter.
- Provide duplicate prevention strategy around email, company domain, and assessment submission IDs.
- Create a clean foundation for enrichment, LinkedIn outreach, AI-generated personalization, and agent workflows.

## Architecture Direction

The system is organized around clear boundaries:

- `src/server.js`: Express app, health route, webhook route, and error handling.
- `src/routes/api/`: internal workspace API routes such as Quick Capture
  preview/commit.
- `src/middleware/`: API middleware such as Netlify rate limits, temporary
  workspace shared-secret validation, and Supabase workspace JWT/profile auth.
- `src/config/`: environment loading, validation, and logging.
- `src/integrations/netlifyWebhook.js`: Netlify assessment webhook normalization.
- `src/integrations/crm/`: provider-neutral CRM adapter boundary.
- `src/integrations/twenty/`: Twenty metadata discovery, schema validation, payload builders, and dry-run object clients.
- `src/integrations/supabase/`: Supabase client setup for operational persistence.
- `src/persistence/`: durable operational store abstraction plus in-memory test store.
- `src/integrations/openAiClient.js`: placeholder for future reviewed AI workflows.
- `src/workflows/`: business workflows that coordinate normalization, scoring, and sync.
- `src/utils/`: pure utilities such as scoring and data shaping.
- `src/agents/`: future AI-agent definitions and orchestration notes.
- `docs/`: operating model, CRM mapping, workflow map, and prompt library.
- `data/`: local development fixtures and exports. Runtime data should not be committed.

## Setup

```bash
cd spot-the-gap-outreach-engine
npm install
cp .env.example .env
npm run dev
```

Run the database schema in Supabase before enabling durable persistence:

```text
docs/database-schema.sql
```

Health check:

```bash
curl http://localhost:3000/health
```

Quick Capture dry run:

```bash
npm run quick-capture:dry
```

The dry run never writes to Twenty. To also persist the planned
`outbound_events` row in a configured Supabase environment, run with
`QUICK_CAPTURE_PERSIST_EVENTS=true`.

Quick Capture metadata inspection:

```bash
npm run quick-capture:inspect-metadata
```

This confirms Company `segment`/`industry`, Person `owner`, Company
`accountOwner`, Task `assignee`, and Twenty `workspaceMember` email matching
before owner/assignee relation-id fields are used.

Controlled Quick Capture live test:

```bash
QUICK_CAPTURE_SYNC_ENABLED=true TWENTY_SYNC_ENABLED=true LIVE_TEST=true npm run quick-capture:live
```

The live script validates that the sample lead is obviously fake/test data,
prints planned payloads before execution, writes through the CRM adapter, and
leaves protected assessment fields untouched.

Relationship payload diagnostics:

```bash
npm run twenty:relationships:test
```

This defaults to dry-run and prints confirmed metadata plus planned payloads for
Person-to-Company and Task target links. Live relationship writes require all
relationship flags plus explicit fake/test record IDs:

```bash
TWENTY_SYNC_ENABLED=true
TWENTY_RELATIONSHIP_WRITES_ENABLED=true
TWENTY_PERSON_COMPANY_LINK_ENABLED=true
TWENTY_TASK_TARGET_LINK_ENABLED=true
LIVE_TEST=true
TEST_PERSON_ID=<fake-person-id>
TEST_COMPANY_ID=<fake-company-id>
TEST_TASK_ID=<fake-task-id>
```

Workspace Quick Capture API:

```text
POST /api/quick-capture/preview
POST /api/quick-capture/commit
POST /api/tasks/:id/complete
GET /api/queues/fresh-leads
GET /api/queues/follow-ups
GET /api/queues/warm-assessments
GET /api/queues/stale-recovery
GET /api/queues/pipeline-review
GET /api/queues/unassigned-tasks
GET /api/queues/summary
GET /api/reporting/executive
GET /api/reporting/queue-health
GET /api/reporting/rep-performance
GET /api/reporting/operations
GET /api/reporting/cadence-analytics
GET /api/reporting/read-observability
```

Preview is dry-run only and is intended for the internal
`visible-gap-workspace` review screen. Commit is disabled by default and
requires explicit write guards:

```bash
QUICK_CAPTURE_API_COMMIT_ENABLED=true
TWENTY_SYNC_ENABLED=true
SUPABASE_JWT_VERIFICATION_ENABLED=true
```

Workspace API auth uses `Authorization: Bearer <supabase-access-token>`. The
engine verifies the token through Supabase, loads `workspace_profiles`, rejects
inactive profiles, and allows `admin`, `operator`, and `rep` roles for Quick
Capture preview/commit. The legacy
`x-visible-gap-workspace-secret: <WORKSPACE_API_SECRET>` path remains only as a
server-configured staging fallback; the browser workspace should not send it.
Set `WORKSPACE_ALLOWED_ORIGIN` to the deployed workspace origin when browser
CORS needs to allow the internal app.

Quick Capture accepts optional notes when another context path exists
(`linkedinUrl`, `email`, or valid phone). Phone writes are US `+1` shaped and
unsafe phone values are omitted with warnings. Company Segment/Industry and
owner/assignee fields are written only when Twenty metadata and workspace-member
matching confirm the exact field shape.

Relationship writes are disabled by default. When all relationship flags are
enabled, Quick Capture attempts non-blocking links after core CRM writes:

- Person to Company through `companyId`
- Task to Person through `taskTargets.targetPersonId`
- Task to Company through `taskTargets.targetCompanyId`, when a Company ID is
  available

Relationship failures produce warnings and audit rows but do not fail an
otherwise successful Quick Capture commit.

Legacy lead retrofit dry-run:

```bash
npm run legacy:retrofit:plan
```

This inspects existing Twenty People, Tasks, task targets, note targets,
timeline activity, workspace members, and legacy Person fields such as
`eventCustom` and `leadStage`. It prints a recommended outbound-field retrofit
plan and performs no CRM writes. Set `WRITE_LEGACY_RETROFIT_PLAN=true` only when
you want to save the dry-run output to `data/legacy-retrofit-plan.json` and
`data/legacy-retrofit-summary.md`. The plan includes owner resolution context
per Person, uses `createdBy` as a dry-run fallback when Owner is missing, and
keeps owner suggestions under `ownerRecommendation` instead of normal retrofit
updates.

Full legacy planning uses Twenty cursor pagination, not offset pagination.
Twenty returns `pageInfo.endCursor` and the next page is requested with
`starting_after=<endCursor>`. To fetch every Person before applying batches:

```bash
WRITE_LEGACY_RETROFIT_PLAN=true LEGACY_RETROFIT_ALL=true LEGACY_RETROFIT_PAGE_SIZE=100 LEGACY_RETROFIT_MAX_PAGES=10 npm run legacy:retrofit:plan
```

The generated summary distinguishes total records, already-retrofitted records,
records still needing updates, safe updates, and manual-review records.

Legacy retrofit apply dry-run:

```bash
npm run legacy:retrofit:apply
```

Live apply is guarded separately and updates only missing outbound fields for
safe records by default. It excludes protected assessment fields and does not
apply owner recommendations:

```bash
LEGACY_RETROFIT_APPLY_ENABLED=true LIVE_TEST=true LEGACY_RETROFIT_BATCH_SIZE=5 LEGACY_RETROFIT_OFFSET=0 npm run legacy:retrofit:apply
```

Apply batching is based on eligible records with non-empty
`recommendedUpdates`; already-retrofitted records do not consume offset slots.

Legacy task relationship retrofit dry-run:

```bash
npm run queues:inspect-task-relationships
npm run queues:inspect-task-relationships -- --summary
npm run queues:inspect-task-relationships -- --limit=25
npm run queues:inspect-task-relationships -- --person-id=<twenty-person-id>
npm run queues:inspect-task-relationships -- --task-id=<twenty-task-id>
npm run queues:inspect-task-relationships -- --json
npm run queues:inspect-task-relationships -- --csv
npm run queues:inspect-person
npm run queues:diagnose-classification
npm run queues:plan-manual-lead-normalization
npm run queues:apply-manual-lead-normalization
npm run queues:plan-missing-next-tasks
npm run queues:apply-missing-next-tasks
npm run legacy:tasks:plan
npm run legacy:tasks:apply
```

These scripts are read-only. The inspection script reports taskTargets,
resolved Person/Company, owner, assignee, resolution path, queue bucket, and
relationship gaps. It now writes:

- `data/task-relationship-summary.md`
- `data/task-relationship-report.json`
- `data/task-relationship-report.csv`

Optional filters:

```bash
SHOW_ONLY_UNLINKED=true npm run queues:inspect-task-relationships -- --summary
SHOW_ONLY_SAFE_LINKS=true npm run queues:inspect-task-relationships -- --summary
```

Queue classification diagnostics:

```bash
PERSON_ID=<twenty-person-id> npm run queues:inspect-person
npm run queues:diagnose-classification
PERSON_ID=<twenty-person-id> npm run queues:diagnose-classification
TASK_ID=<twenty-task-id> npm run queues:diagnose-classification
LIMIT=25 npm run queues:diagnose-classification
```

`queues:inspect-person` is read-only and prints raw queue-relevant Person
fields, Company relation resolution, owner/created-by context, associated
taskTargets, queue classification, and a recommended manual normalization plan.
`queues:diagnose-classification` shows each Person/Task pair, matched queues
before precedence, final queue, excluded queues, and classification reasons.

Manual lead normalization planning:

```bash
npm run queues:plan-manual-lead-normalization
```

This read-only planner finds manually-created Twenty People with missing
outbound fields but enough CRM signal, such as `leadStage`, LinkedIn, email,
Company relation, owner, or created-by context. It writes:

- `data/manual-lead-normalization-plan.json`
- `data/manual-lead-normalization-summary.md`

Guarded manual lead normalization apply:

```bash
npm run queues:apply-manual-lead-normalization
```

This command is dry-run by default. Live People updates require
`MANUAL_LEAD_NORMALIZATION_APPLY_ENABLED=true`, `LIVE_TEST=true`, and an
explicit `MANUAL_LEAD_NORMALIZATION_BATCH_SIZE`. The apply path updates only
missing outbound fields on People, excludes protected assessment fields, does
not overwrite non-empty outbound fields unless
`MANUAL_LEAD_NORMALIZATION_FORCE=true`, and never creates Tasks, taskTargets,
Companies, owner changes, or assessment updates. Task creation remains a
separate guarded workflow.

The task planner identifies existing Tasks missing taskTarget relationships and
recommends `link_task_to_person`, `link_task_to_company`, `leave_unassigned`, or
`manual_review`. The apply command remains dry-run unless both live guards are
enabled; in dry-run it prints the eligible taskTarget payloads without writing.

The missing next-task planner identifies People with active, non-terminal
cadence state and no open Task resolved through taskTargets or Person markers:

```bash
npm run queues:plan-missing-next-tasks
```

It writes:

- `data/missing-next-task-plan.json`
- `data/missing-next-task-summary.md`

For first-touch task creation, the planner preserves
`originalNextOutboundTouchDate` and `originalRecommendedDueDate`. If the
planned due date is missing or older than the current project date, it refreshes
`recommendedDueDate` to the current business day if still actionable, otherwise
the next business day, and sets `dueDateAdjusted=true` with a
`dueDateAdjustmentReason`.

Test/synthetic records are hidden by default. Set `INCLUDE_TEST_RECORDS=true`
only for diagnostics. `queues:apply-missing-next-tasks` remains dry-run unless
every live guard is explicitly set.

The missing next-task planner skips initial-stage People where
`latestTouchStatus=SENT` so it does not recommend another connection request.
Use the sent initial follow-up planner for those records:

```bash
npm run queues:plan-sent-initial-follow-ups
```

It writes `data/sent-initial-follow-up-plan.json` and
`data/sent-initial-follow-up-summary.md`, recommending `INTRO_MESSAGE` with
`Send relationship follow-up / intro message` for relationship cadence records
and `ASSESSMENT_POSITIONING` with `Send assessment positioning follow-up` for
assessment cadence records.

Dry-run apply:

```bash
npm run queues:apply-missing-next-tasks
```

Live missing next-task creation requires an explicit batch:

```bash
MISSING_NEXT_TASK_APPLY_ENABLED=true LIVE_TEST=true MISSING_NEXT_TASK_APPLY_MODE=next_eligible MISSING_NEXT_TASK_BATCH_SIZE=5 npm run queues:apply-missing-next-tasks
```

Recover retryable missing next-task failures from the latest apply output:

```bash
npm run queues:recover-missing-next-tasks
```

Dry-run sent-initial follow-up apply:

```bash
npm run queues:apply-sent-initial-follow-ups
```

Live sent-initial follow-up creation requires an explicit batch:

```bash
SENT_INITIAL_FOLLOW_UP_APPLY_ENABLED=true LIVE_TEST=true SENT_INITIAL_FOLLOW_UP_APPLY_MODE=next_eligible SENT_INITIAL_FOLLOW_UP_BATCH_SIZE=10 npm run queues:apply-sent-initial-follow-ups
```

Recover retryable failures from the latest apply output:

```bash
npm run queues:recover-sent-initial-follow-ups
```

Sent-initial apply rules:

- reads local `data/sent-initial-follow-up-plan.json` by default
- supports `SENT_INITIAL_FOLLOW_UP_APPLY_MODE=next_eligible`, which ignores
  offset and selects the first currently eligible safe records for each batch
- keeps `SENT_INITIAL_FOLLOW_UP_APPLY_MODE=offset` for diagnostics/backward
  compatibility
- returns `remainingEligibleCount` and a `nextRecommendedCommand`; when no
  eligible rows remain, the next command is `null`
- creates Tasks only for `safeToCreate=true` rows
- skips test records unless `SENT_INITIAL_FOLLOW_UP_INCLUDE_TEST_RECORDS=true`
- skips review records unless explicitly forced
- rechecks Twenty for an existing open post-initial follow-up Task before
  writing
- creates the Task first, then creates the Person `taskTarget`
- does not modify the old initial Task
- does not update Person `cadenceStage` unless
  `SENT_INITIAL_FOLLOW_UP_UPDATE_PERSON_STAGE=true`
- optional Company taskTarget linking remains off unless
  `SENT_INITIAL_FOLLOW_UP_LINK_COMPANY=true`
- waits `SENT_INITIAL_FOLLOW_UP_WRITE_DELAY_MS` between live operations
  by default
- retries Twenty 429 responses when
  `SENT_INITIAL_FOLLOW_UP_RETRY_AFTER_429=true`, respecting `retry-after`
  when present and otherwise using
  `SENT_INITIAL_FOLLOW_UP_429_FALLBACK_DELAY_MS`
- writes the latest apply output to
  `data/sent-initial-follow-up-apply-latest.json`
- recovery rechecks the dedupe key and existing `taskTargets` before writing,
  so partially successful operations can be resumed without duplicate Tasks
- if the latest apply output file is missing, recovery falls back to Supabase
  `crm_sync_logs` and `outbound_events` for
  `sent_initial_follow_up_create` / `sent_initial_follow_up_created` before
  failing with an actionable message

Apply rules:

- reads local `data/missing-next-task-plan.json`
- supports `MISSING_NEXT_TASK_APPLY_MODE=next_eligible`, which ignores offset
  and selects the first currently eligible safe records for each batch
- keeps `MISSING_NEXT_TASK_APPLY_MODE=offset` for diagnostics/backward
  compatibility
- returns `remainingEligibleCount` and a `nextRecommendedCommand`; when no
  eligible rows remain, the next command is `null`
- creates Tasks only for `safeToCreate=true` rows
- skips test records unless `MISSING_NEXT_TASK_INCLUDE_TEST_RECORDS=true`
- skips review records unless explicitly forced
- rechecks Twenty for an existing open Task before writing
- adjusts missing or past `recommendedDueDate` again at apply time; past-due
  generated tasks require `MISSING_NEXT_TASK_ALLOW_PAST_DUE=true`
- uses `personId + cadenceName + cadenceStage + recommendedTaskType` as the
  dedupe key
- creates `POST /rest/taskTargets` Person links after Task creation
- optionally links Company only with `MISSING_NEXT_TASK_LINK_COMPANY=true`
- verifies the Task and Person taskTarget after creation
- waits `MISSING_NEXT_TASK_WRITE_DELAY_MS` between live operations by default
- retries Twenty 429 responses when `MISSING_NEXT_TASK_RETRY_AFTER_429=true`,
  respecting `retry-after` when present and otherwise using
  `MISSING_NEXT_TASK_429_FALLBACK_DELAY_MS`
- writes the latest apply output to `data/missing-next-task-apply-latest.json`
- recovery rechecks the dedupe key and existing `taskTargets` before writing,
  so partially successful operations can be resumed without duplicate Tasks
- if the latest apply output file is missing, recovery falls back to Supabase
  `crm_sync_logs` and `outbound_events` for
  `missing_next_task_create` / `missing_next_task_created` before failing with
  an actionable message
- writes `crm_sync_logs` and `outbound_events` with
  `event_type=missing_next_task_created`
- does not update People, change cadence stage, or alter assessment webhook
  behavior

Guarded task relationship apply links existing Tasks to existing People only:

```bash
LEGACY_TASK_RETROFIT_APPLY_ENABLED=true LIVE_TEST=true LEGACY_TASK_RETROFIT_BATCH_SIZE=5 LEGACY_TASK_RETROFIT_OFFSET=0 npm run legacy:tasks:apply
```

The apply path selects only safe `link_task_to_person` candidates, avoids
duplicate `taskTargets`, verifies the link after writing, and records
`crm_sync_logs` plus `outbound_events` with
`event_type=legacy_task_retrofit_applied`. It does not create replacement
Tasks, reopen completed Tasks, create cadence Tasks, or alter assessment
records. Company taskTarget links are disabled unless
`LEGACY_TASK_LINK_COMPANY_ENABLED=true` is explicitly set.

Legacy owner cleanup dry-run:

```bash
npm run legacy:owners:plan
npm run legacy:owners:apply
```

Owner cleanup is separate from outbound retrofit. It uses the confirmed Person
Owner REST shape `PATCH /rest/people/:personId` with `{ "ownerId":
"<workspaceMemberId>" }`, skips existing owners by default, and verifies the
Person owner after each guarded live write.

Task completion endpoint:

```text
POST /api/tasks/:id/complete
```

This records a manual outbound touch, updates Person cadence/outbound touch
fields, creates or skips one next Task according to the cadence rules, writes
`outbound_events`, and audits CRM operations in `crm_sync_logs` when Supabase
persistence is enabled. It requires Supabase workspace JWT auth and role
`admin`, `operator`, or `rep`. It does not automate LinkedIn actions and does
not require relationship writes; next Task bodies include Person ID and cadence
context as a fallback. When relationship flags are enabled, the engine also
attempts a non-blocking `taskTargets.targetPersonId` link for the next Task.

Workspace queue endpoints:

```text
GET /api/queues/fresh-leads
GET /api/queues/follow-ups
GET /api/queues/warm-assessments
GET /api/queues/stale-recovery
GET /api/queues/pipeline-review
GET /api/queues/unassigned-tasks
GET /api/queues/summary
```

These endpoints are read-only. They require Supabase workspace JWT auth and role
`admin`, `operator`, or `rep`; reps default to `ownerScope=mine`, while admins
and operators can request `ownerScope=all`. The Unassigned Tasks queue uses
`assigneeScope=mine|all` instead. Queue fetches read Twenty People and Tasks
plus task targets, note targets, timeline activity, and workspace members. They
return a normalized workspace item shape and include warnings when task
relationships must be inferred from task body `Person ID` markers or when
owner/assignee data is unavailable.

Follow-Ups exclude unassigned Tasks by default and return a warning/count such
as `22 unassigned tasks hidden. Review Unassigned Tasks queue.` The workspace
should review those records through `GET /api/queues/unassigned-tasks` rather
than showing them as "Unknown person" in the normal Follow-Up Queue.

Fresh Leads with `NOT_STARTED` or `CONNECTION_REQUEST` cadence remain visible
even when no open Task exists. Those items include
`suggestedResolutionActions=["create_next_task"]` and the warning
`No open task exists yet; create the first cadence task.` Pipeline Review items
include structured `reviewReasons` such as `missing_company`,
`missing_email`, `missing_linkedin`, `missing_outbound_fields`,
`needs_manual_normalization`, `ready_for_normalization`,
`company_relation_unresolved`, `enrichment_partial`, `missing_next_task`,
`test_record`, and `manual_review`.

Queue responses hide obvious test/synthetic People by default and report the
count as `data.diagnostics.hiddenTestRecords`. Use `includeTestRecords=true`
for diagnostics. Broad `timelineActivities` pagination noise is moved to
`data.diagnostics.timelinePaginationWarning` instead of normal top-level queue
warnings.

Queue reads distinguish degraded data from true empty queues. Critical reads
are People, Tasks, TaskTargets, and WorkspaceMembers when rep scoping requires
owner/assignee enforcement. If Twenty rate-limits a critical read, the response
sets `data.status="degraded_rate_limited"`, `data.isPartial=true`,
`data.partialReason="twenty_rate_limited"`, `data.retryAfterSeconds` when
available, and `data.count=null`. If a recent successful read is cached, the
engine returns `data.status="stale_cache"` with cache diagnostics instead of an
empty queue. Queue retry/cache settings:

```bash
QUEUE_READ_RETRY_ENABLED=true
QUEUE_READ_RETRY_MAX_ATTEMPTS=2
QUEUE_READ_RETRY_BASE_MS=500
QUEUE_READ_CACHE_ENABLED=true
QUEUE_READ_CACHE_TTL_SECONDS=90
```

Queue pagination:

- `count` is the number of items returned in the current page.
- `totalCount` is the full matching count for that queue.
- `limit`, `offset`, `hasMore`, and `nextOffset` support paged/collapsed
  workspace list views.
- `overdueCount` counts overdue tasks within the full matching queue.
- `GET /api/queues/summary` returns all queue counts, overdue counts by queue,
  hidden test record count, people coverage counts, and degraded/rate-limit
  status.
- `npm run queues:coverage-audit` writes
  `data/queue-coverage-audit.json` and `data/queue-coverage-summary.md` so we
  can confirm every non-test Person has an explicit disposition.

Queue coverage audit dispositions:

- `fresh_lead`
- `follow_up`
- `warm_assessment`
- `stale_recovery`
- `pipeline_review`
- `terminal_closed`
- `active_client`
- `unclassified_needs_rule`
- `hidden_test_record`

The audit explains Pipeline Review-only records with explicit reasons such as
`missing_outbound_fields`, `missing_company`, `missing_email`, `missing_task`,
`ready_for_normalization`, `manual_review`, or `no_action_rule_missing`.

Pipeline Review endpoint semantics:

- Default `GET /api/queues/pipeline-review` returns only People whose final
  queue/disposition is Pipeline Review after queue precedence is applied.
- `includeAllReviewed=true` or `includeDiagnostics=true` can reveal all reviewed
  People for diagnostics, including records whose final queue is Fresh Leads,
  Follow-Ups, Warm Assessments, or Stale Recovery.
- `GET /api/queues/summary` exposes `diagnostics.reviewedPeopleCount` and
  `diagnostics.finalPipelineReviewCount` so we can distinguish "reviewed by
  Pipeline Review rules" from "final Pipeline Review tab count."
- `npm run queues:compare-pipeline-review-counts` compares coverage audit,
  summary, and endpoint counts against the same read-only Twenty snapshot.
  Use `BYPASS_QUEUE_CACHE=true` to skip the short-lived queue source cache while
  diagnosing count mismatches.

Fresh vs Follow-Up classification:

- Fresh Leads own first-touch work: `NOT_STARTED` or `CONNECTION_REQUEST`
  records with `latestTouchStatus=DRAFTED` and initial connection/request Tasks.
- Follow-Ups are post-initial-touch work: `INTRO_MESSAGE`, `VALUE_TOUCH`,
  `ASSESSMENT_POSITIONING`, `ASSESSMENT_SENT`, `ASSESSMENT_CHECK_IN`,
  `STRATEGIC_CHECK_IN`, `DISCOVERY_ASK`, or legacy task titles like
  `LI - Day 2` and `LI - final touch`.
- A `DRAFTED` `NOT_STARTED` Person with `Send relationship-oriented connection
  request` or `Send assessment-oriented connection request` stays in Fresh
  Leads and is excluded from Follow-Ups by default.
- A `SENT` `NOT_STARTED` or `CONNECTION_REQUEST` Person is treated as first
  touch already sent. If no post-initial open Task exists, Follow-Ups returns
  `queueClassification=follow_up_after_initial_sent`,
  `suggestedResolutionActions=["create_follow_up_task"]`, and a warning that
  the initial touch appears sent but no follow-up Task exists.
- Open initial tasks generated by the missing next-task planner stay in Fresh
  Leads even when the Person's inherited `nextOutboundTouchDate` is old.
- Open post-initial tasks generated by the sent-initial follow-up apply path
  stay in Follow-Ups even when due today or overdue.
- Queue items expose `dueStatus`, `isOverdueTask`, and `overdueDays`; due dates
  do not move records into Stale Recovery.
- Stale Recovery is reserved for stalled relationship signals such as
  `staleRisk=STALE|HIGH`, explicit stale recovery flags/reasons, `PAUSED`
  stalled cadence, `NO_RESPONSE` with `lastOutboundTouchDate` older than 30
  days, old `lastOutboundTouchDate` with no open actionable task, or terminal
  no-response cadence with no next path.
- Old `nextOutboundTouchDate` alone does not create Stale Recovery membership.
- Queue items include `queueClassification` and `queueClassificationReasons`.
  `includeDiagnostics=true` adds matched/excluded queue details.

Read-only reporting endpoints:

```text
GET /api/reporting/executive
GET /api/reporting/queue-health
GET /api/reporting/rep-performance
GET /api/reporting/operations
GET /api/reporting/cadence-analytics
GET /api/reporting/read-observability
```

These endpoints require Supabase workspace JWT auth and role `admin`,
`operator`, or `rep`. They reuse the same Twenty queue source reads,
rate-limit/degraded states, owner scoping, test-record detection, and queue
classification rules as the queue endpoints. Phase 1 reports current-state
executive and queue-health metrics. Phase 2 adds read-only rep-performance
metrics from Twenty current state plus Supabase activity logs when configured.
Phase 3 adds read-only operations reporting from Supabase `outbound_events`,
`crm_sync_logs`, and `assessment_submissions`. Reporting performs no CRM or
Supabase writes.
Phase 4 adds read-only cadence analytics from Twenty cadence/task state plus
Supabase `outbound_events` and `assessment_submissions`. Conversion rows include
`high`, `medium`, or `low` confidence so approximate current-state conversions
are not mistaken for fully historical funnel rates.
Read Observability is admin/operator-only and reports process-local Twenty read
instrumentation for endpoint/workflow duration, cache status, fetched records,
fetched pages, duplicate-read estimates, and snapshot-layer opportunities.

Diagnostic scripts:

```bash
npm run reporting:executive
npm run reporting:queue-health
npm run reporting:rep-performance
npm run reporting:operations
npm run reporting:cadence-analytics
npm run reporting:read-observability
```

Set `REPORTING_OWNER_SCOPE=mine|all`, `REPORTING_ASSIGNEE_SCOPE=mine|all`,
`REPORTING_INCLUDE_DIAGNOSTICS=true`, `REPORTING_START_DATE=YYYY-MM-DD`,
`REPORTING_END_DATE=YYYY-MM-DD`, `REPORTING_CADENCE_NAME=RELATIONSHIP_BUILDING_V1`,
or `BYPASS_QUEUE_CACHE=true` for local read-only reporting diagnostics. Rep
performance, operations, and cadence analytics default to the last 30 days when
no date range is provided.

Workspace auth flags:

```bash
SUPABASE_JWT_VERIFICATION_ENABLED=false
SUPABASE_AUTH_REQUIRED_FOR_WORKSPACE_API=false
```

Turn both on after the Supabase `workspace_profiles` table is applied and
profile rows exist for workspace users. `SUPABASE_SERVICE_ROLE_KEY` must stay
server-side in this engine and must never be exposed to the frontend.

Webhook endpoint:

```text
POST /webhooks/netlify/spot-the-gap
```

Twenty CRM sync is disabled by default through `TWENTY_SYNC_ENABLED=false`. Supabase persistence is disabled by default through `SUPABASE_ENABLED=false`, in which case local development uses an in-memory operational store.

Live CRM sync should only be enabled after:

- Supabase schema is installed.
- `SUPABASE_ENABLED=true`.
- `TWENTY_API_KEY` is configured.
- Twenty schema validation passes.
- Webhook signature validation and deployment-level rate limiting are in place.

Current CRM flow:

```text
assessmentWorkflow
  -> crmAdapter
      -> twentyProvider
```

Future internal workspace:

```text
visible-gap-workspace
  -> outreach engine API
      -> Supabase operational store
      -> CRM adapter
      -> Twenty provider
```

The future `visible-gap-workspace` repo should be a separately deployed internal
React/Vite app for Quick Capture, rep queues, reporting, and operator recovery.
It should call this engine through authenticated API endpoints and should never
write directly to Twenty or Supabase from the browser.

Useful docs:

- `docs/assessment-schema.md`
- `docs/crm-field-map.md`
- `docs/twenty-integration-plan.md`
- `docs/outbound-operations-architecture.md`
- `docs/quick-capture-blueprint.md`
- `docs/internal-workspace-architecture.md`
- `docs/workspace-api-contract.md`
- `docs/quick-capture-ui-spec.md`
- `docs/rep-queue-ui-spec.md`
- `docs/operator-recovery-ui-spec.md`
- `docs/outbound-state-machine.md`
- `docs/duplicate-resolution-blueprint.md`
- `docs/lead-health-scoring-spec.md`
- `docs/crm-schema-gap-analysis.md`
- `docs/cadence-engine-blueprint.md`
- `docs/rep-queue-blueprint.md`
- `docs/reporting-blueprint.md`
- `docs/reporting-blueprint-v2.md`
- `docs/queue-data-resolution.md`
- `docs/legacy-lead-retrofit-plan.md`
- `docs/workspace-performance-stabilization-plan.md`

## Roadmap

1. Confirm the live assessment payload shape from Netlify.
2. Align scoring logic with the production website assessment behavior.
3. Finalize Twenty CRM field mapping and custom objects.
4. Implement safe CRM upserts for People and Companies.
5. Add Task and Opportunity creation based on score bands and priority signals.
6. Add deployment-grade webhook signature validation and rate limiting.
7. Add enrichment providers and LinkedIn research workflow support.
8. Add OpenAI-powered personalization drafts with human review.
9. Add operational dashboards and alerting.

## Operating Principle

This engine should increase operational visibility, not just automate activity. Every sync, score, task, and outreach suggestion should make the next human action clearer.
