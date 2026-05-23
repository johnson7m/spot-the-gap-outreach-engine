# Assessment Schema

Source inspected: `consulting-landing-page/src/pages/AssessmentPage.jsx` and the hidden Netlify form in `consulting-landing-page/index.html`.

The production website calculates the Spot the Gap result entirely in the browser. Netlify receives the completed score, grade, top weaknesses, profile context, and a compact `answerSummary` string. Individual question fields are not currently submitted as separate form fields.

## Answer Options

| Label | Value |
| --- | ---: |
| Not true today | 1 |
| Inconsistent | 2 |
| Partially true | 3 |
| Mostly true | 4 |
| Consistently true | 5 |

## Questions

| ID | Dimension | Prompt |
| --- | --- | --- |
| `reporting-trust` | Reporting reliability | Leadership can trust operational reporting without manual explanation, cleanup, or side-channel updates. |
| `metric-ownership` | Reporting reliability | Core metrics like pipeline, account health, starts, stuck work, and follow-up have clear definitions and owners. |
| `stage-ownership` | Workflow ownership | Each major workflow stage has a clear owner, expected next action, and escalation path. |
| `accountability-rhythm` | Workflow ownership | Managers can quickly tell who owns a delayed item and what is needed to move it forward. |
| `system-agreement` | Systems fragmentation | Your ATS, VMS, CRM, spreadsheets, and operating tools generally agree on status, ownership, and priority. |
| `duplicate-admin` | Systems fragmentation | Recruiters, admins, or operators are not regularly duplicating updates across multiple tools. |
| `handoff-control` | Handoffs and onboarding | Onboarding, delivery, compliance, and client update handoffs are documented enough that delays are visible early. |
| `scaling-control` | Scaling readiness | The current operating structure could handle materially more accounts, starts, clients, or team members without adding chaos. |

## Dimensions

| ID | Label | Recommendation |
| --- | --- | --- |
| `reporting` | Reporting reliability | Define source-of-truth metrics, reporting ownership, and the cadence leaders use to make decisions. |
| `ownership` | Workflow ownership | Clarify who owns each stage, what triggers escalation, and what must be true before work moves forward. |
| `systems` | Systems fragmentation | Map where ATS, VMS, CRM, spreadsheets, and internal tools disagree or duplicate work. |
| `handoffs` | Handoffs and onboarding | Document onboarding, delivery, and handoff checkpoints so work does not depend on individual memory. |
| `scale` | Scaling readiness | Prioritize the process and reporting constraints most likely to break as volume, headcount, or account load increases. |

## Scoring Logic

The production website requires all 8 answers before generating a result.

Overall score:

```text
Math.round(totalAnswerValue / (8 * 5) * 100)
```

Dimension score:

```text
Math.round(dimensionAnswerTotal / (dimensionQuestionCount * 5) * 100)
```

The two lowest dimension scores become `weakAreas`.

## Result Categories

| Score | Grade | Label | Tone |
| ---: | --- | --- | --- |
| `86-100` | A | Operationally healthy | Strong |
| `72-85` | B | Controlled with constraint risk | Watch |
| `58-71` | C | Operational drag is likely present | Review |
| `0-57` | D | Scaling risk | Urgent |

## Netlify Form Structure

The static hidden form in `index.html` defines:

- `name`
- `company`
- `email`
- `businessType`
- `teamSize`
- `currentTools`
- `score`
- `grade`
- `gradeLabel`
- `topWeaknesses`
- `answerSummary`

The React form submits with:

- `name="assessment"`
- `method="POST"`
- `action="/assessment-thank-you"`
- `data-netlify="true"`
- hidden `form-name=assessment`

The client posts URL-encoded form data to `/` and redirects to `/assessment-thank-you` after success.

## Expected Netlify Webhook Payload

Netlify webhook payloads are normalized from either a stringified `payload` field or an object payload:

```json
{
  "payload": {
    "id": "sample-assessment-2026-05-23-001",
    "form_name": "assessment",
    "created_at": "2026-05-23T18:30:00.000Z",
    "data": {
      "form-name": "assessment",
      "name": "Jordan Smith",
      "email": "jordan@example.com",
      "company": "Acme Workforce Ops",
      "businessType": "Staffing / recruiting / workforce vendor",
      "teamSize": "26-75",
      "currentTools": "Bullhorn, Salesforce, VMS, spreadsheets",
      "score": "55",
      "grade": "D",
      "gradeLabel": "Scaling risk",
      "topWeaknesses": "Reporting reliability (50), Systems fragmentation (50)",
      "answerSummary": "reporting-trust: 2; metric-ownership: 3; stage-ownership: 3; accountability-rhythm: 3; system-agreement: 2; duplicate-admin: 3; handoff-control: 3; scaling-control: 3"
    }
  }
}
```

## Frontend Workflow Notes

- Scores are calculated frontend-side.
- The hidden submitted fields include the score, grade, grade label, top weaknesses, profile context, and answer summary.
- The production website does not submit individual question fields today.
- The outreach engine reconstructs individual answer values from `answerSummary`.
- The engine recalculates score and grade to mirror the website exactly instead of trusting only the hidden score.

## Safety TODOs

- Add webhook signature validation.
- Add idempotency keys using Netlify submission ID.
- Add duplicate submission protection before live CRM writes.
- Add audit logging for every planned and executed CRM action.
- Add retry strategy for transient CRM failures.
- Add rate limiting on public webhook routes.
- Add AI approval queues before any AI-generated outreach can be executed.
