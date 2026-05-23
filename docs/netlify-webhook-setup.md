# Netlify Webhook Setup

This document describes the secure Netlify-to-engine webhook flow for Spot the Gap assessment submissions.

## Endpoint

```text
POST /webhooks/netlify/spot-the-gap
```

The endpoint accepts Netlify form webhook payloads for the production assessment form named `assessment`.

## Required Environment Variables

```bash
NODE_ENV=production
WEBHOOK_SECRET=<shared-secret>
WEBHOOK_RATE_LIMIT_WINDOW_MS=60000
WEBHOOK_RATE_LIMIT_MAX=30

SUPABASE_ENABLED=true
SUPABASE_URL=<supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<server-side-service-role-key>

TWENTY_BASE_URL=https://api.twenty.com
TWENTY_API_KEY=<twenty-api-key>
TWENTY_SYNC_ENABLED=false
WORKFLOW_MAX_ATTEMPTS=3
```

`WEBHOOK_SHARED_SECRET` is also supported for compatibility, but prefer `WEBHOOK_SECRET`.

## Secret Validation

Accepted secret headers:

- `x-visible-gap-secret`
- `x-webhook-secret`
- `x-netlify-secret`

Behavior:

- `NODE_ENV=development` may bypass secret validation only when no secret is configured.
- `NODE_ENV=production` rejects requests if the secret is missing, unconfigured, or invalid.
- Rejected attempts are logged with correlation ID and header presence only. Secret values are never logged.

## Netlify Configuration

In Netlify:

1. Open the production site.
2. Go to Forms.
3. Select the `assessment` form.
4. Add an outgoing webhook notification.
5. Set the webhook URL to the deployed engine endpoint:

```text
https://<engine-domain>/webhooks/netlify/spot-the-gap
```

6. Add the shared secret header if Netlify webhook configuration supports custom headers:

```text
x-visible-gap-secret: <WEBHOOK_SECRET>
```

If custom headers are not available in the Netlify UI path being used, put the webhook behind a small Netlify Function/proxy that adds the header before forwarding to the engine.

## Expected Payload

The engine accepts both object and URL-encoded string payload forms.

Expected shape:

```json
{
  "payload": {
    "id": "netlify-submission-id",
    "form_name": "assessment",
    "created_at": "2026-05-23T18:30:00.000Z",
    "data": {
      "form-name": "assessment",
      "name": "Jane Smith",
      "email": "jane@example.com",
      "company": "Example Company",
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

Required validation:

- `form_name` or `form-name` must be `assessment`.
- `name` and `email` must be present.
- `score`, `grade`, `gradeLabel`, and `answerSummary` must be present.
- All 8 assessment answers must be present and valid.
- Submitted score and grade must match the recalculated engine result.

## Replay Protection

The engine uses:

- Netlify submission ID when present.
- Stable payload hash when Netlify submission ID is unavailable.

Duplicate completed submissions return `duplicate_replay` and do not create duplicate CRM records. Failed or partial-failure submissions may retry up to `WORKFLOW_MAX_ATTEMPTS`.

## Rate Limiting

The webhook route uses an in-memory fixed-window limiter:

- `WEBHOOK_RATE_LIMIT_WINDOW_MS`
- `WEBHOOK_RATE_LIMIT_MAX`

This protects the engine process from simple bursts. For production deployment, also configure platform-level rate limiting or WAF controls because in-memory limits reset on deploy and are per process.

## Local Testing

Dry-run sync test:

```bash
npm run test:sync:dry
```

Manual webhook-style request in development:

```bash
curl -X POST http://localhost:3000/webhooks/netlify/spot-the-gap \
  -H "content-type: application/json" \
  -H "x-visible-gap-secret: $WEBHOOK_SECRET" \
  --data @data/sample-netlify-assessment-submission.json
```

## Staging Test

1. Keep `TWENTY_SYNC_ENABLED=false`.
2. Configure `WEBHOOK_SECRET`.
3. Run:

```bash
npm run check:staging
npm run test:sync:dry
```

4. Send one staging webhook payload.
5. Confirm Supabase records:
   - `assessment_submissions`
   - `workflow_jobs`
   - `crm_sync_logs`
6. Enable controlled live sync only after the dry path is verified.

## Troubleshooting

`401 Missing webhook secret`

- Netlify did not send an accepted secret header.
- Confirm `x-visible-gap-secret`, `x-webhook-secret`, or `x-netlify-secret`.

`401 Invalid webhook secret`

- Header exists but does not match `WEBHOOK_SECRET`.
- Rotate the secret if there is any doubt.

`400 Invalid assessment submission`

- Required form fields are missing.
- `answerSummary` does not include all 8 question IDs.
- Submitted score/grade does not match recalculated score/grade.

`429 Too many webhook requests`

- The fixed-window webhook rate limiter rejected the request.
- Wait for the `Retry-After` header interval.

Duplicate replay

- The submission already processed successfully.
- This is expected for Netlify retries after a successful sync.
