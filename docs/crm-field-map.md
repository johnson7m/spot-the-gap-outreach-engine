# CRM Field Map

This map reflects the current Twenty metadata discovery pass and the assessment schema found in the production website. Live writes remain disabled until idempotency, audit logging, and permission boundaries are implemented.

## Twenty Metadata Discovery Result

Read-only metadata discovery confirmed these core objects:

- `person` / `people`
- `company` / `companies`
- `task` / `tasks`
- `opportunity` / `opportunities`

Important schema inconsistency:

- Requested People select value: `DISQUALIFIED_NURTURE`
- Discovered People select value: `DISQUALIFIED_NUTURE`

The schema validator treats this as an error because the field value is likely a typo and would break code expecting the intended spelling.

## People

| Engine Field | Twenty Field API Name | Type | Required for Sync | Notes |
| --- | --- | --- | --- | --- |
| `person.firstName` / `person.lastName` | `name` | `FULL_NAME` | Yes | Standard full-name field. |
| `person.email` | `emails` | `EMAILS` | Yes | Primary dedupe key. |
| `person.linkedinUrl` | `linkedinLink` | `LINKS` | No | Future enrichment/outreach field. |
| `person.role` | `jobTitle` | `TEXT` | No | Standard job title. |
| `assessment.completed` | `assessmentCompleted` | `BOOLEAN` | Yes | Custom field. Set to `true` after successful assessment intake. |
| `score.score` | `assessmentScore` | `NUMBER` | Yes | Custom field. Stores 0-100 website-compatible score. |
| `submittedAt` | `lastTouchDate` | `DATE` | Yes | Custom field. Date-only value. |
| workflow state | `leadstageAuto` | `SELECT` | Yes | Custom field. Assessment sync uses `ASSESSMENT_COMPLETED`. |
| first-message strategy | `messageAngle` | `TEXT` | Yes | Custom field. Generated deterministically for now; future AI drafts require review. |
| follow-up date | `nextFollowUpDate` | `DATE` | Yes | Custom field. Based on assessment priority. |
| company link | `company` | `RELATION` | Future | Requires Company ID after upsert. |

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

Discovered values currently include `DISQUALIFIED_NUTURE` instead of `DISQUALIFIED_NURTURE`.

## Companies

| Engine Field | Twenty Field API Name | Type | Required for Sync | Notes |
| --- | --- | --- | --- | --- |
| `company.name` | `name` | `TEXT` | Yes | Fallback dedupe key when no domain exists. |
| `company.domain` / `company.website` | `domainName` | `LINKS` | Preferred | Current website assessment does not submit a company URL. |
| `score.score` | `operationalMaturityScore` | `RATING` | No | Custom rating field with `RATING_1` through `RATING_5`. |
| person/company link | `people` | `RELATION` | Future | Requires Person ID after upsert. |

Company duplicate criteria discovered:

- `name`
- `domainNamePrimaryLinkUrl`

## Tasks

| Engine Field | Twenty Field API Name | Type | Required for Sync | Notes |
| --- | --- | --- | --- | --- |
| task title | `title` | `TEXT` | Yes | Example: `Review Spot the Gap assessment: Acme Workforce Ops`. |
| task body | `bodyV2` | `RICH_TEXT` | Yes | Includes score, grade, weaknesses, tools, and next action. |
| task due date | `dueAt` | `DATE_TIME` | Yes | Based on priority. |
| task status | `status` | `SELECT` | Yes | Uses `TODO` initially. |
| CRM links | `taskTargets` | `RELATION` | Future | Requires resolved Person/Company IDs. |

Task status values discovered:

- `TODO`
- `IN_PROGRESS`
- `DONE`

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

Dry-run sync currently:

1. Normalizes the Netlify payload.
2. Recalculates assessment score from `answerSummary`.
3. Builds CRM-ready Person, Company, Task, and Opportunity payloads.
4. Discovers and validates Twenty schema when an API key is configured.
5. Returns planned operations without writing records.

Live sync still needs:

- Idempotency storage.
- Duplicate lookup before upsert.
- Relationship resolution after Person/Company writes.
- Audit logging.
- Retry policy.
- Rate limits.
- Scoped API keys and service permissions.
