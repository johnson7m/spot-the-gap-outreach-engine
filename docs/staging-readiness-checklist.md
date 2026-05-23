# Staging Readiness Checklist

Use this checklist before the first controlled live CRM sync test. Keep the production website unchanged until this engine is ready to receive real webhooks.

## Required Setup

- [ ] Supabase project created for staging or controlled internal testing.
- [ ] `docs/database-schema.sql` applied successfully in Supabase.
- [ ] Required Supabase tables exist:
  - [ ] `assessment_submissions`
  - [ ] `outbound_events`
  - [ ] `crm_sync_logs`
  - [ ] `workflow_jobs`
- [ ] Environment variables configured:
  - [ ] `NODE_ENV`
  - [ ] `SUPABASE_ENABLED=true`
  - [ ] `SUPABASE_URL`
  - [ ] `SUPABASE_SERVICE_ROLE_KEY`
  - [ ] `TWENTY_BASE_URL`
  - [ ] `TWENTY_API_KEY`
  - [ ] `WORKFLOW_MAX_ATTEMPTS`
- [ ] `TWENTY_SYNC_ENABLED=false` remains set until the final live test step.
- [ ] `WEBHOOK_SECRET` is documented as a pre-production TODO before live Netlify integration.

## Twenty Readiness

- [ ] Twenty metadata discovery succeeds.
- [ ] Twenty schema validation passes.
- [ ] `leadstageAuto` contains `DISQUALIFIED_NURTURE`.
- [ ] `leadstageAuto` no longer contains typo value `DISQUALIFIED_NUTURE`.
- [ ] Relationship metadata has been reviewed:
  - [ ] `person.company`
  - [ ] `task.taskTargets`
  - [ ] `opportunity.company`
  - [ ] `opportunity.pointOfContact`
- [ ] Relationship writes remain disabled until the payload shape is verified in staging.

## Test Payload

Prepared payload:

- File: `data/sample-netlify-assessment-submission.json`
- Script-applied test contact: `Visible Gap Sync Test`
- Script-applied test email: `visiblegap.sync-test@example.com`
- Script-applied test company: `Visible Gap Sync Test Company`
- Stable test submission ID: `staging-live-sync-test-001`

Expected CRM operations before execution:

- Company upsert for `Visible Gap Sync Test Company`
- Person upsert for `visiblegap.sync-test@example.com`
- Task create-or-skip for assessment review
- Opportunity create/update because the sample assessment grade is `D`

## Validation Commands

Dry-run script:

```bash
npm run test:sync:dry
```

Staging readiness:

```bash
npm run check:staging
```

Final controlled live test:

```bash
SUPABASE_ENABLED=true TWENTY_SYNC_ENABLED=true LIVE_TEST=true npm run test:sync:live
```

The live script fails closed unless both `LIVE_TEST=true` and `TWENTY_SYNC_ENABLED=true` are set, and it also requires durable Supabase persistence for idempotency.

## Manual Cleanup Plan

If the live test creates records that need cleanup, manually review Twenty for:

- Person: `visiblegap.sync-test@example.com`
- Company: `Visible Gap Sync Test Company`
- Task: `Review Spot the Gap assessment: Visible Gap Sync Test Company`
- Opportunity: `Visible Gap Sync Test Company - Spot the Gap diagnostic`

Do not delete audit rows from Supabase unless you are resetting the staging environment. They are the operational trace.
