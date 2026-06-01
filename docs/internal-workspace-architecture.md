# Internal Workspace Architecture

This document defines the future third repository for Visible Gap's internal rep
workspace. The workspace repo now exists as a standalone frontend shell. Quick
Capture preview and commit API endpoints exist in the outreach engine; queue,
reporting, recovery, and task APIs remain planned.

## Repository Boundary

Future repository:

```text
visible-gap-workspace
```

Current repositories remain separate:

- `consulting-landing-page`: public website, assessment UX, Netlify form proxy.
- `spot-the-gap-outreach-engine`: ingestion, Supabase persistence, CRM sync,
  Quick Capture backend workflows, retry/recovery, and future API surface.
- `visible-gap-workspace`: authenticated internal UI for reps and operators.

The workspace should call the outreach engine API. It should not talk directly
to Twenty or Supabase from the browser.

## Product Purpose

The workspace should give reps and operators one quiet, reliable place to:

- capture manually sourced leads
- review CRM payloads before Quick Capture writes
- work daily queues
- complete follow-up tasks
- inspect warm assessment leads
- see stale or blocked records
- run controlled retry/recovery actions
- review lightweight reporting

It should not automate LinkedIn actions, scrape profile pages, or send outreach
without explicit future approval.

## Recommended Stack

- React
- Vite
- TypeScript strongly recommended for UI/API contracts
- Tailwind CSS
- shadcn/ui if useful for tables, forms, dialogs, toasts, and menus
- TanStack Query for API state and cache invalidation
- React Router for app routes
- Zod for client-side form validation matching backend contracts
- Supabase Auth for authentication and session management
- Deployed separately from the public website

The first workspace release should be staging-only.

## Suggested Folder Structure

```text
visible-gap-workspace/
  src/
    app/
      App.tsx
      routes.tsx
    components/
      layout/
      forms/
      queues/
      recovery/
      reporting/
      ui/
    features/
      quick-capture/
      queues/
      recovery/
      reporting/
    lib/
      apiClient.ts
      auth.ts
      dates.ts
      formatters.ts
      validation.ts
    types/
      api.ts
      crm.ts
      queues.ts
    styles/
      globals.css
  public/
  tests/
  .env.example
  package.json
  README.md
```

Feature folders should own their screens, hooks, and local components. Shared
components should stay generic.

## Routes

Recommended MVP routes:

| Route | Purpose |
| --- | --- |
| `/` | Workspace overview and today's priorities. |
| `/quick-capture` | Manual lead intake, preview, and submit flow. |
| `/duplicates` | Merge gate for duplicate People/Companies. |
| `/queues/fresh-leads` | New manually captured or imported prospects. |
| `/queues/follow-ups` | Due and overdue rep follow-up tasks. |
| `/queues/warm-assessments` | Assessment completions and high-score leads. |
| `/queues/stale-recovery` | Leads with stale risk or missed touch windows. |
| `/queues/pipeline-review` | Discovery-ready or opportunity-adjacent leads. |
| `/recovery` | Retryable CRM failures and dead-letter visibility. |
| `/reporting` | MVP operational metrics. |
| `/settings` | Future user, owner, source, and queue configuration. |

## Auth Assumptions

MVP assumptions:

- Internal-only access.
- Reps can create Quick Capture leads and complete tasks.
- Operators can view retryable failures and trigger recovery.
- Admins can configure source values, owners, and future API credentials.
- Supabase Auth issues user sessions.
- The outreach engine validates user roles server-side.

Confirmed roles:

| Role | Capabilities |
| --- | --- |
| `rep` | Quick Capture, queue work, task completion. |
| `operator` | Everything rep can do plus retry/recovery visibility. |
| `admin` | Configuration, role management, future integration controls. |

The outreach engine validates authorization server-side for workspace API
requests when Supabase JWT verification is enabled. UI-only role checks are not
enough. During staging API bring-up, Quick Capture commit can still use a
temporary `x-visible-gap-workspace-secret` fallback for server-side scripts, but
the browser workspace should send only `Authorization: Bearer <supabase token>`.

## Environment Variables

Workspace environment:

```bash
VITE_OUTREACH_ENGINE_API_BASE_URL=https://<render-service-or-api-domain>
VITE_WORKSPACE_ENV=staging
VITE_SUPABASE_URL=<supabase-project-url>
VITE_SUPABASE_ANON_KEY=<supabase-anon-key>
```

Only the Supabase anon key belongs in the browser. Service role keys must remain
server-side in the outreach engine or Supabase environment.

Outreach engine variables needed before workspace integration:

```bash
NODE_ENV=production
SUPABASE_ENABLED=true
SUPABASE_JWT_VERIFICATION_ENABLED=false
SUPABASE_AUTH_REQUIRED_FOR_WORKSPACE_API=false
TWENTY_SYNC_ENABLED=false
QUICK_CAPTURE_SYNC_ENABLED=false
QUICK_CAPTURE_API_PREVIEW_ENABLED=true
QUICK_CAPTURE_API_COMMIT_ENABLED=false
WORKSPACE_API_SECRET=<temporary-server-side-shared-secret>
WORKSPACE_ALLOWED_ORIGIN=https://<workspace-domain>
WEBHOOK_SECRET=<website-webhook-secret>
SUPABASE_URL=<supabase-project-url>
SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-key>
```

`SUPABASE_SERVICE_ROLE_KEY` stays server-side in the outreach engine. It is used
to verify Supabase users and read `workspace_profiles`; it must never be exposed
to the frontend.

Server-side workspace auth flow:

```text
Authorization bearer token
  -> Supabase Auth getUser(token)
  -> workspace_profiles by user_id
  -> is_active check
  -> role check
  -> req.workspaceUser
```

Resolved roles:

- `admin`
- `operator`
- `rep`

For the first workspace preview integration, leave `TWENTY_SYNC_ENABLED=false`
and `QUICK_CAPTURE_API_COMMIT_ENABLED=false`. The UI can safely call
`POST /api/quick-capture/preview` to render normalized lead data, dedupe
warnings, CRM payload previews, and the cadence/task plan.

Once Supabase workspace profiles are populated, enable authenticated preview:

```bash
SUPABASE_JWT_VERIFICATION_ENABLED=true
SUPABASE_AUTH_REQUIRED_FOR_WORKSPACE_API=true
```

For a controlled staging commit test, enable all relevant guards deliberately:

```bash
QUICK_CAPTURE_API_COMMIT_ENABLED=true
TWENTY_SYNC_ENABLED=true
SUPABASE_ENABLED=true
SUPABASE_JWT_VERIFICATION_ENABLED=true
```

The browser must never receive Twenty API keys or Supabase service-role keys.

## Deployment Recommendation

Deploy separately from both current repos.

Recommended options:

1. Vercel or Netlify for the Vite workspace if authentication is handled cleanly.
2. Render static site if keeping frontend/backend hosting under one provider is
   operationally simpler.
3. Cloudflare Pages if access controls and edge routing are desired later.

The workspace should point at the deployed outreach engine API, not at Twenty or
Supabase directly.

## Backend Dependency Map

```text
visible-gap-workspace
  -> outreach engine API
      -> Supabase Auth token verification
      -> Quick Capture workflow
      -> queue query layer
      -> recovery service
      -> reporting query layer
      -> CRM adapter
      -> Supabase operational store
      -> Twenty provider
```

The workspace is a client. It should display plans, warnings, IDs, and recovery
states, but execution remains in the outreach engine.

## Source Of Truth

Twenty stores:

- CRM records
- relationships
- pipeline state
- rep-facing ownership

Supabase stores:

- workflow state
- audit logs
- outbound events
- retries
- reporting aggregates
- operational intelligence

The workspace should reconcile these through engine API responses rather than
choosing one system directly.

## MVP Dashboard

The home dashboard should prioritize work, not marketing-style summary cards.

Suggested first viewport:

- tasks due today
- overdue follow-ups
- retryable CRM failures
- fresh leads awaiting first touch
- warm assessment leads awaiting review

MVP reporting can sit below the priority section or under `/reporting`.

## Reporting MVP

The first reporting pass should answer "what needs attention today?" and "is
the outbound operating system working?"

Initial metrics:

| Metric | Primary Source | Notes |
| --- | --- | --- |
| leads captured this week | `outbound_events` | `event_type=quick_capture_planned`. |
| tasks due today | Twenty Tasks, optionally cached | Open tasks with `dueAt` today. |
| overdue follow-ups | Twenty Tasks + Person state | Open tasks with past `dueAt`. |
| assessment completions | `assessment_submissions` and Person fields | Count by week/month and score band. |
| quick captures by rep | `outbound_events.payload.lead.assignedRep` | Later use user IDs. |
| touches by channel | `outbound_events.channel` | Manual/approved touches only. |
| stale leads | Person `staleRisk`, task due dates | Queue count plus trend. |
| conversion by source | `leadSource`, assessment and opportunity outcomes | Define conversion stages before using for goals. |

Dashboard widgets:

- captured this week
- due today
- overdue
- warm assessments
- stale leads
- retryable failures

Reporting should stay lightweight until queue behavior is validated. Do not
build complex charts before the team has agreed on source values, rep ownership,
and conversion definitions.

## Confirmed Lead Sources

Allowed `leadSource` values:

- `LINKEDIN`
- `EVENT`
- `DROP_IN`
- `REFERRAL`
- `ASSESSMENT`
- `WEBSITE`
- `EMAIL`
- `PHONE`
- `MANUAL`
- `OTHER`

## Non-Goals

- No LinkedIn automation.
- No scraping.
- No browser extension.
- No direct client-side CRM writes.
- No direct client-side Supabase writes.
- No autonomous AI outreach.
- No changes to the public assessment UX or webhook flow.

## Implementation Sequence

1. Finalize workspace API contracts in the outreach engine docs.
2. Add Supabase Auth verification and role authorization in the outreach engine.
3. Add authenticated read-only queue endpoints in the outreach engine.
4. Add Quick Capture preview endpoint.
5. Add Quick Capture commit endpoint after preview review and merge gates are
   designed.
6. Scaffold `visible-gap-workspace`.
7. Build Quick Capture form and preview.
8. Build queue list pages.
9. Build operator recovery page.
10. Add lightweight reporting.
11. Add role-based audit events for all write actions.
