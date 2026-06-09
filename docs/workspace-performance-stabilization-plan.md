# Workspace Performance Stabilization Plan

## Purpose

This plan documents the current Visible Gap Workspace read/write behavior, the
immediate low-risk UI stabilization work, and the recommended backend sync/cache
architecture for reducing expensive CRM reads without weakening auditability.

Scope:

- `visible-gap-workspace` as the primary MVP surface
- `spot-the-gap-outreach-engine` as the API, CRM read, cache, and write boundary
- no public website changes
- no assessment webhook changes
- no live writes in this planning pass

## Current Read/Write Audit

### Workspace Reads

The workspace currently reads through the outreach engine only. It does not read
from Twenty directly and does not use Supabase service-role credentials.

High-volume read surfaces:

- `/queues` calls `GET /api/queues/summary` for tab counts and one active
  `GET /api/queues/:queueName` endpoint for the current queue tab.
- `/reporting` calls five reporting endpoints when mounted:
  `executive`, `queue-health`, `rep-performance`, `operations`, and
  `cadence-analytics`.
- `operations` reporting is Supabase-backed. The other reporting endpoints reuse
  queue/classification source records and can trigger full Twenty reads.

The workspace now uses a two-minute browser stale window and ten-minute query
garbage collection window for queue and reporting reads. This reduces refetches
while navigating between pages. Explicit Refresh buttons remain available.

### Outreach Engine Reads

Queue and most reporting endpoints use the same core source path:

- `src/workflows/outbound/getQueueWorkflow.js`
- `src/workflows/reporting/reportingWorkflowUtils.js`
- `src/integrations/twenty/queueDataSource.js`

The expensive path is:

```text
listAllQueueRecords
  -> people
  -> companies
  -> tasks
  -> taskTargets
  -> noteTargets
  -> timelineActivities
  -> workspaceMembers
```

Critical reads:

- `people`
- `tasks`
- `taskTargets`
- `workspaceMembers` when `ownerScope=mine` or `assigneeScope=mine`

Non-critical reads can degrade with warnings. Critical 429/502/503/504 failures
return degraded status or stale cache when available.

Current queue read cache:

- in-memory module cache in `queueDataSource`
- `QUEUE_READ_CACHE_ENABLED=true` by default
- `QUEUE_READ_CACHE_TTL_SECONDS=90` by default
- cache key includes source read mode and critical object set
- `bypassCache=true` or `BYPASS_QUEUE_CACHE=true` can be used for diagnostics

Risk:

- `/reporting` mounts multiple independent read requests. Without cache hits,
  this can multiply full CRM reads.
- `/queues` can perform both summary and active queue full reads on page load.
- cache is per-process memory only, so Render restarts or multiple instances can
  lose shared read state.

### Writes

Workspace-triggered writes are still guarded and explicit:

- Quick Capture commit writes People/Companies/Tasks through the outreach engine
  only after preview, confirmation, workspace auth, and backend env guards.
- Task completion writes outbound events, CRM audit rows, Person cadence updates,
  and next Task creation only after user confirmation.

Script/apply writes remain separate from the workspace and require explicit live
guards. Recovery/apply scripts perform targeted reads and verification reads, but
they are not workspace UI traffic.

The workspace now invalidates queue and queue summary queries after successful
task completion so the next queue view can reflect the cadence change.

## Immediate Stabilization Completed

The workspace received low-risk changes:

- query stale time increased from 30 seconds to 120 seconds
- query garbage collection window set to 10 minutes
- refetch on window focus disabled globally
- Queue Refresh now reloads both active queue and summary badges
- task completion success invalidates queue and summary queries
- raw response accordions are hidden unless workspace debug mode is enabled
- diagnostics request controls are admin/operator only and require debug mode
- Settings now shows profile, role source, environment, sync guidance, and debug
  visibility
- Recovery is labeled as a mock preview with disabled retry actions
- operators can access Settings for operational mode/debug visibility
- Quick Capture commit warnings and errors use commit-specific copy

## Debug Mode

Workspace debug mode is local-only and browser-stored.

Allowed roles:

- admin
- operator

Not allowed by default:

- rep

Debug mode controls:

- raw response accordions
- raw error response accordions
- `includeDiagnostics` request controls on Queues and Reporting

Debug mode does not:

- alter backend permissions
- send workspace shared secrets
- enable Quick Capture commit
- expose Supabase service-role keys
- change owner scope enforcement

## Settings and Recovery Positioning

Settings is the MVP control surface for:

- signed-in email and profile state
- resolved role and role source
- mock-auth visibility
- workspace environment
- engine API and Supabase configuration status
- Quick Capture commit UI status
- local debug mode
- near-term sync metadata guidance

Recovery remains a preview until live workspace recovery endpoints are wired:

- current rows are mock data
- retry buttons are disabled
- live retry continues through outreach-engine scripts

## Recommended Sync and Cache Architecture

### Phase 1: Keep Current API, Reduce Accidental Reads

Completed in the workspace:

- longer query stale time
- explicit Refresh usage
- debug-gated diagnostics
- refresh after task completion invalidates relevant queue data

Recommended backend follow-up:

- log cache hit/miss and source read timing for queue and reporting endpoints
- include `cacheGeneratedAt`, `cacheAgeSeconds`, and `lastSuccessfulCrmReadAt`
  consistently in queue/reporting diagnostics
- make reporting endpoints share one classified source read per request cycle
  when multiple reports are requested together

Implemented read observability:

- `GET /api/reporting/read-observability`
- `npm run reporting:read-observability`
- process-local logical Twenty read events by endpoint/workflow/request source
- aggregate cache hit/miss rates, durations, records/pages fetched, frequent
  reads, expensive reads, duplicate-read estimates, and snapshot opportunities

### Phase 2: Workspace Snapshot

Add a shared snapshot layer in the outreach engine:

```text
Twenty source reads
  -> classified workspace snapshot
  -> queue slices
  -> reporting slices
  -> workspace UI
```

Candidate endpoint:

```text
GET /api/workspace/snapshot
```

Snapshot contents:

- generatedAt
- lastSuccessfulCrmReadAt
- sourceReadStatus
- cacheStatus
- queueCounts
- overdueCountsByQueue
- countsByDisposition
- hiddenTestRecords
- compact queue/reporting freshness metadata

Storage options:

- in-memory cache for current single-instance staging
- Supabase `workspace_snapshots` table for multi-instance or audit visibility

Refresh behavior:

- normal UI reads use the latest fresh snapshot
- explicit Refresh can request a new snapshot if outside TTL
- admin/operator can use `forceRefresh=true` behind a guarded diagnostic control
- after writes, invalidate affected snapshot slices and return sync guidance

### Phase 3: Slice-Specific Incremental Reads

Once stable, reduce full reads by adding targeted source queries:

- queues can page through preclassified snapshot items instead of full CRM reads
- reporting can use snapshots plus Supabase event tables
- task completion can return enough affected item metadata for optimistic UI
  updates
- background refresh can update People/Tasks/TaskTargets independently

## Role and User Preview Design

User/role preview should be an admin-only UI aid, not a permission bypass.

Recommended behavior:

- Settings includes "Preview workspace as" for admins only
- preview mode changes visible owner scope, labels, and local route affordances
- every API call still sends the real signed-in Supabase bearer token
- backend continues enforcing the real workspace profile role
- UI displays "Previewing as ..." prominently
- preview state is local and expires when the browser session ends

Do not use preview mode to:

- impersonate backend permissions
- write as another user
- bypass owner scope on server-side endpoints

## Registration Workflow Plan

Recommended MVP:

1. Admin creates Supabase Auth user or sends Supabase invite.
2. Admin inserts `workspace_profiles` row with role `rep`, `operator`, or
   `admin`.
3. User signs in through `/login`.
4. Workspace loads profile by `user_id`.
5. Inactive or missing production profile does not grant elevated access.

Future table:

```text
workspace_invitations
  id
  email
  role
  invited_by
  accepted_at
  expires_at
  status
```

Safety rules:

- default new users to `rep`
- only admins can assign `operator` or `admin`
- never allow self-registration into `admin`
- keep service-role operations in the outreach engine only

## Prioritized Implementation Plan

### Priority 1: Stabilize MVP UX

- Keep current debug-mode and cache-tuning changes.
- Keep Recovery visibly labeled as preview.
- Keep Settings as the mode/profile/status surface.
- Add manual QA pass across desktop, tablet, and phone widths.

### Priority 2: Backend Read Observability

- Use `GET /api/reporting/read-observability` during workspace QA to measure
  real endpoint/workflow read frequency and cost.
- Add `lastSuccessfulCrmReadAt` to queue summary and reporting responses.
- Audit whether reporting endpoints can share one source read for a single page
  load or use a reporting bundle endpoint.

### Priority 3: Shared Snapshot

- Implement a shared classified workspace snapshot.
- Serve queue counts and reporting Phase 1 metrics from the same snapshot.
- Add explicit snapshot refresh semantics.

### Priority 4: Admin Preview and Registration

- Add admin-only local user/role preview.
- Add managed user onboarding documentation and profile admin workflow.
- Add backend endpoints only after permissions are reviewed.

## Deferred Items

- live recovery UI actions
- direct duplicate merge UI
- owner override UI
- workspace user management UI
- task or lead creation from queue gaps
- AI summaries, recommendations, or coaching

These should wait until the snapshot/read model and role enforcement are settled.
