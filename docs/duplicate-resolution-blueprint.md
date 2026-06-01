# Duplicate Resolution Blueprint

This document defines duplicate detection and merge-gate behavior for future
Quick Capture and workspace flows. It is documentation-only. No merge endpoint,
CRM write, or database migration is implemented by this pass.

## Goals

- Prevent duplicate People and Companies.
- Preserve useful missing data from both records.
- Require human review for ambiguous matches.
- Avoid destructive overwrites.
- Keep an audit trail of merge decisions.

## Matching Hierarchy

Use all available signals, but rank them by reliability.

Person matching:

1. email
2. LinkedIn URL, when user-provided
3. first name + last name + company
4. first name + last name + title
5. phone

Company matching:

1. company domain
2. exact company name
3. normalized company name
4. LinkedIn company URL, when user-provided

The requested matching checks are:

- first name
- last name
- email
- company
- LinkedIn URL, if available

## Confidence Levels

| Confidence | Signals | Default behavior |
| --- | --- | --- |
| high | exact email match, or exact LinkedIn URL match | Show merge/update recommendation before commit. |
| medium | exact name + same company domain/name | Show merge gate; require user choice. |
| low | name similarity only, company missing, or weak title match | Warn only; default to keep separate. |
| conflict | strong identity match but conflicting company/title/email | Require explicit field choices. |

Even high-confidence matches should be visible in preview-first Quick Capture so
the rep understands whether the result will create or update.

## Merge Gate Behavior

When a potential duplicate exists, the workspace should present a merge gate
before commit.

User choices:

- merge lead 1 into lead 2
- merge lead 2 into lead 1
- keep separate

The merge gate should show:

- match confidence
- matching fields
- conflicting fields
- missing fields that can be copied
- current Twenty record links
- proposed surviving record
- proposed field updates

No merge should run as a hidden side effect.

## Surviving Record Logic

The user chooses the surviving record.

Defaults:

- Prefer an existing Twenty record over a newly submitted Quick Capture lead.
- Prefer the record with CRM owner, active tasks, assessment history, or
  opportunity relationships.
- Prefer the record with verified email or stronger LinkedIn URL if neither has
  assessment/opportunity history.

Protected assessment fields should stay on the surviving record. Quick Capture
should not overwrite them.

## Field Resolution Rules

Missing fields:

- Copy missing fields from the non-surviving record into the surviving record
  when field types are compatible.
- Show a clear list of copied fields before merge.

Conflicting fields:

- Require explicit keep/overwrite choice.
- Do not overwrite populated email, LinkedIn URL, company, owner, or protected
  assessment fields without explicit user selection.

Multi-value fields:

- Preserve existing primary value unless the user chooses otherwise.
- Add non-duplicate secondary values when supported.

Relationship fields:

- Do not force relationship merges until Twenty relationship payloads are
  confirmed for the relevant objects.
- Preserve tasks, notes, opportunities, and audit history on the surviving
  record when supported.

## Quick Capture Preview Behavior

Preview should return:

```json
{
  "duplicateCandidates": [
    {
      "id": "candidate-id",
      "object": "person",
      "confidence": "high",
      "matchedBy": ["email"],
      "conflicts": [],
      "missingFieldsToCopy": ["jobTitle", "linkedinUrl"]
    }
  ],
  "requiresMergeDecision": true
}
```

Commit should be blocked when `requiresMergeDecision=true` until the user
chooses merge direction or keep separate.

## Future API Shape

Candidate endpoints:

```text
GET /api/duplicates
POST /api/duplicates/:id/merge
```

`GET /api/duplicates` should support filtering by object, confidence, source,
and assigned rep.

`POST /api/duplicates/:id/merge` should require:

- surviving record ID
- losing record ID
- field choices
- reason
- actor

## Audit Logging Requirements

Every duplicate decision should write an audit event to Supabase.

Required audit fields:

- actor user ID
- actor role
- correlation ID
- duplicate candidate IDs
- surviving record ID
- non-surviving record ID
- selected action
- field choices
- conflicts shown
- timestamp
- result status
- CRM operation IDs, if any

Keep separate decisions should also be logged so the same candidate pair does
not interrupt the rep repeatedly without a reason.

## Reporting Signals

Track:

- duplicate candidates created
- merges completed
- keep-separate decisions
- fields copied
- conflicts resolved
- merge failures
- duplicate prevention rate

## Non-Goals

- No automatic destructive merges.
- No hidden overwrite of protected assessment fields.
- No merge behavior implemented in this pass.
- No relationship write expansion in this pass.
