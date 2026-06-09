# Workspace API Contract

This document defines the API surface the `visible-gap-workspace` should use.
Quick Capture preview/commit, task completion, and read-only rep queue endpoints
are implemented. Duplicate, recovery, reporting, pause, and resume endpoints are
still planned.

The workspace should call the outreach engine only. The browser should not call
Twenty or Supabase directly.

## API Principles

- Dry-run and preview modes should be available before live writes.
- All write endpoints should be authenticated and audit logged.
- Every response should include a `correlationId`.
- Validation warnings should be separate from blocking errors.
- CRM writes must continue routing through `crmAdapter`.
- Recovery endpoints must retry only targeted failed operations.
- Protected assessment fields must not be writable through Quick Capture.
- Quick Capture is preview-first: users review payloads, task, cadence plan, and
  dedupe warnings before commit.
- Task completion may generate exactly one next task according to cadence stage.

## Common Headers

Common request headers:

```text
Authorization: Bearer <workspace-session-token>
X-Visible-Gap-Workspace: visible-gap-workspace
X-Visible-Gap-Workspace-Secret: <temporary-shared-secret-for-commit>
X-Correlation-Id: <optional-client-generated-id>
Content-Type: application/json
```

Authentication uses Supabase Auth. `Authorization` carries the Supabase Auth
access token. When workspace API auth is enabled, the outreach engine verifies
that token, loads the matching `workspace_profiles` row by `user_id`, rejects
inactive profiles, and authorizes actions by role:

- `admin`
- `rep`
- `operator`

The temporary `x-visible-gap-workspace-secret` header remains available only as
a server-configured fallback for controlled staging compatibility. The browser
workspace should use `Authorization: Bearer <supabase-access-token>` and should
not send the shared secret.

Workspace auth flags:

```bash
SUPABASE_JWT_VERIFICATION_ENABLED=false
SUPABASE_AUTH_REQUIRED_FOR_WORKSPACE_API=false
```

Set both to `true` after `workspace_profiles` is populated and the deployed
workspace sends Supabase access tokens reliably.

## Common Response Envelope

```json
{
  "ok": true,
  "correlationId": "workspace:...",
  "data": {},
  "warnings": [],
  "errors": []
}
```

For failed requests:

```json
{
  "ok": false,
  "correlationId": "workspace:...",
  "data": null,
  "warnings": [],
  "errors": [
    {
      "code": "VALIDATION_ERROR",
      "message": "companyName is required.",
      "field": "companyName"
    }
  ]
}
```

## Endpoint Index

Implemented endpoints:

- `POST /api/quick-capture/preview`
- `POST /api/quick-capture/commit`
- `POST /api/tasks/:id/complete`
- `GET /api/queues/fresh-leads`
- `GET /api/queues/follow-ups`
- `GET /api/queues/warm-assessments`
- `GET /api/queues/stale-recovery`
- `GET /api/queues/pipeline-review`
- `GET /api/queues/unassigned-tasks`
- `GET /api/queues/summary`

Planned endpoints:

- `GET /api/duplicates`
- `POST /api/duplicates/:id/merge`
- `POST /api/tasks/:id/pause`
- `POST /api/tasks/:id/resume`
- `GET /api/recovery/retryable-failures`
- `POST /api/recovery/:id/retry`

## Lead Source Values

Approved `leadSource` values:

- `LINKEDIN`
- `EVENT`
- `DROP_IN`
- `REFERRAL`
- `ASSESSMENT`
- `WEBSITE`
- `EMAIL`
- `PHONE`
- `MANUAL`
- `OTHER`

## Role Requirements

| Endpoint family | Roles |
| --- | --- |
| Quick Capture preview | `admin`, `rep`, `operator` |
| Quick Capture commit | `admin`, `rep`, `operator` |
| Duplicate merge | `admin`, `rep`, `operator` |
| Queue reads | `admin`, `rep`, `operator` |
| Task complete/pause/resume | `admin`, `rep`, `operator` |
| Recovery reads/retries | `admin`, `operator` |

## POST /api/quick-capture/preview

Normalizes a lead, validates data, detects duplicates, generates lead-health
score, builds CRM payloads, plans cadence, and returns the first task. It does
not write to Twenty or Supabase. This endpoint is safe for the staging workspace
UI and does not require live CRM flags.

Environment guard:

```bash
QUICK_CAPTURE_API_PREVIEW_ENABLED=true
```

Auth behavior:

- If `SUPABASE_AUTH_REQUIRED_FOR_WORKSPACE_API=false`, preview stays available
  for staging/dev compatibility and marks unauthenticated requests as
  `roleSource=unauthenticated/dev`.
- If `SUPABASE_AUTH_REQUIRED_FOR_WORKSPACE_API=true`, preview requires a valid
  Supabase bearer token and an active `workspace_profiles` row.
- Allowed roles: `admin`, `operator`, `rep`.

Request:

```json
{
  "lead": {
    "firstName": "Taylor",
    "lastName": "Morgan",
    "fullName": "Taylor Morgan",
    "title": "VP of Operations",
    "companyName": "Visible Gap Test Company",
    "companyWebsite": "https://example.com",
    "linkedinUrl": "https://www.linkedin.com/in/example-test",
    "email": "taylor@example.com",
    "phone": "555 010 0142",
    "phoneCountryCode": "US",
    "phoneCallingCode": "+1",
    "leadSource": "LINKEDIN",
    "outboundPipelineType": "ASSESSMENT_CAMPAIGN",
    "companySegment": "SMALL_BUSINESS",
    "companyIndustry": "INFORMATION_TECHNOLOGY_IT",
    "notes": "",
    "assignedRep": "workspace-user-id"
  }
}
```

The endpoint also accepts the lead fields at the request body root for early UI
integration, but the preferred shape is `{ "lead": { ... } }`.

`notes` is optional when at least one other capture context path is provided:
`linkedinUrl`, `email`, or `phone`.

Phone support is currently US-focused. The workspace should send
`phoneCountryCode=US` and `phoneCallingCode=+1`. Invalid or unsafe phone values
are omitted with warnings rather than blocking the entire capture.

Confirmed Company values:

- `companySegment`: `SMALL_BUSINESS`, `COMMERCIAL`, `MID_MARKET`, `ENTERPRISE`
- `companyIndustry`: `INFORMATION_TECHNOLOGY_IT`, `FINANCIALS`,
  `CONSUMER_DISCRETIONARY`, `CONSUMER_STAPLES`, `INDUSTRIALS`,
  `COMMUNICATION_SERVICES`, `ENERGY`, `MATERIALS`, `UTILITIES`, `REAL_ESTATE`

Response:

```json
{
  "ok": true,
  "correlationId": "quick-capture:person:email:taylor@example.com",
  "data": {
    "status": "preview",
    "dryRun": true,
    "normalizedLead": {},
    "dedupePlan": {
      "primaryKey": "person:email:taylor@example.com",
      "strategy": "email",
      "warnings": []
    },
    "crmPayloadPreview": {
      "person": {},
      "company": {},
      "task": {}
    },
    "firstTaskPreview": {},
    "cadencePlan": {
      "cadenceName": "ASSESSMENT_CAMPAIGN_V1",
      "cadenceStage": "CONNECTION_REQUEST"
    },
    "schemaValidation": {},
    "protectedFieldCheck": {
      "ok": true,
      "blockedFields": []
    },
    "outboundEventPreview": {},
    "workspaceUser": {
      "authenticated": true,
      "userId": "auth-user-id",
      "email": "rep@visiblegap.com",
      "fullName": "Visible Gap Rep",
      "role": "rep",
      "roleSource": "profile",
      "profileId": "workspace-profile-id"
    },
    "workspaceMember": {
      "id": "twenty-workspace-member-id",
      "userEmail": "rep@visiblegap.com",
      "userId": "twenty-user-id"
    },
    "skippedRelationships": [],
    "warnings": []
  },
  "warnings": [],
  "errors": []
}
```

Preview responses can include non-blocking warnings for missing optional dedupe
keys, unresolved relationship mappings, or schema metadata that could not be
validated locally.

Owner/assignee resolution:

- The engine matches `workspace_profiles.email` to Twenty
  `workspaceMember.userEmail`.
- When a match exists, payloads can include:
  - Person `ownerId`
  - Company `accountOwnerId`
  - Task `assigneeId`
- When no match exists, those fields are omitted and warnings are returned.
- The engine does not guess owner or assignee relation shapes.

## POST /api/quick-capture/commit

Commits a reviewed Quick Capture lead through the outreach engine workflow and
CRM adapter. The endpoint accepts the same preferred payload shape as preview:
`{ "lead": { ... }, "approval": { ... } }`.

Preferred header:

```text
Authorization: Bearer <supabase-access-token>
```

Temporary staging fallback header:

```text
x-visible-gap-workspace-secret: <WORKSPACE_API_SECRET>
```

The fallback is available only when `WORKSPACE_API_SECRET` is configured on the
server. It is intended for transitional scripts and should not be used by the
browser workspace.

Required environment guards:

```bash
QUICK_CAPTURE_API_COMMIT_ENABLED=true
TWENTY_SYNC_ENABLED=true
```

Auth requirements:

- A valid active workspace user is required for UI-driven commit.
- Allowed roles: `admin`, `operator`, `rep`.
- Missing or inactive profiles are rejected.
- The legacy workspace-secret fallback may be used only for explicitly
  configured staging/server-side compatibility.

Optional persistence:

```bash
SUPABASE_ENABLED=true
```

If any guard is missing, the endpoint returns a structured error and does not
write to Twenty. Commit always excludes protected assessment fields.

Commit may still proceed with warnings when optional Quick Capture fields cannot
be safely mapped. Examples: invalid phone omitted, owner match not found,
assignee match not found, or Company Segment/Industry unavailable in metadata.
Relationship writes are optional and feature-flagged; failed relationship
results return warnings and do not fail an otherwise successful commit.

Request:

```json
{
  "lead": {
    "firstName": "Taylor",
    "lastName": "Morgan",
    "companyName": "Visible Gap Test Company",
    "email": "taylor@example.com",
    "phone": "555 010 0142",
    "phoneCountryCode": "US",
    "phoneCallingCode": "+1",
    "leadSource": "LINKEDIN",
    "outboundPipelineType": "ASSESSMENT_CAMPAIGN",
    "companySegment": "SMALL_BUSINESS",
    "companyIndustry": "INFORMATION_TECHNOLOGY_IT",
    "notes": ""
  },
  "approval": {
    "approvedBy": "workspace-user-id",
    "previewReviewed": true
  }
}
```

Response:

```json
{
  "ok": true,
  "correlationId": "quick-capture:person:email:taylor@example.com",
  "data": {
    "status": "succeeded",
    "outboundEventId": "supabase-event-id",
    "crmResults": [
      {
        "object": "person",
        "action": "update",
        "status": "succeeded",
        "id": "twenty-person-id",
        "duplicateAvoided": true,
        "matchedBy": "email"
      }
    ],
    "auditLogs": [
      {
        "operation": "quick_capture_person_upsert",
        "status": "succeeded",
        "provider": "twenty"
      }
    ],
    "relationshipResults": [
      {
        "key": "person.company",
        "object": "person",
        "action": "update",
        "status": "succeeded",
        "id": "twenty-person-id"
      },
      {
        "key": "task.taskTargets.person",
        "object": "taskTarget",
        "action": "create",
        "status": "succeeded",
        "id": "twenty-task-target-id"
      }
    ],
    "workspaceUser": {
      "authenticated": true,
      "role": "rep",
      "roleSource": "profile"
    },
    "workspaceMember": {
      "id": "twenty-workspace-member-id",
      "userEmail": "rep@visiblegap.com"
    },
    "protectedFieldCheck": {
      "ok": true,
      "blockedFields": []
    },
    "skippedRelationships": []
  },
  "warnings": [],
  "errors": []
}
```

Protected assessment fields must remain excluded from Quick Capture payloads.

## GET /api/duplicates

Returns potential duplicate People or Companies needing a merge decision.

Query params:

```text
?object=person&confidence=medium&assignedRep=<id>&limit=50
```

Response item:

```json
{
  "id": "duplicate-candidate-id",
  "object": "person",
  "confidence": "medium",
  "candidateA": {
    "id": "twenty-person-id-1",
    "displayName": "Taylor Morgan"
  },
  "candidateB": {
    "id": "twenty-person-id-2",
    "displayName": "Taylor Morgan"
  },
  "matchedBy": ["firstName", "lastName", "company"],
  "conflicts": ["email", "title"],
  "missingFieldsToCopy": ["linkedinUrl"],
  "suggestedAction": "Review merge direction."
}
```

## POST /api/duplicates/:id/merge

Executes a user-approved merge decision.

Request:

```json
{
  "survivingRecordId": "twenty-person-id-1",
  "losingRecordId": "twenty-person-id-2",
  "fieldChoices": {
    "email": "keep_surviving",
    "title": "overwrite_from_losing",
    "linkedinUrl": "copy_missing"
  },
  "reason": "Same person confirmed by rep."
}
```

Allowed actions:

- merge lead 1 into lead 2
- merge lead 2 into lead 1
- keep separate

The backend should copy missing fields into the selected surviving record and
require explicit keep/overwrite choices for conflicts.

## GET /api/queues/*

The queue endpoints return read-only workspace queue items from Twenty People
and Tasks. They do not write to Twenty, Supabase, or the assessment workflow.

Implemented endpoints:

- `GET /api/queues/fresh-leads`
- `GET /api/queues/follow-ups`
- `GET /api/queues/warm-assessments`
- `GET /api/queues/stale-recovery`
- `GET /api/queues/pipeline-review`
- `GET /api/queues/unassigned-tasks`

Auth:

- Requires `Authorization: Bearer <supabase-access-token>`.
- Allowed roles: `admin`, `operator`, `rep`.
- Reps default to `ownerScope=mine`.
- `admin` and `operator` can request `ownerScope=all`.
- If Twenty records do not expose owner or assignee email data, the item is
  returned with a warning because ownership cannot be confidently enforced.

Query params:

```text
?limit=50&offset=0&ownerScope=mine&dueBefore=2026-06-03&includeOverdue=true
```

Supported query params:

- `limit`: 1-100, default 50.
- `offset` or `cursor`: numeric offset for current page slicing.
- `ownerScope`: `mine` or `all`; reps are forced to `mine`.
- `assigneeScope`: `mine` or `all`; applies to `unassigned-tasks`; reps are forced to `mine`.
- `dueBefore`: ISO date used by due/overdue queue logic.
- `includeOverdue`: default `true`; `false` limits follow-ups to the selected
  due date.
- `includeUnassigned`: default `false`; applies to Follow-Ups.
- `includeTestRecords`: default `false`; shows test/synthetic People for
  diagnostics.
- `includeDiagnostics`: default `false`; adds queue classification diagnostics
  to each item. For Pipeline Review, this also reveals all reviewed People for
  diagnostics instead of only final Pipeline Review dispositions.
- `includeAllReviewed`: default `false`; applies to Pipeline Review and returns
  all People with review warnings, including records whose final queue is Fresh
  Leads, Follow-Ups, Warm Assessments, or Stale Recovery. The default endpoint
  and tab count return only final Pipeline Review records.
- `bypassCache`: default `false`; diagnostics-only escape hatch for queue reads.
  When `true`, the engine skips the short-lived source-read cache and will
  return a degraded/rate-limited response instead of a stale cached snapshot if
  Twenty critical reads fail.
- `status`: optional Task status filter for `unassigned-tasks`.

Response:

```json
{
  "ok": true,
  "correlationId": "request-correlation-id",
  "data": {
    "queueName": "Fresh Lead Queue",
    "queueSlug": "fresh-leads",
    "items": [
      {
        "personId": "twenty-person-id",
        "taskId": "twenty-task-id",
        "personName": "Taylor Morgan",
        "title": "VP of Operations",
        "companyName": "Example Co",
        "linkedinUrl": "https://www.linkedin.com/in/example",
        "email": "taylor@example.com",
        "outboundPipelineType": "ASSESSMENT_CAMPAIGN",
        "cadenceName": "ASSESSMENT_CAMPAIGN_V1",
        "cadenceStage": "CONNECTION_REQUEST",
        "leadHealthScore": 86,
        "icpFitScore": 91,
        "nextOutboundTouchDate": "2026-06-05",
        "latestTouchChannel": "LINKEDIN",
        "latestTouchStatus": "DRAFTED",
        "outreachAngle": "Invite Taylor to compare operating gaps.",
        "taskTitle": "Send assessment-oriented connection request",
        "taskDueDate": "2026-06-05",
        "taskStatus": "TODO",
        "owner": {
          "id": "twenty-workspace-member-id",
          "email": "rep@visiblegap.com",
          "name": "Visible Gap Rep",
          "workspaceMemberId": "twenty-workspace-member-id",
          "source": "person_owner_and_task_assignee"
        },
        "assignedRep": "rep@visiblegap.com",
        "assignedRepDetails": {
          "id": "twenty-workspace-member-id",
          "email": "rep@visiblegap.com",
          "name": "Visible Gap Rep",
          "workspaceMemberId": "twenty-workspace-member-id",
          "source": "task_assignee_workspace_member"
        },
        "source": "twenty:person",
        "queueClassification": "fresh_initial_task",
        "queueClassificationReasons": ["fresh_initial_task", "initial_outreach_task_open"],
        "queuePrecedenceApplied": "fresh-leads",
        "matchedQueueCandidates": ["fresh-leads"],
        "excludedQueueCandidates": [],
        "isOverdueTask": false,
        "overdueDays": null,
        "dueStatus": "upcoming",
        "staleReason": null,
        "isTestRecord": false,
        "testRecordReasons": [],
        "reviewReasons": [],
        "personLinkSource": "task_target",
        "personResolutionPath": ["taskTarget.targetPersonId"],
        "personResolutionConfidence": "high",
        "personResolutionEvidence": ["taskTarget.targetPersonId=twenty-person-id"],
        "targetCompanyId": "twenty-company-id",
        "queueBucket": null,
        "suggestedResolutionActions": [],
        "warnings": []
      }
    ],
    "count": 1,
    "totalCount": 42,
    "limit": 50,
    "offset": 0,
    "hasMore": false,
    "nextOffset": null,
    "overdueCount": 3,
    "ownerScope": "mine",
    "assigneeScope": "mine",
    "dataSource": "twenty",
    "status": "ok",
    "isPartial": false,
    "partialReason": null,
    "retryAfterSeconds": null,
    "diagnostics": {
      "hiddenTestRecords": 0,
      "timelinePaginationWarning": null,
      "queueReadStatus": {
        "status": "ok",
        "isPartial": false,
        "partialReason": null,
        "retryAfterSeconds": null,
        "criticalFailures": [],
        "nonCriticalFailures": []
      },
      "staleCacheGuidance": null
    },
    "warnings": []
  },
  "warnings": [],
  "errors": []
}
```

Queue read states:

- `status="ok"`: critical Twenty reads succeeded. Non-critical failures can
  still set `isPartial=true` with warnings.
- `status="degraded_rate_limited"`: a critical Twenty read such as `people`,
  `tasks`, `taskTargets`, or required `workspaceMembers` returned 429. The
  response keeps `ok=true`, but `count=null`, `totalCount=null`, `items=[]`,
  `isPartial=true`, `partialReason="twenty_rate_limited"`, and
  `retryAfterSeconds` when Twenty provided it. The workspace should show a
  temporary rate-limit state, not an empty queue.
- `status="stale_cache"`: a critical read was rate-limited, but the engine
  returned the last successful queue snapshot from the short-lived cache.
  `diagnostics.queueReadStatus.cache` includes `cachedAt`, `ageSeconds`, and
  `ttlSeconds`.

Critical queue reads are `people`, `tasks`, and `taskTargets`.
`workspaceMembers` is also critical when `ownerScope=mine` or
`assigneeScope=mine` is needed to enforce rep ownership. `noteTargets` and
`timelineActivities` are non-critical; their failures should be shown as
warnings/diagnostics without implying the queue is empty.

## GET /api/queues/summary

Returns read-only aggregate counts for workspace navigation and pagination.

Response data:

```json
{
  "status": "ok",
  "isPartial": false,
  "partialReason": null,
  "retryAfterSeconds": null,
  "counts": {
    "freshLeads": 42,
    "followUps": 120,
    "warmAssessments": 4,
    "staleRecovery": 8,
    "pipelineReview": 19,
    "unassignedTasks": 22
  },
  "overdueTasksByQueue": {
    "freshLeads": 5,
    "followUps": 64,
    "warmAssessments": 1,
    "staleRecovery": 0,
    "pipelineReview": 3,
    "unassignedTasks": 2
  },
  "hiddenTestRecords": 11,
  "totalPeople": 324,
  "expectedRealPeople": 313,
  "accountedForPeople": 313,
  "unclassifiedPeople": 0,
  "countsByDisposition": {
    "fresh_lead": 92,
    "follow_up": 87,
    "pipeline_review": 121,
    "terminal_closed": 13
  },
  "countsByFinalQueue": {
    "fresh-leads": 92,
    "follow-ups": 87,
    "pipeline-review": 121,
    "terminal_closed": 13,
    "hidden_test_record": 11
  },
  "diagnostics": {
    "timelinePaginationWarning": null,
    "queueReadStatus": {
      "status": "ok"
    },
    "reviewedPeopleCount": 313,
    "finalPipelineReviewCount": 116
  },
  "warnings": []
}
```

If a critical Twenty read is rate-limited, summary returns
`status="degraded_rate_limited"`, `isPartial=true`, `counts=null`,
`overdueTasksByQueue=null`, and `retryAfterSeconds` when available.

People coverage fields:

- `totalPeople`: all Twenty People fetched.
- `hiddenTestRecords`: People suppressed from normal queues by test-record
  detection.
- `expectedRealPeople`: `totalPeople - hiddenTestRecords`.
- `accountedForPeople`: non-test People with an explicit queue or non-work
  disposition.
- `unclassifiedPeople`: non-test People where no current queue or terminal rule
  applies.
- `countsByDisposition`: person-level dispositions such as `fresh_lead`,
  `follow_up`, `warm_assessment`, `stale_recovery`, `pipeline_review`,
  `terminal_closed`, `active_client`, and `unclassified_needs_rule`.
- `countsByFinalQueue`: final queue/precedence bucket, including pseudo-buckets
  such as `terminal_closed`, `active_client`, and `hidden_test_record`.
- `counts.pipelineReview`: final Pipeline Review queue count. It should match
  `countsByDisposition.pipeline_review` and the default
  `GET /api/queues/pipeline-review` `totalCount`.
- `diagnostics.reviewedPeopleCount`: all non-test People that had any Pipeline
  Review warning during classification.
- `diagnostics.finalPipelineReviewCount`: People whose final queue/disposition
  is Pipeline Review after precedence is applied.
- `diagnostics.queueReadStatus.cache`: queue source-read cache diagnostics,
  including `status`, `cacheKey`, `cacheGeneratedAt`, `ttlSeconds`, and
  `bypass` when available. The cache stores raw successful Twenty reads for
  short-lived rate-limit recovery; it does not cache rendered queue counts.

Run `npm run queues:coverage-audit` for the full per-Person report. The audit
writes `data/queue-coverage-audit.json` and
`data/queue-coverage-summary.md`. Pipeline Review-only records include
`exclusionReasons` so the workspace can explain whether they are missing
outbound fields, company/email data, a next task, manual review, normalization,
or a new queue rule.

Fresh Leads criteria:

- Person `outboundPipelineType` is present.
- Person `cadenceStage` is `CONNECTION_REQUEST` or `NOT_STARTED`.
- Person `latestTouchStatus` is `DRAFTED`.
- Initial connection/request Task is included when a matching task can be found.
- If no open task exists, the Person remains visible with
  `suggestedResolutionActions=["create_next_task"]` and the item warning
  `No open task exists yet; create the first cadence task.`
- Person `latestTouchStatus=SENT`, `RESPONDED`, or `COMPLETED` is excluded from
  Fresh Leads by default. `SENT` initial-touch records move to Follow-Ups as
  follow-up gaps when no post-initial Task exists.
- `queueClassification=fresh_initial_task`.

Follow-Ups criteria:

- Task status is `TODO`, `OPEN`, `IN_PROGRESS`, or `NOT_STARTED`.
- Task due date is today or overdue according to `dueBefore`.
- Person cadence is not terminal.
- Person or parsed task body includes cadence context.
- Post-initial cadence stages include `INTRO_MESSAGE`, `VALUE_TOUCH`,
  `ASSESSMENT_POSITIONING`, `ASSESSMENT_SENT`, `ASSESSMENT_CHECK_IN`,
  `STRATEGIC_CHECK_IN`, and `DISCOVERY_ASK`.
- Legacy task titles such as `LI - Day 2`, `LI - f/u accepted connect`, and
  `LI - final touch` can be included when task history indicates outreach has
  already started.
- `DRAFTED` `NOT_STARTED` initial connection/request Tasks are excluded from
  Follow-Ups by default and stay in Fresh Leads.
- `SENT` `NOT_STARTED` or `CONNECTION_REQUEST` records are treated as first
  touch already sent. If no post-initial open Task exists, they appear in
  Follow-Ups with `queueClassification=follow_up_after_initial_sent`,
  `suggestedResolutionActions=["create_follow_up_task"]`, and the warning
  `Initial touch appears sent, but no follow-up task exists.`
- Tasks with no reliable Person are excluded by default.
- The response includes a warning/count such as
  `22 unassigned tasks hidden. Review Unassigned Tasks queue.`
- `includeUnassigned=true` can include unresolved Tasks for diagnostics, but the
  workspace should keep them out of the normal Follow-Up tab by default.
- Follow-Up classifications are `follow_up_post_initial_touch`,
  `follow_up_legacy_task_history`, and `follow_up_after_initial_sent`.

Unassigned Tasks criteria:

- Task does not expose `taskTarget.targetPersonId`.
- Task does not have a high or medium confidence Person inference.
- Existing Company taskTargets can be shown, but they do not make the Task a
  Person-linked follow-up.

Unassigned Task item fields:

```json
{
  "taskId": "twenty-task-id",
  "taskTitle": "LI - f/u pending connect",
  "taskStatus": "TODO",
  "taskDueDate": "2026-06-05",
  "assignee": {
    "email": "rep@visiblegap.com",
    "name": "Visible Gap Rep",
    "workspaceMemberId": "twenty-workspace-member-id"
  },
  "memberResolution": {
    "email": "rep@visiblegap.com",
    "name": "Visible Gap Rep"
  },
  "taskBodyExcerpt": "Short task body preview...",
  "existingTaskTargets": [],
  "suggestedResolutionActions": [
    "associate_person",
    "associate_company",
    "dismiss_from_my_view",
    "leave_unassigned"
  ],
  "warnings": []
}
```

Warm Assessments criteria:

- Person `assessmentCompleted=true`, or
- Person `leadstageAuto=ASSESSMENT_COMPLETED`, or
- Person `discoveryReadiness` is `READY`, `REQUESTED`, or `BOOKED`.

Protected assessment fields remain read-only from workspace Quick Capture.

Stale Recovery criteria:

- Person `staleRisk=STALE` or `HIGH`.
- Explicit stale recovery flag/reason fields are present.
- Cadence is `PAUSED` because outreach has stalled or no response was received.
- `latestTouchStatus=NO_RESPONSE` and `lastOutboundTouchDate` is more than 30
  days old.
- `lastOutboundTouchDate` is more than 30 days old and no open actionable Task
  exists.
- Terminal/expired cadence has no response and no next path.

Stale Recovery does not match solely because a Task is due today, a Task is
overdue, or `nextOutboundTouchDate` is old. Overdue Tasks remain in their
logical queue and expose `isOverdueTask`, `overdueDays`, and `dueStatus`.
Generated first-touch Tasks remain in Fresh Leads; generated post-initial Tasks
remain in Follow-Ups unless one of the relationship-stale criteria above is
met.

Every Stale Recovery item includes `staleReason`.

Pipeline Review criteria:

- Missing key fields such as email, LinkedIn URL, company, cadence name, or
  cadence stage.
- `enrichmentStatus=NEEDS_REVIEW` or `PARTIAL`.
- Duplicate warning fields are present.
- Non-terminal cadence exists but no open next task was found.
- Manually-created Twenty People have missing outbound fields but enough CRM
  signal to plan normalization.
- A Company relation ID exists but Company details were not available from the
  Person relation or fetched Companies list.
- Obvious test/synthetic records are included only when
  `includeTestRecords=true`.

Pipeline Review items include `reviewReasons` values such as:

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

Pipeline Review items may include `suggestedResolutionActions`:

- `normalize_manual_lead`
- `create_first_task`
- `create_follow_up_task`
- `enrich_company`
- `review_company_relation`

Manual lead normalization is handled outside the workspace API for now through
the guarded operations script:

```bash
npm run queues:apply-manual-lead-normalization
```

The script is dry-run by default. Live apply requires
`MANUAL_LEAD_NORMALIZATION_APPLY_ENABLED=true`, `LIVE_TEST=true`, and
`MANUAL_LEAD_NORMALIZATION_BATCH_SIZE`. It updates only missing outbound fields
on People and intentionally does not create Tasks, taskTargets, Companies,
owner changes, or assessment-field updates.

Relationship fallback:

- Relationship writes remain disabled.
- When a Task does not expose a direct Person relationship, the queue service
  parses `Person ID: <id>` from task body markdown.
- Items using this fallback include a warning so the workspace can display the
  limitation clearly.

Diagnostics:

- Obvious test/synthetic People are hidden by default. Hidden count is returned
  as `data.diagnostics.hiddenTestRecords`.
- Broad `timelineActivities` pagination messages are returned as
  `data.diagnostics.timelinePaginationWarning` instead of normal top-level
  queue warnings unless timeline data becomes required for an item-specific
  resolution.
- `includeDiagnostics=true` adds `classificationDiagnostics` with
  `matchedQueues`, `finalQueue`, `excludedQueues`, and
  `classificationReasons`.
- Classification diagnostics also include `initialTaskDetected`,
  `firstTouchAlreadySent`, `followUpTaskDetected`, and `recommendedFix`.

Classification precedence:

1. Stale Recovery
2. Warm Assessment
3. Follow-Up
4. Fresh Lead
5. Pipeline Review

Script diagnostics:

```bash
npm run queues:diagnose-classification
PERSON_ID=<twenty-person-id> npm run queues:diagnose-classification
TASK_ID=<twenty-task-id> npm run queues:diagnose-classification
```

Missing next-task operations:

- `npm run queues:plan-missing-next-tasks` creates a local dry-run plan for
  People with active non-terminal cadence state and no open Task.
- The plan includes `originalNextOutboundTouchDate`,
  `originalRecommendedDueDate`, `dueDateAdjusted`, and
  `dueDateAdjustmentReason`; missing, past, or same-day after-cutoff first-touch
  due dates are refreshed to the current or next business day.
- The missing next-task planner skips initial-stage records with
  `latestTouchStatus=SENT` so it does not recommend another connection request.
- `npm run queues:plan-sent-initial-follow-ups` creates a local dry-run plan for
  `SENT` `NOT_STARTED` or `CONNECTION_REQUEST` People with no open
  post-initial Task. Relationship cadence records recommend `INTRO_MESSAGE`;
  assessment cadence records recommend `ASSESSMENT_POSITIONING`.
- `npm run queues:apply-missing-next-tasks` reads that local plan and remains
  dry-run unless `MISSING_NEXT_TASK_APPLY_ENABLED=true`, `LIVE_TEST=true`, and
  `MISSING_NEXT_TASK_BATCH_SIZE=<n>` are set.
- Recommended live batching uses `MISSING_NEXT_TASK_APPLY_MODE=next_eligible`,
  which ignores offset and selects the first currently eligible safe rows after
  rechecking current Twenty Tasks/taskTargets. `offset` mode remains available
  for diagnostics. Script output includes `remainingEligibleCount`; when it
  reaches `0`, no next apply command is recommended.
- `npm run queues:apply-sent-initial-follow-ups` reads
  `data/sent-initial-follow-up-plan.json` and remains dry-run unless
  `SENT_INITIAL_FOLLOW_UP_APPLY_ENABLED=true`, `LIVE_TEST=true`, and
  `SENT_INITIAL_FOLLOW_UP_BATCH_SIZE=<n>` are set.
- Recommended live batching uses
  `SENT_INITIAL_FOLLOW_UP_APPLY_MODE=next_eligible`, which ignores offset and
  selects the first currently eligible safe rows after rechecking the plan.
  `offset` mode remains available for diagnostics. Script output includes
  `remainingEligibleCount`; when it reaches `0`, no next apply command is
  recommended.
- The apply path is script-only for now; no workspace endpoint exists yet.
- Live apply creates a Twenty Task, links it to the Person through
  `taskTargets`, verifies the link, and records CRM audit plus outbound event
  rows. It re-checks due dates at apply time and refuses past-due generated
  Tasks unless `MISSING_NEXT_TASK_ALLOW_PAST_DUE=true`.
- Sent-initial apply creates only the post-initial follow-up Task, links it to
  the Person through `taskTargets`, and does not modify the old initial Task.
  Person `cadenceStage` updates remain disabled unless
  `SENT_INITIAL_FOLLOW_UP_UPDATE_PERSON_STAGE=true`.
- Sent-initial apply is paced with
  `SENT_INITIAL_FOLLOW_UP_WRITE_DELAY_MS` and retries Twenty 429 responses
  when `SENT_INITIAL_FOLLOW_UP_RETRY_AFTER_429=true`. Script output includes
  `retryAfterSeconds`, `status=partial_success` when mixed results occur, and
  `recommendedNextCommand`.
- `npm run queues:recover-sent-initial-follow-ups` is the recovery command for
  partially successful batches. It reads
  `data/sent-initial-follow-up-apply-latest.json`, rechecks dedupe keys and
  `taskTargets`, and writes only missing recovery operations when live guards
  are enabled.

## POST /api/tasks/:id/complete

Records a completed manual outbound touch, updates the Person cadence state,
and creates exactly one next cadence task when the cadence rule calls for one.
This endpoint does not automate LinkedIn actions and does not require
relationship writes.

Auth:

- Requires `Authorization: Bearer <supabase-access-token>`.
- Allowed roles: `admin`, `operator`, `rep`.
- Requires an active `workspace_profiles` row.

Request:

```json
{
  "personId": "twenty-person-id",
  "taskId": "twenty-task-id",
  "completion": {
    "channel": "LINKEDIN",
    "touchStatus": "SENT",
    "messageBody": "Optional message copy.",
    "notes": "Optional completion note.",
    "completedAt": "2026-06-03T15:00:00.000Z"
  }
}
```

For dry-run/testing contexts, the body may include `personSnapshot` with
`cadenceName` and `cadenceStage`. Normal live workspace calls should send
`personId`; the engine fetches the Person through the CRM adapter.

Supported `completion.channel` values:

- `LINKEDIN`
- `EMAIL`
- `PHONE`
- `TEXT`
- `IN_PERSON`
- `OTHER`

Supported `completion.touchStatus` values:

- `DRAFTED`
- `SENT`
- `RESPONDED`
- `NO_RESPONSE`
- `BOUNCED`
- `DECLINED`
- `COMPLETED`

Person fields updated:

- `cadenceName`
- `cadenceStage`
- `latestTouchChannel`
- `latestTouchStatus`
- `lastOutboundTouchDate`
- `nextOutboundTouchDate`, when a next task exists

Next task dedupe key:

```text
personId + cadenceName + nextCadenceStage + taskType
```

Relationship writes remain disabled by default. The next Task body includes
Person ID, completed Task ID, cadence context, and the dedupe key so the
workspace/operator can identify the associated record without `taskTargets`.
When relationship flags are enabled, the engine also attempts a Task Target link
for the next Task. Link failures are returned in `relationshipResults` and
warnings without failing the core task completion response.

Response:

```json
{
  "ok": true,
  "correlationId": "request-correlation-id",
  "data": {
    "taskId": "twenty-task-id",
    "personId": "twenty-person-id",
    "status": "succeeded",
    "transition": {
      "cadenceName": "ASSESSMENT_CAMPAIGN_V1",
      "oldCadenceStage": "CONNECTION_REQUEST",
      "newCadenceStage": "INTRO_MESSAGE",
      "lastOutboundTouchDate": "2026-06-03",
      "nextOutboundTouchDate": "2026-06-05"
    },
    "crmResults": [
      {
        "object": "person",
        "action": "update",
        "status": "succeeded",
        "id": "twenty-person-id"
      },
      {
        "object": "task",
        "action": "create",
        "status": "succeeded",
        "id": "next-twenty-task-id"
      }
    ],
    "outboundEvents": {
      "persisted": true,
      "ids": ["task-completed-event-id", "next-task-created-event-id"]
    },
    "relationshipResults": [
      {
        "key": "task.taskTargets.person",
        "object": "taskTarget",
        "action": "create",
        "status": "succeeded",
        "id": "twenty-task-target-id"
      }
    ],
    "auditLogs": {
      "persisted": true,
      "ids": ["person-update-log-id", "task-create-log-id"]
    },
    "skippedRelationships": []
  },
  "warnings": [],
  "errors": []
}
```

## POST /api/tasks/:id/pause

Pauses an active task/cadence path.

Request:

```json
{
  "reason": "Not interested right now.",
  "resumeOn": null
}
```

Pause reasons include not interested, end of cadence cycle, data quality issue,
or manual rep judgment. Pausing should write an outbound event and prevent
automatic next-task generation.

## POST /api/tasks/:id/resume

Resumes a paused task/cadence path.

Request:

```json
{
  "reason": "Rep observed a new company activity signal.",
  "nextCadenceStage": "VALUE_TOUCH"
}
```

Resume signals can include role change, industry/company change, response,
company activity, or rep-observed opportunity. Resume should create exactly one
next task.

## POST /api/outbound-events

Creates a structured outbound event. This should represent a manual or approved
action, not an automated LinkedIn action.

Request:

```json
{
  "personId": "twenty-person-id",
  "companyId": "twenty-company-id",
  "taskId": "twenty-task-id",
  "eventType": "manual_touch_logged",
  "channel": "linkedin",
  "status": "sent",
  "payload": {
    "summary": "Rep manually sent connection request.",
    "messageCopy": ""
  }
}
```

## GET /api/recovery/retryable-failures

Returns retryable CRM sync failures and dead-letter candidates.

Response item:

```json
{
  "id": "crm-sync-log-id",
  "correlationId": "quick-capture:...",
  "provider": "twenty",
  "object": "company",
  "action": "upsert",
  "dedupeKey": "company:domain:example.com",
  "retryable": true,
  "retryCount": 1,
  "maxRetries": 3,
  "lastError": "Request failed with status code 502",
  "retryAfter": null,
  "suggestedAction": "Retry failed Company upsert.",
  "createdAt": "2026-05-27T17:17:01.000Z"
}
```

## POST /api/recovery/:id/retry

Retries one failed operation by CRM sync log ID.

Request:

```json
{
  "reason": "Operator approved retry after transient provider failure."
}
```

Response:

```json
{
  "data": {
    "retriedOperation": {
      "object": "company",
      "dedupeKey": "company:domain:example.com"
    },
    "status": "succeeded",
    "auditLogId": "new-crm-sync-log-id",
    "crmRecordId": "twenty-company-id"
  }
}
```

## Reporting Endpoints

Reporting can start as one aggregate endpoint:

```text
GET /api/reporting/summary?from=2026-05-01&to=2026-05-27
```

Response:

```json
{
  "data": {
    "leadsCapturedThisWeek": 12,
    "tasksDueToday": 8,
    "overdueFollowUps": 3,
    "assessmentCompletions": 5,
    "quickCapturesByRep": [],
    "touchesByChannel": [],
    "staleLeads": 4,
    "conversionBySource": []
  }
}
```

Split reporting into smaller endpoints only after the UI proves which queries
are used frequently.

## Open Contract Questions

- Where should Supabase Auth roles live: user metadata, app metadata, or a
  dedicated workspace profile table?
- Should operators be able to retry only retryable failures while admins can
  override dead-letter failures after a fix?
- Should task completion update Twenty only, Supabase only, or both in one
  transaction-like workflow?
- Should Quick Capture commit be enabled in staging immediately, or remain
  preview-only until the workspace form is reviewed?
- Should merge decisions be stored as a new Supabase table or as
  `outbound_events` payloads first?
