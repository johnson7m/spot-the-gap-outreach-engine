# Outbound State Machine

This document defines the outbound state machine for Quick Capture, rep queues,
cadence task generation, warm escalation, stale recovery, and discovery
readiness. Quick Capture and task completion now have backend foundations; queue
read models, pause/resume endpoints, and reporting endpoints remain planned.

## Source Of Truth

Twenty stores:

- CRM records
- Person, Company, Task, and Opportunity relationships
- rep-facing ownership
- pipeline state used in CRM views
- current cadence and lead state summary fields

Supabase stores:

- workflow state
- audit logs
- outbound events
- retry history
- reporting aggregates
- operational intelligence used by the workspace

The workspace should read through the outreach engine API. The browser should
not write directly to Twenty or Supabase.

## Protected Assessment State

The assessment webhook keeps using the protected Person field `leadstageAuto`.
Outbound workflows must not rename, repurpose, or directly mutate these values
from Quick Capture:

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

Assessment completions become warm immediately and should route into the Warm
Assessment Queue without changing the public assessment flow.

## Manual Pipeline States

Use a separate manual/general lead-stage concept for non-assessment outbound:

- `IDENTIFIED`
- `OUTREACH_INITIATED`
- `ENGAGED`
- `ACTIVE_CONVERSATION`
- `DISCOVERY_READY`
- `UNQUALIFIED_CLOSED`
- `ACTIVE_CLIENT`

Suggested progression:

```text
IDENTIFIED
  -> OUTREACH_INITIATED
    -> ENGAGED
      -> ACTIVE_CONVERSATION
        -> DISCOVERY_READY
          -> ACTIVE_CLIENT
```

Exit path:

```text
IDENTIFIED or OUTREACH_INITIATED or ENGAGED
  -> UNQUALIFIED_CLOSED
```

Cold leads should not automatically move directly to `DISCOVERY_READY`. Normal
path is cold -> warm -> discovery, with manual override allowed.

## Cadence Stages

Confirmed cadence stages:

- `NOT_STARTED`
- `CONNECTION_REQUEST`
- `INTRO_MESSAGE`
- `ASSESSMENT_POSITIONING`
- `ASSESSMENT_SENT`
- `ASSESSMENT_CHECK_IN`
- `VALUE_TOUCH`
- `STRATEGIC_CHECK_IN`
- `DISCOVERY_ASK`
- `PAUSED`
- `COMPLETED`

Cadence state should be stored separately from protected assessment state.

## One-Next-Task Rule

The cadence engine should generate only one next task at a time.

Rules:

- Do not create the next task until the active task is completed, skipped,
  paused, or explicitly advanced.
- Do not create duplicate open tasks for the same Person, cadence name, and
  cadence stage.
- Store each planned/completed touch in Supabase `outbound_events`.
- Store the active rep-facing action in Twenty Task.

## Task Completion Transitions

Supported task completion rules:

| Completion rule | Current state | Next state | Next task |
| --- | --- | --- | --- |
| Review Fresh Leads | `IDENTIFIED` / `NOT_STARTED` | `IDENTIFIED` / `CONNECTION_REQUEST` | Day 1 send connection request. |
| Lead Research Completed | `IDENTIFIED` | `OUTREACH_INITIATED` / `CONNECTION_REQUEST` | Send connection request or intro task. |
| Connection Request Sent | `OUTREACH_INITIATED` / `CONNECTION_REQUEST` | `OUTREACH_INITIATED` / `INTRO_MESSAGE` or `ASSESSMENT_POSITIONING` | Day 3 follow-up task. |
| Message Sent | `OUTREACH_INITIATED` or `ENGAGED` | next cadence stage | Follow-up task based on cadence. |
| Assessment Sent | `OUTREACH_INITIATED` / `ASSESSMENT_SENT` | `ENGAGED` / `ASSESSMENT_CHECK_IN` | Assessment check-in task. |
| Add to Pipeline | any warm lead | `DISCOVERY_READY` or `ACTIVE_CONVERSATION` | Discovery ask or pipeline review task. |

The exact next task depends on `outboundPipelineType`:

- `ASSESSMENT_CAMPAIGN`: connection -> assessment positioning -> assessment
  sent -> assessment check-in -> discovery ask or pause.
- `RELATIONSHIP_BUILDING`: connection -> intro -> value touch -> strategic
  check-in -> discovery ask or completed.
- `GENERAL_PROSPECT`: connection -> intro -> value touch or pause until a more
  specific pipeline is selected.

Implemented task completion endpoint:

```text
POST /api/tasks/:id/complete
```

Implemented behavior:

- requires Supabase workspace JWT and role `admin`, `operator`, or `rep`
- records `task_completed` in `outbound_events`
- updates Person cadence and outbound touch summary fields
- creates or skips exactly one next Task
- writes `next_task_created` when a next task is planned
- writes `crm_sync_logs` for Person update and Task create/skip/failure
- keeps relationship writes disabled

Implemented Assessment Campaign V1 transitions:

| Current `cadenceStage` | New `cadenceStage` | Next task |
| --- | --- | --- |
| `CONNECTION_REQUEST` | `INTRO_MESSAGE` | Send assessment positioning message |
| `INTRO_MESSAGE` | `ASSESSMENT_POSITIONING` | Send assessment positioning message |
| `ASSESSMENT_POSITIONING` | `ASSESSMENT_SENT` | Send Spot the Gap assessment link |
| `ASSESSMENT_SENT` | `ASSESSMENT_CHECK_IN` | Check in on Spot the Gap assessment |
| `ASSESSMENT_CHECK_IN` | `PAUSED` or `COMPLETED` | none |

Implemented Relationship Building V1 transitions:

| Current `cadenceStage` | New `cadenceStage` | Next task |
| --- | --- | --- |
| `CONNECTION_REQUEST` | `INTRO_MESSAGE` | Send contextual introduction |
| `INTRO_MESSAGE` | `VALUE_TOUCH` | Send value touch |
| `VALUE_TOUCH` | `STRATEGIC_CHECK_IN` | Send strategic check-in |
| `STRATEGIC_CHECK_IN` | `DISCOVERY_ASK` | Evaluate discovery ask |
| `DISCOVERY_ASK` | `PAUSED` or `COMPLETED` | none |

## Warm Escalation Rules

Assessment completions become warm immediately.

Other leads may become warm through:

- response count
- response quality
- lead evaluation
- industry event trigger
- company activity
- rep-observed opportunity
- `leadHealthScore > 50`

Warm escalation should create or update the next human task, not auto-send
outreach.

## Discovery Readiness Rules

Discovery Ready recommendation criteria:

- `leadHealthScore > 75`
- response quality indicates business relevance
- decision-making power is medium or high
- ICP fit is credible
- no active disqualification or pause reason

Discovery conversion should normally follow:

```text
cold -> warm -> discovery
```

Manual override is allowed when a rep or operator has context the score does not
capture. Overrides must write an audit event with the actor, reason, prior
state, and new state.

## Stale Rules

Mark or recommend stale recovery when either condition is met:

- no inbound or outbound activity for 3 months
- no response after a full cadence cycle

Stale state should lower lead-health scoring when appropriate, especially when
there is long inactivity and no response quality signal.

Stale leads should route to Stale Recovery Queue unless they are:

- `UNQUALIFIED_CLOSED`
- `ACTIVE_CLIENT`
- explicitly paused for a future date

## Pause Rules

Pause cadence when:

- the lead is not interested
- the cadence cycle ends without meaningful response
- enrichment or data quality is insufficient for credible outreach
- a rep manually pauses the lead
- the lead should not receive more touches until a specific date

Pause should:

- set cadence stage to `PAUSED`
- keep current CRM ownership
- write a Supabase outbound event
- prevent automatic next-task generation

## Resume Rules

Resume when:

- the system detects a re-engagement signal
- a rep manually unpauses the lead
- role change or company change suggests new relevance
- response or company activity creates a new reason to engage
- a rep observes a new opportunity

Resume should:

- require a reason
- set the next cadence stage deliberately
- generate one next task
- write an audit event

## Manual Override Rules

Allowed manual overrides:

- change pipeline type
- change cadence stage
- mark lead warm
- mark discovery ready
- pause or resume
- close as unqualified
- mark active client

Manual overrides should require:

- authenticated user
- role permission
- reason
- previous state
- new state
- timestamp
- correlation ID

## Queue Routing Summary

| State/signal | Queue |
| --- | --- |
| `IDENTIFIED`, `NOT_STARTED`, first task open | Fresh Lead Queue |
| open task due today or overdue | Follow-Up Queue |
| `assessmentCompleted=true` | Warm Assessment Queue |
| stale threshold met | Stale Recovery Queue |
| `DISCOVERY_READY`, Opportunity review, or manual pipeline escalation | Pipeline Review Queue |

## Non-Goals

- No LinkedIn automation.
- No LinkedIn scraping.
- No browser extension behavior.
- No direct workspace-to-Twenty writes.
- No direct workspace-to-Supabase writes.
- No autonomous AI execution.
