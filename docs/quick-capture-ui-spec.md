# Quick Capture UI Spec

This document defines the future Quick Capture screen for
`visible-gap-workspace`. It is UI and API planning only.

## Goal

Give reps a fast, safe way to capture a manually discovered lead, preview what
the outreach engine will create, and submit the lead without touching protected
assessment fields or automating LinkedIn actions.

The MVP is preview-first. The rep must review the planned CRM payload, first
task, cadence plan, and duplicate warnings before commit.

## Primary User Flow

1. Rep opens `/quick-capture`.
2. Rep pastes a LinkedIn URL or source URL.
3. Rep enters minimum lead details.
4. Rep selects a pipeline type.
5. Workspace calls `POST /api/quick-capture/preview`.
6. Workspace shows normalized lead, CRM payloads, first task, warnings, and
   dedupe strategy.
7. Rep fixes blocking errors if any.
8. Rep resolves any required merge gate.
9. Rep commits the reviewed plan through `POST /api/quick-capture/commit`.
10. Workspace shows created/updated Person, Company, and Task IDs.
11. Workspace links to the Twenty records when URLs are available.

## Form Fields

| Field | Required | UI Control | Notes |
| --- | --- | --- | --- |
| `linkedinUrl` | Recommended | URL input | User-provided only. No scraping. |
| `fullName` | Required unless first/last provided | Text input | Preserve full value for event payload. |
| `firstName` | Optional | Text input | Can be inferred from full name. |
| `lastName` | Optional | Text input | Can be inferred from full name. |
| `title` | Optional | Text input | Useful for scoring and angle. |
| `companyName` | Required | Text input | Required for fallback dedupe. |
| `companyWebsite` | Optional | URL input | Used for company domain dedupe. |
| `email` | Optional | Email input | Strongest Person dedupe when present. |
| `phone` | Optional | Phone input | Store only when rep provides it. |
| `leadSource` | Required | Select | Use approved values listed below. |
| `outboundPipelineType` | Required | Segmented control or select | `ASSESSMENT_CAMPAIGN`, `RELATIONSHIP_BUILDING`, `GENERAL_PROSPECT`. |
| `assignedRep` | Optional | Select | Defaults to current user if supported. |
| `notes` | Required | Textarea | Why this lead matters. |

Minimum valid input:

- `companyName`
- `leadSource`
- one name path: `fullName` or `firstName`/`lastName`
- one context path: `linkedinUrl`, `email`, or useful `notes`

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

## Validation Behavior

Blocking errors:

- missing name
- missing company
- missing source
- missing capture context
- invalid URL or email format
- unsupported pipeline value

Warnings:

- email missing; LinkedIn/name+company dedupe will be weaker
- company website missing; company dedupe will use name
- title missing; scoring/personalization will be less precise
- assigned rep missing; backend default owner will be used
- relationship writes unavailable; Person/Company/Task links may be skipped

Warnings should be visible but should not block submission unless the backend
marks them as errors.

## Preview Panel

The preview should show:

- normalized lead
- dedupe strategy
- ICP fit score
- lead health score
- stale risk
- discovery readiness
- outreach angle
- selected cadence
- first task title, due date, and body
- CRM payload preview for Person, Company, and Task
- schema warnings
- relationship write status
- duplicate candidates and match confidence
- whether commit is blocked by a merge decision

Payload preview should be collapsible by object.

## Duplicate Merge Gate

If preview finds possible duplicates, show a merge gate before commit.

The user can choose:

- merge lead 1 into lead 2
- merge lead 2 into lead 1
- keep separate

The merge gate should display:

- matched fields
- confidence level
- missing fields to copy
- conflicting fields
- explicit keep/overwrite choices
- surviving record preview

Missing fields should be copied into the selected surviving record. Conflicting
fields require explicit user choice.

## Submit Result

After submit, show:

| Result | Display |
| --- | --- |
| Person | created, updated, skipped, or failed; Twenty ID if available. |
| Company | created, updated, skipped, or failed; Twenty ID if available. |
| Task | created, skipped existing, or failed; Twenty ID if available. |
| Supabase event | event ID and status. |
| Audit logs | count and IDs for operator traceability. |

If the result is `partial_failure`, the UI should preserve the successful IDs
and link to recovery guidance.

## Dedupe Display

Show the dedupe strategy before submission:

1. email
2. LinkedIn URL
3. name + company

If a duplicate is found, display:

- matched by
- update instead of create
- fields that will be updated
- whether a new task will be created or skipped

## Protected Fields

Quick Capture must never send these assessment fields:

- `assessmentCompleted`
- `assessmentScore`
- `lastTouchDate`
- `leadstageAuto`
- `messageAngle`
- `nextFollowUpDate`

The UI does not need controls for these fields.

## States

- empty form
- client validation errors
- preview loading
- preview ready
- preview warnings
- submit confirmation
- submit loading
- success
- partial failure
- failure

Use toasts for short status changes and an inline result panel for durable
details. Do not hide operation IDs after submission.

## Accessibility And Ergonomics

- Use labels on all inputs.
- Keep keyboard navigation predictable.
- Preserve entered form data when preview fails.
- Avoid modal-only flows for critical details.
- Make submit disabled only for blocking validation errors.
- Place the preview beside or below the form depending on screen width.

## Non-Goals

- No LinkedIn scraping.
- No automated connection requests.
- No automated messages.
- No browser extension behavior.
- No direct writes to Twenty or Supabase from the browser.
