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

The queue data source treats individual read failures as warnings where
possible. A missing optional object should not block all queue visibility.

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
with the Person after taskTarget and fallback resolution.

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
| `No open task found for this fresh lead...` | No open task matched the Person after relationship resolution. |
| `Ownership unavailable...` | Neither owner nor assignee email could be resolved. |
| `Some queue items do not expose owner or assignee email data from Twenty.` | One or more items could not be scoped confidently for a rep. |

Warnings should guide cleanup and schema improvements. They should not hide
queue records unless the user role explicitly cannot access the queue.

## Queue Definitions

Fresh Leads:

- `outboundPipelineType` present
- `cadenceStage` is `CONNECTION_REQUEST` or `NOT_STARTED`
- `latestTouchStatus=DRAFTED`
- open task when possible

Follow-Ups:

- open task due today or overdue
- non-terminal cadence
- cadence name present
- unresolved due tasks are returned with `queueBucket=unassigned_tasks` and
  suggested resolution actions: `associate_person`, `associate_company`,
  `accept_and_link`, and `dismiss_from_my_view`.

Warm Assessments:

- `assessmentCompleted=true`
- or `leadstageAuto=ASSESSMENT_COMPLETED`
- or `discoveryReadiness` in `READY`, `REQUESTED`, `BOOKED`

Stale Recovery:

- `staleRisk=STALE` or `HIGH`
- or `nextOutboundTouchDate` is older than the query date
- or `latestTouchStatus=NO_RESPONSE`

Pipeline Review:

- missing key contact/cadence fields
- enrichment status is `NEEDS_REVIEW` or `PARTIAL`
- duplicate warning exists
- non-terminal cadence exists but no next task is found

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
