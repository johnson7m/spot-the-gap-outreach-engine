# Outbound Agents

Future outbound agents belong here, but they must not execute outreach directly.

Required execution boundary:

```text
AI Agent
  -> recommends action

Execution Layer
  -> validates schema
  -> validates permissions
  -> checks idempotency
  -> logs action
  -> requires approval when needed
  -> executes safely
```

Initial future agents:

- Lead enrichment researcher.
- Operational pain analyst.
- Message angle proposer.
- Outreach draft writer.

All outbound events must be recorded in `outbound_events` and default to `requires_approval=true`.
