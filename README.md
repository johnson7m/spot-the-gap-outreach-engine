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

Useful docs:

- `docs/assessment-schema.md`
- `docs/crm-field-map.md`
- `docs/twenty-integration-plan.md`

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
