import {
  normalizeNetlifySubmission,
  assertWebhookSecret,
  validateNetlifyAssessmentSubmission
} from '../integrations/netlifyWebhook.js';
import { createCrmAdapter } from '../integrations/crm/crmAdapter.js';
import { createOperationalStore } from '../persistence/operationalStore.js';
import { createAssessmentIdempotency, createCorrelationId } from '../utils/idempotency.js';
import { scoreAssessment } from '../utils/leadScoring.js';

const WORKFLOW_NAME = 'assessment.crm_sync';

export async function processAssessmentSubmission({
  body,
  headers,
  config,
  log,
  schemaOverride,
  operationalStore,
  restClient,
  now = new Date()
}) {
  const startedAt = now.toISOString();
  const correlationId = createCorrelationId(headers);
  assertWebhookSecret(headers, config.webhookSharedSecret, {
    environment: config.env ?? 'development',
    log,
    correlationId
  });

  const submission = normalizeNetlifySubmission(body);
  const score = scoreAssessment(submission.assessment.answers);
  validateNetlifyAssessmentSubmission(submission, score);
  const idempotency = createAssessmentIdempotency({ submission, score });
  const maxAttempts = config.workflowMaxAttempts ?? 3;
  const store = operationalStore ?? createOperationalStore({ config, log });

  log?.info?.(
    {
      correlationId,
      submissionId: submission.submissionId,
      idempotencyKey: idempotency.idempotencyKey
    },
    'Assessment workflow received submission'
  );

  const submissionAttempt = await store.recordSubmissionAttempt({
    submission,
    score,
    rawPayload: body,
    idempotency,
    correlationId,
    maxAttempts,
    now: startedAt
  });

  if (submissionAttempt.duplicate && !submissionAttempt.shouldProcess) {
    log?.info?.(
      {
        correlationId,
        submissionId: submission.submissionId,
        idempotencyKey: idempotency.idempotencyKey
      },
      'Duplicate assessment submission skipped'
    );

    return {
      status: 'duplicate_replay',
      duplicate: true,
      replayProtected: true,
      correlationId,
      idempotency,
      submissionId: submission.submissionId,
      receivedAt: startedAt,
      submission,
      score,
      persistence: {
        store: store.type,
        submissionRecordId: submissionAttempt.record.id
      },
      crmSync: {
        provider: config.crmProvider ?? 'twenty',
        status: 'skipped',
        dryRun: !config.twenty?.syncEnabled,
        reason: 'Duplicate submission replay was detected. CRM sync was skipped.',
        operations: []
      }
    };
  }

  const workflowJob = await store.createWorkflowJob({
    assessmentSubmissionId: submissionAttempt.record.id,
    workflowName: WORKFLOW_NAME,
    idempotencyKey: idempotency.idempotencyKey,
    correlationId,
    maxAttempts,
    input: {
      submissionId: submission.submissionId,
      score: score.score,
      grade: score.grade
    },
    now: startedAt
  });
  const runningJob = await store.markWorkflowJobRunning(workflowJob.record.id, {
    now: startedAt
  });

  await store.updateSubmissionStatus(submissionAttempt.record.id, {
    syncStatus: 'processing',
    retryCount: runningJob?.attempt_count ?? submissionAttempt.record.retry_count ?? 0,
    processedAt: null,
    lastError: null,
    now: startedAt
  });

  try {
    const completedOperations = await store.listSuccessfulCrmSyncLogsBySubmission(
      submissionAttempt.record.id
    );
    const crmAdapter = createCrmAdapter({
      provider: config.crmProvider ?? 'twenty',
      config,
      log,
      schemaOverride,
      restClient
    });
    const crmSync = await crmAdapter.syncAssessmentSubmission({
      submission,
      score,
      completedOperations
    });
    const finishedAt = new Date().toISOString();
    const auditLogs = await writeCrmAuditLogs({
      store,
      crmSync,
      submissionRecordId: submissionAttempt.record.id,
      workflowJobId: runningJob?.id ?? workflowJob.record.id,
      correlationId,
      attempt: runningJob?.attempt_count ?? 1,
      startedAt,
      finishedAt
    });
    const finalSubmissionStatus = toSubmissionStatus(crmSync);
    const workflowStatus = toWorkflowStatus(crmSync);

    await store.updateSubmissionStatus(submissionAttempt.record.id, {
      syncStatus: finalSubmissionStatus,
      retryCount: runningJob?.attempt_count ?? 1,
      processedAt: finishedAt,
      lastError: buildLastError(crmSync),
      now: finishedAt
    });
    await store.finishWorkflowJob(runningJob?.id ?? workflowJob.record.id, {
      status: workflowStatus,
      result: {
        crmStatus: crmSync.status,
        operationCount: crmSync.operations.length,
        auditLogCount: auditLogs.length
      },
      error: buildLastError(crmSync),
      nextAttemptAt: getNextAttemptAt({
        crmSync,
        attemptCount: runningJob?.attempt_count ?? 1,
        maxAttempts
      }),
      now: finishedAt
    });

    return {
      status: finalSubmissionStatus,
      duplicate: submissionAttempt.duplicate,
      replayProtected: false,
      correlationId,
      idempotency,
      submissionId: submission.submissionId,
      receivedAt: startedAt,
      finishedAt,
      submission,
      score,
      persistence: {
        store: store.type,
        submissionRecordId: submissionAttempt.record.id,
        workflowJobId: runningJob?.id ?? workflowJob.record.id,
        auditLogCount: auditLogs.length
      },
      crmSync,
      workflowSummary: {
        workflowName: WORKFLOW_NAME,
        status: workflowStatus,
        attempt: runningJob?.attempt_count ?? 1,
        maxAttempts,
        operationStatusCounts: countOperationStatuses(crmSync.operations)
      }
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const structuredError = serializeError(error);

    await store.updateSubmissionStatus(submissionAttempt.record.id, {
      syncStatus: 'failed',
      retryCount: runningJob?.attempt_count ?? 1,
      processedAt: finishedAt,
      lastError: structuredError,
      now: finishedAt
    });
    await store.finishWorkflowJob(runningJob?.id ?? workflowJob.record.id, {
      status: 'failed',
      result: null,
      error: structuredError,
      nextAttemptAt:
        (runningJob?.attempt_count ?? 1) < maxAttempts
          ? backoffDate(runningJob?.attempt_count ?? 1).toISOString()
          : null,
      now: finishedAt
    });

    log?.error?.(
      {
        correlationId,
        submissionId: submission.submissionId,
        error: structuredError
      },
      'Assessment workflow failed'
    );

    return {
      status: 'failed',
      duplicate: submissionAttempt.duplicate,
      replayProtected: false,
      correlationId,
      idempotency,
      submissionId: submission.submissionId,
      receivedAt: startedAt,
      finishedAt,
      submission,
      score,
      persistence: {
        store: store.type,
        submissionRecordId: submissionAttempt.record.id,
        workflowJobId: runningJob?.id ?? workflowJob.record.id
      },
      error: structuredError,
      crmSync: {
        provider: config.crmProvider ?? 'twenty',
        status: 'failed',
        dryRun: !config.twenty?.syncEnabled,
        reason: 'Workflow failed before CRM sync completed.',
        operations: []
      }
    };
  }
}

async function writeCrmAuditLogs({
  store,
  crmSync,
  submissionRecordId,
  workflowJobId,
  correlationId,
  attempt,
  startedAt,
  finishedAt
}) {
  const logs = [];

  for (const operation of crmSync.operations) {
    logs.push(
      await store.appendCrmSyncLog({
        assessmentSubmissionId: submissionRecordId,
        workflowJobId,
        correlationId,
        provider: crmSync.provider,
        objectName: operation.object,
        action: operation.action,
        dedupeKey: operation.dedupeKey,
        status: normalizeAuditStatus(operation.status),
        attempt,
        requestPayload: operation.payload,
        responsePayload: operation.response,
        errorPayload: operation.error,
        startedAt,
        finishedAt
      })
    );
  }

  return logs;
}

function toSubmissionStatus(crmSync) {
  if (crmSync.status === 'dry_run') {
    return 'dry_run';
  }

  if (crmSync.status === 'succeeded') {
    return 'synced';
  }

  if (crmSync.status === 'partial_failure') {
    return 'partial_failure';
  }

  return 'failed';
}

function toWorkflowStatus(crmSync) {
  if (['dry_run', 'succeeded'].includes(crmSync.status)) {
    return 'succeeded';
  }

  if (crmSync.status === 'partial_failure') {
    return 'partial_failure';
  }

  if (crmSync.status === 'blocked_schema_validation' || crmSync.status === 'blocked_configuration') {
    return 'failed';
  }

  return 'failed';
}

function normalizeAuditStatus(status) {
  if (status === 'planned') {
    return 'planned';
  }

  if (status === 'dry_run') {
    return 'dry_run';
  }

  if (status === 'skipped') {
    return 'skipped';
  }

  if (status === 'failed') {
    return 'failed';
  }

  return 'succeeded';
}

function buildLastError(crmSync) {
  const failedOperations = crmSync.operations.filter((operation) => operation.status === 'failed');

  if (failedOperations.length === 0 && !crmSync.status.startsWith('blocked_')) {
    return null;
  }

  return {
    crmStatus: crmSync.status,
    reason: crmSync.reason,
    schemaErrors: crmSync.schemaValidation?.errors ?? [],
    failedOperations: failedOperations.map((operation) => ({
      object: operation.object,
      action: operation.action,
      dedupeKey: operation.dedupeKey,
      error: operation.error
    }))
  };
}

function getNextAttemptAt({ crmSync, attemptCount, maxAttempts }) {
  if (!['failed', 'partial_failure'].includes(crmSync.status)) {
    return null;
  }

  if (attemptCount >= maxAttempts) {
    return null;
  }

  return backoffDate(attemptCount).toISOString();
}

function backoffDate(attemptCount) {
  const date = new Date();
  date.setUTCMinutes(date.getUTCMinutes() + Math.min(60, 5 * attemptCount));
  return date;
}

function countOperationStatuses(operations) {
  return operations.reduce((counts, operation) => {
    counts[operation.status] = (counts[operation.status] ?? 0) + 1;
    return counts;
  }, {});
}

function serializeError(error) {
  return {
    message: error.message,
    code: error.code,
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack
  };
}
