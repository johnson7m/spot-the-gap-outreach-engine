-- Spot the Gap Outreach Engine operational persistence schema.
-- Target: Supabase/Postgres.
--
-- Setup guidance:
-- 1. Open Supabase SQL Editor for the project.
-- 2. Run this file in a migration or SQL editor session.
-- 3. Use a server-side service role key only in this backend process.
-- 4. Keep RLS enabled for client-facing access; this engine should use server-only credentials.
-- 5. Add row-level policies only if data must be queried from a user-facing app later.

create extension if not exists pgcrypto;

create table if not exists assessment_submissions (
  id uuid primary key default gen_random_uuid(),
  external_submission_id text,
  idempotency_key text not null unique,
  payload_hash text not null,
  correlation_id text not null,
  source text not null default 'netlify',
  form_name text,
  person_email text,
  company_name text,
  score integer,
  grade text,
  sync_status text not null default 'received'
    check (sync_status in ('received', 'duplicate', 'processing', 'dry_run', 'synced', 'partial_failure', 'failed')),
  retry_count integer not null default 0,
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  processed_at timestamptz,
  normalized_payload jsonb not null,
  score_payload jsonb not null,
  raw_payload jsonb not null,
  last_error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_assessment_submissions_external_submission_id
  on assessment_submissions (external_submission_id);

create index if not exists idx_assessment_submissions_person_email
  on assessment_submissions (person_email);

create index if not exists idx_assessment_submissions_sync_status
  on assessment_submissions (sync_status);

create index if not exists idx_assessment_submissions_created_at
  on assessment_submissions (created_at desc);

create table if not exists workflow_jobs (
  id uuid primary key default gen_random_uuid(),
  assessment_submission_id uuid references assessment_submissions(id) on delete set null,
  correlation_id text not null,
  workflow_name text not null,
  idempotency_key text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'partial_failure', 'failed', 'skipped')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  locked_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  next_attempt_at timestamptz,
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  last_error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_name, idempotency_key)
);

create index if not exists idx_workflow_jobs_status_next_attempt
  on workflow_jobs (status, next_attempt_at);

create index if not exists idx_workflow_jobs_correlation_id
  on workflow_jobs (correlation_id);

create table if not exists crm_sync_logs (
  id uuid primary key default gen_random_uuid(),
  assessment_submission_id uuid references assessment_submissions(id) on delete set null,
  workflow_job_id uuid references workflow_jobs(id) on delete set null,
  correlation_id text not null,
  provider text not null,
  object_name text not null,
  action text not null,
  dedupe_key text,
  status text not null
    check (status in ('planned', 'dry_run', 'succeeded', 'skipped', 'failed')),
  attempt integer not null default 1,
  request_payload jsonb,
  response_payload jsonb,
  error_payload jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_crm_sync_logs_submission
  on crm_sync_logs (assessment_submission_id);

create index if not exists idx_crm_sync_logs_correlation_id
  on crm_sync_logs (correlation_id);

create index if not exists idx_crm_sync_logs_provider_object
  on crm_sync_logs (provider, object_name, status);

create table if not exists outbound_events (
  id uuid primary key default gen_random_uuid(),
  assessment_submission_id uuid references assessment_submissions(id) on delete set null,
  correlation_id text not null,
  event_type text not null,
  channel text,
  status text not null default 'planned'
    check (status in ('planned', 'queued', 'approved', 'sent', 'cancelled', 'failed')),
  actor_type text not null default 'system'
    check (actor_type in ('system', 'human', 'ai_agent')),
  requires_approval boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  approval_payload jsonb,
  error_payload jsonb,
  scheduled_for timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_outbound_events_submission
  on outbound_events (assessment_submission_id);

create index if not exists idx_outbound_events_correlation_id
  on outbound_events (correlation_id);

create index if not exists idx_outbound_events_status_scheduled
  on outbound_events (status, scheduled_for);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_assessment_submissions_updated_at on assessment_submissions;
create trigger set_assessment_submissions_updated_at
before update on assessment_submissions
for each row execute function set_updated_at();

drop trigger if exists set_workflow_jobs_updated_at on workflow_jobs;
create trigger set_workflow_jobs_updated_at
before update on workflow_jobs
for each row execute function set_updated_at();

drop trigger if exists set_outbound_events_updated_at on outbound_events;
create trigger set_outbound_events_updated_at
before update on outbound_events
for each row execute function set_updated_at();
