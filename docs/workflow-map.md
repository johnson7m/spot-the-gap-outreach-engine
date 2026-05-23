# Workflow Map

## Initial Assessment Intake

1. Visitor completes the Spot the Gap assessment on the production website.
2. Netlify receives the form submission.
3. Netlify triggers a webhook to this engine.
4. The engine validates the shared webhook secret when configured.
5. The Netlify payload is parsed and normalized.
6. Assessment answers are scored.
7. A stable idempotency key and payload hash are generated.
8. The submission is persisted in `assessment_submissions`.
9. A workflow job is created or reused in `workflow_jobs`.
10. CRM operations are planned or executed depending on `TWENTY_SYNC_ENABLED`.
11. Every CRM operation writes a `crm_sync_logs` audit row.
12. The submission and workflow job receive final status updates.
13. The response returns correlation ID, score, sync state, and workflow summary.

## CRM Sync Workflow

1. Identify Person by email.
2. Identify Company by website domain, then company name fallback.
3. Upsert Person and Company records.
4. Link Person to Company.
5. Add assessment metadata, score band, and source details.
6. Create a Task for follow-up when the submission is qualified.
7. Create an Opportunity when score, fit, or urgency thresholds are met.
8. Record the submission ID to support idempotency.

## Future Outreach Workflow

1. Enrich company and role context.
2. Generate an assessment insight summary.
3. Draft personalized first-touch copy.
4. Route draft for human review.
5. Sync approved outreach notes back to CRM.
6. Schedule follow-up tasks or sequences.

## Operational Controls

- CRM writes should be disabled by default in local development.
- Webhook payloads should be validated before processing.
- External calls should be isolated in integration modules.
- Scoring should remain testable as a pure utility.
- Webhook replays are protected by idempotency keys before CRM sync.
- Live CRM writes must be blocked when schema validation fails.
- Outbound events must default to `requires_approval=true`.
