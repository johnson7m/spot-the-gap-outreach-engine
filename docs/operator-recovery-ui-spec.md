# Operator Recovery UI Spec

This document defines the future recovery and dead-letter screen for
`visible-gap-workspace`. It does not implement recovery endpoints or UI.

## Purpose

Operators need a clear way to inspect CRM sync failures, understand whether they
are retryable, and trigger safe operation-level recovery without replaying full
workflows.

## Route

```text
/recovery
```

## Primary Data Source

Future endpoint:

```text
GET /api/recovery/retryable-failures
```

The backend should query `crm_sync_logs`, join or enrich with matching
`outbound_events` or `assessment_submissions` where useful, and return only
safe operational details.

## Table Columns

| Column | Notes |
| --- | --- |
| failed operation | Human label such as "Company upsert". |
| provider | `twenty` for current implementation. |
| object | `person`, `company`, `task`, `opportunity`, etc. |
| action | `create`, `update`, `upsert`, `skip_existing`, etc. |
| retryable | Boolean plus reason. |
| last error | Short message, not full raw payload by default. |
| retry count | Current attempt count and max. |
| correlation ID | Copyable. |
| dedupe key | Copyable. |
| last attempted | Timestamp. |
| suggested action | Retry, fix schema, inspect provider, or manual cleanup. |
| actions | Retry button, view details, open related record. |

## Detail Panel

On selecting a failure, show:

- correlation ID
- CRM sync log ID
- provider
- object/action
- dedupe key
- request payload
- response payload, if any
- error payload
- retryable classification
- retry_after, if present
- prior attempts
- matching outbound event
- matching assessment submission, if any
- related successful operations in same correlation group

Raw JSON should be collapsible and copyable.

## Retry Button Behavior

Retry should call:

```text
POST /api/recovery/:id/retry
```

Required UI safeguards:

- Retry button disabled when failure is not retryable.
- Retry button disabled when max retries are exhausted.
- Confirmation step names the exact operation.
- Confirmation makes clear that only the failed operation will be retried.
- Button shows loading state.
- Result shows new audit log ID and CRM record ID if available.

## Retry Result States

Success:

- mark row as recovered
- show new CRM record ID
- show new audit log ID
- keep original failure visible in history

Partial/failed retry:

- update retry count
- display latest error
- preserve prior successful operations
- show whether another retry is allowed

Blocked:

- schema validation failure
- auth/permission issue
- max retries exhausted
- operation already recovered by a newer audit log

## Dead-Letter Visibility

Dead-letter candidates:

- retryable failure exceeded max retries
- non-retryable schema/payload error
- missing required metadata
- CRM auth failure
- repeated relationship mapping failure

Dead-letter rows should not offer blind retry. They should suggest the smallest
safe next action:

- fix payload builder
- fix CRM schema
- refresh metadata
- inspect provider outage
- manually clean duplicate records
- retry after configuration change

## Relationship To Existing Recovery Script

The current script:

```bash
npm run quick-capture:retry-failed
```

is operator tooling for staging and early production. The future UI should call
backend recovery endpoints that reuse the same operation-level safety model.

The UI should not implement retry logic in the browser.

## Permissions

Recommended permissions:

| Role | Access |
| --- | --- |
| `rep` | No recovery page by default. |
| `operator` | View retryable failures and retry allowed operations. |
| `admin` | View all failures and dead-letter records. |

Confirmed auth model:

- Supabase Auth
- roles: `admin`, `rep`, `operator`
- operator recovery actions are admin/operator only

Every retry action should record:

- operator user ID
- reason
- timestamp
- target CRM sync log ID
- result CRM sync log ID

## Non-Goals

- No bulk retry in MVP.
- No automatic retry scheduler from UI.
- No destructive CRM cleanup.
- No direct Twenty mutation from the browser.
