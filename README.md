# Spot the Gap Outreach Engine

Internal Visible Gap platform for turning Spot the Gap assessment submissions into operationally useful CRM records, follow-up tasks, opportunity context, and future AI-assisted outreach workflows.

This project is intentionally separate from the production website. The website owns the public assessment experience. This engine owns ingestion, normalization, CRM synchronization, lead intelligence, and future outbound automation.

## Current Scope

- Receive Spot the Gap assessment submissions from the existing website or Netlify form flow.
- Normalize form payloads into a stable internal assessment shape.
- Calculate an initial operational maturity score.
- Persist assessment submissions, workflow jobs, and CRM sync logs through Supabase/Postgres.
- Prepare or execute People, Companies, Tasks, and Opportunities through the CRM adapter.
- Provide duplicate prevention strategy around email, company domain, and assessment submission IDs.
- Create a clean foundation for enrichment, LinkedIn outreach, AI-generated personalization, and agent workflows.

## Architecture Direction

The system is organized around clear boundaries:

- `src/server.js`: Express app, health route, webhook route, and error handling.
- `src/routes/api/`: internal workspace API routes such as Quick Capture
  preview/commit.
- `src/middleware/`: API middleware such as Netlify rate limits, temporary
  workspace shared-secret validation, and Supabase workspace JWT/profile auth.
- `src/config/`: environment loading, validation, and logging.
- `src/integrations/netlifyWebhook.js`: Netlify assessment webhook normalization.
- `src/integrations/crm/`: provider-neutral CRM adapter boundary.
- `src/integrations/twenty/`: Twenty metadata discovery, schema validation, payload builders, and dry-run object clients.
- `src/integrations/supabase/`: Supabase client setup for operational persistence.
- `src/persistence/`: durable operational store abstraction plus in-memory test store.
- `src/integrations/openAiClient.js`: placeholder for future reviewed AI workflows.
- `src/workflows/`: business workflows that coordinate normalization, scoring, and sync.
- `src/utils/`: pure utilities such as scoring and data shaping.
- `src/agents/`: future AI-agent definitions and orchestration notes.
- `docs/`: operating model, CRM mapping, workflow map, and prompt library.
- `data/`: local development fixtures and exports. Runtime data should not be committed.

## Setup

```bash
cd spot-the-gap-outreach-engine
npm install
cp .env.example .env
npm run dev
```

Run the database schema in Supabase before enabling durable persistence:

```text
docs/database-schema.sql
```

Health check:

```bash
curl http://localhost:3000/health
```

Quick Capture dry run:

```bash
npm run quick-capture:dry
```

The dry run never writes to Twenty. To also persist the planned
`outbound_events` row in a configured Supabase environment, run with
`QUICK_CAPTURE_PERSIST_EVENTS=true`.

Quick Capture metadata inspection:

```bash
npm run quick-capture:inspect-metadata
```

This confirms Company `segment`/`industry`, Person `owner`, Company
`accountOwner`, Task `assignee`, and Twenty `workspaceMember` email matching
before owner/assignee relation-id fields are used.

Controlled Quick Capture live test:

```bash
QUICK_CAPTURE_SYNC_ENABLED=true TWENTY_SYNC_ENABLED=true LIVE_TEST=true npm run quick-capture:live
```

The live script validates that the sample lead is obviously fake/test data,
prints planned payloads before execution, writes through the CRM adapter, and
leaves protected assessment fields untouched.

Workspace Quick Capture API:

```text
POST /api/quick-capture/preview
POST /api/quick-capture/commit
POST /api/tasks/:id/complete
GET /api/queues/fresh-leads
GET /api/queues/follow-ups
GET /api/queues/warm-assessments
GET /api/queues/stale-recovery
GET /api/queues/pipeline-review
```

Preview is dry-run only and is intended for the internal
`visible-gap-workspace` review screen. Commit is disabled by default and
requires explicit write guards:

```bash
QUICK_CAPTURE_API_COMMIT_ENABLED=true
TWENTY_SYNC_ENABLED=true
SUPABASE_JWT_VERIFICATION_ENABLED=true
```

Workspace API auth uses `Authorization: Bearer <supabase-access-token>`. The
engine verifies the token through Supabase, loads `workspace_profiles`, rejects
inactive profiles, and allows `admin`, `operator`, and `rep` roles for Quick
Capture preview/commit. The legacy
`x-visible-gap-workspace-secret: <WORKSPACE_API_SECRET>` path remains only as a
server-configured staging fallback; the browser workspace should not send it.
Set `WORKSPACE_ALLOWED_ORIGIN` to the deployed workspace origin when browser
CORS needs to allow the internal app.

Quick Capture accepts optional notes when another context path exists
(`linkedinUrl`, `email`, or valid phone). Phone writes are US `+1` shaped and
unsafe phone values are omitted with warnings. Company Segment/Industry and
owner/assignee fields are written only when Twenty metadata and workspace-member
matching confirm the exact field shape.

Task completion endpoint:

```text
POST /api/tasks/:id/complete
```

This records a manual outbound touch, updates Person cadence/outbound touch
fields, creates or skips one next Task according to the cadence rules, writes
`outbound_events`, and audits CRM operations in `crm_sync_logs` when Supabase
persistence is enabled. It requires Supabase workspace JWT auth and role
`admin`, `operator`, or `rep`. It does not automate LinkedIn actions and does
not require relationship writes; next Task bodies include Person ID and cadence
context until `taskTargets` linking is enabled.

Workspace queue endpoints:

```text
GET /api/queues/fresh-leads
GET /api/queues/follow-ups
GET /api/queues/warm-assessments
GET /api/queues/stale-recovery
GET /api/queues/pipeline-review
```

These endpoints are read-only. They require Supabase workspace JWT auth and role
`admin`, `operator`, or `rep`; reps default to `ownerScope=mine`, while admins
and operators can request `ownerScope=all`. Queue fetches read Twenty People and
Tasks, return a normalized workspace item shape, and include warnings when task
relationships must be inferred from task body `Person ID` markers or when
owner/assignee data is unavailable.

Workspace auth flags:

```bash
SUPABASE_JWT_VERIFICATION_ENABLED=false
SUPABASE_AUTH_REQUIRED_FOR_WORKSPACE_API=false
```

Turn both on after the Supabase `workspace_profiles` table is applied and
profile rows exist for workspace users. `SUPABASE_SERVICE_ROLE_KEY` must stay
server-side in this engine and must never be exposed to the frontend.

Webhook endpoint:

```text
POST /webhooks/netlify/spot-the-gap
```

Twenty CRM sync is disabled by default through `TWENTY_SYNC_ENABLED=false`. Supabase persistence is disabled by default through `SUPABASE_ENABLED=false`, in which case local development uses an in-memory operational store.

Live CRM sync should only be enabled after:

- Supabase schema is installed.
- `SUPABASE_ENABLED=true`.
- `TWENTY_API_KEY` is configured.
- Twenty schema validation passes.
- Webhook signature validation and deployment-level rate limiting are in place.

Current CRM flow:

```text
assessmentWorkflow
  -> crmAdapter
      -> twentyProvider
```

Future internal workspace:

```text
visible-gap-workspace
  -> outreach engine API
      -> Supabase operational store
      -> CRM adapter
      -> Twenty provider
```

The future `visible-gap-workspace` repo should be a separately deployed internal
React/Vite app for Quick Capture, rep queues, reporting, and operator recovery.
It should call this engine through authenticated API endpoints and should never
write directly to Twenty or Supabase from the browser.

Useful docs:

- `docs/assessment-schema.md`
- `docs/crm-field-map.md`
- `docs/twenty-integration-plan.md`
- `docs/outbound-operations-architecture.md`
- `docs/quick-capture-blueprint.md`
- `docs/internal-workspace-architecture.md`
- `docs/workspace-api-contract.md`
- `docs/quick-capture-ui-spec.md`
- `docs/rep-queue-ui-spec.md`
- `docs/operator-recovery-ui-spec.md`
- `docs/outbound-state-machine.md`
- `docs/duplicate-resolution-blueprint.md`
- `docs/lead-health-scoring-spec.md`
- `docs/crm-schema-gap-analysis.md`
- `docs/cadence-engine-blueprint.md`
- `docs/rep-queue-blueprint.md`
- `docs/reporting-blueprint.md`

## Roadmap

1. Confirm the live assessment payload shape from Netlify.
2. Align scoring logic with the production website assessment behavior.
3. Finalize Twenty CRM field mapping and custom objects.
4. Implement safe CRM upserts for People and Companies.
5. Add Task and Opportunity creation based on score bands and priority signals.
6. Add deployment-grade webhook signature validation and rate limiting.
7. Add enrichment providers and LinkedIn research workflow support.
8. Add OpenAI-powered personalization drafts with human review.
9. Add operational dashboards and alerting.

## Operating Principle

This engine should increase operational visibility, not just automate activity. Every sync, score, task, and outreach suggestion should make the next human action clearer.
