export function createSupabaseOperationalStore({ client, log } = {}) {
  if (!client) {
    throw new Error('A Supabase client is required to create the operational store.');
  }

  return {
    type: 'supabase',

    async recordSubmissionAttempt(input) {
      const record = {
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
        normalized_payload: input.submission,
        score_payload: input.score,
        raw_payload: input.rawPayload,
        first_received_at: input.now,
        last_received_at: input.now
      };

      const inserted = await client
        .from('assessment_submissions')
        .insert(record)
        .select()
        .single();

      if (!inserted.error) {
        return {
          record: inserted.data,
          duplicate: false,
          shouldProcess: true
        };
      }

      if (inserted.error.code !== '23505') {
        throw toStoreError(inserted.error, 'Failed to persist assessment submission.');
      }

      const existing = await findSubmissionByIdempotencyKey(
        client,
        input.idempotency.idempotencyKey
      );

      if (!existing) {
        throw toStoreError(inserted.error, 'Submission insert conflicted but no record was found.');
      }

      await client
        .from('assessment_submissions')
        .update({ last_received_at: input.now })
        .eq('id', existing.id);

      return {
        record: existing,
        duplicate: true,
        shouldProcess:
          ['failed', 'partial_failure'].includes(existing.sync_status) &&
          (existing.retry_count ?? 0) < input.maxAttempts
      };
    },

    async updateSubmissionStatus(id, updates) {
      const response = await client
        .from('assessment_submissions')
        .update({
          sync_status: updates.syncStatus,
          retry_count: updates.retryCount,
          processed_at: updates.processedAt,
          last_error: updates.lastError
        })
        .eq('id', id)
        .select()
        .single();

      if (response.error) {
        throw toStoreError(response.error, 'Failed to update assessment submission.');
      }

      return response.data;
    },

    async createWorkflowJob(input) {
      const record = {
        assessment_submission_id: input.assessmentSubmissionId,
        correlation_id: input.correlationId,
        workflow_name: input.workflowName,
        idempotency_key: input.idempotencyKey,
        status: 'queued',
        max_attempts: input.maxAttempts,
        input: input.input
      };

      const inserted = await client.from('workflow_jobs').insert(record).select().single();

      if (!inserted.error) {
        return {
          record: inserted.data,
          duplicate: false
        };
      }

      if (inserted.error.code !== '23505') {
        throw toStoreError(inserted.error, 'Failed to create workflow job.');
      }

      const existing = await findWorkflowJob(client, input.workflowName, input.idempotencyKey);

      return {
        record: existing,
        duplicate: true
      };
    },

    async markWorkflowJobRunning(id, { now }) {
      const response = await client
        .from('workflow_jobs')
        .update({
          status: 'running',
          locked_at: now,
          started_at: now
        })
        .eq('id', id)
        .select()
        .single();

      if (response.error) {
        throw toStoreError(response.error, 'Failed to mark workflow job running.');
      }

      const incremented = await client
        .from('workflow_jobs')
        .update({ attempt_count: (response.data.attempt_count ?? 0) + 1 })
        .eq('id', id)
        .select()
        .single();

      if (incremented.error) {
        throw toStoreError(incremented.error, 'Failed to increment workflow job attempt count.');
      }

      return incremented.data;
    },

    async finishWorkflowJob(id, updates) {
      const response = await client
        .from('workflow_jobs')
        .update({
          status: updates.status,
          finished_at: updates.now,
          result: updates.result,
          last_error: updates.error,
          next_attempt_at: updates.nextAttemptAt
        })
        .eq('id', id)
        .select()
        .single();

      if (response.error) {
        throw toStoreError(response.error, 'Failed to finish workflow job.');
      }

      return response.data;
    },

    async appendCrmSyncLog(entry) {
      const response = await client.from('crm_sync_logs').insert(toCrmSyncLogRow(entry)).select().single();

      if (response.error) {
        log?.error({ error: response.error, entry }, 'Failed to write CRM sync audit log');
        throw toStoreError(response.error, 'Failed to write CRM sync audit log.');
      }

      return response.data;
    },

    async listSuccessfulCrmSyncLogsBySubmission(assessmentSubmissionId) {
      const response = await client
        .from('crm_sync_logs')
        .select('object_name,action,dedupe_key,status,response_payload')
        .eq('assessment_submission_id', assessmentSubmissionId)
        .eq('status', 'succeeded');

      if (response.error) {
        throw toStoreError(response.error, 'Failed to read successful CRM sync logs.');
      }

      return response.data.map((record) => ({
        objectName: record.object_name,
        action: record.action,
        dedupeKey: record.dedupe_key,
        status: record.status,
        response: record.response_payload
      }));
    },

    async appendOutboundEvent(entry) {
      const response = await client.from('outbound_events').insert(toOutboundEventRow(entry)).select().single();

      if (response.error) {
        throw toStoreError(response.error, 'Failed to write outbound event.');
      }

      return response.data;
    }
  };
}

async function findSubmissionByIdempotencyKey(client, idempotencyKey) {
  const response = await client
    .from('assessment_submissions')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .single();

  if (response.error) {
    return null;
  }

  return response.data;
}

async function findWorkflowJob(client, workflowName, idempotencyKey) {
  const response = await client
    .from('workflow_jobs')
    .select('*')
    .eq('workflow_name', workflowName)
    .eq('idempotency_key', idempotencyKey)
    .single();

  if (response.error) {
    throw toStoreError(response.error, 'Workflow job insert conflicted but no record was found.');
  }

  return response.data;
}

function toCrmSyncLogRow(entry) {
  return {
    assessment_submission_id: entry.assessmentSubmissionId,
    workflow_job_id: entry.workflowJobId,
    correlation_id: entry.correlationId,
    provider: entry.provider,
    object_name: entry.objectName,
    action: entry.action,
    dedupe_key: entry.dedupeKey,
    status: entry.status,
    attempt: entry.attempt,
    request_payload: entry.requestPayload,
    response_payload: entry.responsePayload,
    error_payload: entry.errorPayload,
    started_at: entry.startedAt,
    finished_at: entry.finishedAt
  };
}

function toOutboundEventRow(entry) {
  return {
    assessment_submission_id: entry.assessmentSubmissionId,
    correlation_id: entry.correlationId,
    event_type: entry.eventType,
    channel: entry.channel,
    status: entry.status,
    actor_type: entry.actorType,
    requires_approval: entry.requiresApproval,
    payload: entry.payload,
    approval_payload: entry.approvalPayload,
    error_payload: entry.errorPayload,
    scheduled_for: entry.scheduledFor
  };
}

function toStoreError(error, message) {
  const wrapped = new Error(`${message} ${error.message ?? ''}`.trim());
  wrapped.code = error.code;
  wrapped.details = error;
  return wrapped;
}
