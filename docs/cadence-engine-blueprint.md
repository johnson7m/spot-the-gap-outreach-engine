# Cadence Engine Blueprint

This document defines cadence behavior for human-controlled outbound. The first
implemented backend path is `POST /api/tasks/:id/complete`, which records manual
task completion, updates Person cadence fields, and creates one next Task when
the cadence rule calls for one. It does not implement automation or LinkedIn
actions.

## Core Rules

- Cadences create tasks and recommendations, not autonomous sends.
- Every touch must be completed manually by a rep.
- AI-generated copy, when added later, must require approval.
- Cadence state should be separate from protected assessment fields.
- Assessment completion overrides active outbound cadence state.
- Generate only one next task at a time.
- Supabase should record every planned, skipped, completed, failed, and approved
  touch in `outbound_events`.

## Assessment Campaign Cadence

Purpose: move a captured or researched lead toward completing the Spot the Gap
assessment.

| Timing | Stage | Task |
| --- | --- | --- |
| Day 1 | `CONNECTION_REQUEST` | Send manual connection request. |
| Day 2 | `ASSESSMENT_POSITIONING` | Send short positioning message. |
| Day 3 | `ASSESSMENT_SENT` | Invite lead to take assessment. |
| Week 1 | `ASSESSMENT_CHECK_IN` | Check whether assessment is still relevant. |
| Month 1 | `DISCOVERY_ASK` | Ask for a relevant operational conversation if warm enough. |

Implemented stage transitions:

```text
NOT_STARTED
  -> CONNECTION_REQUEST
    -> INTRO_MESSAGE
      -> ASSESSMENT_POSITIONING
      -> ASSESSMENT_SENT
        -> ASSESSMENT_CHECK_IN
          -> PAUSED_OR_COMPLETED
```

Implemented task-completion rules:

| Completed stage | New Person `cadenceStage` | Next task | Due |
| --- | --- | --- | --- |
| `CONNECTION_REQUEST` | `INTRO_MESSAGE` | Send assessment positioning message | +2 days |
| `INTRO_MESSAGE` | `ASSESSMENT_POSITIONING` | Send assessment positioning message | +1 day |
| `ASSESSMENT_POSITIONING` | `ASSESSMENT_SENT` | Send Spot the Gap assessment link | +1 day |
| `ASSESSMENT_SENT` | `ASSESSMENT_CHECK_IN` | Check in on Spot the Gap assessment | +3 days |
| `ASSESSMENT_CHECK_IN` | `PAUSED` or `COMPLETED` | None | n/a |

Task creation rules:

- Create one open task per active cadence step.
- Assign to Person `owner` if available, otherwise default queue owner.
- Store recommended message/action in Task `bodyV2`.
- Store structured touch plan in Supabase `outbound_events`.
- Do not create the next task until the current task is completed, skipped, or
  intentionally advanced.

Pause/exit rules:

- Pause on any reply or manual "needs review" mark.
- Exit on disqualification, opt-out, bad fit, or active client status.
- Exit or convert when discovery is requested.
- Stop assessment campaign touches after assessment completion.

Assessment completion override:

- Preserve assessment sync behavior.
- Set/retain `assessmentCompleted=true`.
- Set/retain `leadstageAuto=ASSESSMENT_COMPLETED`.
- Route to Warm Assessment Queue.
- Cancel or close future assessment CTA/check-in tasks for that cadence.
- Create a human review task for discovery qualification.

## Relationship Building Cadence

Purpose: build non-transactional relationships with high-fit leads not ready
for an assessment CTA.

| Timing | Stage | Task |
| --- | --- | --- |
| Day 1 | `CONNECTION_REQUEST` | Send manual connection request. |
| Day 3 | `INTRO_MESSAGE` | Send short introduction with no heavy CTA. |
| Week 2 | `VALUE_TOUCH` | Share useful operational point or resource. |
| Month 1 | `DISCOVERY_ASK` | Invite an operational conversation when warm enough. |
| Month 3 | `STRATEGIC_CHECK_IN` | Check for changing priorities. |

Implemented stage transitions:

```text
NOT_STARTED
  -> CONNECTION_REQUEST
    -> INTRO_MESSAGE
      -> VALUE_TOUCH
        -> STRATEGIC_CHECK_IN
          -> DISCOVERY_ASK
          -> COMPLETED_OR_PAUSED
```

Implemented task-completion rules:

| Completed stage | New Person `cadenceStage` | Next task | Due |
| --- | --- | --- | --- |
| `CONNECTION_REQUEST` | `INTRO_MESSAGE` | Send contextual introduction | +2 days |
| `INTRO_MESSAGE` | `VALUE_TOUCH` | Send value touch | +14 days |
| `VALUE_TOUCH` | `STRATEGIC_CHECK_IN` | Send strategic check-in | +30 days |
| `STRATEGIC_CHECK_IN` | `DISCOVERY_ASK` | Evaluate discovery ask | +60 days |
| `DISCOVERY_ASK` | `PAUSED` or `COMPLETED` | None | n/a |

Task creation rules:

- Use a lower-pressure next action than the assessment campaign.
- Keep value touches specific to the captured context.
- If the lead asks for a diagnostic, switch to assessment campaign or direct
  assessment follow-up.
- If the lead becomes discovery-ready, exit cadence and create discovery task.

Pause/exit rules:

- Pause on reply.
- Pause when enrichment is incomplete and needed for a credible touch.
- Exit on disqualification or explicit no-contact.
- Move to stale review if tasks are overdue beyond approved thresholds.

## Response Handling

When a lead responds:

- Stop automatic next-task creation.
- Create a response review task.
- Set the general lifecycle field to a human-reviewed state such as `ENGAGED`,
  `ACTIVE_CONVERSATION`, or `DISCOVERY_READY`.
- Add a Note summarizing the response.
- Add an `outbound_events` row with `event_type=response_received`.

## Task Completion Rules

Supported completion events:

- Review Fresh Leads
- Lead Research Completed
- Message Sent
- Assessment Sent
- Connection Request Sent
- Add to Pipeline

Examples:

- Lead selected/submitted -> generate Day 1 Send Connection Request task.
- Connection Request Sent -> generate Day 3 follow-up task.
- Assessment Sent -> generate Assessment Check-In task.
- Add to Pipeline -> generate Discovery Ask or Pipeline Review task.

The implemented endpoint creates one next task only after the current task is
completed. Skipping, pausing, and explicit advancement remain future endpoints.

Implemented Person updates:

- `cadenceName`
- `cadenceStage`
- `latestTouchChannel`
- `latestTouchStatus`
- `lastOutboundTouchDate`
- `nextOutboundTouchDate`, when a next task exists

Implemented audit/event writes:

- `outbound_events.event_type=task_completed`
- `outbound_events.event_type=next_task_created`, when a next task is planned
- `crm_sync_logs` rows for Person update and next Task create/skip/failure

Next task dedupe key includes:

```text
personId + cadenceName + nextCadenceStage + taskType
```

Relationship writes remain disabled. Next Task `bodyV2` includes Person ID,
completed Task ID, cadence context, and the dedupe key.

## Pause And Resume

Pause when:

- lead is not interested
- end of cadence cycle is reached
- data quality prevents credible outreach
- rep manually pauses

Resume when:

- system detects re-engagement signal
- rep manually unpauses
- role change, industry/company change, response, company activity, or
  rep-observed opportunity creates a new reason to engage

Resume should require a reason and generate exactly one next task.

## Warm And Discovery Escalation

Assessment completions become warm immediately.

Other warm signals:

- response count
- response quality
- lead evaluation
- industry event trigger
- company activity
- `leadHealthScore > 50`

Discovery Ready recommendation:

- `leadHealthScore > 75`
- credible business relevance
- warm state reached first, unless there is a manual override

Cold leads should not auto-progress directly to discovery.

## Suggested Cadence Field Values

Confirmed `cadenceStage` values:

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

Confirmed `outboundPipelineType` values:

- `ASSESSMENT_CAMPAIGN`
- `RELATIONSHIP_BUILDING`
- `GENERAL_PROSPECT`

Confirmed `cadenceName` values:

- `ASSESSMENT_CAMPAIGN_V1`
- `RELATIONSHIP_BUILDING_V1`
- `NONE`

## Execution Guardrails

- No LinkedIn automated sends.
- No LinkedIn scraping.
- No browser extension actions in this phase.
- No cadence action should execute without an idempotency key.
- No task should be duplicated if an open task exists for the same Person,
  cadence, and stage.
- Reps must have an obvious way to skip, pause, disqualify, or mark responded.
