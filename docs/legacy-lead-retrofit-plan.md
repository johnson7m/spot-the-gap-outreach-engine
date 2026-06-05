# Legacy Lead Retrofit Plan

This plan prepares existing Twenty People records for the outbound operating
loop without changing the public assessment flow and without running CRM writes.
The current implementation is a dry-run planner only.

## Purpose

Legacy leads already exist in Twenty before the Quick Capture workflow was
introduced. Many of those records do not have outbound-specific fields such as
`outboundPipelineType`, `cadenceName`, `cadenceStage`, `leadHealthScore`,
`enrichmentStatus`, or `nextOutboundTouchDate`.

The retrofit planner inspects existing CRM context and proposes safe updates so
the internal workspace queues can classify those leads more clearly.

## Confirmed Twenty Metadata

Twenty metadata discovery confirmed these Person fields:

| Label | API name | Type | Notes |
| --- | --- | --- | --- |
| Event | `eventCustom` | `BOOLEAN` | Used as a legacy signal that a human relationship context exists. |
| Lead Stage | `leadStage` | `SELECT` | Manual/general lead stage separate from protected assessment field `leadstageAuto`. |
| Owner | `owner` | `RELATION` | Join column is `ownerId`. |
| Created by | `createdBy` | `ACTOR` | Shape includes `source`, `workspaceMemberId`, `name`, and `context`. Used only for owner recommendations when Owner is missing. |
| Company | `company` | `RELATION` | Join column is `companyId`. |
| Emails | `emails` | `EMAILS` | Existing primary email field. |
| LinkedIn | `linkedinLink` | `LINKS` | Existing LinkedIn/profile URL field. |
| Task Targets | `taskTargets` | `RELATION` | Reverse relation used to find task history. |
| Note Targets | `noteTargets` | `RELATION` | Reverse relation used to find note history. |
| Timeline Activities | `timelineActivities` | `RELATION` | Existing activity history signal. |

Manual `leadStage` values:

- `IDENTIFIED`
- `OUTREACH_INITIATED`
- `ENGAGED`
- `ACTIVE_CONVERSATION`
- `DISCOVERY_READY`
- `UNQUALIFIED_CLOSED`
- `ACTIVE_CLIENT`

Related object metadata confirmed:

| Object | Useful fields |
| --- | --- |
| `task` | `taskTargets`, `assigneeId`, `bodyV2`, `status`, `dueAt` |
| `taskTarget` | `taskId`, `targetPersonId`, `targetCompanyId` |
| `noteTarget` | `noteId`, `targetPersonId`, `targetCompanyId` |
| `timelineActivity` | `targetPersonId`, `targetTaskId`, `workspaceMemberId` |
| `workspaceMember` | member/user email fields used for owner and assignee display |

## Owner Resolution

The dry-run planner includes owner planning context for every Person record:

- `ownerId`
- `ownerName`
- `ownerEmail`
- `ownerWorkspaceMemberId`
- `createdById`
- `createdByName`
- `createdByEmail`
- `inferredOwnerName`
- `inferredOwnerEmail`
- `inferredOwnerWorkspaceMemberId`
- `ownerResolutionStatus`
- `ownerRecommendation`
- `recommendedWorkspaceEmail`

Existing `ownerId` wins over Created By. `ownerId` is resolved against Twenty
`workspaceMembers` first. If that does not resolve a workspace email, the
planner falls back to embedded owner email/name data and then to this legacy
owner-name map:

| Legacy owner name | Recommended workspace email |
| --- | --- |
| Chandler Johnson | `chandler@visiblegap.com` |
| Brayson Grider | `brayson.grider@visiblegap.com` |
| Darrean Beller | `darrean.beller@visiblegap.com` |
| Visible Gap | `hello@visiblegap.com` |

If `ownerId` is missing and `createdBy` can be resolved, the planner sets
`ownerResolutionStatus=inferred_from_created_by` and places the suggested owner
under `ownerRecommendation`. It does not add `ownerId` to normal
`recommendedUpdates`.

If `createdBy` maps to the legacy Visible Gap workspace member, the planner
recommends Chandler Johnson unless a stronger user-level Created By identity is
available. The Created By fields remain visible in the plan so this inference
can be reviewed before any future live owner apply.

Owner resolution statuses:

| Status | Meaning |
| --- | --- |
| `resolved` | Owner matched by `ownerId`, direct owner email, or known legacy owner name. |
| `inferred_from_created_by` | Owner is missing and a recommended owner was inferred from `createdBy`. |
| `unresolved` | Owner data exists but does not map to a known workspace email. |
| `missing` | No owner ID, owner object, owner name, or owner email was available. |
| `legacy_visible_gap` | Owner is the legacy Visible Gap account. Recommended workspace email is `hello@visiblegap.com`. |

The planner never recommends owner overwrites. Missing or unresolved owner
context adds this warning but does not block `safeToUpdate` by itself:

```text
Owner could not be resolved; retrofit can proceed but rep assignment may need review.
```

When Created By exists but cannot be resolved, the planner uses:

```text
Owner missing and Created By could not be resolved.
```

## Protected Assessment Fields

The retrofit planner must not recommend updates to:

- `assessmentCompleted`
- `assessmentScore`
- `lastTouchDate`
- `leadstageAuto`
- `messageAngle`
- `nextFollowUpDate`

These fields remain owned by the assessment webhook pipeline.

## Classification Rules

The planner classifies each Person into one of two outbound modes:

| Evidence | Inferred pipeline |
| --- | --- |
| `eventCustom=true` | `RELATIONSHIP_BUILDING` |
| Existing task history | `RELATIONSHIP_BUILDING` |
| Existing note history | `RELATIONSHIP_BUILDING` |
| Existing timeline activity | `RELATIONSHIP_BUILDING` |
| `leadStage` beyond `IDENTIFIED` | `RELATIONSHIP_BUILDING` |
| No relationship evidence | `ASSESSMENT_CAMPAIGN` |

Default cadence names:

| Pipeline type | Cadence name |
| --- | --- |
| `RELATIONSHIP_BUILDING` | `RELATIONSHIP_BUILDING_V1` |
| `ASSESSMENT_CAMPAIGN` | `ASSESSMENT_CAMPAIGN_V1` |

## Lead Stage Mapping

| Legacy `leadStage` | Recommended cadence stage | Discovery readiness | Lead health |
| --- | --- | --- | --- |
| `IDENTIFIED` | `NOT_STARTED` | `NOT_READY` | 35 |
| `OUTREACH_INITIATED` | `CONNECTION_REQUEST` or `INTRO_MESSAGE` when a connection task exists | `NOT_READY` | 45 |
| `ENGAGED` | `VALUE_TOUCH` | `MONITOR` | 65 |
| `ACTIVE_CONVERSATION` | `STRATEGIC_CHECK_IN` | `MONITOR` | 72 |
| `DISCOVERY_READY` | `DISCOVERY_ASK` | `READY` | 85 |
| `UNQUALIFIED_CLOSED` | `PAUSED` | `NOT_READY` | 10 |
| `ACTIVE_CLIENT` | `COMPLETED` | `BOOKED` | 100 |

## Planner Output

Run:

```bash
npm run legacy:retrofit:plan
```

The script prints:

- metadata discovery status
- confirmed legacy field API names
- requested fetch mode
- page size
- pages fetched
- total fetched
- Twenty `totalCount`
- `hasMore` and next cursor status
- final total plan count
- summary counts
- sample plans
- warnings from read-only Twenty fetches

Twenty People list pagination is cursor-based. The endpoint returns
`totalCount` and `pageInfo.endCursor`; the next page is requested with
`starting_after=<endCursor>`. `offset` is accepted by the endpoint but does not
advance the People page in this workspace, so the retrofit planner uses cursor
pagination when full mode is enabled.

Full People fetch:

```bash
WRITE_LEGACY_RETROFIT_PLAN=true LEGACY_RETROFIT_ALL=true npm run legacy:retrofit:plan
```

Full-fetch options:

| Env var | Default | Purpose |
| --- | --- | --- |
| `LEGACY_RETROFIT_ALL` | `false` | Enables cursor pagination through all People pages. |
| `LEGACY_RETROFIT_PAGE_SIZE` | `100` | People page size requested from Twenty. |
| `LEGACY_RETROFIT_MAX_PAGES` | `10` | Safety cap for full CRM reads. |

If `LEGACY_RETROFIT_ALL=true` fetches exactly one 100-record page while Twenty
reports more records, the planner emits a warning so apply batches are not run
from a truncated plan.

It does not write to Twenty. It writes `data/legacy-retrofit-plan.json` and
`data/legacy-retrofit-summary.md` only when explicitly requested:

```bash
WRITE_LEGACY_RETROFIT_PLAN=true npm run legacy:retrofit:plan
```

## Recommended Update Shape

Each plan includes:

- `personId`
- `name`
- `company`
- `ownerId`
- `ownerName`
- `ownerEmail`
- `ownerWorkspaceMemberId`
- `createdById`
- `createdByName`
- `createdByEmail`
- `inferredOwnerName`
- `inferredOwnerEmail`
- `inferredOwnerWorkspaceMemberId`
- `ownerResolutionStatus`
- `ownerRecommendation`
- `recommendedWorkspaceEmail`
- `currentFields`
- `inferredPipelineType`
- `inferredCadenceName`
- `inferredCadenceStage`
- `inferredDiscoveryReadiness`
- `inferredLeadHealthScore`
- `inferredStaleRisk`
- `missingFields`
- `recommendedUpdates`
- `evidence`
- `warnings`
- `safeToUpdate`

`safeToUpdate=false` means the row needs manual review before any future
migration. Common reasons include missing strong identifiers, unrecognized
legacy stage values, or no missing outbound fields.

The summary includes owner rollups:

- `alreadyRetrofitted`
- `needingUpdate`
- `safeToUpdate`
- `requiresManualReview`
- `recordsByOwner`
- `recordsByCreatedBy`
- `recordsWithMissingOwner`
- `recordsWithResolvedOwner`
- `recordsWithUnresolvedOwner`
- `recordsInferredFromCreatedBy`
- `recordsStillMissingOwner`
- `recordsOwnedByVisibleGap`
- `recordsByRecommendedWorkspaceEmail`
- `ownerRecommendationsByPerson`

## Guarded Apply Path

The apply path is intentionally separate from planning:

```bash
npm run legacy:retrofit:apply
```

By default this command is a dry-run. It loads
`data/legacy-retrofit-plan.json`, selects the configured batch, prints the
People payloads it would send to Twenty, and does not write.

Required live guards:

```bash
LEGACY_RETROFIT_APPLY_ENABLED=true
LIVE_TEST=true
```

Apply configuration:

| Env var | Default | Purpose |
| --- | --- | --- |
| `LEGACY_RETROFIT_PLAN_PATH` | `data/legacy-retrofit-plan.json` | JSON plan to apply. |
| `LEGACY_RETROFIT_BATCH_SIZE` | `5` | Required live batch size. |
| `LEGACY_RETROFIT_OFFSET` | `0` | Offset into eligible plan rows. |
| `LEGACY_RETROFIT_INCLUDE_MANUAL_REVIEW` | `false` | Keeps manual-review records skipped by default. |
| `LEGACY_RETROFIT_FORCE_OVERWRITE` | `false` | Keeps writes missing-field-only by default. |

First live 5-record batch:

```bash
LEGACY_RETROFIT_APPLY_ENABLED=true \
LIVE_TEST=true \
LEGACY_RETROFIT_BATCH_SIZE=5 \
LEGACY_RETROFIT_OFFSET=0 \
npm run legacy:retrofit:apply
```

Apply safety rules:

- Safe records only by default.
- Apply batches are selected from eligible records that still have non-empty
  `recommendedUpdates`; already-retrofitted records do not consume batch
  offsets.
- Manual-review records are skipped unless explicitly included.
- Protected assessment fields are rejected before any write.
- Owner recommendations are excluded from `recommendedUpdates`.
- `ownerId`, `ownerRecommendation`, `createdBy`, and related owner fields are
  never written in this first apply path.
- Existing outbound fields are not overwritten unless
  `LEGACY_RETROFIT_FORCE_OVERWRITE=true`.
- Each live Person update writes a `crm_sync_logs` row and an
  `outbound_events` row with `event_type=legacy_retrofit_applied`.
- The script stops after repeated write failures and returns a nonzero exit code
  when live writes fail.

## Legacy Task Retrofit Planner

Task relationship cleanup is separate from outbound-field retrofit. The task
planner is dry-run only and does not create replacement tasks, assign new task
IDs, or write taskTarget relationships:

```bash
npm run legacy:tasks:plan
```

It reads Twenty Tasks, taskTargets, People, and workspaceMembers, then emits one
plan per task:

- `taskId`
- `taskTitle`
- `taskStatus`
- `currentTargetPersonId`
- `currentTargetCompanyId`
- `inferredTargetPersonId`
- `inferredTargetCompanyId`
- `confidence`
- `evidence`
- `recommendedAction`
- `safeToUpdate`
- `warnings`

Supported `recommendedAction` values:

- `link_task_to_person`
- `link_task_to_company`
- `leave_unassigned`
- `manual_review`

The planner uses the same resolution priority as queue reads:

1. `taskTarget.targetPersonId`
2. embedded Task relationship fields
3. `Person ID` marker in task body
4. task title/body Person-name matching
5. Company matching
6. owner/assignee matching
7. fallback unknown

The task planner writes these files by default:

- `data/legacy-task-retrofit-plan.json`
- `data/legacy-task-retrofit-summary.md`

Set `WRITE_LEGACY_TASK_RETROFIT_PLAN=false` only when a read-only console
inspection is needed without refreshing the saved files.

## Legacy Task Retrofit Apply

Task relationship apply is its own guarded path:

```bash
npm run legacy:tasks:apply
```

Without live guards, the script stays in dry-run mode and prints the selected
taskTarget payloads. It selects eligible rows from
`data/legacy-task-retrofit-plan.json` and
does not consume batch offset slots for unassigned, manual-review, company-only,
or already-linked Tasks.

Required live guards:

```bash
LEGACY_TASK_RETROFIT_APPLY_ENABLED=true
LIVE_TEST=true
```

Apply configuration:

| Env var | Default | Purpose |
| --- | --- | --- |
| `LEGACY_TASK_RETROFIT_PLAN_PATH` | `data/legacy-task-retrofit-plan.json` | JSON task retrofit plan to apply. |
| `LEGACY_TASK_RETROFIT_BATCH_SIZE` | `5` | Required live batch size. |
| `LEGACY_TASK_RETROFIT_OFFSET` | `0` | Offset into eligible task-to-person candidates. |
| `LEGACY_TASK_LINK_COMPANY_ENABLED` | `false` | Optional Company taskTarget links. Person links remain the priority. |

Confirmed taskTarget write shape:

```text
POST /rest/taskTargets
{ "taskId": "<task-id>", "targetPersonId": "<person-id>" }
```

Optional Company link shape, behind `LEGACY_TASK_LINK_COMPANY_ENABLED=true`:

```text
POST /rest/taskTargets
{ "taskId": "<task-id>", "targetCompanyId": "<company-id>" }
```

Safety rules:

- Only `recommendedAction=link_task_to_person` and `safeToUpdate=true` rows are
  eligible.
- Tasks that already expose `currentTargetPersonId` are skipped.
- `leave_unassigned`, `manual_review`, and company-only recommendations are not
  applied.
- Existing matching taskTargets are detected to avoid duplicates.
- No Task status is changed, including completed Tasks.
- No replacement Tasks or cadence Tasks are created.
- No assessment fields or assessment webhook behavior are touched.
- Each live write is verified by rereading `taskTargets` for the Task.
- Each live attempt writes `crm_sync_logs` and `outbound_events` with
  `event_type=legacy_task_retrofit_applied`.

First live task target batch:

```bash
LEGACY_TASK_RETROFIT_APPLY_ENABLED=true \
LIVE_TEST=true \
LEGACY_TASK_RETROFIT_BATCH_SIZE=5 \
LEGACY_TASK_RETROFIT_OFFSET=0 \
npm run legacy:tasks:apply
```

## Owner Cleanup Path

Owner cleanup is intentionally separate from outbound retrofit. It reads
`ownerRecommendation.futureOwnerRecommendation.ownerId` from the retrofit plan
and builds a dedicated owner cleanup plan:

```bash
npm run legacy:owners:plan
```

This writes:

- `data/legacy-owner-cleanup-plan.json`
- `data/legacy-owner-cleanup-summary.md`

Confirmed owner write shape:

```text
PATCH /rest/people/:personId
{ "ownerId": "<workspaceMemberId>" }
```

The shape comes from Person `owner` metadata where `joinColumnName=ownerId`.

Owner apply dry-run:

```bash
npm run legacy:owners:apply
```

Required live guards:

```bash
LEGACY_OWNER_APPLY_ENABLED=true
LIVE_TEST=true
```

Owner apply configuration:

| Env var | Default | Purpose |
| --- | --- | --- |
| `LEGACY_OWNER_PLAN_PATH` | `data/legacy-owner-cleanup-plan.json` | JSON owner cleanup plan to apply. |
| `LEGACY_OWNER_BATCH_SIZE` | `5` | Required live batch size. |
| `LEGACY_OWNER_OFFSET` | `0` | Offset into safe owner cleanup rows. |
| `LEGACY_OWNER_FORCE_OVERWRITE` | `false` | Keeps existing owners protected by default. |

First live owner cleanup batch:

```bash
LEGACY_OWNER_APPLY_ENABLED=true \
LIVE_TEST=true \
LEGACY_OWNER_BATCH_SIZE=5 \
LEGACY_OWNER_OFFSET=0 \
npm run legacy:owners:apply
```

Owner cleanup safety rules:

- Missing-owner records only by default.
- Existing owners are skipped unless `LEGACY_OWNER_FORCE_OVERWRITE=true`.
- No protected assessment fields are written.
- Each live owner update writes `crm_sync_logs`.
- Each live owner update writes `outbound_events` with
  `event_type=legacy_owner_cleanup_applied`.
- After each update, the script fetches the Person and verifies `ownerId`
  matches the expected workspace member ID.
- Verification mismatch is reported as `verification_failed`.

## Future Live Migration Guardrails

Before any live retrofit migration:

- Review the generated dry-run plan.
- Export a copy of affected Twenty People records.
- Keep assessment fields excluded.
- Require an explicit migration flag and a limited batch size.
- Write one audit row per attempted Person update.
- Prefer manual review for records without email or LinkedIn URL.
- Do not create outreach tasks automatically until the migrated queue behavior
  has been reviewed by an operator.
