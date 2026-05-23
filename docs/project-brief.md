# Project Brief: Spot the Gap Outreach Engine

## Business Objectives

Visible Gap needs a serious internal platform that converts assessment interest into structured operational intelligence. The Spot the Gap assessment is more than a form submission; it is an early signal about how a company sees its own systems, process gaps, growth friction, and readiness for advisory help.

The outreach engine should help Visible Gap:

- Capture assessment submissions reliably from the existing website and Netlify form flow.
- Translate assessment responses into normalized lead intelligence.
- Identify high-fit opportunities without creating manual CRM cleanup.
- Keep Twenty CRM accurate, deduplicated, and useful for follow-up.
- Create consistent next actions for the team.
- Build a foundation for future service offerings around operational visibility and AI-assisted growth systems.

## System Goals

The system should be modular, observable, and conservative with external side effects. Early versions should favor clear data flow and safe dry-run behavior before live CRM writes.

Core goals:

- Ingest assessment webhook payloads.
- Normalize contact, company, and assessment fields.
- Calculate operational maturity and priority signals.
- Upsert CRM records safely.
- Create follow-up tasks with enough context for a human to act.
- Create opportunities only when qualification signals justify it.
- Preserve the original submission payload for debugging and audit trails.
- Provide a clean path to enrichment, personalization, and outbound workflows.

## Outreach Philosophy

Visible Gap outreach should be specific, useful, and grounded in the prospect's actual operational context. The engine should not create generic outbound at scale. It should help the team understand:

- What problem the prospect likely feels.
- Which maturity gaps are visible in the assessment.
- What operational risk or growth constraint is implied.
- What the most helpful first conversation should focus on.
- Whether follow-up should be advisory, educational, diagnostic, or opportunity-led.

Automation should support judgment. AI-generated copy should be treated as a draft, not an autonomous final message, until review workflows and quality controls exist.

## CRM Workflow Strategy

Twenty CRM should become the operational source of truth for assessment-driven leads.

Planned record strategy:

- Person: created or updated by primary email address.
- Company: created or updated by normalized company domain, then company name as a fallback.
- Task: created for human follow-up after each qualified assessment.
- Opportunity: created only for submissions with sufficient fit, urgency, score threshold, or explicit interest.
- Assessment metadata: stored in custom fields or notes once the Twenty schema is finalized.

Duplicate prevention should use stable keys:

- Netlify submission ID.
- Person email.
- Company website/domain.
- Company name plus location when no domain exists.
- Existing CRM record IDs once available.

The first production implementation should include idempotency checks so replayed webhooks do not create duplicate tasks or opportunities.

## Future AI-Agent Plans

The engine should be ready for agentic workflows without coupling the first version to them.

Future agents may include:

- Assessment analyst: summarizes maturity gaps and flags hidden operational risk.
- CRM hygiene agent: detects likely duplicate People or Companies.
- Personalization agent: drafts prospect-specific outreach using assessment responses and approved Visible Gap voice.
- Enrichment agent: researches company context and fills missing CRM fields.
- Sequencing agent: recommends follow-up timing and channel based on score, role, and urgency.
- Opportunity analyst: suggests whether a lead should become a diagnostic call, nurture track, or advisory opportunity.

Every future agent should produce traceable outputs with source context, confidence, and human review status.

## Operational Visibility Positioning

Spot the Gap should reinforce Visible Gap's positioning around operational clarity. The engine should surface what is usually hidden:

- Process breakdowns.
- Ownership gaps.
- Tooling friction.
- Data visibility issues.
- Lead handoff weaknesses.
- Capacity constraints.
- Readiness for repeatable growth.

The best version of this system does not merely move form data into a CRM. It turns a lightweight assessment into an operating signal that helps Visible Gap respond with relevance, speed, and discipline.

## Near-Term Success Criteria

- A webhook can accept and normalize a representative assessment payload.
- The scoring utility produces a stable maturity band.
- CRM sync can run in dry-run mode and show planned People, Company, Task, and Opportunity operations.
- Environment configuration is validated at startup.
- The codebase is easy to extend without touching the production website.
