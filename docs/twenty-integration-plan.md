# Twenty Integration Plan

## Current State

The engine has a controlled Twenty provider behind a CRM adapter boundary:

```text
assessmentWorkflow
  -> crmAdapter
      -> twentyProvider
```

No workflow should call Twenty directly. All Twenty-specific behavior lives under `src/integrations/twenty/`.

Dry-run remains the default. Live writes require `TWENTY_SYNC_ENABLED=true`, a configured API key, and passing schema validation.

## Auth Flow

Configuration:

- `TWENTY_API_BASE_URL`
- `TWENTY_API_KEY`
- `TWENTY_WORKSPACE_ID`
- `TWENTY_SYNC_ENABLED`

Twenty cloud API access uses Bearer authentication:

```text
Authorization: Bearer <TWENTY_API_KEY>
```

Development may use an admin-level key. Future production design should use scoped keys separated by service role.

## Metadata Discovery Flow

`src/integrations/twenty/metadataClient.js` fetches:

```text
GET /rest/metadata/objects
```

The discovery layer normalizes object metadata into:

- `objectsBySingularName`
- `objectsByPluralName`
- `fieldsByName`
- active relationship fields
- duplicate criteria

Initial required objects:

- `person`
- `company`
- `task`
- `opportunity`

## Schema Validation Strategy

`src/integrations/twenty/schemaValidator.js` validates:

- required objects exist
- required fields exist
- field types match expectations
- select/rating values exist
- unexpected select values are surfaced as warnings

Historical validation failed until the `leadstageAuto` value mismatch was resolved:

```text
Expected: DISQUALIFIED_NURTURE
Discovered: DISQUALIFIED_NUTURE
```

The corrected `DISQUALIFIED_NURTURE` value was confirmed in the 2026-05-27 metadata inspection. The validator intentionally produces human-readable errors so future schema issues can be fixed before live execution.

## Dry-Run Execution Model

`TWENTY_SYNC_ENABLED=false` keeps all CRM execution in dry-run mode.

Dry-run returns:

- provider name
- schema validation result
- planned object operations
- dedupe keys
- payloads that would be sent
- reason no records were written

This lets us test full workflow behavior without mutating CRM data.

## Controlled Live Execution Model

Live execution is deterministic and provider-contained:

1. Payload builders create typed object payloads.
2. Schema validation runs before writes.
3. Company upsert executes first.
4. Person upsert executes second.
5. Task create-or-skip executes third.
6. Opportunity create/update/skip executes last.
7. Each object operation returns a structured result.
8. The assessment workflow writes audit logs for all operations.

Partial failures do not disappear. They are returned as structured operation failures and persisted with retry metadata.

Retry behavior:

- Operations already logged as `succeeded` for the same assessment submission are skipped on retry.
- Failed operations are attempted again after the payload or configuration issue is fixed.
- This prevents duplicate Company, Person, or Task records during controlled retry testing.

Quick Capture uses the same operational principle, but recovery is driven by
Quick Capture audit logs instead of assessment submission IDs:

- retryable Twenty errors are `429`, `502`, `503`, and `504`
- `retry_after` is respected when Twenty or Cloudflare provides it
- otherwise bounded exponential backoff starts at `QUICK_CAPTURE_RETRY_BASE_MS`
- `QUICK_CAPTURE_MAX_RETRIES` limits retry attempts after the original write
- recovery retries only the failed object operation from `crm_sync_logs`
- Person and Task operations are not replayed when Company recovery is needed

Manual recovery command:

```bash
QUICK_CAPTURE_SYNC_ENABLED=true TWENTY_SYNC_ENABLED=true LIVE_TEST=true npm run quick-capture:retry-failed
```

Confirmed Opportunity live payload:

```json
{
  "name": "Company Name - Spot the Gap diagnostic",
  "stage": "TARGET_IDENTIFIED",
  "dealValue": null,
  "hiring": false
}
```

The Opportunity object does not currently include `source`, `assessmentScore`, `assessmentGrade`, or `assessmentLabel`; those fields must not be sent unless they are created and validated in metadata first.

## Staging Execution Process

1. Apply `docs/database-schema.sql` in Supabase.
2. Configure staging environment variables from `.env.example`.
3. Keep `TWENTY_SYNC_ENABLED=false`.
4. Run `npm run check:staging`.
5. Fix any schema blockers surfaced by metadata validation.
6. Run `npm run test:sync:dry` and review the printed execution plan.
7. Confirm expected test records:
   - Person: `visiblegap.sync-test@example.com`
   - Company: `Visible Gap Sync Test Company`
   - Task: assessment review task
   - Opportunity: Spot the Gap diagnostic opportunity
8. Run the final controlled live test only with `LIVE_TEST=true` and `TWENTY_SYNC_ENABLED=true`.

## Live Sync Guardrails

- The sync test script defaults to dry-run.
- Live mode requires `LIVE_TEST=true`.
- Live mode also requires `TWENTY_SYNC_ENABLED=true`.
- Live mode requires Supabase persistence so idempotency survives process restarts.
- Live writes are blocked if Twenty schema validation fails.
- Relationship writes are not forced until payload shape is confirmed.
- All CRM operation results are logged in `crm_sync_logs`.
- Duplicate test payloads reuse the same idempotency key and should not create repeated CRM writes.

## Relationship Mapping Risks

Current metadata-confirmed relationship fields:

- `person.company`
- `task.taskTargets`
- `opportunity.company`
- `opportunity.pointOfContact`

The metadata confirms the fields exist, but the exact REST payload shape for setting these relations still needs staging confirmation. Until then, relationship mapping is logged as unresolved and relationship writes remain disabled.

Potential risks:

- Twenty may expect relation IDs through join-column field names rather than nested objects.
- Task targets may require a polymorphic relation payload.
- Opportunity contact/company links may need existing record IDs from prior operations.
- Partial relationship writes could create confusing CRM links if attempted without confirmation.

## Rollback And Manual Cleanup

The first live test should use only the marked test record:

- Person email: `visiblegap.sync-test@example.com`
- Company: `Visible Gap Sync Test Company`

If cleanup is needed, manually remove the test Person, Company, Task, and Opportunity from Twenty after reviewing `crm_sync_logs`. Keep Supabase audit logs unless the entire staging environment is being reset.

## Future Live Sync Strategy

Before setting `TWENTY_SYNC_ENABLED=true`, implement:

- deployment-grade webhook signature validation
- relationship resolution for Person-to-Company links
- richer Task and Opportunity dedupe once Twenty custom external IDs exist
- rate limiting
- dead-letter handling for failed syncs
- alerting for repeated partial failures

Live writes should be blocked if schema validation fails.

## Future Permission Separation Strategy

Development can use an admin-level key for metadata discovery and testing. Production should split permissions by role:

- Metadata reader: schema discovery and validation only.
- CRM writer: constrained People, Company, Task, and Opportunity operations.
- AI recommender: no write permissions.
- Audit reader/writer: append-only operational logs.
- Admin operator: manual recovery and configuration changes.

This keeps AI reasoning separate from system execution.

For production, replace the admin-level development key with scoped API keys for metadata reads and narrowly bounded CRM writes.

## Future CRM Adapter Architecture

The CRM adapter should remain provider-agnostic:

```text
workflows
  -> crmAdapter
      -> twentyProvider
      -> hubspotProvider
      -> salesforceProvider
      -> zohoProvider
      -> pipedriveProvider
      -> clientSpecificProvider
```

Provider contracts should expose stable operations:

- `syncAssessmentSubmission()`
- `validateSchema()`
- `previewOperations()`
- `executeOperations()`

Provider implementations can translate those operations into each CRM's native object model.

## AI Execution Boundary

Future AI agents should recommend actions, not execute them directly:

```text
AI Agent
  -> recommends action

Execution Layer
  -> validates schema
  -> validates permissions
  -> checks idempotency
  -> logs action
  -> executes safely
```

No autonomous outreach generation should be enabled until prompt output, review status, approval routing, and execution logging are implemented.
