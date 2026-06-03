# Workspace API Contract

This document defines the API surface the `visible-gap-workspace` should use.
The Quick Capture preview and commit endpoints are implemented. The remaining
queue, task, duplicate, recovery, and reporting endpoints are still planned.

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

Planned endpoints:

- `GET /api/duplicates`
- `POST /api/duplicates/:id/merge`
- `POST /api/tasks/:id/complete`
- `POST /api/tasks/:id/pause`
- `POST /api/tasks/:id/resume`
- `GET /api/queues/fresh-leads`
- `GET /api/queues/follow-ups`
- `GET /api/queues/warm-assessments`
- `GET /api/queues/stale-recovery`
- `GET /api/queues/pipeline-review`
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

## GET /api/queues/fresh-leads

Returns manually captured leads needing first touch.

Query params:

```text
?limit=50&cursor=<cursor>&assignedRep=<id>&pipelineType=ASSESSMENT_CAMPAIGN
```

Queue criteria draft:

- Quick Capture event exists.
- Person has `cadenceStage=CONNECTION_REQUEST` or `NOT_STARTED`.
- First-touch task is open.
- `latestTouchStatus=DRAFTED` or missing.

Response item:

```json
{
  "id": "queue-item-id",
  "personId": "twenty-person-id",
  "companyId": "twenty-company-id",
  "taskId": "twenty-task-id",
  "person": "Taylor Morgan",
  "title": "VP of Operations",
  "company": "Example Co",
  "pipelineType": "ASSESSMENT_CAMPAIGN",
  "cadenceStage": "CONNECTION_REQUEST",
  "leadHealthScore": 86,
  "icpFitScore": 91,
  "nextAction": "Send assessment-oriented connection request",
  "dueDate": "2026-05-28T14:00:00.000Z",
  "outreachAngle": "Invite Taylor to compare operating gaps.",
  "latestTouchStatus": "DRAFTED",
  "twentyUrl": "https://app.twenty.com/...",
  "linkedinUrl": "https://www.linkedin.com/in/example"
}
```

## GET /api/queues/follow-ups

Returns due or overdue follow-up tasks.

Criteria draft:

- Task status is `TODO` or `IN_PROGRESS`.
- Task due date is today or earlier.
- Lead is not paused, completed, disqualified, or booked.

Sorting:

1. overdue first
2. highest lead health score
3. highest ICP fit score
4. oldest due date

## GET /api/queues/warm-assessments

Returns assessment completions needing review.

Criteria draft:

- `assessmentCompleted=true`
- assessment completions become warm immediately
- recent completion or no completed review task
- high assessment score or discovery-ready CRM state
- other leads can become warm through response count, response quality,
  lead evaluation, industry event trigger, company activity, or
  `leadHealthScore > 50`

Protected assessment fields remain read-only from workspace Quick Capture.

## GET /api/queues/stale-recovery

Returns leads at risk of being forgotten.

Criteria draft:

- `staleRisk=HIGH` or `STALE`
- no inbound/outbound activity for 3 months
- no response after a full cadence cycle
- `nextOutboundTouchDate` is in the past
- no recent completed outbound event
- not disqualified or completed

## GET /api/queues/pipeline-review

Returns high-priority records needing sales judgment.

Criteria draft:

- `discoveryReadiness=READY` or `REQUESTED`
- `leadHealthScore > 75` supports Discovery Ready recommendation
- Opportunity exists or should be considered
- assessment completion or positive response signal exists
- normal path is cold -> warm -> discovery, with manual override allowed

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

Relationship writes remain disabled. The next Task body includes Person ID,
completed Task ID, cadence context, and the dedupe key so the workspace/operator
can identify the associated record without `taskTargets`.

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
