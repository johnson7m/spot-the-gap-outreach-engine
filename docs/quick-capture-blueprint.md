# Quick Capture Blueprint

Quick Capture is the future rep-assisted intake path for leads discovered
outside the public assessment form. This document designs the operating model
only. It does not implement a browser extension, LinkedIn automation, scraping,
or new CRM writes.

## MVP Recommendation

Start with an internal web form in the outreach engine, not a browser extension.

Why:

- Lowest compliance and platform risk.
- Fastest way to validate fields and rep behavior.
- Easier authentication and audit logging.
- Works for LinkedIn, email, referrals, event leads, and manual research.
- Avoids browser-store packaging and extension permission review.

After the form is proven, evaluate a bookmarklet or extension that only opens
the form with user-copied context. It should not scrape pages or automate
LinkedIn actions.

## Rep-Captured Data

Required for MVP:

- full name
- company name
- source
- at least one contact/context path: user-provided profile URL, email, phone, or
  a useful note
- pipeline type
- authenticated workspace user for owner/assignee resolution when available

Recommended when available:

- job title
- email
- phone with country/calling-code context
- company website/domain
- company segment
- company industry
- company LinkedIn URL
- city/location
- team size or company size estimate
- visible operating pain signal
- proposed first-touch angle
- consent/source note if the lead came from a referral or event

Do not require email for MVP if a high-quality LinkedIn URL and company name are
available. Mark the lead as enrichment-needed instead.

## System-Inferred Or Enriched Data

Safe deterministic inference:

- first and last name split
- company domain from website URL
- dedupe keys from email, LinkedIn URL, and company domain/name
- initial lead source from capture source
- initial task due date
- initial queue assignment

Future enrichment, with approval:

- email discovery
- company size normalization
- industry classification
- ICP fit score
- operational pain summary
- outreach angle
- draft message

No LinkedIn scraping should be performed. A LinkedIn URL can be accepted only as
user-provided input.

## CRM Records To Create Or Update

Person:

- `name`
- `emails`, if provided
- `phones`, if provided as a safe US `+1` value with country/calling-code
  context
- `linkedinLink`, if user provided
- `jobTitle`, if provided
- `company`, after relationship payloads are validated
- `leadSource`
- `leadStage`
- `ownerId`, when the workspace user's email matches a Twenty `workspaceMember`

Company:

- `name`
- `domainName`, if available
- `linkedinLink`, if user provided
- `industry`, if selected from confirmed Twenty values
- `segment`, if selected from confirmed Twenty values
- `idealCustomerProfile`, if manually set or later enriched
- `accountOwnerId`, when the workspace user's email matches a Twenty
  `workspaceMember`

Task:

- initial first-touch task
- due date based on cadence day 1
- `assigneeId`, when the workspace user's email matches a Twenty
  `workspaceMember`
- body with source, reason captured, proposed angle, and required manual action

Note:

- capture context note
- approved draft message note, if generated later

Supabase:

- `outbound_events` row for capture
- future rows for planned touches, approvals, sends, skips, and replies

## Suggested Capture Form Fields

| Field | Required | Destination | Notes |
| --- | --- | --- | --- |
| `fullName` | Yes | Person `name` | Split deterministically but preserve full value in event payload. |
| `companyName` | Yes | Company `name` | Used for fallback dedupe. |
| `source` | Yes | Person `leadSource`; Supabase event | Use approved lead source values. |
| `sourceUrl` | Yes for LinkedIn capture | Person `linkedinLink` or event payload | User-provided only. |
| `jobTitle` | No | Person `jobTitle` | Useful for personalization. |
| `email` | No | Person `emails` | Strongest dedupe when present. |
| `phone` | No | Person `phones` | Optional. Workspace sends `phoneCountryCode=US` and `phoneCallingCode=+1`; invalid local-only values are omitted with warnings. |
| `companyWebsite` | No | Company `domainName` | Strong company dedupe. |
| `companySegment` | No | Company `segment` | Confirmed values: `SMALL_BUSINESS`, `COMMERCIAL`, `MID_MARKET`, `ENTERPRISE`. |
| `companyIndustry` | No | Company `industry` | Multi-select payload, currently one selected value from confirmed Twenty values. |
| `pipelineType` | Yes | Person `outboundPipelineType` | `ASSESSMENT_CAMPAIGN`, `RELATIONSHIP_BUILDING`, or `GENERAL_PROSPECT`. |
| `captureNote` | No | Supabase event; future Note | Useful context. Optional when URL, email, or phone exists. |
| workspace user email | Automatic | Person `ownerId`; Company `accountOwnerId`; Task `assigneeId` | Resolved server-side through Twenty `workspaceMember.userEmail`. |

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

## Auto-Generated Tasks

For assessment campaign:

- Create "Send connection request" task due today or next business day.
- Include assessment campaign context and first-touch guardrails.
- Do not send any message automatically.

For relationship building:

- Create "Send connection request" task due today or next business day.
- Include relationship reason and no-CTA first-touch guidance.

If enrichment is required:

- Create a separate enrichment/research task before first touch, or mark the
  first-touch task body with missing data.

## Message Draft Handling

MVP recommendation:

- Store the current recommended message in the Task `bodyV2`.
- Store approved or sent message copy in a Twenty Note.
- Store structured event status in Supabase `outbound_events`.

Do not create a Twenty `message` record for LinkedIn text unless there is a real
message-channel integration later.

## Safeguards

- User must manually provide LinkedIn URLs.
- No page scraping.
- No automated profile parsing.
- No automated connection request or message send.
- All AI-generated drafts require human review.
- All writes use idempotency keys.
- Duplicate checks should use email, LinkedIn URL, company domain, and name.
- Capture events should be logged before CRM writes.
- Rep-visible records should clearly mark test/capture source in notes/tasks
  until live rollout is approved.
- Owner and assignee matching should be warning-safe: no match means omit the
  relation-id fields and continue, not fail the capture.

## Controlled Live Test Guard

The script-based Quick Capture live test requires all three flags:

```bash
QUICK_CAPTURE_SYNC_ENABLED=true
TWENTY_SYNC_ENABLED=true
LIVE_TEST=true
```

If any guard is missing, the live script prints a plan and does not write to
Twenty. The live test path uses fake/test fixture data only and explicitly
excludes protected assessment fields:

- `assessmentCompleted`
- `assessmentScore`
- `lastTouchDate`
- `leadstageAuto`
- `messageAngle`
- `nextFollowUpDate`

Relationship writes remain skipped until Person/Company/Task relationship
payload shape is confirmed safely.

## Workspace API Guard

The internal workspace uses preview-first API endpoints:

```text
POST /api/quick-capture/preview
POST /api/quick-capture/commit
```

Preview is always dry-run. It normalizes the lead, builds dedupe warnings,
generates CRM payload previews, and returns the first task/cadence plan without
writing to Twenty or Supabase.

Preview auth is configurable:

```bash
SUPABASE_JWT_VERIFICATION_ENABLED=false
SUPABASE_AUTH_REQUIRED_FOR_WORKSPACE_API=false
```

With auth required disabled, staging/dev preview remains available for UI
compatibility. With auth required enabled, preview requires a valid Supabase
bearer token, an active `workspace_profiles` row, and role `admin`, `operator`,
or `rep`.

Commit is staging-gated and requires:

```bash
QUICK_CAPTURE_API_COMMIT_ENABLED=true
TWENTY_SYNC_ENABLED=true
SUPABASE_JWT_VERIFICATION_ENABLED=true
```

The browser workspace should send:

```text
Authorization: Bearer <supabase-access-token>
```

The temporary `x-visible-gap-workspace-secret` fallback can remain configured
server-side for controlled staging scripts, but it should not be sent by the
browser workspace.

`SUPABASE_ENABLED=true` should be enabled for commit tests so outbound events
and CRM audit logs are persisted. Commit still routes through the CRM adapter
and excludes all protected assessment fields. When a workspace user is
available, outbound event and CRM audit metadata include sanitized role context.

## Confirmed CRM Mapping Details

Metadata inspection on 2026-06-03 confirmed:

- Company `segment`: `SELECT`
  - `SMALL_BUSINESS`
  - `COMMERCIAL`
  - `MID_MARKET`
  - `ENTERPRISE`
- Company `industry`: `MULTI_SELECT`
  - `INFORMATION_TECHNOLOGY_IT`
  - `FINANCIALS`
  - `CONSUMER_DISCRETIONARY`
  - `CONSUMER_STAPLES`
  - `INDUSTRIALS`
  - `COMMUNICATION_SERVICES`
  - `ENERGY`
  - `MATERIALS`
  - `UTILITIES`
  - `REAL_ESTATE`
- Person owner relation: `owner`, REST field `ownerId`.
- Company owner relation: `accountOwner`, REST field `accountOwnerId`.
- Task assignee relation: `assignee`, REST field `assigneeId`.
- Workspace member matching source: `workspaceMember.userEmail`.

If any of these fields are unavailable in metadata, Quick Capture omits them and
returns warnings. It does not send speculative field names.

## Retry And Recovery Model

Quick Capture live writes use operation-level retry only. A retryable Twenty
failure on Company does not replay Person or Task operations, and a retryable
Task failure does not recreate Person or Company records.

Retryable Twenty responses:

- `429`
- `502`
- `503`
- `504`

Configuration:

```bash
QUICK_CAPTURE_MAX_RETRIES=3
QUICK_CAPTURE_RETRY_BASE_MS=1000
```

When Twenty supplies `retry_after`, the engine respects that delay. Otherwise it
uses bounded exponential backoff from `QUICK_CAPTURE_RETRY_BASE_MS`.

Recovery is run manually with:

```bash
QUICK_CAPTURE_SYNC_ENABLED=true TWENTY_SYNC_ENABLED=true LIVE_TEST=true npm run quick-capture:retry-failed
```

The recovery script:

- reads the latest retryable Quick Capture failure from `crm_sync_logs`
- skips operations already followed by a successful audit log
- retries only the failed operation
- appends a new CRM audit log
- updates the matching `outbound_events` row with recovery status

This is intentionally not a full workflow replay.
