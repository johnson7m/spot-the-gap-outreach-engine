# Reporting Blueprint V2

This document defines the reporting architecture for the Visible Gap Workspace.
Phase 1 implements read-only backend reporting endpoints for executive and queue
health metrics. Phase 2 implements read-only rep-performance reporting. Phase 3
implements read-only operations reporting from Supabase operational logs. Later
phases remain planning-only until explicitly implemented.
Reporting does not perform CRM writes, schema migrations, dashboard UI changes,
or assessment webhook changes.

## Phase 1 Implementation Status

Implemented read-only endpoints:

- `GET /api/reporting/executive`
- `GET /api/reporting/queue-health`
- `GET /api/reporting/rep-performance`
- `GET /api/reporting/operations`

Implemented read-only diagnostic scripts:

- `npm run reporting:executive`
- `npm run reporting:queue-health`
- `npm run reporting:rep-performance`
- `npm run reporting:operations`

Phase 1/2 reporting reuses the same Twenty source reads, queue read
cache/degraded handling, test-record hiding, owner scope rules, queue
classification, coverage audit, and overdue metadata used by the queue
endpoints. Rep Performance additionally reads Supabase `outbound_events`,
`crm_sync_logs`, and `assessment_submissions` when Supabase is configured.
Operations reporting reads Supabase activity logs only and does not perform
Twenty reads.

## Reporting Principles

- Use deterministic operational state before AI summaries.
- Keep source-of-truth metrics explainable and auditable.
- Prefer Supabase operational logs for historical time-series metrics.
- Use Twenty for current CRM state, ownership, task state, and opportunity
  context.
- Use queue classification as a current-state read model, not as the only
  long-term reporting source.
- Separate active work metrics from data-quality and recovery metrics.
- Every metric should be traceable to a record set, date window, and calculation.

## Source Model

| Source | Current role | Reporting notes |
| --- | --- | --- |
| Twenty People | Current lead state, owner, outbound fields, assessment fields, lead health, ICP fit, stale risk, discovery readiness | Primary current-state source for executive and queue health counts. |
| Twenty Companies | Company name, segment, industry, relationship context | Used for enrichment, ICP, and company-missing metrics. |
| Twenty Tasks | Open/completed task status, due date, assignee, task body cadence markers | Primary current-state source for task backlog and overdue counts. |
| Twenty Opportunities | Discovery/deal pipeline, value, stage, linked company/person where available | Future source for discovery conversion and client pipeline metrics. |
| Supabase `outbound_events` | Durable outbound, task completion, recovery, retrofit, and workflow event stream | Primary historical source for activity, velocity, and conversion metrics. |
| Supabase `crm_sync_logs` | Auditable CRM operation attempts, successes, failures, retries, partial failures | Primary source for operational reliability and recovery metrics. |
| Supabase `assessment_submissions` | Assessment form submissions, score, result, sync status | Primary source for assessment completions and assessment score reporting. |
| Supabase `workflow_jobs` | Workflow execution attempts and retry state | Source for webhook/job reliability. |
| Queue snapshots | Current `GET /api/queues/summary` and queue classification pass; future persisted snapshot table if needed | Phase 1 can compute on demand. Phase 2 should persist daily snapshots for trends. |
| Workspace activity | Future `workspace_activity` or equivalent; current proxy is `outbound_events.actorType` and metadata | Needed for UI actions that do not result in CRM writes. |

## Common Reporting Dimensions

All reporting endpoints should support these common filters when possible:

| Dimension | Values |
| --- | --- |
| Date range | `from`, `to`, default current 30 days |
| Rep/owner | `ownerId`, `ownerEmail`, `ownerScope=mine|all` |
| Pipeline type | `ASSESSMENT_CAMPAIGN`, `RELATIONSHIP_BUILDING` |
| Cadence name | `ASSESSMENT_CAMPAIGN_V1`, `RELATIONSHIP_BUILDING_V1` |
| Cadence stage | Current Person `cadenceStage` or event payload stage |
| Lead source | Approved `leadSource` values |
| Company segment | Twenty Company Segment select values |
| Company industry | Twenty Company Industry select values |
| Include test records | `includeTestRecords=false` by default |

## Executive Reporting

Executive reporting answers: "How much pipeline exists, how healthy is it, and
where is leadership attention required?"

| Metric | Twenty source objects | Outbound events | CRM sync logs | Queue snapshots | Workspace activity | Calculation method |
| --- | --- | --- | --- | --- | --- | --- |
| Total Leads | People | Optional `quick_capture_committed`, `legacy_retrofit_applied` | Person create/update logs for audit only | Coverage audit total | Not required | Count non-test People. Exclude hidden test records by default. |
| Active Leads | People | Task/cadence events for historical context | Not primary | Queue summary active dispositions | Not required | Count non-test People not terminal: not active client, not unqualified/declined/completed, and assigned to Fresh, Follow-Up, Warm, Stale, or Pipeline Review active dispositions. |
| Fresh Leads | People, Tasks, taskTargets | `missing_next_task_created` optional historical context | Task create audit logs for validation | Fresh Lead queue count | Not required | Use queue classification final queue `fresh_leads`. |
| Follow-Ups | People, Tasks, taskTargets | `sent_initial_follow_up_created`, `next_task_created`, `task_completed` | Task create/update logs for validation | Follow-Up queue count | Not required | Use queue classification final queue `follow_ups`. |
| Warm Assessments | People, assessment fields | `assessment_completed`, assessment follow-up events when added | Assessment CRM sync logs for validation | Warm Assessment queue count | Not required | Count People where `assessmentCompleted=true`, `leadstageAuto=ASSESSMENT_COMPLETED`, or `discoveryReadiness in READY/REQUESTED/BOOKED`, excluding terminal records. |
| Discovery Ready | People, Opportunities | `discovery_requested`, `task_completed` with discovery ask | Opportunity create/update logs | Warm/Pipeline queues for current candidates | Future discovery action events | Count People where `discoveryReadiness in READY/REQUESTED/BOOKED` or Opportunities in discovery stages. |
| Active Clients | People, Companies, Opportunities | Optional client conversion event | Opportunity/client stage logs | Coverage audit terminal disposition | Not required | Count People/Companies with `leadStage=ACTIVE_CLIENT`, `cadenceStage=ACTIVE_CLIENT`, or Opportunity closed-won/client stage. |
| Stale Leads | People, Tasks | `task_completed`, no-response events when added | Not primary | Stale Recovery queue count | Not required | Use Stale Recovery final queue and stale reason. Do not count overdue alone as stale. |
| Unassigned Leads | People owner, workspaceMembers | Optional assignment events | Owner update logs | Coverage audit owner missing count | Future assignment actions | Count non-test People with missing/unresolved owner. |
| Pipeline Review Leads | People, Companies, Tasks | Manual normalization, recovery, retrofit events for context | Failed/partial sync logs | Pipeline Review final queue count | Not required | Count final queue/disposition `pipeline_review`, not every reviewed Person. |

Recommended executive cards:

- Lead Coverage: Total Leads, Active Leads, Pipeline Review Leads
- Workload: Fresh Leads, Follow-Ups, Warm Assessments, Stale Leads
- Conversion: Discovery Ready, Active Clients, Assessments Completed
- Data Quality: Unassigned Leads, Missing Company, Missing Email, Missing LinkedIn

## Rep Performance

Rep performance answers: "Who owns which work, what activity was completed, and
what outcomes followed?"

Breakdowns:

- By Rep: owner/workspace member email or profile ID
- By Week: ISO week from event/task completion timestamp
- By Month: calendar month from event/task completion timestamp

| Metric | Twenty source objects | Outbound events | CRM sync logs | Queue snapshots | Workspace activity | Calculation method |
| --- | --- | --- | --- | --- | --- | --- |
| Tasks Completed | Tasks | `task_completed` | Task update logs if completion is synced | Not primary | Future UI task completion action | Count completed tasks by completion date and actor/owner. Prefer `outbound_events.event_type=task_completed`. |
| Tasks Created | Tasks | `missing_next_task_created`, `sent_initial_follow_up_created`, `next_task_created` | Task create logs | Not primary | Not required | Count task create events by created date and assignee/owner. |
| Tasks Overdue | Tasks | Not primary | Not primary | Queue summary overdue by queue | Not required | Count open Tasks where due date is before today, grouped by assignee/owner. |
| Touches Sent | Tasks plus Person touch fields | `task_completed` with `touchStatus=SENT`, channel | Not primary | Not primary | Future manual touch logging | Count completed touch events where status is sent/completed. |
| Responses | People latestTouchStatus | `task_completed` with `touchStatus=RESPONDED`, future `response_received` | Not primary | Not primary | Future response capture UI | Count response events by owner and period. |
| Discovery Requests | People discoveryReadiness, Opportunities | `task_completed` with `DISCOVERY_ASK`, future `discovery_requested` | Opportunity/task logs | Warm/Pipeline queues | Future discovery request action | Count discovery ask/request events. |
| Discovery Conversions | Opportunities | `discovery_booked`, future meeting/result events | Opportunity stage logs | Not primary | Future meeting outcome logging | Count leads that move from discovery requested to booked or opportunity discovery stage. |
| Assessments Requested | People, Tasks | `task_completed` for assessment CTA, future `assessment_requested` | Task logs | Not primary | Future assessment send action | Count assessment CTA task completions or requested events. |
| Assessments Completed | People assessment fields | Assessment completion event or `assessment_submissions` | Person update logs | Warm queue | Not required | Count accepted assessment submissions, grouped by owner at completion time where resolvable. |
| Lead Ownership Counts | People owner | Assignment events when added | Owner update logs | Queue summary by owner | Future assignment actions | Count current non-test People by owner and disposition. |

Rep performance caveats:

- Owner changes can rewrite current ownership in Twenty. Historical rep
  attribution should use event actor/owner metadata captured at event time.
- If no actor metadata exists, use current Person owner and mark the metric as
  current-owner attributed.

## Queue Health

Queue health answers: "Is the operating system clear, actionable, and clean?"

| Metric | Twenty source objects | Outbound events | CRM sync logs | Queue snapshots | Workspace activity | Calculation method |
| --- | --- | --- | --- | --- | --- | --- |
| Queue Counts | People, Tasks | Not primary | Not primary | `GET /api/queues/summary` | Not required | Current total count by final queue. |
| Queue Growth | People, Tasks | Events entering/leaving queue when persisted | Not primary | Future daily queue snapshots | Not required | Difference between daily snapshot counts by queue. Phase 1 reports current only. |
| Queue Velocity | Tasks, People cadence state | `task_completed`, task create events | Task create/update logs | Future snapshots | Not required | Items completed or moved out of queue per period divided by starting queue count. Phase 2. |
| Overdue Tasks | Tasks | Not primary | Not primary | Queue summary overdue by queue | Not required | Count open tasks with `dueStatus=overdue`; keep in logical queue, not stale by default. |
| Owner Missing | People owner | Optional assignment events | Owner cleanup logs | Pipeline Review reasons | Not required | Count People with missing/unresolved owner. |
| Email Missing | People emails | Not primary | Not primary | Pipeline Review reasons | Not required | Count active People with no usable email. |
| Company Missing | People company relation, Companies | Not primary | Not primary | Pipeline Review reasons | Not required | Count active People with no Company relation or unresolved Company relation. |
| LinkedIn Missing | People LinkedIn field | Not primary | Not primary | Pipeline Review reasons | Not required | Count active People with no LinkedIn URL. |
| Enrichment Status | People enrichmentStatus, Company segment/industry | Enrichment events when added | Not primary | Pipeline Review reasons | Future enrichment actions | Count by `enrichmentStatus` and missing segment/industry. |

Queue health must distinguish:

- Overdue work: task timing issue, stays in Fresh or Follow-Up.
- Stale relationship: relationship status issue, enters Stale Recovery.
- Pipeline Review: data or normalization issue.
- Unassigned Tasks: task relationship issue, not "Unknown person" follow-up.

## Cadence Analytics

Cadence analytics answers: "Which cadence stages are producing action and
conversion?"

| Metric | Twenty source objects | Outbound events | CRM sync logs | Queue snapshots | Workspace activity | Calculation method |
| --- | --- | --- | --- | --- | --- | --- |
| Connection Requests | Tasks, People cadenceStage | `task_completed` channel/status for connection request; `missing_next_task_created` for created tasks | Task create/update logs | Fresh queue | Completion count by task type `connection_request`. |
| Intro Messages | Tasks, People cadenceStage | `task_completed`, `sent_initial_follow_up_created` | Task logs | Follow-Up queue | Completion count by stage `INTRO_MESSAGE`. |
| Assessment Positioning | Tasks, People cadenceStage | `task_completed`, `sent_initial_follow_up_created` for assessment campaign | Task logs | Follow-Up queue | Completion count by stage `ASSESSMENT_POSITIONING`. |
| Assessment Follow-Up | Tasks, assessment fields | `task_completed` for `ASSESSMENT_CHECK_IN` | Task logs | Warm Assessment queue | Completion count by stage `ASSESSMENT_CHECK_IN`. |
| Strategic Check-In | Tasks, People cadenceStage | `task_completed` for `STRATEGIC_CHECK_IN` | Task logs | Follow-Up/Stale queues | Completion count by stage `STRATEGIC_CHECK_IN`. |
| Discovery Ask | Tasks, People discoveryReadiness | `task_completed` for `DISCOVERY_ASK`, future `discovery_requested` | Task/opportunity logs | Warm/Pipeline queues | Completion count and resulting discovery readiness/opportunity movement. |

Conversions:

| Conversion | Sources | Calculation |
| --- | --- | --- |
| Stage-to-stage conversion | `outbound_events`, Person cadence fields, Task events | Count leads with event/stage B after event/stage A divided by leads reaching A in date window. |
| Response rate | `outbound_events`, Person latestTouchStatus | Leads with `RESPONDED` event divided by leads with at least one sent/completed touch. |
| Discovery rate | `outbound_events`, Opportunities, Person discoveryReadiness | Leads with discovery requested/booked/opportunity discovery divided by eligible warm or post-response leads. |
| Assessment completion rate | `assessment_submissions`, `outbound_events`, People assessment fields | Completed assessments divided by assessment requested/sent events. |

Cadence analytics should store stage names from event payloads at the time of
action. Current Person `cadenceStage` alone is not enough for historical
conversion math.

## Operational Metrics

Operational metrics answer: "Is the engine reliable, recoverable, and creating
safe work?"

| Metric | Twenty source objects | Outbound events | CRM sync logs | Queue snapshots | Workspace activity | Calculation method |
| --- | --- | --- | --- | --- | --- | --- |
| Task Creation Rate | Tasks | `missing_next_task_created`, `sent_initial_follow_up_created`, `next_task_created` | Task create logs | Not primary | Not required | Count successful task creation events per day/week. |
| Task Completion Rate | Tasks | `task_completed` | Task update logs | Queue overdue counts for denominator support | Future UI task actions | Completed tasks divided by due tasks in period. |
| Recovery Events | Not primary | Recovery event statuses | Failed and recovered CRM sync logs | Not primary | Operator recovery actions | Count recovery attempts, successes, failures, and retryable failures by operation type. |
| Duplicate Prevention Events | Tasks, People | Skipped duplicate events, payload `duplicateTaskSkipped` | Logs with skipped duplicate/open task response | Not primary | Not required | Count skipped duplicate writes and dedupe-key hits. |
| Queue Classification Events | People, Tasks | Optional future classification snapshot events | Not primary | Coverage audit and queue summary | Not required | Count classification runs/snapshots and unclassified People. Phase 1 via diagnostics. |
| Manual Review Events | People, Tasks | `manual_lead_normalized`, future `manual_review_created/resolved` | Manual normalization logs | Pipeline Review reasons | Future review UI actions | Count items entering and exiting manual review reasons. |

Operational health should expose:

- `failedCrmWrites`
- `retryableFailures`
- `partialSuccessBatches`
- `recoveredOperations`
- `deadLetterOperations`, future
- `missingOutputRecoveryFallbacks`
- `queueRateLimitedReads`
- `staleCacheResponses`

## Reporting APIs

All reporting endpoints should use the common workspace response envelope:

```json
{
  "ok": true,
  "correlationId": "reporting:...",
  "data": {},
  "warnings": [],
  "errors": []
}
```

Common query params:

```text
from=2026-06-01
to=2026-06-30
ownerScope=mine|all
ownerEmail=chandler@visiblegap.com
pipelineType=RELATIONSHIP_BUILDING
includeTestRecords=false
compareToPreviousPeriod=true
```

### GET /api/reporting/executive

Purpose: Phase 1 executive summary cards and current-state indicators.

Response contract:

```json
{
  "data": {
    "reportName": "executive",
    "generatedAt": "2026-06-09T00:00:00.000Z",
    "ownerScope": "all",
    "assigneeScope": "all",
    "metrics": {
      "totalPeople": 324,
      "hiddenTestRecords": 11,
      "expectedRealPeople": 313,
      "activeLeads": 0,
      "freshLeads": 0,
      "followUps": 0,
      "warmAssessments": 0,
      "pipelineReview": 0,
      "staleRecovery": 0,
      "activeClients": 0,
      "unclassifiedPeople": 0,
      "totalOpenTasks": 0,
      "overdueTasks": 0
    },
    "status": "ok",
    "isPartial": false,
    "partialReason": null,
    "retryAfterSeconds": null,
    "diagnostics": {},
    "warnings": []
  }
}
```

### GET /api/reporting/rep-performance

Purpose: Phase 2 rep-level ownership, workload, activity, and early conversion
reporting.

Response contract:

```json
{
  "data": {
    "reportName": "rep-performance",
    "generatedAt": "2026-06-09T00:00:00.000Z",
    "ownerScope": "all",
    "assigneeScope": "all",
    "dateRange": {
      "startDate": "2026-05-10T00:00:00.000Z",
      "endDate": "2026-06-09T23:59:59.999Z"
    },
    "metrics": {
      "totals": {
        "leadsOwned": 0,
        "openTasksAssigned": 0,
        "overdueTasksAssigned": 0,
        "tasksCreated": 0,
        "tasksCompleted": 0,
        "touchesSent": 0,
        "responses": 0,
        "noResponses": 0,
        "discoveryRequests": 0,
        "assessmentRequests": 0,
        "assessmentCompletions": 0,
        "activeLeadCount": 0,
        "followUpCount": 0,
        "freshLeadCount": 0,
        "pipelineReviewCount": 0
      },
      "reps": [
        {
          "repKey": "chandler@visiblegap.com",
          "ownerEmail": "chandler@visiblegap.com",
          "ownerName": "Chandler Johnson",
          "source": "person_owner",
          "metrics": {}
        }
      ]
    },
    "status": "ok",
    "isPartial": false,
    "partialReason": null,
    "retryAfterSeconds": null,
    "diagnostics": {},
    "warnings": []
  }
}
```

Supported query params:

- `ownerScope=mine|all`
- `assigneeScope=mine|all`
- `startDate=YYYY-MM-DD`
- `endDate=YYYY-MM-DD`
- `includeDiagnostics=true|false`

Current-state metrics come from Twenty People owner and Twenty Tasks assignee.
Date-window activity metrics come from Task dates plus Supabase
`outbound_events` and `assessment_submissions` when configured. `crm_sync_logs`
are loaded for diagnostics/future reliability metrics, but Task creation totals
prefer Twenty Task `createdAt` and outbound task-created events to avoid double
counting the same write audit.

### GET /api/reporting/queue-health

Purpose: Phase 1 queue counts, data-quality gaps, overdue work, and review
load.

Response contract:

```json
{
  "data": {
    "reportName": "queue-health",
    "generatedAt": "2026-06-09T00:00:00.000Z",
    "ownerScope": "all",
    "assigneeScope": "all",
    "metrics": {
      "queueCounts": {
        "freshLeads": 0,
        "followUps": 0,
        "warmAssessments": 0,
        "staleRecovery": 0,
        "pipelineReview": 0,
        "unassignedTasks": 0
      },
      "overdueCountsByQueue": {
        "freshLeads": 0,
        "followUps": 0,
        "warmAssessments": 0,
        "staleRecovery": 0,
        "pipelineReview": 0,
        "unassignedTasks": 0
      },
      "ownerMissing": 0,
      "emailMissing": 0,
      "companyMissing": 0,
      "linkedinMissing": 0,
      "enrichmentPartial": 0,
      "missingNextTask": 0,
      "unresolvedReviewItems": 0,
      "unassignedTasks": 0,
      "hiddenTestRecords": 0
    },
    "status": "ok",
    "isPartial": false,
    "partialReason": null,
    "retryAfterSeconds": null,
    "diagnostics": {},
    "warnings": []
  }
}
```

### GET /api/reporting/cadence-analytics

Purpose: cadence stage activity and conversion rates.

Response contract:

```json
{
  "data": {
    "range": { "from": "2026-06-01", "to": "2026-06-30" },
    "stageActivity": {
      "connectionRequests": 0,
      "introMessages": 0,
      "assessmentPositioning": 0,
      "assessmentFollowUp": 0,
      "strategicCheckIn": 0,
      "discoveryAsk": 0
    },
    "conversions": {
      "stageToStage": [],
      "responseRate": null,
      "discoveryRate": null,
      "assessmentCompletionRate": null
    },
    "byCadenceName": [],
    "warnings": []
  }
}
```

### GET /api/reporting/operations

Purpose: engine reliability, recovery, partial failures, and audit visibility.

Response contract:

```json
{
  "data": {
    "reportName": "operations",
    "generatedAt": "2026-06-09T00:00:00.000Z",
    "dateRange": {
      "startDate": "2026-05-10T00:00:00.000Z",
      "endDate": "2026-06-09T23:59:59.999Z"
    },
    "metrics": {
      "totalOutboundEvents": 0,
      "totalCrmSyncLogs": 0,
      "successfulSyncs": 0,
      "failedSyncs": 0,
      "partialSuccessSyncs": 0,
      "recoveryEvents": 0,
      "duplicatePreventionEvents": 0,
      "manualReviewEvents": 0,
      "queueClassificationEvents": 0,
      "taskCreationEvents": 0,
      "taskCompletionEvents": 0,
      "quickCaptureCommitEvents": 0,
      "assessmentWebhookEvents": 0
    },
    "breakdowns": {
      "byEventType": {},
      "byStatus": {
        "outboundEvents": {},
        "crmSyncLogs": {},
        "assessmentSubmissions": {}
      },
      "bySourceWorkflow": [],
      "byDay": []
    },
    "recentFailures": [],
    "status": "ok",
    "isPartial": false,
    "partialReason": null,
    "retryAfterSeconds": null,
    "diagnostics": {},
    "warnings": []
  }
}
```

Supported query params:

- `startDate=YYYY-MM-DD`
- `endDate=YYYY-MM-DD`
- `includeDiagnostics=true|false`

Operations reporting reads Supabase `outbound_events`, `crm_sync_logs`, and
`assessment_submissions` for the selected date range. It does not read or write
Twenty. `recentFailures[]` is intentionally sanitized: secrets, tokens,
authorization headers, passwords, and API keys are omitted or redacted before
the response is returned.

## MVP Recommendation

### Phase 1: Must-Have

Build the simplest dashboard that answers what needs attention today:

1. Executive cards from current-state queue summary and People counts.
2. Queue Health cards: queue counts, overdue counts, Pipeline Review reasons,
   unassigned task count.
3. Rep Performance basics: tasks completed, tasks created, tasks overdue,
   lead ownership count.
4. Operational Health basics: failed CRM sync logs, recovery events, duplicate
   prevention count.

Phase 1 can compute most data on demand from Twenty, existing queue summary,
`outbound_events`, `crm_sync_logs`, and `assessment_submissions`. No persisted
queue snapshots are required yet.

### Phase 2: Valuable

Rep Performance is now implemented as a read-only current-state plus recent
activity report. Remaining Phase 2 work adds trend and conversion reporting
after the current-state dashboard is stable:

1. Persist daily queue snapshots for queue growth and velocity.
2. Add weekly/monthly rep breakdowns.
3. Add cadence conversion reporting from structured `outbound_events`.
4. Add assessment requested to assessment completed conversion.
5. Add owner and source trend comparisons.

Phase 2 likely needs a persisted `reporting_snapshots` or
`queue_snapshots` table.

### Phase 3: Advanced

Add planning and forecasting:

1. Discovery goal calculator.
2. Required activity to hit discovery targets.
3. Rep capacity model by queue load and overdue work.
4. Source quality and conversion by channel.
5. Cohort reporting by capture month and cadence.
6. Opportunity value attribution by source/cadence/rep.

Phase 3 should be built only after event schemas and opportunity relationships
are stable.

## Future AI Layer

AI should sit above deterministic reporting, not replace it.

Future AI capabilities:

- Summarize pipeline health from reporting endpoint outputs.
- Recommend next actions for reps based on queue health and overdue work.
- Identify stalled leads using stale reasons, last touch dates, and response
  history.
- Generate coaching insights by rep, such as missed follow-up patterns or strong
  response channels.
- Suggest enrichment priorities based on missing fields, company segment,
  industry, ICP fit, and lead health.
- Explain why counts changed week over week.
- Draft executive narrative summaries for internal meetings.

AI guardrails:

- AI reads reporting aggregates and item summaries only.
- AI does not write to Twenty directly.
- AI recommendations must route through an execution layer with permissions,
  schema validation, and audit logs.
- AI-generated coaching or summaries should cite the deterministic metrics used.

## Implementation Sequence

1. Add read-only reporting service layer in the outreach engine.
2. Implement `GET /api/reporting/executive` using queue summary, People counts,
   assessment submissions, and current CRM state.
3. Implement `GET /api/reporting/queue-health` using queue summary and Pipeline
   Review reasons.
4. Implement `GET /api/reporting/rep-performance` with current-owner attribution
   plus recent event-time attribution where available.
5. Implement `GET /api/reporting/operations` using `crm_sync_logs`,
   `outbound_events`, and `assessment_submissions`. Completed in Phase 3.
6. Implement `GET /api/reporting/cadence-analytics` after cadence event payloads
   are verified for stage/type consistency.
7. Wire the workspace reporting page to Phase 1 endpoints.
8. Add persisted queue/reporting snapshots only when Phase 1 dashboard usage
   proves trend reporting is needed.
