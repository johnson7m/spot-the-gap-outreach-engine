# CRM Field Map

This map reflects the current Twenty metadata discovery pass and the assessment schema found in the production website. Controlled live assessment sync is available behind environment gates, idempotency checks, audit logging, and the CRM adapter boundary.

## Twenty Metadata Discovery Result

Read-only metadata discovery confirmed these core objects:

- `person` / `people`
- `company` / `companies`
- `task` / `tasks`
- `opportunity` / `opportunities`
- `workspaceMember` / `workspaceMembers`

Current schema note:

- People `leadstageAuto` now includes the corrected value `DISQUALIFIED_NURTURE`.
- The prior typo value `DISQUALIFIED_NUTURE` was not present in the 2026-05-27 metadata inspection.

## People

| Engine Field | Twenty Field API Name | Type | Required for Sync | Notes |
| --- | --- | --- | --- | --- |
| `person.firstName` / `person.lastName` | `name` | `FULL_NAME` | Yes | Standard full-name field. |
| `person.email` | `emails` | `EMAILS` | Yes | Primary dedupe key. |
| `person.linkedinUrl` | `linkedinLink` | `LINKS` | No | Future enrichment/outreach field. |
| `person.role` | `jobTitle` | `TEXT` | No | Standard job title. |
| workspace owner | `owner` | `RELATION` | Quick Capture only | REST payload shape confirmed as `ownerId` when workspace email matches a Twenty workspace member. |
| `assessment.completed` | `assessmentCompleted` | `BOOLEAN` | Yes | Custom field. Set to `true` after successful assessment intake. |
| `score.score` | `assessmentScore` | `NUMBER` | Yes | Custom field. Stores 0-100 website-compatible score. |
| `submittedAt` | `lastTouchDate` | `DATE` | Yes | Custom field. Date-only value. |
| workflow state | `leadstageAuto` | `SELECT` | Yes | Custom field. Assessment sync uses `ASSESSMENT_COMPLETED`. |
| first-message strategy | `messageAngle` | `TEXT` | Yes | Custom field. Generated deterministically for now; future AI drafts require review. |
| follow-up date | `nextFollowUpDate` | `DATE` | Yes | Custom field. Based on assessment priority. |
| company link | `company` | `RELATION` | Future | Requires Company ID after upsert. |

### People Outbound Fields

Read-only metadata discovery on 2026-05-27 confirmed these People fields for
Quick Capture and future outbound workflows:

| Field API Name | Type | Values / Notes |
| --- | --- | --- |
| `outboundPipelineType` | `SELECT` | `ASSESSMENT_CAMPAIGN`, `RELATIONSHIP_BUILDING`, `GENERAL_PROSPECT` |
| `cadenceName` | `SELECT` | `ASSESSMENT_CAMPAIGN_V1`, `RELATIONSHIP_BUILDING_V1`, `NONE` |
| `cadenceStage` | `SELECT` | `NOT_STARTED`, `CONNECTION_REQUEST`, `INTRO_MESSAGE`, `ASSESSMENT_POSITIONING`, `ASSESSMENT_SENT`, `ASSESSMENT_CHECK_IN`, `VALUE_TOUCH`, `STRATEGIC_CHECK_IN`, `DISCOVERY_ASK`, `PAUSED`, `COMPLETED` |
| `enrichmentStatus` | `SELECT` | `NOT_STARTED`, `PARTIAL`, `ENRICHED`, `NEEDS_REVIEW`, `FAILED` |
| `icpFitScore` | `NUMBER` | Preliminary 0-100 score. |
| `leadHealthScore` | `NUMBER` | Preliminary 0-100 score. |
| `lastOutboundTouchDate` | `DATE` | Outbound-specific date. Do not overload `lastTouchDate`. |
| `nextOutboundTouchDate` | `DATE` | Outbound-specific date. Do not overload `nextFollowUpDate`. |
| `outreachAngle` | `TEXT` | Outbound-specific angle. Do not overload assessment `messageAngle`. |
| `latestTouchChannel` | `SELECT` | `LINKEDIN`, `EMAIL`, `PHONE`, `TEXT`, `IN_PERSON`, `OTHER` |
| `latestTouchStatus` | `SELECT` | `DRAFTED`, `SENT`, `RESPONDED`, `NO_RESPONSE`, `BOUNCED`, `DECLINED`, `COMPLETED` |
| `quickCaptureUrl` | `LINKS` | User-provided source/profile URL. |
| `staleRisk` | `SELECT` | `LOW`, `MEDIUM`, `HIGH`, `STALE` |
| `discoveryReadiness` | `SELECT` | `NOT_READY`, `MONITOR`, `READY`, `REQUESTED`, `BOOKED` |

All expected People outbound fields were found with the expected camelCase API
names. User-provided LinkedIn URLs are stored in both standard `linkedinLink`
and outbound `quickCaptureUrl` when metadata confirms the field is available.

### People `leadstageAuto` Values

Expected values:

- `NEW_LEAD`
- `RESEARCHED`
- `CONNECTION_REQUESTED`
- `CONNECTED`
- `MESSAGE_SENT`
- `FOLLOW_UP_NEEDED`
- `ASSESSMENT_SENT`
- `ASSESSMENT_COMPLETED`
- `DISCOVERY_REQUESTED`
- `DISQUALIFIED_NURTURE`

The corrected `DISQUALIFIED_NURTURE` value was confirmed in metadata on 2026-05-27.

## Companies

| Engine Field | Twenty Field API Name | Type | Required for Sync | Notes |
| --- | --- | --- | --- | --- |
| `company.name` | `name` | `TEXT` | Yes | Fallback dedupe key when no domain exists. |
| `company.domain` / `company.website` | `domainName` | `LINKS` | Preferred | Current website assessment does not submit a company URL. |
| quick capture segment | `segment` | `SELECT` | No | Quick Capture only. Omitted with a warning when metadata does not confirm the field. |
| quick capture industry | `industry` | `MULTI_SELECT` | No | Quick Capture only. Payload shape is an array of confirmed values. |
| workspace owner | `accountOwner` | `RELATION` | No | REST payload shape confirmed as `accountOwnerId` when workspace email matches a Twenty workspace member. |
| `score.score` | `operationalMaturityScore` | `RATING` | No | Custom rating field with `RATING_1` through `RATING_5`. |
| person/company link | `people` | `RELATION` | Future | Requires Person ID after upsert. |

Company duplicate criteria discovered:

- `name`
- `domainNamePrimaryLinkUrl`

Company Quick Capture values confirmed on 2026-06-03:

`segment` values:

- `SMALL_BUSINESS`
- `COMMERCIAL`
- `MID_MARKET`
- `ENTERPRISE`

`industry` values:

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

## Tasks

| Engine Field | Twenty Field API Name | Type | Required for Sync | Notes |
| --- | --- | --- | --- | --- |
| task title | `title` | `TEXT` | Yes | Example: `Review Spot the Gap assessment: Acme Workforce Ops`. |
| task body | `bodyV2` | `RICH_TEXT` | Yes | Includes score, grade, weaknesses, tools, and next action. |
| task due date | `dueAt` | `DATE_TIME` | Yes | Based on priority. |
| task status | `status` | `SELECT` | Yes | Uses `TODO` initially. |
| task assignee | `assignee` | `RELATION` | Quick Capture only | REST payload shape confirmed as `assigneeId` when workspace email matches a Twenty workspace member. |
| CRM links | `taskTargets` | `RELATION` | Future | Requires resolved Person/Company IDs. |

Task status values discovered:

- `TODO`
- `IN_PROGRESS`
- `DONE`

## Workspace Members

Quick Capture owner/assignee mapping uses Twenty `workspaceMember` records:

| Field API Name | Type | Notes |
| --- | --- | --- |
| `name` | `FULL_NAME` | Display name for the workspace member. |
| `userEmail` | `TEXT` | Matched against `workspace_profiles.email`. |
| `userId` | `UUID` | Twenty user id. |

When an authenticated workspace profile email matches `workspaceMember.userEmail`:

- Person owner is sent as `ownerId`.
- Company owner is sent as `accountOwnerId`.
- Task assignee is sent as `assigneeId`.

If no match is found, the workflow omits owner/assignee fields, returns warnings,
and still allows Quick Capture preview/commit to proceed.

## Opportunities

| Engine Field | Twenty Field API Name | Type | Required for Sync | Notes |
| --- | --- | --- | --- | --- |
| opportunity name | `name` | `TEXT` | Yes | Company plus Spot the Gap diagnostic. |
| opportunity stage | `stage` | `SELECT` | Yes | Initial planned value: `TARGET_IDENTIFIED`. |
| opportunity deal value | `dealValue` | `NUMBER` | No | Custom field. Sent as `null` until commercial mapping exists. |
| opportunity hiring flag | `hiring` | `BOOLEAN` | No | Custom field. Sent as `false` for the staging test path. |
| company link | `company` | `RELATION` | Future | Requires Company ID after upsert. |
| point of contact | `pointOfContact` | `RELATION` | Future | Requires Person ID after upsert. |

Confirmed fields not present on Opportunity and therefore not sent:

- `source`
- `assessmentScore`
- `assessmentGrade`
- `assessmentLabel`

Opportunity stages discovered include:

- `TARGET_IDENTIFIED`
- `CONNECTION_SENT`
- `CONNECTED`
- `CONVERSATION_STARTED`
- `QUALIFIED`
- `CALL_SCHEDULED`
- `OPPORTUNITY`
- `DISCOVERY_SCHEDULED`
- `DISCOVERY_COMPLETED`
- `SOLUTION_ALIGNMENT`
- `PROPOSAL_SCOPE_DISCUSSION`
- `VERBAL_ALIGNMENT`
- `CLOSED_WON`
- `CLOSED_LOST`
- `DEFERRED_NURTURE`

The current builder only plans opportunities for grade `C` or `D` assessments. The live-safe payload is intentionally minimal:

```json
{
  "name": "Company Name - Spot the Gap diagnostic",
  "stage": "TARGET_IDENTIFIED",
  "dealValue": null,
  "hiring": false
}
```

## Dedupe Strategy

| Object | Primary Key | Fallback |
| --- | --- | --- |
| Person | `emails.primaryEmail` | Netlify submission ID |
| Company | `domainName.primaryLinkUrl` | Company name |
| Task | Netlify submission ID plus task purpose | None |
| Opportunity | Netlify submission ID plus opportunity purpose | Company plus assessment date after live design |

## Sync Workflow Notes

Current architecture:

```text
assessmentWorkflow
  -> crmAdapter
      -> twentyProvider
          -> metadataClient
          -> schemaValidator
          -> payloadBuilders
          -> object clients
```

Assessment sync:

1. Normalizes the Netlify payload.
2. Recalculates assessment score from `answerSummary`.
3. Builds CRM-ready Person, Company, Task, and Opportunity payloads.
4. Discovers and validates Twenty schema when an API key is configured.
5. Returns planned operations without writing records.

Future CRM expansion still needs:

- Relationship resolution after Person/Company writes.
- Scoped API keys and service permissions.
- Native relationship write confirmation for task, person, and opportunity links.
- Outbound-specific fields after approval.

## Quick Capture Dry-Run Payloads

Quick Capture planning is intentionally separate from the assessment sync. The
dry-run script builds:

- Person upsert payload with outbound fields when metadata confirms support.
- Company upsert payload when `companyName` is provided, including `segment` and
  `industry` when confirmed by metadata and provided by the workspace.
- Task create payload for the first manual cadence action, with `assigneeId`
  when a matching Twenty workspace member is resolved.
- Supabase `outbound_events` plan when event persistence is enabled.

Twenty writes are not performed by `npm run quick-capture:dry`.

Controlled live Quick Capture writes require:

- `QUICK_CAPTURE_SYNC_ENABLED=true`
- `TWENTY_SYNC_ENABLED=true`
- `LIVE_TEST=true`

The live test path may create/update Person and Company records and create or
skip a first Task. It does not write protected assessment fields and does not
write unresolved relationships.
