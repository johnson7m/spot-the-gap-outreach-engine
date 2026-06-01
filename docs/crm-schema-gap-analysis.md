# CRM Schema Gap Analysis

Metadata inspected: Twenty CRM metadata API on 2026-05-27.

This document identifies what the current Twenty schema can support and what
should be added before building outbound queues, cadence workflows, enrichment,
or reporting. No CRM fields are created by this pass.

## Objects Inspected

Core objects:

- `person`
- `company`
- `task`
- `opportunity`

Activity/context objects:

- `note`
- `noteTarget`
- `timelineActivity`
- `taskTarget`
- `message`
- `messageThread`
- `messageParticipant`
- `calendarEvent`
- `calendarEventParticipant`
- `workspaceMember`

Custom/supporting objects discovered:

- `employee`

No dedicated outbound cadence custom object was discovered.
No standalone `comment` object was discovered in the metadata response.

## Protected Person Fields

| Field | Type | Status |
| --- | --- | --- |
| `assessmentCompleted` | `BOOLEAN` | Protected; used by assessment sync. |
| `assessmentScore` | `NUMBER` | Protected; used by assessment sync. |
| `lastTouchDate` | `DATE` | Protected; currently used by assessment follow-up. |
| `leadstageAuto` | `SELECT` | Protected; assessment automation state. |
| `messageAngle` | `TEXT` | Protected; assessment message angle. |
| `nextFollowUpDate` | `DATE` | Protected; assessment follow-up date. |

`leadstageAuto` now includes the corrected `DISQUALIFIED_NURTURE` value.

## Existing Fields Useful For Outbound

### Person

| Need | Existing field | Fit |
| --- | --- | --- |
| Lead source | `leadSource` | Good, but currently free text. |
| LinkedIn URL | `linkedinLink` | Good. User-provided input only. |
| Email | `emails` | Good. Primary dedupe when present. |
| Phone | `phones` | Good. |
| Job title | `jobTitle` | Good. |
| Company | `company` | Good after relationship write shape is validated. |
| General lead stage | `leadStage` | Good for high-level lifecycle. |
| Lead health | `leadHealth` | Good for 1-5 rating, not precise score. |
| Owner/assigned rep | `owner` | Good. Relationship to workspace member. |
| Notes | `noteTargets` | Good. |
| Tasks | `taskTargets` | Good. |
| Timeline | `timelineActivities` | Good after write shape is validated. |
| Pipeline type | `outboundPipelineType` | Confirmed for Quick Capture. |
| Cadence name | `cadenceName` | Confirmed for Quick Capture. |
| Cadence stage | `cadenceStage` | Confirmed for Quick Capture. |
| Enrichment status | `enrichmentStatus` | Confirmed for Quick Capture. |
| ICP fit score | `icpFitScore` | Confirmed numeric field. |
| Lead health score | `leadHealthScore` | Confirmed numeric field. |
| Outbound touch dates | `lastOutboundTouchDate`, `nextOutboundTouchDate` | Confirmed. Keeps outbound state separate from assessment follow-up dates. |
| Outbound angle | `outreachAngle` | Confirmed. Keeps outbound angle separate from assessment `messageAngle`. |
| Latest touch state | `latestTouchChannel`, `latestTouchStatus` | Confirmed. |
| Stale risk | `staleRisk` | Confirmed. |
| Discovery readiness | `discoveryReadiness` | Confirmed. |

### Company

| Need | Existing field | Fit |
| --- | --- | --- |
| Name | `name` | Good. |
| Website/domain | `domainName` | Good. |
| LinkedIn URL | `linkedinLink` | Good. |
| Segment | `segment` | Good if values fit the business. |
| Industry | `industry` | Good for broad industry tagging. |
| ICP flag | `idealCustomerProfile` | Useful but binary only. |
| Operational maturity | `operationalMaturityScore` | Good for assessment/company maturity. |
| Account owner | `accountOwner` | Good. |
| Employees | `employees` | Good if enriched or manually provided. |

### Task

| Need | Existing field | Fit |
| --- | --- | --- |
| Cadence step title | `title` | Good. |
| Recommended body/message | `bodyV2` | Good for human action details. |
| Due date | `dueAt` | Good. |
| Completion status | `status` | Good: `TODO`, `IN_PROGRESS`, `DONE`. |
| Assigned rep | `assignee` | Good. |
| Link to records | `taskTargets` | Good after write shape is validated. |

Task gaps:

- no structured `channel`
- no structured `cadenceStage`
- no structured `generatedByAutomation`
- no structured `recommendedMessage`

For MVP, place these in `bodyV2` and Supabase `outbound_events`. Add Task custom
fields only if reps need native filtering/reporting on tasks.

### Opportunity

| Need | Existing field | Fit |
| --- | --- | --- |
| Pipeline stage | `stage` | Good. |
| Value | `amount` or `dealValue` | Both exist; choose one commercial source of truth later. |
| Company | `company` | Good after relationship write shape is validated. |
| Person contact | `pointOfContact` | Good after relationship write shape is validated. |
| Owner | `owner` | Good. |
| Close date | `closeDate` | Good. |

Opportunity stage values:

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

Opportunity fields safe for the current assessment sync:

- `name`
- `stage`
- `dealValue`
- `hiring`

Opportunity fields available for future use after mapping approval:

- `amount`
- `closeDate`
- `company`
- `pointOfContact`
- `owner`

Recommended assessment-to-opportunity rule:

- Keep the current grade `C` or `D` opportunity threshold until the sales policy
  changes.
- Do not create opportunities for every assessment unless the team wants the
  opportunity pipeline to represent all diagnostic completions.
- If every assessment completion becomes an Opportunity later, add a low-intent
  stage or reporting field so warm diagnostics do not pollute active discovery
  pipeline.

## Requested Field Gap Analysis

| Requested field | Current support | Recommendation |
| --- | --- | --- |
| `outboundPipelineType` | Confirmed on Person | Use for Quick Capture. Consider Opportunity copy later for deal reporting. |
| `outboundLeadStage` | Partially covered by Person `leadStage` | Prefer new field if outbound state must be separate from sales lifecycle. |
| `cadenceStage` | Confirmed on Person | Use for first-task planning and future queues. |
| `cadenceName` | Confirmed on Person | Use `ASSESSMENT_CAMPAIGN_V1`, `RELATIONSHIP_BUILDING_V1`, or `NONE`. |
| `touchCount` | Missing | Calculate from Supabase `outbound_events`; add field only for CRM list views. |
| `lastOutboundTouchDate` | Confirmed on Person | Use for outbound only. Do not overload protected `lastTouchDate`. |
| `nextOutboundTouchDate` | Confirmed on Person | Use for outbound only. Do not overload protected `nextFollowUpDate`. |
| `leadHealthScore` | Confirmed on Person | Use numeric preliminary score. Existing `leadHealth` rating can remain legacy/coarse. |
| `icpFitScore` | Confirmed on Person | Use numeric preliminary score. |
| `enrichmentStatus` | Confirmed on Person | Use for MVP. |
| `enrichmentSummary` | Missing | Add Person long text or store as Note. |
| `outreachAngle` | Confirmed on Person | Use for outbound. Do not overload assessment `messageAngle`. |
| `latestDraftMessage` | Missing | Prefer Task/Note for MVP; add field only for queue preview if needed. |
| `latestTouchChannel` | Confirmed on Person | Use for current/last planned channel. |
| `latestTouchStatus` | Confirmed on Person | Use for current/last touch status. |
| `quickCaptureSource` | Partially covered by `leadSource` | Use `leadSource` for MVP if source taxonomy is approved. |
| `quickCaptureUrl` | Confirmed on Person | Use for user-provided source/profile URL. |
| `assignedRep` | Covered by Person `owner`, Task `assignee`, Opportunity `owner` | Use existing owner/assignee fields. |
| `staleRisk` | Confirmed on Person | Use for queues. |
| `discoveryReadiness` | Confirmed on Person | Use for Discovery Ready queue logic. |

## Confirmed New People Fields

| Field | Type | Confirmed values/notes |
| --- | --- | --- |
| `outboundPipelineType` | `SELECT` | `ASSESSMENT_CAMPAIGN`, `RELATIONSHIP_BUILDING`, `GENERAL_PROSPECT` |
| `cadenceName` | `SELECT` | `ASSESSMENT_CAMPAIGN_V1`, `RELATIONSHIP_BUILDING_V1`, `NONE` |
| `cadenceStage` | `SELECT` | `NOT_STARTED`, `CONNECTION_REQUEST`, `INTRO_MESSAGE`, `ASSESSMENT_POSITIONING`, `ASSESSMENT_SENT`, `ASSESSMENT_CHECK_IN`, `VALUE_TOUCH`, `STRATEGIC_CHECK_IN`, `DISCOVERY_ASK`, `PAUSED`, `COMPLETED` |
| `enrichmentStatus` | `SELECT` | `NOT_STARTED`, `PARTIAL`, `ENRICHED`, `NEEDS_REVIEW`, `FAILED` |
| `icpFitScore` | `NUMBER` | Preliminary 0-100 score. |
| `leadHealthScore` | `NUMBER` | Preliminary 0-100 score. |
| `lastOutboundTouchDate` | `DATE` | Last rep/approved outbound touch. |
| `nextOutboundTouchDate` | `DATE` | Next due touch. |
| `outreachAngle` | `TEXT` | Non-assessment outreach angle. |
| `latestTouchChannel` | `SELECT` | `LINKEDIN`, `EMAIL`, `PHONE`, `TEXT`, `IN_PERSON`, `OTHER` |
| `latestTouchStatus` | `SELECT` | `DRAFTED`, `SENT`, `RESPONDED`, `NO_RESPONSE`, `BOUNCED`, `DECLINED`, `COMPLETED` |
| `quickCaptureUrl` | `LINKS` | User-provided source/profile URL. |
| `staleRisk` | `SELECT` | `LOW`, `MEDIUM`, `HIGH`, `STALE` |
| `discoveryReadiness` | `SELECT` | `NOT_READY`, `MONITOR`, `READY`, `REQUESTED`, `BOOKED` |

The metadata inspection confirmed all expected API names in camelCase.

### Optional Later Fields

| Field | Type | Reason to defer |
| --- | --- | --- |
| `touchCount` | `NUMBER` | Better derived from `outbound_events` until reporting needs CRM display. |
| `latestDraftMessage` | `TEXT` | Better stored in Task/Note to preserve context and revisions. |
| `outboundLeadStage` | `SELECT` | Existing `leadStage` may be enough if values are approved. |
| `enrichmentSummary` | `TEXT` | Store as Note first unless reps need a dedicated list-view field. |

## Notes And Activity Recommendation

Use Twenty Notes for rep-visible message drafts, sent-copy summaries, assessment
follow-up notes, and manual notes. Use Supabase `outbound_events` as the
structured audit log. Use Timeline Activity only after write payload shape is
validated.

Avoid using Twenty `message` records for LinkedIn messages in MVP. The message
object appears aligned to native message channel/thread data and should not be
used to imply a real channel integration where none exists.

## Quick Capture Recovery Notes

The first guarded live Quick Capture test created the Person and Task and wrote
Supabase audit records, but the Company upsert received a retryable
Twenty/Cloudflare `502 Bad Gateway`.

Schema impact:

- No new CRM field is required for this failure.
- The Company payload shape remains minimal: `name` and `domainName`.
- The failure is treated as transport/provider instability, not a schema gap.

Recovery approach:

- retry only the failed Company operation
- preserve the existing Person and Task
- do not write protected assessment fields
- do not enable relationship writes during recovery
- continue recording Quick Capture recovery attempts in `crm_sync_logs`

If Company upsert failures repeat after bounded retries, inspect Twenty service
health and the `companies` REST endpoint before changing payload shape.
