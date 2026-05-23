import { randomUUID } from 'node:crypto';

export function createMemoryOperationalStore() {
  const submissions = new Map();
  const workflowJobs = new Map();
  const crmSyncLogs = [];
  const outboundEvents = [];

  return {
    type: 'memory',

    async recordSubmissionAttempt(input) {
      const existing = submissions.get(input.idempotency.idempotencyKey);

      if (existing) {
        existing.last_received_at = input.now;

        return {
          record: existing,
          duplicate: true,
          shouldProcess: shouldRetryExisting(existing, input.maxAttempts)
        };
      }

      const record = {
        id: randomUUID(),
        external_submission_id: input.submission.submissionId,
        idempotency_key: input.idempotency.idempotencyKey,
        payload_hash: input.idempotency.payloadHash,
        correlation_id: input.correlationId,
        source: 'netlify',
        form_name: input.submission.formName,
        person_email: input.submission.person.email,
        company_name: input.submission.company.name,
        score: input.score.score,
        grade: input.score.grade,
        sync_status: 'received',
        retry_count: 0,
        first_received_at: input.now,
        last_received_at: input.now,
        normalized_payload: input.submission,
        score_payload: input.score,
        raw_payload: input.rawPayload,
        created_at: input.now,
        updated_at: input.now
      };

      submissions.set(record.idempotency_key, record);

      return {
        record,
        duplicate: false,
        shouldProcess: true
      };
    },

    async updateSubmissionStatus(id, updates) {
      const record = findById(submissions, id);

      if (!record) {
        return null;
      }

      Object.assign(record, toSubmissionUpdates(updates), { updated_at: updates.now });
      return record;
    },

    async createWorkflowJob(input) {
      const key = `${input.workflowName}:${input.idempotencyKey}`;
      const existing = workflowJobs.get(key);

      if (existing) {
        return {
          record: existing,
          duplicate: true
        };
      }

      const record = {
        id: randomUUID(),
        assessment_submission_id: input.assessmentSubmissionId,
        correlation_id: input.correlationId,
        workflow_name: input.workflowName,
        idempotency_key: input.idempotencyKey,
        status: 'queued',
        attempt_count: 0,
        max_attempts: input.maxAttempts,
        input: input.input,
        created_at: input.now,
        updated_at: input.now
      };

      workflowJobs.set(key, record);

      return {
        record,
        duplicate: false
      };
    },

    async markWorkflowJobRunning(id, { now }) {
      const record = findById(workflowJobs, id);

      if (!record) {
        return null;
      }

      record.status = 'running';
      record.attempt_count += 1;
      record.locked_at = now;
      record.started_at = record.started_at ?? now;
      record.updated_at = now;
      return record;
    },

    async finishWorkflowJob(id, updates) {
      const record = findById(workflowJobs, id);

      if (!record) {
        return null;
      }

      Object.assign(record, {
        status: updates.status,
        finished_at: updates.now,
        result: updates.result,
        last_error: updates.error,
        next_attempt_at: updates.nextAttemptAt,
        updated_at: updates.now
      });

      return record;
    },

    async appendCrmSyncLog(entry) {
      const record = {
        id: randomUUID(),
        ...entry,
        created_at: entry.createdAt ?? new Date().toISOString()
      };

      crmSyncLogs.push(record);
      return record;
    },

    async listSuccessfulCrmSyncLogsBySubmission(assessmentSubmissionId) {
      return crmSyncLogs.filter(
        (record) =>
          record.assessmentSubmissionId === assessmentSubmissionId &&
          record.status === 'succeeded'
      );
    },

    async appendOutboundEvent(entry) {
      const record = {
        id: randomUUID(),
        status: 'planned',
        actor_type: 'system',
        requires_approval: true,
        ...entry,
        created_at: entry.createdAt ?? new Date().toISOString()
      };

      outboundEvents.push(record);
      return record;
    },

    snapshot() {
      return {
        submissions: [...submissions.values()],
        workflowJobs: [...workflowJobs.values()],
        crmSyncLogs: [...crmSyncLogs],
        outboundEvents: [...outboundEvents]
      };
    }
  };
}

function shouldRetryExisting(record, maxAttempts) {
  return (
    ['failed', 'partial_failure'].includes(record.sync_status) &&
    (record.retry_count ?? 0) < maxAttempts
  );
}

function findById(map, id) {
  return [...map.values()].find((record) => record.id === id);
}

function toSubmissionUpdates(updates) {
  return {
    sync_status: updates.syncStatus,
    retry_count: updates.retryCount,
    processed_at: updates.processedAt,
    last_error: updates.lastError
  };
}
