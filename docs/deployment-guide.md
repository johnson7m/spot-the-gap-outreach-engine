# Deployment Guide

This guide prepares the Spot the Gap Outreach Engine for a staging deployment that receives Netlify assessment webhooks. Do not point production Netlify traffic at the engine until the staging webhook test passes.

## Recommendation

Use Render for the first staging deployment.

Why Render:

- Simple Web Service setup for an Express app.
- Direct Git-based deploys.
- Built-in environment variable management.
- Built-in health check path support.
- No Dockerfile required for the current app.

Railway is also straightforward and is a good option if you already manage projects there. Fly.io is powerful, but it adds more deployment primitives than this webhook service needs for the first staging path.

## Required Production/Staging Environment

Set these variables on the hosting provider:

```bash
NODE_ENV=production
PORT=<provider-managed-or-3000>

SUPABASE_ENABLED=true
SUPABASE_URL=<supabase-project-url>
SUPABASE_SERVICE_ROLE_KEY=<server-side-service-role-key>

TWENTY_SYNC_ENABLED=false
TWENTY_BASE_URL=https://api.twenty.com
TWENTY_API_KEY=<twenty-api-key>

WEBHOOK_SECRET=<long-random-shared-secret>
WEBHOOK_RATE_LIMIT_WINDOW_MS=60000
WEBHOOK_RATE_LIMIT_MAX=30

WORKFLOW_MAX_ATTEMPTS=3
CRM_PROVIDER=twenty
LOG_LEVEL=info
CORS_ORIGIN=*
```

Keep `TWENTY_SYNC_ENABLED=false` for the first deployed webhook test. That test should validate receipt, secret validation, Supabase persistence, and dry-run CRM planning only.

## Render

1. Push the `spot-the-gap-outreach-engine` repo to GitHub.
2. Create a new Render Web Service.
3. Connect the repo.
4. Configure:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
5. Add the environment variables listed above.
6. Deploy.
7. Validate:

```bash
curl https://<render-service>.onrender.com/health
```

Expected:

```json
{
  "status": "ok",
  "service": "spot-the-gap-outreach-engine",
  "environment": "production"
}
```

## Railway

1. Create a Railway project.
2. Add a service from the GitHub repo.
3. Configure variables in the service Variables tab.
4. Railway should detect the Node app from `package.json`.
5. Ensure the service runs `npm start`.
6. Generate or attach a public domain.
7. Validate `/health`.

Railway works well if you want quick environment cloning later, for example staging and production with separate variables.

## Fly.io

Fly.io is best if you want more control over regions, machine sizing, or container deployment.

Basic path:

1. Install and authenticate `flyctl`.
2. Run `fly launch` from the project directory.
3. Configure secrets:

```bash
fly secrets set NODE_ENV=production
fly secrets set SUPABASE_ENABLED=true
fly secrets set SUPABASE_URL=<supabase-project-url>
fly secrets set SUPABASE_SERVICE_ROLE_KEY=<server-side-service-role-key>
fly secrets set TWENTY_SYNC_ENABLED=false
fly secrets set TWENTY_BASE_URL=https://api.twenty.com
fly secrets set TWENTY_API_KEY=<twenty-api-key>
fly secrets set WEBHOOK_SECRET=<long-random-shared-secret>
```

4. Deploy with `fly deploy`.
5. Validate `/health`.

## Deployed Health Check

After deployment:

```bash
curl https://<engine-domain>/health
```

The service must return HTTP 200 before configuring a Netlify webhook.

## Staging Webhook Smoke Test

Run from the local project after deployment:

```bash
WEBHOOK_URL=https://<engine-domain>/webhooks/netlify/spot-the-gap \
WEBHOOK_SECRET=<same-secret-configured-on-engine> \
npm run test:webhook:staging
```

The script:

- Calls `GET /health`.
- Sends a realistic Netlify-style assessment payload.
- Adds `x-visible-gap-secret`.
- Prints response status, response body, and correlation ID.
- Uses a fake test record:
  - `visiblegap.webhook-test@example.com`
  - `Visible Gap Webhook Test Company`

For the first deployed test, keep the deployed service at:

```bash
TWENTY_SYNC_ENABLED=false
```

Expected outcome:

- Endpoint receives request.
- Secret validation passes.
- Supabase persistence writes `assessment_submissions`, `workflow_jobs`, and `crm_sync_logs`.
- CRM sync result is `dry_run`.

## Netlify Connection Options

### Option 1: Direct Outgoing Webhook

Use this if Netlify lets you configure a custom request header for the form webhook.

Configure the webhook URL:

```text
https://<engine-domain>/webhooks/netlify/spot-the-gap
```

Configure header:

```text
x-visible-gap-secret: <WEBHOOK_SECRET>
```

### Option 2: Netlify Function Proxy

Use this if the direct Netlify outgoing webhook path cannot attach custom headers.

This is the recommended path for the current Visible Gap website because it keeps
the public assessment UX unchanged while allowing the engine webhook secret to be
added server-side.

Use either the direct outgoing webhook or this proxy function, not both for the
same form. Running both paths can forward one Netlify submission twice.

Flow:

```text
Netlify Form
  -> Netlify Function
      -> adds x-visible-gap-secret
      -> POSTs to outreach engine
```

The proxy function should:

- Read the secret from Netlify environment variables.
- Forward the original payload.
- Add `x-visible-gap-secret`.
- Log only status/correlation ID, never the secret.

Current website function:

```text
consulting-landing-page/netlify/functions/submission-created.mjs
```

Website-side Netlify environment variables:

```bash
SPOT_GAP_ENGINE_WEBHOOK_URL=https://<engine-domain>/webhooks/netlify/spot-the-gap
SPOT_GAP_ENGINE_WEBHOOK_SECRET=<same-secret-as-engine-WEBHOOK_SECRET>
```

The function is backend-only and filters to the `assessment` form before
forwarding. Do not enable broad production traffic until one dry-run website
submission has been verified in Supabase.

## Enabling Live CRM Sync After Dry-Run

After the deployed dry-run webhook succeeds:

1. Confirm Supabase audit records.
2. Confirm no schema validation errors.
3. Confirm test payload is fake.
4. Change only this deployed environment variable:

```bash
TWENTY_SYNC_ENABLED=true
```

5. Redeploy or restart the service if the hosting provider requires it.
6. Send exactly one controlled test webhook.
7. Validate Twenty records and Supabase audit logs.

## Rollback

If anything fails:

1. Set `TWENTY_SYNC_ENABLED=false`.
2. Restart the service.
3. Preserve Supabase audit records.
4. Inspect `crm_sync_logs` for the exact failed operation and payload.
5. Do not retry live sync repeatedly without changing the failing cause.
