import { randomUUID } from 'node:crypto';
import { createTwentyRestClient } from '../../integrations/twenty/restClient.js';
import { createOperationalStore } from '../../persistence/operationalStore.js';
import { invalidateWorkspaceSnapshot } from '../../services/workspaceSnapshotService.js';

const REPEATED_FAILURE_LIMIT = 2;
const ALLOWED_CONFIDENCE = new Set(['high', 'medium']);

export async function applyLegacyTaskRetrofitPlan({
  plan = {},
  config = {},
  options = {},
  restClient,
  operationalStore,
  log,
  now = new Date()
} = {}) {
  const normalizedOptions = normalizeTaskApplyOptions(options);
  const liveEnabled = Boolean(normalizedOptions.applyEnabled && normalizedOptions.liveTest);
  const selected = selectTaskApplyCandidates(plan, normalizedOptions);
  const operations = selected.map((record) =>
    buildTaskApplyOperation({
      record,
      linkCompany: normalizedOptions.linkCompany,
      now
    })
  );

  if (!liveEnabled) {
    return {
      status: 'dry_run',
      dryRun: true,
      liveEnabled: false,
      guard: buildGuardState(normalizedOptions),
      summary: summarizeTaskOperationResults({
        planned: operations.filter((operation) => operation.status === 'planned').length,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        verificationFailed: 0,
        skipped: operations.filter((operation) => operation.status === 'skipped').length
      }),
      operations,
      warnings: [
        'Legacy task retrofit apply is in dry-run mode. Set LEGACY_TASK_RETROFIT_APPLY_ENABLED=true and LIVE_TEST=true to write taskTargets.'
      ]
    };
  }

  if (!config.twenty?.apiKey && !restClient) {
    const error = new Error('TWENTY_API_KEY is required for live legacy task retrofit apply.');
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

    const startedAt = now.toISOString();
    const auditBase = buildTaskCrmSyncLogEntry({
      operation,
      status: 'planned',
      startedAt
    });
    const eventBase = buildTaskOutboundEventEntry({
      operation,
      status: 'planned',
      now
    });

    try {
      const duplicateCheck = await findExistingTaskTarget({
        client,
        taskId: operation.taskId,
        targetPersonId: operation.inferredTargetPersonId
      });

      if (duplicateCheck) {
        const verification = await verifyTaskTargetLink({
          client,
          operation
        });
        const audit = await store.appendCrmSyncLog({
          ...auditBase,
          status: 'succeeded',
          responsePayload: {
            duplicateSkipped: true,
            existingTaskTarget: duplicateCheck,
            verification
          },
          finishedAt: new Date().toISOString()
        });
        const outboundEvent = await store.appendOutboundEvent({
          ...eventBase,
          status: 'sent',
          payload: {
            ...eventBase.payload,
            duplicateSkipped: true,
            existingTaskTargetId: duplicateCheck.id,
            verification
          }
        });

        consecutiveFailures = 0;
        results.push({
          ...operation,
          status: verification.ok ? 'verification_succeeded' : 'verification_failed',
          response: duplicateCheck,
          duplicateSkipped: true,
          verification,
          audit,
          outboundEvent
        });
        continue;
      }

      const personTarget = await client.createRecord('taskTargets', operation.personTargetPayload);
      const companyTarget =
        operation.companyTargetPayload
          ? await createCompanyTargetIfMissing({
              client,
              operation
            })
          : null;
      const verification = await verifyTaskTargetLink({
        client,
        operation
      });
      const succeeded = verification.ok;
      const finishedAt = new Date().toISOString();
      const audit = await store.appendCrmSyncLog({
        ...auditBase,
        status: succeeded ? 'succeeded' : 'failed',
        responsePayload: {
          personTarget,
          companyTarget,
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
          response: {
            personTaskTargetId: personTarget?.id ?? null,
            companyTaskTargetId: companyTarget?.id ?? null
          },
          verification
        },
        errorPayload: succeeded ? null : verification
      });

      consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
      results.push({
        ...operation,
        status: succeeded ? 'verification_succeeded' : 'verification_failed',
        response: {
          personTarget,
          companyTarget
        },
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

  const summary = summarizeTaskLiveResults(results);

  if ((summary.succeeded ?? 0) > 0) {
    invalidateWorkspaceSnapshot('legacy_task_retrofit_apply');
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

export function normalizeTaskApplyOptions(options = {}) {
  return {
    applyEnabled: toBoolean(options.applyEnabled),
    liveTest: toBoolean(options.liveTest),
    linkCompany: toBoolean(options.linkCompany),
    batchSize: normalizePositiveInt(options.batchSize, 5),
    offset: normalizeNonNegativeInt(options.offset, 0)
  };
}

export function selectTaskApplyCandidates(plan = {}, options = {}) {
  const normalizedOptions = normalizeTaskApplyOptions(options);
  const candidates = (plan.plans ?? []).filter(isEligibleTaskApplyRecord);

  return candidates.slice(
    normalizedOptions.offset,
    normalizedOptions.offset + normalizedOptions.batchSize
  );
}

export function isEligibleTaskApplyRecord(record = {}) {
  return (
    record.recommendedAction === 'link_task_to_person' &&
    record.safeToUpdate === true &&
    ALLOWED_CONFIDENCE.has(String(record.confidence ?? '').toLowerCase()) &&
    !record.currentTargetPersonId &&
    Boolean(record.inferredTargetPersonId)
  );
}

export function buildTaskApplyOperation({ record, linkCompany = false, now = new Date() }) {
  const personTargetPayload = buildPersonTaskTargetPayload(record);
  const companyTargetPayload =
    linkCompany && record.inferredTargetCompanyId
      ? buildCompanyTaskTargetPayload(record)
      : null;
  const correlationId = `legacy-task-retrofit:${record.taskId}:${randomUUID()}`;
  const skippedReason = !record.taskId
    ? 'Missing Task ID.'
    : !record.inferredTargetPersonId
      ? 'Missing inferred Person target.'
      : record.currentTargetPersonId
        ? 'Task already has a Person taskTarget.'
        : Object.keys(personTargetPayload).length === 0
          ? 'No taskTarget payload to create.'
          : null;

  return {
    taskId: record.taskId ?? null,
    taskTitle: record.taskTitle ?? null,
    taskStatus: record.taskStatus ?? null,
    correlationId,
    status: skippedReason ? 'skipped' : 'planned',
    skippedReason,
    personTargetPayload,
    companyTargetPayload,
    currentTargetPersonId: record.currentTargetPersonId ?? null,
    currentTargetCompanyId: record.currentTargetCompanyId ?? null,
    inferredTargetPersonId: record.inferredTargetPersonId ?? null,
    inferredTargetCompanyId: record.inferredTargetCompanyId ?? null,
    inferredTargetPersonName: record.inferredTargetPersonName ?? null,
    confidence: record.confidence ?? null,
    recommendedAction: record.recommendedAction ?? null,
    generatedAt: now.toISOString()
  };
}

export function buildPersonTaskTargetPayload(record = {}) {
  return record.taskId && record.inferredTargetPersonId
    ? {
        taskId: record.taskId,
        targetPersonId: record.inferredTargetPersonId
      }
    : {};
}

export function buildCompanyTaskTargetPayload(record = {}) {
  return record.taskId && record.inferredTargetCompanyId
    ? {
        taskId: record.taskId,
        targetCompanyId: record.inferredTargetCompanyId
      }
    : null;
}

async function createCompanyTargetIfMissing({ client, operation }) {
  const existing = await findExistingTaskTarget({
    client,
    taskId: operation.taskId,
    targetCompanyId: operation.inferredTargetCompanyId
  });

  if (existing) {
    return {
      ...existing,
      duplicateSkipped: true
    };
  }

  return client.createRecord('taskTargets', operation.companyTargetPayload);
}

async function verifyTaskTargetLink({ client, operation }) {
  const taskTargets = await listTaskTargetsForTask(client, operation.taskId);
  const personTarget = taskTargets.find(
    (target) =>
      String(target.targetPersonId ?? '') === String(operation.inferredTargetPersonId ?? '')
  );
  const companyTarget = operation.companyTargetPayload
    ? taskTargets.find(
        (target) =>
          String(target.targetCompanyId ?? '') === String(operation.inferredTargetCompanyId ?? '')
      )
    : null;

  return {
    ok: Boolean(personTarget) && (!operation.companyTargetPayload || Boolean(companyTarget)),
    taskId: operation.taskId,
    expectedTargetPersonId: operation.inferredTargetPersonId,
    actualTargetPersonId: personTarget?.targetPersonId ?? null,
    expectedTargetCompanyId: operation.companyTargetPayload ? operation.inferredTargetCompanyId : null,
    actualTargetCompanyId: companyTarget?.targetCompanyId ?? null,
    taskTargetIds: taskTargets.map((target) => target.id).filter(Boolean)
  };
}

async function findExistingTaskTarget({ client, taskId, targetPersonId, targetCompanyId }) {
  const taskTargets = await listTaskTargetsForTask(client, taskId);

  return taskTargets.find((target) => {
    if (targetPersonId) {
      return String(target.targetPersonId ?? '') === String(targetPersonId);
    }

    if (targetCompanyId) {
      return String(target.targetCompanyId ?? '') === String(targetCompanyId);
    }

    return false;
  }) ?? null;
}

async function listTaskTargetsForTask(client, taskId) {
  const result =
    typeof client.listAllRecords === 'function'
      ? await client.listAllRecords('taskTargets', {
          pageSize: 100,
          maxPages: 10
        })
      : {
          records: await client.listRecords('taskTargets', {
            limit: 100
          })
        };

  return (result.records ?? result ?? []).filter(
    (target) => String(target.taskId ?? '') === String(taskId ?? '')
  );
}

function buildTaskCrmSyncLogEntry({ operation, status, startedAt }) {
  return {
    assessmentSubmissionId: null,
    workflowJobId: null,
    correlationId: operation.correlationId,
    provider: 'twenty',
    objectName: 'taskTarget',
    action: 'legacy_task_retrofit_create',
    dedupeKey: `legacy-task-retrofit:task:${operation.taskId}:person:${operation.inferredTargetPersonId}`,
    status,
    attempt: 1,
    requestPayload: {
      object: 'taskTargets',
      personTargetPayload: operation.personTargetPayload,
      companyTargetPayload: operation.companyTargetPayload
    },
    responsePayload: null,
    errorPayload: null,
    startedAt,
    finishedAt: status === 'dry_run' ? startedAt : null
  };
}

function buildTaskOutboundEventEntry({ operation, status, now }) {
  return {
    assessmentSubmissionId: null,
    correlationId: operation.correlationId,
    eventType: 'legacy_task_retrofit_applied',
    channel: 'crm',
    status,
    actorType: 'system',
    requiresApproval: false,
    payload: {
      taskId: operation.taskId,
      taskTitle: operation.taskTitle,
      taskStatus: operation.taskStatus,
      inferredTargetPersonId: operation.inferredTargetPersonId,
      inferredTargetCompanyId: operation.inferredTargetCompanyId,
      confidence: operation.confidence,
      personTargetPayload: operation.personTargetPayload,
      companyTargetPayload: operation.companyTargetPayload
    },
    approvalPayload: null,
    errorPayload: null,
    scheduledFor: now.toISOString()
  };
}

function summarizeTaskOperationResults(summary) {
  return {
    planned: summary.planned ?? 0,
    attempted: summary.attempted ?? 0,
    succeeded: summary.succeeded ?? 0,
    failed: summary.failed ?? 0,
    verificationFailed: summary.verificationFailed ?? 0,
    skipped: summary.skipped ?? 0,
    taskIdsLinked: summary.taskIdsLinked ?? [],
    personIdsLinked: summary.personIdsLinked ?? [],
    companyIdsLinked: summary.companyIdsLinked ?? [],
    auditIds: summary.auditIds ?? [],
    outboundEventIds: summary.outboundEventIds ?? []
  };
}

function summarizeTaskLiveResults(results = []) {
  return summarizeTaskOperationResults({
    planned: 0,
    attempted: results.filter((result) =>
      ['verification_succeeded', 'verification_failed', 'failed'].includes(result.status)
    ).length,
    succeeded: results.filter((result) => result.status === 'verification_succeeded').length,
    failed: results.filter((result) => result.status === 'failed').length,
    verificationFailed: results.filter((result) => result.status === 'verification_failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    taskIdsLinked: results
      .filter((result) => result.status === 'verification_succeeded')
      .map((result) => result.taskId)
      .filter(Boolean),
    personIdsLinked: results
      .filter((result) => result.status === 'verification_succeeded')
      .map((result) => result.inferredTargetPersonId)
      .filter(Boolean),
    companyIdsLinked: results
      .filter((result) => result.status === 'verification_succeeded' && result.companyTargetPayload)
      .map((result) => result.inferredTargetCompanyId)
      .filter(Boolean),
    auditIds: results.map((result) => result.audit?.id).filter(Boolean),
    outboundEventIds: results.map((result) => result.outboundEvent?.id).filter(Boolean)
  });
}

function buildGuardState(options) {
  return {
    applyEnabled: options.applyEnabled,
    liveTest: options.liveTest,
    linkCompany: options.linkCompany,
    batchSize: options.batchSize,
    offset: options.offset
  };
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

function toErrorPayload(error) {
  return {
    message: error.message,
    code: error.code,
    httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status,
    responseBody: error.twentyDiagnostics?.responseBody ?? error.response?.data
  };
}
