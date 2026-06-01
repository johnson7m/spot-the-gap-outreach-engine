# Outbound Operations Architecture

Metadata inspected: Twenty CRM metadata API on 2026-05-27.

This document defines the future outbound operating model for the Spot the Gap
Outreach Engine. It is intentionally documentation-only. No production workflow,
CRM write behavior, database schema, LinkedIn scraping, or browser extension
logic is introduced by this pass.

## Current Working Production Path

The live assessment path must remain stable:

```text
consulting-landing-page
  Netlify form + submission-created event function
    -> spot-the-gap-outreach-engine Render webhook
      -> Supabase persistence
        -> Twenty People, Companies, Tasks, Opportunities
```

The outbound architecture should build around that path, not replace it.

## Design Principles

- Preserve the current assessment pipeline and field names.
- Keep AI reasoning separate from execution.
- Keep CRM writes behind the CRM adapter and Twenty provider.
- Treat Supabase as the operational audit/event layer.
- Use Twenty as the rep-facing system of record for contacts, companies, tasks,
  notes, opportunities, and ownership.
- Use Supabase Auth for the future internal workspace.
- Release the future workspace to staging first.
- Do not automate LinkedIn browsing, scraping, connection requests, messaging, or
  profile extraction.
- Use user-provided LinkedIn URLs as normal contact data only.

## Protected Assessment Fields

These Person fields are currently used by the live assessment sync and should
not be renamed, repurposed, or have values changed without a controlled migration:

| Field | Type | Current use |
| --- | --- | --- |
| `assessmentCompleted` | `BOOLEAN` | Set true after a valid assessment submission. |
| `assessmentScore` | `NUMBER` | Stores website-compatible score, 0-100. |
| `lastTouchDate` | `DATE` | Assessment submission/follow-up touch date. |
| `leadstageAuto` | `SELECT` | Assessment automation state. Current sync writes `ASSESSMENT_COMPLETED`. |
| `messageAngle` | `TEXT` | Deterministic assessment follow-up angle. |
| `nextFollowUpDate` | `DATE` | Assessment follow-up date. |

Confirmed `leadstageAuto` values:

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

## Existing CRM Capabilities For Outbound

Person can already support:

- name: `name`
- email: `emails`
- phone: `phones`
- LinkedIn URL: `linkedinLink`
- job title: `jobTitle`
- company relationship: `company`
- lead source: `leadSource`
- owner/assigned rep: `owner`
- general lifecycle: `leadStage`
- coarse lead health: `leadHealth`
- tasks: `taskTargets`
- notes: `noteTargets`
- timeline events: `timelineActivities`
- outbound pipeline: `outboundPipelineType`
- cadence state: `cadenceName`, `cadenceStage`
- enrichment state: `enrichmentStatus`
- lead scoring: `icpFitScore`, `leadHealthScore`, `staleRisk`,
  `discoveryReadiness`
- outbound touch state: `lastOutboundTouchDate`, `nextOutboundTouchDate`,
  `latestTouchChannel`, `latestTouchStatus`
- outbound angle: `outreachAngle`
- quick capture source URL: `quickCaptureUrl`

All expected People outbound fields were found with the expected camelCase API
names in the latest 2026-05-27 metadata validation.

Company can already support:

- company name: `name`
- website/domain: `domainName`
- LinkedIn URL: `linkedinLink`
- employee count: `employees`
- segment: `segment`
- industry: `industry`
- ICP boolean: `idealCustomerProfile`
- account owner: `accountOwner`
- operational maturity: `operationalMaturityScore`
- people, tasks, notes, opportunities, timeline events

Task can already support:

- cadence task title: `title`
- recommended action/message body: `bodyV2`
- due date: `dueAt`
- completion status: `status`
- assigned rep: `assignee`
- links to Person, Company, Opportunity through `taskTargets`

Opportunity can already support:

- name: `name`
- stage: `stage`
- value: `amount` or custom `dealValue`
- close date: `closeDate`
- company: `company`
- point of contact: `pointOfContact`
- owner: `owner`
- tasks, notes, timeline events

Notes and activities can already support:

- CRM-visible notes: `note.title`, `note.bodyV2`, `noteTargets`
- event timeline: `timelineActivity.name`, `happensAt`, `properties`, target
  fields
- message records exist, but should not be used to fabricate LinkedIn messages
  unless a legitimate channel integration is implemented later.

## Recommended System Boundaries

```text
Rep input or assessment event
  -> workflow orchestration
    -> deterministic normalization and validation
      -> Supabase audit/event write
        -> CRM adapter
          -> Twenty provider
            -> People, Companies, Tasks, Opportunities, Notes
```

Future AI should remain advisory:

```text
AI recommender
  -> drafts angle, summary, or next action
    -> approval queue
      -> execution layer validates schema, permissions, idempotency
        -> CRM write or human task
```

## Outbound Workflow Objects

Use a hybrid model:

- Twenty Person/Company/Opportunity: rep-facing state and ownership.
- Twenty Task: the next human action.
- Twenty Note: visible context, approved message draft, sent-copy summary, and
  rep notes.
- Supabase `outbound_events`: immutable operational log for planned, approved,
  skipped, sent, failed, or cancelled touches.

This avoids overloading CRM fields with every event while keeping the rep view
useful.

## Confirmed Workspace Decisions

- Auth: Supabase Auth.
- Roles: `admin`, `rep`, `operator`.
- Operator recovery: admin/operator only.
- Quick Capture: preview-first MVP.
- Task generation: one next task at a time, according to cadence stage.
- Workspace release: staging-only first.

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

Source of truth:

- Twenty stores CRM records, relationships, pipeline state, and rep-facing
  ownership.
- Supabase stores workflow state, audit logs, outbound events, retries,
  reporting aggregates, and operational intelligence.

## State And Scoring References

Detailed contracts now live in:

- `docs/outbound-state-machine.md`
- `docs/duplicate-resolution-blueprint.md`
- `docs/lead-health-scoring-spec.md`

## Recommended Implementation Sequence

1. Validate outbound schema metadata before Quick Capture runs.
2. Use Quick Capture dry-run to review normalized lead, CRM payloads, first task,
   and outbound event plan.
3. Add read-only CRM queue queries.
4. Add Quick Capture as an internal form before considering an extension.
5. Add task-only cadence planning.
6. Add note draft generation with human approval.
7. Add reporting queries against Supabase and Twenty.
8. Only later consider browser extension packaging.

## Quick Capture Backend Foundation

The current backend foundation supports:

- lead normalization
- dedupe-key selection by email, LinkedIn URL, then name plus company
- preliminary `icpFitScore`
- preliminary `leadHealthScore`
- cadence defaults
- outbound People payload generation
- Company payload generation
- first Task payload generation
- planned `outbound_events` payload
- dry-run script: `npm run quick-capture:dry`

This foundation does not write to Twenty. Supabase event persistence remains
explicitly controlled by workflow options or dry-run script flags.

## Open Questions

1. Should `outboundPipelineType` live on Person, Opportunity, or both?
2. Should relationship-building and assessment-campaign state use fields
   separate from `leadstageAuto`?
3. Should message drafts live primarily in Tasks, Notes, or Supabase?
4. Should Quick Capture start as a browser extension, bookmarklet, or internal
   form?
5. How much manual LinkedIn data entry is acceptable for the MVP?
6. Is email required before creating a lead, or can LinkedIn URL plus name be
   enough?
7. Who owns new leads by default?
8. What is the daily lead target per rep?
9. Should every assessment completion create an Opportunity?
10. Should stale leads auto-nurture or require manual review?
11. Should duplicate decisions be stored in `outbound_events` first or in a
    dedicated future table?
