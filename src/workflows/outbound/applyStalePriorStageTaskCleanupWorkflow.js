import { randomUUID } from 'node:crypto';
import { createTwentyRestClient } from '../../integrations/twenty/restClient.js';
import { createOperationalStore } from '../../persistence/operationalStore.js';
import { invalidateWorkspaceSnapshot } from '../../services/workspaceSnapshotService.js';

const REPEATED_FAILURE_LIMIT = 2;
const OPEN_TASK_STATUSES = new Set(['TODO', 'OPEN', 'IN_PROGRESS', 'NOT_STARTED']);
const COMPLETED_TASK_STATUSES = new Set(['DONE', 'COMPLETED', 'COMPLETE']);

export async function applyStalePriorStageTaskCleanupPlan({
  plan = {},
  config = {},
  options = {},
  restClient,
  operationalStore,
  log,
  now = new Date()
} = {}) {
  const normalizedOptions = normalizeStalePriorStageTaskCleanupOptions(options);
  const liveEnabled = Boolean(normalizedOptions.applyEnabled && normalizedOptions.liveTest);

  if (liveEnabled && !normalizedOptions.batchSizeProvided) {
    const error = new Error(
      'STALE_PRIOR_STAGE_TASK_CLEANUP_BATCH_SIZE is required for live stale prior-stage task cleanup.'
    );
    error.code = 'STALE_PRIOR_STAGE_TASK_CLEANUP_BATCH_SIZE_REQUIRED';
    throw error;
  }

  const selected = selectStalePriorStageTaskCleanupCandidates(plan, normalizedOptions);
  const operations = selected.map((record) =>
    buildStalePriorStageTaskCleanupOperation({
      record,
      now
    })
  );

  if (!liveEnabled) {
    return {
      status: 'dry_run',
      dryRun: true,
      liveEnabled: false,
      guard: buildGuardState(normalizedOptions),
      summary: summarizeCleanupOperationResults({
        planned: operations.filter((operation) => operation.status === 'planned').length,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        verificationFailed: 0,
        skipped: operations.filter((operation) => operation.status === 'skipped').length
      }),
      operations,
      warnings: [
        'Stale prior-stage task cleanup is in dry-run mode. Set STALE_PRIOR_STAGE_TASK_CLEANUP_ENABLED=true, LIVE_TEST=true, and STALE_PRIOR_STAGE_TASK_CLEANUP_BATCH_SIZE to close Tasks.'
      ]
    };
  }

  if (!config.twenty?.apiKey && !restClient) {
    const error = new Error('TWENTY_API_KEY is required for live stale prior-stage task cleanup.');
    error.code = 'TWENTY_AUTH_MISSING';
    throw error;
  }

  const client = restClient ?? createTwentyRestClient(config.twenty);
  const store = operationalStore ?? createOperationalStore({ config, log });
  const results = [];
  let consecutiveFailures = 0;

  for (const operation of operations) {
    if (operation.status === 'skipped') {
      results.push(operation);
      continue;
    }

    if (consecutiveFailures >= REPEATED_FAILURE_LIMIT) {
      results.push({
        ...operation,
        status: 'skipped',
        skippedReason: 'Stopped after repeated failures.'
      });
      continue;
    }

    const startedAt = new Date().toISOString();
    const auditBase = buildCleanupCrmSyncLogEntry({
      operation,
      status: 'planned',
      startedAt
    });
    const eventBase = buildCleanupOutboundEventEntry({
      operation,
      status: 'planned',
      now
    });

    try {
      const before = await client.getRecord('tasks', operation.taskId);
      const beforeStatus = normalizeStatus(before?.status);

      if (isCompletedTaskStatus(beforeStatus)) {
        const skippedReason = 'already_done';
        const audit = await store.appendCrmSyncLog({
          ...auditBase,
          status: 'skipped',
          responsePayload: {
            skippedReason,
            before: summarizeTask(before)
          },
          finishedAt: new Date().toISOString()
        });
        const outboundEvent = await store.appendOutboundEvent({
          ...eventBase,
          status: 'cancelled',
          payload: {
            ...eventBase.payload,
            skippedReason,
            before: summarizeTask(before)
          }
        });

        consecutiveFailures = 0;
        results.push({
          ...operation,
          status: 'skipped',
          skippedReason,
          before,
          audit,
          outboundEvent
        });
        continue;
      }

      if (!isOpenTaskStatus(beforeStatus)) {
        const skippedReason = `Task is not open; current status is ${beforeStatus || 'UNKNOWN'}.`;
        const audit = await store.appendCrmSyncLog({
          ...auditBase,
          status: 'skipped',
          responsePayload: {
            skippedReason,
            before: summarizeTask(before)
          },
          finishedAt: new Date().toISOString()
        });
        const outboundEvent = await store.appendOutboundEvent({
          ...eventBase,
          status: 'cancelled',
          payload: {
            ...eventBase.payload,
            skippedReason,
            before: summarizeTask(before)
          }
        });

        consecutiveFailures = 0;
        results.push({
          ...operation,
          status: 'skipped',
          skippedReason,
          before,
          audit,
          outboundEvent
        });
        continue;
      }

      const response = await client.updateRecord('tasks', operation.taskId, operation.payload);
      const after = await client.getRecord('tasks', operation.taskId);
      const verification = verifyTaskClosed({
        before,
        after,
        expectedStatus: operation.payload.status
      });
      const succeeded = verification.ok;
      const finishedAt = new Date().toISOString();
      const audit = await store.appendCrmSyncLog({
        ...auditBase,
        status: succeeded ? 'succeeded' : 'failed',
        responsePayload: {
          response,
          verification
        },
        errorPayload: succeeded ? null : verification,
        finishedAt
      });
      const outboundEvent = await store.appendOutboundEvent({
        ...eventBase,
        status: succeeded ? 'sent' : 'failed',
        payload: {
          ...eventBase.payload,
          response: summarizeTask(response),
          verification
        },
        errorPayload: succeeded ? null : verification
      });

      consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
      results.push({
        ...operation,
        status: succeeded ? 'verification_succeeded' : 'verification_failed',
        before,
        response,
        after,
        verification,
        audit,
        outboundEvent
      });
    } catch (error) {
      consecutiveFailures += 1;
      const errorPayload = toErrorPayload(error);
      const audit = await store.appendCrmSyncLog({
        ...auditBase,
        status: 'failed',
        errorPayload,
        finishedAt: new Date().toISOString()
      });
      const outboundEvent = await store.appendOutboundEvent({
        ...eventBase,
        status: 'failed',
        errorPayload
      });

      results.push({
        ...operation,
        status: 'failed',
        error: errorPayload,
        audit,
        outboundEvent
      });
    }
  }

  const summary = summarizeCleanupLiveResults(results);

  if ((summary.succeeded ?? 0) > 0) {
    invalidateWorkspaceSnapshot('stale_prior_stage_task_cleanup_apply');
  }

  return {
    status: summary.failed > 0 || summary.verificationFailed > 0 ? 'failed' : 'succeeded',
    dryRun: false,
    liveEnabled: true,
    guard: buildGuardState(normalizedOptions),
    summary,
    operations: results,
    warnings: config.supabase?.enabled
      ? []
      : ['Supabase is not enabled; crm_sync_logs and outbound_events used the in-memory store for this run.']
  };
}

export function normalizeStalePriorStageTaskCleanupOptions(options = {}) {
  const rawBatchSize = options.batchSize;
  const batchSizeProvided = rawBatchSize !== undefined && rawBatchSize !== null && rawBatchSize !== '';

  return {
    applyEnabled: toBoolean(options.applyEnabled),
    liveTest: toBoolean(options.liveTest),
    batchSize: normalizePositiveInt(rawBatchSize, 5),
    batchSizeProvided,
    offset: normalizeNonNegativeInt(options.offset, 0)
  };
}

export function selectStalePriorStageTaskCleanupCandidates(plan = {}, options = {}) {
  const normalizedOptions = normalizeStalePriorStageTaskCleanupOptions(options);
  const records = Array.isArray(plan.records) ? plan.records : [];
  const candidates = records.filter(isEligibleStalePriorStageTaskCleanupRecord);

  return candidates.slice(
    normalizedOptions.offset,
    normalizedOptions.offset + normalizedOptions.batchSize
  );
}

export function isEligibleStalePriorStageTaskCleanupRecord(record = {}) {
  return (
    record.recommendedAction === 'close_or_review_prior_stage_task' &&
    record.safeToPlan === true &&
    Boolean(record.staleTaskId) &&
    !isCompletedTaskStatus(record.staleTaskStatus)
  );
}

export function buildStalePriorStageTaskCleanupOperation({ record = {}, now = new Date() } = {}) {
  const payload = {
    status: 'DONE'
  };
  const correlationId = `stale-prior-stage-task-cleanup:${record.staleTaskId}:${randomUUID()}`;
  const skippedReason = !record.staleTaskId
    ? 'Missing stale Task ID.'
    : isCompletedTaskStatus(record.staleTaskStatus)
      ? 'already_done'
      : !record.safeToPlan
        ? 'Record is not marked safe to plan.'
        : record.recommendedAction !== 'close_or_review_prior_stage_task'
          ? 'Record is not a stale prior-stage cleanup candidate.'
          : null;

  return {
    record,
    taskId: record.staleTaskId ?? null,
    taskTitle: record.staleTaskTitle ?? null,
    taskStatus: record.staleTaskStatus ?? null,
    taskDueDate: record.staleTaskDueDate ?? null,
    taskCadenceStage: record.staleTaskCadenceStage ?? null,
    personId: record.personId ?? null,
    personName: record.personName ?? null,
    personCadenceStage: record.personCadenceStage ?? null,
    currentQueueTaskId: record.currentQueueTaskId ?? null,
    correlationId,
    status: skippedReason ? 'skipped' : 'planned',
    skippedReason,
    payload,
    generatedAt: now.toISOString()
  };
}

export function verifyTaskClosed({ before = {}, after = {}, expectedStatus = 'DONE' } = {}) {
  const actualStatus = normalizeStatus(after?.status);

  return {
    ok: isCompletedTaskStatus(actualStatus),
    taskId: after?.id ?? before?.id ?? null,
    beforeStatus: normalizeStatus(before?.status),
    expectedStatus: normalizeStatus(expectedStatus),
    actualStatus,
    completed: isCompletedTaskStatus(actualStatus)
  };
}

function buildCleanupCrmSyncLogEntry({ operation, status, startedAt }) {
  return {
    assessmentSubmissionId: null,
    workflowJobId: null,
    correlationId: operation.correlationId,
    provider: 'twenty',
    objectName: 'task',
    action: 'stale_prior_stage_task_cleanup_close',
    dedupeKey: `stale-prior-stage-task-cleanup:task:${operation.taskId}`,
    status,
    attempt: 1,
    requestPayload: {
      object: 'tasks',
      id: operation.taskId,
      payload: operation.payload,
      personId: operation.personId,
      personName: operation.personName,
      personCadenceStage: operation.personCadenceStage,
      taskCadenceStage: operation.taskCadenceStage,
      currentQueueTaskId: operation.currentQueueTaskId
    },
    responsePayload: null,
    errorPayload: null,
    startedAt,
    finishedAt: status === 'dry_run' ? startedAt : null
  };
}

function buildCleanupOutboundEventEntry({ operation, status, now }) {
  return {
    assessmentSubmissionId: null,
    correlationId: operation.correlationId,
    eventType: 'stale_prior_stage_task_closed',
    channel: 'crm',
    status,
    actorType: 'system',
    requiresApproval: false,
    payload: {
      taskId: operation.taskId,
      taskTitle: operation.taskTitle,
      taskStatus: operation.taskStatus,
      taskDueDate: operation.taskDueDate,
      taskCadenceStage: operation.taskCadenceStage,
      personId: operation.personId,
      personName: operation.personName,
      personCadenceStage: operation.personCadenceStage,
      currentQueueTaskId: operation.currentQueueTaskId,
      payload: operation.payload
    },
    approvalPayload: null,
    errorPayload: null,
    scheduledFor: now.toISOString()
  };
}

function summarizeCleanupOperationResults(summary) {
  return {
    planned: summary.planned ?? 0,
    attempted: summary.attempted ?? 0,
    succeeded: summary.succeeded ?? 0,
    failed: summary.failed ?? 0,
    verificationFailed: summary.verificationFailed ?? 0,
    skipped: summary.skipped ?? 0,
    taskIdsClosed: summary.taskIdsClosed ?? [],
    personIdsAffected: summary.personIdsAffected ?? [],
    auditIds: summary.auditIds ?? [],
    outboundEventIds: summary.outboundEventIds ?? []
  };
}

function summarizeCleanupLiveResults(results = []) {
  return summarizeCleanupOperationResults({
    planned: 0,
    attempted: results.filter((result) =>
      ['verification_succeeded', 'verification_failed', 'failed'].includes(result.status)
    ).length,
    succeeded: results.filter((result) => result.status === 'verification_succeeded').length,
    failed: results.filter((result) => result.status === 'failed').length,
    verificationFailed: results.filter((result) => result.status === 'verification_failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    taskIdsClosed: results
      .filter((result) => result.status === 'verification_succeeded')
      .map((result) => result.taskId)
      .filter(Boolean),
    personIdsAffected: [
      ...new Set(
        results
          .filter((result) => result.status === 'verification_succeeded')
          .map((result) => result.personId)
          .filter(Boolean)
      )
    ],
    auditIds: results.map((result) => result.audit?.id).filter(Boolean),
    outboundEventIds: results.map((result) => result.outboundEvent?.id).filter(Boolean)
  });
}

function buildGuardState(options) {
  return {
    applyEnabled: options.applyEnabled,
    liveTest: options.liveTest,
    batchSize: options.batchSize,
    batchSizeProvided: options.batchSizeProvided,
    offset: options.offset
  };
}

function isOpenTaskStatus(status) {
  return OPEN_TASK_STATUSES.has(normalizeStatus(status));
}

function isCompletedTaskStatus(status) {
  return COMPLETED_TASK_STATUSES.has(normalizeStatus(status));
}

function normalizeStatus(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function normalizeNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function summarizeTask(task = {}) {
  return {
    id: task?.id ?? null,
    title: task?.title ?? task?.name ?? null,
    status: task?.status ?? null,
    dueAt: task?.dueAt ?? task?.dueDate ?? null
  };
}

function toErrorPayload(error) {
  return {
    message: error.message,
    code: error.code,
    httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status,
    responseBody: error.twentyDiagnostics?.responseBody ?? error.response?.data
  };
}
