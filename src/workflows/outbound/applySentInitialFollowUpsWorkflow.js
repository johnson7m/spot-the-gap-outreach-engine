import { randomUUID } from 'node:crypto';
import { createTwentyRestClient } from '../../integrations/twenty/restClient.js';
import { buildNextTaskDedupeKey } from '../../integrations/twenty/taskCompletionPayloadBuilders.js';
import { createOperationalStore } from '../../persistence/operationalStore.js';
import { resolveSafeMissingNextTaskDueDate } from '../../utils/projectDate.js';

const REPEATED_FAILURE_LIMIT = 2;
const OPEN_TASK_STATUSES = new Set(['TODO', 'OPEN', 'IN_PROGRESS', 'NOT_STARTED']);
const EXCLUDED_STATES = new Set([
  'PAUSED',
  'COMPLETED',
  'COMPLETE',
  'DONE',
  'ACTIVE_CLIENT',
  'UNQUALIFIED_CLOSED',
  'DECLINED',
  'DISQUALIFIED',
  'DISQUALIFIED_NURTURE'
]);
const POST_INITIAL_CADENCE_STAGES = new Set([
  'INTRO_MESSAGE',
  'VALUE_TOUCH',
  'ASSESSMENT_POSITIONING',
  'ASSESSMENT_SENT',
  'ASSESSMENT_CHECK_IN',
  'STRATEGIC_CHECK_IN',
  'DISCOVERY_ASK'
]);
const POST_INITIAL_TASK_PATTERNS = [
  /send relationship follow-up \/ intro message/i,
  /send contextual introduction/i,
  /send assessment positioning follow-up/i,
  /send assessment positioning message/i,
  /send value touch/i,
  /send spot the gap assessment link/i,
  /check in on spot the gap assessment/i,
  /send strategic check-in/i,
  /evaluate discovery ask/i,
  /\bli\s*-\s*day\s*2\b/i,
  /\bli\s*-\s*f\/?u\b/i,
  /\bfinal touch\b/i
];

export async function applySentInitialFollowUpPlan({
  plan = {},
  config = {},
  options = {},
  restClient,
  operationalStore,
  log,
  now = new Date(),
  sleep = defaultSleep
} = {}) {
  const normalizedOptions = normalizeSentInitialFollowUpApplyOptions(options);
  const liveEnabled = Boolean(normalizedOptions.applyEnabled && normalizedOptions.liveTest);

  if (liveEnabled && !normalizedOptions.batchSizeProvided) {
    const error = new Error(
      'SENT_INITIAL_FOLLOW_UP_BATCH_SIZE is required for live sent-initial follow-up apply.'
    );
    error.code = 'SENT_INITIAL_FOLLOW_UP_BATCH_SIZE_REQUIRED';
    throw error;
  }

  const selected = selectSentInitialFollowUpCandidates(plan, normalizedOptions);
  const operations = selected.map((record) =>
    buildSentInitialFollowUpOperation({
      record,
      updatePersonStage: normalizedOptions.updatePersonStage,
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
      summary: summarizeSentInitialFollowUpOperationResults({
        planned: operations.filter((operation) => operation.status === 'planned').length,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        verificationFailed: 0,
        skipped: operations.filter((operation) => operation.status === 'skipped').length
      }),
      retryAfterSeconds: null,
      recommendedNextCommand: buildRecommendedNextCommand({
        summary: {
          failed: 0,
          verificationFailed: 0,
          skipped: operations.filter((operation) => operation.status === 'skipped').length
        },
        options: normalizedOptions
      }),
      operations,
      warnings: [
        'Sent-initial follow-up apply is in dry-run mode. Set SENT_INITIAL_FOLLOW_UP_APPLY_ENABLED=true, LIVE_TEST=true, and SENT_INITIAL_FOLLOW_UP_BATCH_SIZE to create Tasks.'
      ]
    };
  }

  if (!config.twenty?.apiKey && !restClient) {
    const error = new Error('TWENTY_API_KEY is required for live sent-initial follow-up apply.');
    error.code = 'TWENTY_AUTH_MISSING';
    throw error;
  }

  const client = restClient ?? createTwentyRestClient(config.twenty);
  const store = operationalStore ?? createOperationalStore({ config, log });
  const results = [];
  let consecutiveFailures = 0;

  for (const [index, operation] of operations.entries()) {
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

    if (index > 0 && normalizedOptions.writeDelayMs > 0) {
      await sleep(normalizedOptions.writeDelayMs);
    }

    const startedAt = new Date().toISOString();
    const auditBase = buildSentInitialFollowUpCrmSyncLogEntry({
      operation,
      status: 'planned',
      startedAt
    });
    const eventBase = buildSentInitialFollowUpOutboundEventEntry({
      operation,
      status: 'planned',
      now
    });

    try {
      const operationResult = await executeSentInitialFollowUpOperationWithRetry({
        client,
        operation,
        options: normalizedOptions,
        sleep
      });

      if (operationResult.skippedReason) {
        const audit = await store.appendCrmSyncLog({
          ...auditBase,
          status: 'skipped',
          responsePayload: {
            skippedReason: operationResult.skippedReason,
            existingTask: operationResult.existingTask
          },
          finishedAt: new Date().toISOString()
        });
        const outboundEvent = await store.appendOutboundEvent({
          ...eventBase,
          status: 'cancelled',
          payload: {
            ...eventBase.payload,
            skippedReason: operationResult.skippedReason,
            existingTaskId: operationResult.existingTask?.id ?? null
          }
        });

        consecutiveFailures = 0;
        results.push({
          ...operation,
          status: 'skipped',
          skippedReason: operationResult.skippedReason,
          existingTask: operationResult.existingTask,
          retryAttempts: operationResult.retryAttempts,
          retryAfterSeconds: operationResult.retryAfterSeconds,
          audit,
          outboundEvent
        });
        continue;
      }

      const {
        task,
        personTarget,
        companyTarget,
        personStageUpdate,
        duplicateTaskSkipped,
        verification,
        retryAttempts,
        retryAfterSeconds
      } = operationResult;
      const succeeded = verification.ok;
      const finishedAt = new Date().toISOString();
      const audit = await store.appendCrmSyncLog({
        ...auditBase,
        status: succeeded ? 'succeeded' : 'failed',
        responsePayload: {
          task,
          personTarget,
          companyTarget,
          personStageUpdate,
          duplicateTaskSkipped,
          verification,
          retryAttempts,
          retryAfterSeconds
        },
        errorPayload: succeeded ? null : verification,
        finishedAt
      });
      const outboundEvent = await store.appendOutboundEvent({
        ...eventBase,
        status: succeeded ? 'sent' : 'failed',
        payload: {
          ...eventBase.payload,
          taskId: task.id,
          personTaskTargetId: personTarget?.id ?? null,
          companyTaskTargetId: companyTarget?.id ?? null,
          personStageUpdate,
          duplicateTaskSkipped,
          verification,
          retryAttempts,
          retryAfterSeconds
        },
        errorPayload: succeeded ? null : verification
      });

      consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
      results.push({
        ...operation,
        status: succeeded ? 'verification_succeeded' : 'verification_failed',
        task,
        personTarget,
        companyTarget,
        personStageUpdate,
        duplicateTaskSkipped,
        verification,
        retryAttempts,
        retryAfterSeconds,
        audit,
        outboundEvent
      });
    } catch (error) {
      consecutiveFailures += 1;
      const errorPayload = {
        ...toErrorPayload(error),
        retryAttempts: error.retryAttempts ?? 0,
        retryAfterSeconds: error.retryAfterSeconds ?? getRetryAfterSeconds(error, normalizedOptions)
      };
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
        retryAttempts: errorPayload.retryAttempts,
        retryAfterSeconds: errorPayload.retryAfterSeconds,
        error: errorPayload,
        audit,
        outboundEvent
      });
    }
  }

  const summary = summarizeSentInitialFollowUpLiveResults(results);

  return {
    status: determineSentInitialFollowUpStatus(summary),
    dryRun: false,
    liveEnabled: true,
    guard: buildGuardState(normalizedOptions),
    summary,
    retryAfterSeconds: getMaxRetryAfterSeconds(results),
    recommendedNextCommand: buildRecommendedNextCommand({
      summary,
      options: normalizedOptions
    }),
    operations: results,
    warnings: config.supabase?.enabled
      ? []
      : ['Supabase is not enabled; crm_sync_logs and outbound_events used the in-memory store for this run.']
  };
}

export function normalizeSentInitialFollowUpApplyOptions(options = {}) {
  const rawBatchSize = options.batchSize;
  const batchSizeProvided = rawBatchSize !== undefined && rawBatchSize !== null && rawBatchSize !== '';

  return {
    applyEnabled: toBoolean(options.applyEnabled),
    liveTest: toBoolean(options.liveTest),
    updatePersonStage: toBoolean(options.updatePersonStage),
    linkCompany: toBoolean(options.linkCompany),
    includeReview: toBoolean(options.includeReview),
    includeTestRecords: toBoolean(options.includeTestRecords),
    force: toBoolean(options.force),
    batchSize: normalizePositiveInt(rawBatchSize, 5),
    batchSizeProvided,
    offset: normalizeNonNegativeInt(options.offset, 0),
    writeDelayMs: normalizeNonNegativeInt(options.writeDelayMs, 1500),
    retryAfter429: options.retryAfter429 === undefined ? true : toBoolean(options.retryAfter429),
    maxRetryAttempts: normalizeNonNegativeInt(options.maxRetryAttempts, 2),
    retryFallbackMs: normalizePositiveInt(options.retryFallbackMs, 60000)
  };
}

export function selectSentInitialFollowUpCandidates(plan = {}, options = {}) {
  const normalizedOptions = normalizeSentInitialFollowUpApplyOptions(options);
  const candidates = (plan.plans ?? []).filter((record) =>
    isEligibleSentInitialFollowUpRecord(record, normalizedOptions)
  );

  return candidates.slice(
    normalizedOptions.offset,
    normalizedOptions.offset + normalizedOptions.batchSize
  );
}

export function isEligibleSentInitialFollowUpRecord(record = {}, options = {}) {
  const normalizedOptions = normalizeSentInitialFollowUpApplyOptions(options);

  if (record.isTestRecord && !normalizedOptions.includeTestRecords) {
    return false;
  }

  if (!record.safeToCreate && !(normalizedOptions.force && normalizedOptions.includeReview)) {
    return false;
  }

  if (!record.safeToCreate && !normalizedOptions.includeReview) {
    return false;
  }

  if (!record.personId || !record.recommendedTaskTitle || !record.recommendedDueDate) {
    return false;
  }

  if (!record.cadenceName || !record.recommendedNextCadenceStage || !record.recommendedTaskType) {
    return false;
  }

  if (normalizeSelect(record.latestTouchStatus) !== 'SENT') {
    return false;
  }

  if (isExcludedRecordState(record)) {
    return false;
  }

  return true;
}

export function buildSentInitialFollowUpRecoveryPlan({ plan = {}, applyOutput = {} } = {}) {
  const sourcePlans = plan.plans ?? [];
  const plansByPersonId = new Map(sourcePlans.map((record) => [String(record.personId), record]));
  const recoverableOperations = (applyOutput.operations ?? []).filter(isRecoverableApplyOperation);
  const plans = recoverableOperations
    .map((operation) => plansByPersonId.get(String(operation.personId)) ?? operationToPlanRecord(operation))
    .filter(Boolean);

  return {
    status: 'recovery_plan',
    dryRun: true,
    sourceApplyStatus: applyOutput.status ?? null,
    sourceSummary: applyOutput.summary ?? null,
    recoverableOperationCount: recoverableOperations.length,
    plans
  };
}

export function buildSentInitialFollowUpOperation({
  record,
  updatePersonStage = false,
  linkCompany = false,
  now = new Date()
}) {
  const dueDate = resolveSafeMissingNextTaskDueDate({
    recommendedDueDate: record.recommendedDueDate,
    now
  });
  const adjustedRecord = {
    ...record,
    originalRecommendedDueDate:
      record.originalRecommendedDueDate ?? dueDate.originalRecommendedDueDate ?? record.recommendedDueDate ?? null,
    recommendedDueDate: dueDate.recommendedDueDate,
    dueDateAdjusted: Boolean(record.dueDateAdjusted || dueDate.dueDateAdjusted),
    dueDateAdjustmentReason:
      dueDate.dueDateAdjustmentReason ?? record.dueDateAdjustmentReason ?? null
  };
  const dedupeKey = buildNextTaskDedupeKey({
    personId: adjustedRecord.personId,
    cadenceName: adjustedRecord.cadenceName,
    nextCadenceStage: adjustedRecord.recommendedNextCadenceStage,
    taskType: adjustedRecord.recommendedTaskType
  });
  const taskPayload = buildSentInitialFollowUpTaskPayload({
    record: adjustedRecord,
    dedupeKey,
    now
  });
  const correlationId = `sent-initial-follow-up:${adjustedRecord.personId}:${randomUUID()}`;
  const skippedReason = getOperationSkippedReason({ record: adjustedRecord, taskPayload });
  const companyId = firstString(adjustedRecord.targetCompanyId, adjustedRecord.companyId, adjustedRecord.company?.id);

  return {
    personId: adjustedRecord.personId ?? null,
    personName: adjustedRecord.personName ?? null,
    owner: adjustedRecord.owner ?? null,
    cadenceName: adjustedRecord.cadenceName ?? null,
    cadenceStage: adjustedRecord.cadenceStage ?? null,
    recommendedNextCadenceStage: adjustedRecord.recommendedNextCadenceStage ?? null,
    latestTouchChannel: adjustedRecord.latestTouchChannel ?? null,
    latestTouchStatus: adjustedRecord.latestTouchStatus ?? null,
    currentInitialTaskId: adjustedRecord.currentInitialTaskId ?? null,
    recommendedTaskTitle: adjustedRecord.recommendedTaskTitle ?? null,
    recommendedDueDate: adjustedRecord.recommendedDueDate ?? null,
    originalRecommendedDueDate: adjustedRecord.originalRecommendedDueDate ?? null,
    dueDateAdjusted: Boolean(adjustedRecord.dueDateAdjusted),
    dueDateAdjustmentReason: adjustedRecord.dueDateAdjustmentReason ?? null,
    recommendedTaskType: adjustedRecord.recommendedTaskType ?? null,
    confidence: adjustedRecord.confidence ?? null,
    safeToCreate: Boolean(adjustedRecord.safeToCreate),
    isTestRecord: Boolean(adjustedRecord.isTestRecord),
    testRecordReasons: adjustedRecord.testRecordReasons ?? [],
    warnings: adjustedRecord.warnings ?? [],
    evidence: adjustedRecord.evidence ?? [],
    companyId: companyId || null,
    companyTargetEnabled: Boolean(linkCompany && companyId),
    personStageUpdateEnabled: Boolean(updatePersonStage),
    personStagePayload: updatePersonStage
      ? {
          cadenceStage: adjustedRecord.recommendedNextCadenceStage
        }
      : null,
    dedupeKey,
    correlationId,
    status: skippedReason ? 'skipped' : 'planned',
    skippedReason,
    taskPayload,
    generatedAt: now.toISOString()
  };
}

function isRecoverableApplyOperation(operation = {}) {
  if (['failed', 'verification_failed'].includes(operation.status)) {
    return true;
  }

  return operation.status === 'skipped' && /repeated failures/i.test(operation.skippedReason ?? '');
}

function operationToPlanRecord(operation = {}) {
  if (!operation.personId) {
    return null;
  }

  return {
    personId: operation.personId,
    personName: operation.personName ?? null,
    owner: operation.taskPayload?.assigneeId
      ? {
          id: operation.taskPayload.assigneeId,
          workspaceMemberId: operation.taskPayload.assigneeId
        }
      : null,
    cadenceName: operation.cadenceName,
    cadenceStage: operation.oldCadenceStage ?? operation.cadenceStage,
    recommendedNextCadenceStage: operation.recommendedNextCadenceStage,
    latestTouchStatus: operation.latestTouchStatus,
    currentInitialTaskId: operation.currentInitialTaskId ?? null,
    recommendedTaskTitle: operation.recommendedTaskTitle,
    recommendedDueDate: operation.recommendedDueDate,
    originalRecommendedDueDate: operation.originalRecommendedDueDate ?? null,
    dueDateAdjusted: Boolean(operation.dueDateAdjusted),
    dueDateAdjustmentReason: operation.dueDateAdjustmentReason ?? null,
    recommendedTaskType: operation.recommendedTaskType,
    safeToCreate: true,
    isTestRecord: false,
    testRecordReasons: [],
    evidence: ['Recovered from latest sent-initial follow-up apply output.'],
    warnings: []
  };
}

export function buildSentInitialFollowUpTaskPayload({ record = {}, dedupeKey, now = new Date() } = {}) {
  const payload = {
    title: record.recommendedTaskTitle,
    status: 'TODO',
    dueAt: record.recommendedDueDate,
    bodyV2: {
      markdown: buildSentInitialFollowUpMarkdown({
        record,
        dedupeKey,
        now
      })
    }
  };
  const assigneeId = firstString(record.owner?.workspaceMemberId, record.owner?.id);

  if (assigneeId) {
    payload.assigneeId = assigneeId;
  }

  return stripEmpty(payload);
}

function getOperationSkippedReason({ record, taskPayload }) {
  if (!record.personId) {
    return 'Missing Person ID.';
  }

  if (normalizeSelect(record.latestTouchStatus) !== 'SENT') {
    return 'Latest touch status is not SENT.';
  }

  if (!record.recommendedTaskTitle) {
    return 'Missing recommended task title.';
  }

  if (!record.recommendedDueDate) {
    return 'Missing recommended due date.';
  }

  if (!record.cadenceName || !record.recommendedNextCadenceStage || !record.recommendedTaskType) {
    return 'Missing cadence, next stage, or task type context.';
  }

  if (isExcludedRecordState(record)) {
    return 'Record is terminal, paused, active-client, unqualified, or declined.';
  }

  if (Object.keys(taskPayload).length === 0) {
    return 'No Task payload to create.';
  }

  return null;
}

async function createPersonTaskTargetIfMissing({ client, operation, taskId }) {
  const existing = await findExistingTaskTarget({
    client,
    taskId,
    targetPersonId: operation.personId
  });

  if (existing) {
    return {
      ...existing,
      duplicateSkipped: true
    };
  }

  return client.createRecord('taskTargets', {
    taskId,
    targetPersonId: operation.personId
  });
}

async function createCompanyTaskTargetIfMissing({ client, operation, taskId }) {
  const existing = await findExistingTaskTarget({
    client,
    taskId,
    targetCompanyId: operation.companyId
  });

  if (existing) {
    return {
      ...existing,
      duplicateSkipped: true
    };
  }

  return client.createRecord('taskTargets', {
    taskId,
    targetCompanyId: operation.companyId
  });
}

async function updatePersonStageIfEnabled({ client, operation }) {
  if (!operation.personStagePayload) {
    return null;
  }

  return client.updateRecord('people', operation.personId, operation.personStagePayload);
}

async function executeSentInitialFollowUpOperationWithRetry({
  client,
  operation,
  options,
  sleep
}) {
  let attempt = 0;
  let lastRetryAfterSeconds = null;

  while (true) {
    try {
      const result = await executeSentInitialFollowUpOperation({
        client,
        operation
      });

      return {
        ...result,
        retryAttempts: attempt,
        retryAfterSeconds: lastRetryAfterSeconds
      };
    } catch (error) {
      if (!shouldRetryTwentyError(error, options) || attempt >= options.maxRetryAttempts) {
        error.retryAttempts = attempt;
        error.retryAfterSeconds = lastRetryAfterSeconds ?? getRetryAfterSeconds(error, options);
        throw error;
      }

      attempt += 1;
      const retryAfterSeconds = getRetryAfterSeconds(error, options);
      lastRetryAfterSeconds = retryAfterSeconds;
      await sleep(retryAfterSeconds * 1000);
    }
  }
}

async function executeSentInitialFollowUpOperation({ client, operation }) {
  const existingTask = await findExistingTaskByDedupeKey({
    client,
    dedupeKey: operation.dedupeKey
  });

  if (!existingTask) {
    const openFollowUp = await findOpenPostInitialFollowUpTaskForPerson({
      client,
      personId: operation.personId
    });

    if (openFollowUp) {
      return {
        skippedReason: 'Open post-initial follow-up Task already exists for Person.',
        existingTask: summarizeTask(openFollowUp)
      };
    }
  }

  const task = existingTask ?? (await client.createRecord('tasks', operation.taskPayload));
  const personTarget = await createPersonTaskTargetIfMissing({
    client,
    operation,
    taskId: task.id
  });
  const companyTarget =
    operation.companyId && operation.companyTargetEnabled
      ? await createCompanyTaskTargetIfMissing({
          client,
          operation,
          taskId: task.id
        })
      : null;
  const personStageUpdate = operation.personStageUpdateEnabled
    ? await updatePersonStageIfEnabled({
        client,
        operation
      })
    : null;
  const verification = await verifySentInitialFollowUp({
    client,
    operation,
    taskId: task.id
  });

  return {
    task,
    personTarget,
    companyTarget,
    personStageUpdate,
    duplicateTaskSkipped: Boolean(existingTask),
    verification
  };
}

async function verifySentInitialFollowUp({ client, operation, taskId }) {
  const [task, taskTargets, person] = await Promise.all([
    client.getRecord ? client.getRecord('tasks', taskId) : Promise.resolve({ id: taskId }),
    listTaskTargetsForTask(client, taskId),
    operation.personStageUpdateEnabled && client.getRecord
      ? client.getRecord('people', operation.personId)
      : Promise.resolve(null)
  ]);
  const personTarget = taskTargets.find(
    (target) => String(target.targetPersonId ?? '') === String(operation.personId ?? '')
  );
  const companyTarget = operation.companyTargetEnabled
    ? taskTargets.find(
        (target) => String(target.targetCompanyId ?? '') === String(operation.companyId ?? '')
      )
    : null;
  const personStageVerified = operation.personStageUpdateEnabled
    ? normalizeSelect(person?.cadenceStage) === normalizeSelect(operation.recommendedNextCadenceStage)
    : true;

  return {
    ok:
      Boolean(task?.id) &&
      Boolean(personTarget) &&
      (!operation.companyTargetEnabled || Boolean(companyTarget)) &&
      personStageVerified,
    expectedTaskId: taskId,
    actualTaskId: task?.id ?? null,
    expectedTargetPersonId: operation.personId,
    actualTargetPersonId: personTarget?.targetPersonId ?? null,
    expectedTargetCompanyId: operation.companyTargetEnabled ? operation.companyId : null,
    actualTargetCompanyId: companyTarget?.targetCompanyId ?? null,
    personStageUpdateExpected: operation.personStageUpdateEnabled,
    expectedPersonCadenceStage: operation.personStageUpdateEnabled ? operation.recommendedNextCadenceStage : null,
    actualPersonCadenceStage: person?.cadenceStage ?? null,
    personStageVerified,
    taskTargetIds: taskTargets.map((target) => target.id).filter(Boolean)
  };
}

async function findOpenPostInitialFollowUpTaskForPerson({ client, personId }) {
  const [tasks, taskTargets] = await Promise.all([
    listAllRecords(client, 'tasks'),
    listAllRecords(client, 'taskTargets')
  ]);

  return tasks.find((task) => {
    if (!isOpenTask(task) || !isPostInitialFollowUpTask(task)) {
      return false;
    }

    if (taskBodyIncludesPersonId(task, personId)) {
      return true;
    }

    return taskTargets.some(
      (target) =>
        String(target.taskId ?? '') === String(task.id ?? '') &&
        String(target.targetPersonId ?? '') === String(personId ?? '')
    );
  }) ?? null;
}

async function findExistingTaskByDedupeKey({ client, dedupeKey }) {
  const tasks = await listAllRecords(client, 'tasks');

  return tasks.find((task) => taskBodyIncludesDedupeKey(task, dedupeKey)) ?? null;
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
  const taskTargets = await listAllRecords(client, 'taskTargets');

  return taskTargets.filter((target) => String(target.taskId ?? '') === String(taskId ?? ''));
}

async function listAllRecords(client, objectPlural) {
  if (typeof client.listAllRecords === 'function') {
    const result = await client.listAllRecords(objectPlural, {
      pageSize: 100,
      maxPages: 10
    });

    return result.records ?? result ?? [];
  }

  return client.listRecords(objectPlural, {
    limit: 100
  });
}

function buildSentInitialFollowUpCrmSyncLogEntry({ operation, status, startedAt }) {
  return {
    assessmentSubmissionId: null,
    workflowJobId: null,
    correlationId: operation.correlationId,
    provider: 'twenty',
    objectName: 'task',
    action: 'sent_initial_follow_up_create',
    dedupeKey: operation.dedupeKey,
    status,
    attempt: 1,
    requestPayload: {
      taskPayload: operation.taskPayload,
      personTarget: {
        targetPersonId: operation.personId
      },
      companyTarget: operation.companyTargetEnabled
        ? {
            targetCompanyId: operation.companyId
          }
        : null,
      personStagePayload: operation.personStagePayload
    },
    responsePayload: null,
    errorPayload: null,
    startedAt,
    finishedAt: status === 'dry_run' ? startedAt : null
  };
}

function buildSentInitialFollowUpOutboundEventEntry({ operation, status, now }) {
  return {
    assessmentSubmissionId: null,
    correlationId: operation.correlationId,
    eventType: 'sent_initial_follow_up_created',
    channel: 'task',
    status,
    actorType: 'system',
    requiresApproval: false,
    payload: {
      personId: operation.personId,
      personName: operation.personName,
      cadenceName: operation.cadenceName,
      oldCadenceStage: operation.cadenceStage,
      recommendedNextCadenceStage: operation.recommendedNextCadenceStage,
      recommendedTaskType: operation.recommendedTaskType,
      recommendedTaskTitle: operation.recommendedTaskTitle,
      recommendedDueDate: operation.recommendedDueDate,
      originalRecommendedDueDate: operation.originalRecommendedDueDate,
      dueDateAdjusted: operation.dueDateAdjusted,
      dueDateAdjustmentReason: operation.dueDateAdjustmentReason,
      currentInitialTaskId: operation.currentInitialTaskId,
      personStageUpdateEnabled: operation.personStageUpdateEnabled,
      dedupeKey: operation.dedupeKey,
      owner: operation.owner,
      taskPayload: operation.taskPayload
    },
    approvalPayload: null,
    errorPayload: null,
    scheduledFor: operation.recommendedDueDate ?? now.toISOString()
  };
}

function summarizeSentInitialFollowUpOperationResults(summary) {
  return {
    planned: summary.planned ?? 0,
    attempted: summary.attempted ?? 0,
    succeeded: summary.succeeded ?? 0,
    failed: summary.failed ?? 0,
    verificationFailed: summary.verificationFailed ?? 0,
    skipped: summary.skipped ?? 0,
    taskIdsCreated: summary.taskIdsCreated ?? [],
    personIdsAffected: summary.personIdsAffected ?? [],
    auditIds: summary.auditIds ?? [],
    outboundEventIds: summary.outboundEventIds ?? []
  };
}

function summarizeSentInitialFollowUpLiveResults(results = []) {
  return summarizeSentInitialFollowUpOperationResults({
    planned: 0,
    attempted: results.filter((result) =>
      ['verification_succeeded', 'verification_failed', 'failed'].includes(result.status)
    ).length,
    succeeded: results.filter((result) => result.status === 'verification_succeeded').length,
    failed: results.filter((result) => result.status === 'failed').length,
    verificationFailed: results.filter((result) => result.status === 'verification_failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    taskIdsCreated: results
      .filter((result) => result.status === 'verification_succeeded' && !result.duplicateTaskSkipped)
      .map((result) => result.task?.id)
      .filter(Boolean),
    personIdsAffected: results
      .filter((result) => result.status === 'verification_succeeded')
      .map((result) => result.personId)
      .filter(Boolean),
    auditIds: results.map((result) => result.audit?.id).filter(Boolean),
    outboundEventIds: results.map((result) => result.outboundEvent?.id).filter(Boolean)
  });
}

function buildSentInitialFollowUpMarkdown({ record = {}, dedupeKey, now = new Date() }) {
  return [
    'Source: Sent initial follow-up planner',
    `Person ID: ${record.personId}`,
    `Current initial Task ID: ${record.currentInitialTaskId ?? 'Not resolved'}`,
    `Dedupe key: ${dedupeKey}`,
    `Idempotency key: ${dedupeKey}`,
    `Cadence: ${record.cadenceName}`,
    `Previous cadence stage: ${record.cadenceStage}`,
    `Next cadence stage: ${record.recommendedNextCadenceStage}`,
    `Task type: ${record.recommendedTaskType}`,
    `Original recommended due date: ${record.originalRecommendedDueDate ?? 'Not provided'}`,
    `Recommended due date: ${record.recommendedDueDate ?? 'Not provided'}`,
    `Due date adjusted: ${record.dueDateAdjusted ? 'true' : 'false'}`,
    `Due date adjustment reason: ${record.dueDateAdjustmentReason ?? 'none'}`,
    `Latest touch channel: ${record.latestTouchChannel ?? 'Not provided'}`,
    `Latest touch status: ${record.latestTouchStatus ?? 'Not provided'}`,
    '',
    `Person: ${record.personName ?? 'Unknown person'}`,
    `Owner: ${record.owner?.email ?? record.owner?.name ?? 'Unresolved'}`,
    `Planner generated at: ${now.toISOString()}`,
    '',
    'Planner evidence:',
    ...(record.evidence ?? []).map((item) => `- ${item}`),
    '',
    (record.warnings ?? []).length > 0
      ? ['Planner warnings:', ...(record.warnings ?? []).map((item) => `- ${item}`)].join('\n')
      : 'Planner warnings: None',
    '',
    'Manual action required. Do not automate LinkedIn requests or messages.'
  ].join('\n');
}

function buildGuardState(options) {
  return {
    applyEnabled: options.applyEnabled,
    liveTest: options.liveTest,
    updatePersonStage: options.updatePersonStage,
    linkCompany: options.linkCompany,
    includeReview: options.includeReview,
    includeTestRecords: options.includeTestRecords,
    force: options.force,
    writeDelayMs: options.writeDelayMs,
    retryAfter429: options.retryAfter429,
    maxRetryAttempts: options.maxRetryAttempts,
    retryFallbackMs: options.retryFallbackMs,
    batchSize: options.batchSize,
    batchSizeProvided: options.batchSizeProvided,
    offset: options.offset
  };
}

function determineSentInitialFollowUpStatus(summary = {}) {
  const failed = (summary.failed ?? 0) + (summary.verificationFailed ?? 0);
  const succeeded = summary.succeeded ?? 0;

  if (failed > 0 && succeeded > 0) {
    return 'partial_success';
  }

  if (failed > 0) {
    return 'failed';
  }

  return 'succeeded';
}

function buildRecommendedNextCommand({ summary = {}, options = {} } = {}) {
  const failed = (summary.failed ?? 0) + (summary.verificationFailed ?? 0);

  if (failed > 0) {
    return 'SENT_INITIAL_FOLLOW_UP_APPLY_ENABLED=true LIVE_TEST=true npm run queues:recover-sent-initial-follow-ups';
  }

  const nextOffset = (options.offset ?? 0) + (options.batchSize ?? 0);

  return `SENT_INITIAL_FOLLOW_UP_APPLY_ENABLED=true LIVE_TEST=true SENT_INITIAL_FOLLOW_UP_BATCH_SIZE=${options.batchSize ?? 10} SENT_INITIAL_FOLLOW_UP_OFFSET=${nextOffset} npm run queues:apply-sent-initial-follow-ups`;
}

function getMaxRetryAfterSeconds(results = []) {
  const values = results
    .map((result) => result.retryAfterSeconds ?? result.error?.retryAfterSeconds)
    .filter((value) => Number.isFinite(Number(value)))
    .map(Number);

  return values.length > 0 ? Math.max(...values) : null;
}

function shouldRetryTwentyError(error, options = {}) {
  const status = getHttpStatus(error);

  if (status === 429 && options.retryAfter429) {
    return true;
  }

  return [502, 503, 504].includes(status);
}

function getRetryAfterSeconds(error, options = {}) {
  const headerValue =
    error?.twentyDiagnostics?.headers?.['retry-after'] ??
    error?.twentyDiagnostics?.headers?.['Retry-After'] ??
    error?.response?.headers?.['retry-after'] ??
    error?.response?.headers?.['Retry-After'];
  const parsedHeader = Number(headerValue);

  if (Number.isFinite(parsedHeader) && parsedHeader > 0) {
    return parsedHeader;
  }

  return Math.max(1, Math.ceil((options.retryFallbackMs ?? 60000) / 1000));
}

function getHttpStatus(error) {
  return Number(error?.twentyDiagnostics?.httpStatus ?? error?.response?.status ?? error?.httpStatus);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExcludedRecordState(record = {}) {
  return [
    record.cadenceStage,
    record.latestTouchStatus === 'SENT' ? null : record.latestTouchStatus,
    record.leadstageAuto,
    record.discoveryReadiness
  ].some((value) => EXCLUDED_STATES.has(normalizeSelect(value)));
}

function isOpenTask(task = {}) {
  return OPEN_TASK_STATUSES.has(normalizeSelect(task.status));
}

function isPostInitialFollowUpTask(task = {}) {
  const text = getTaskClassificationText(task);

  return (
    POST_INITIAL_CADENCE_STAGES.has(normalizeSelect(readMarkdownValue(getTaskBody(task), 'Next cadence stage'))) ||
    POST_INITIAL_CADENCE_STAGES.has(normalizeSelect(readMarkdownValue(getTaskBody(task), 'Cadence stage'))) ||
    POST_INITIAL_CADENCE_STAGES.has(normalizeSelect(task.cadenceStage)) ||
    POST_INITIAL_TASK_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function taskBodyIncludesPersonId(task = {}, personId) {
  const body = getTaskBody(task);
  return String(body).includes(`Person ID: ${personId}`) || String(task.personId ?? '') === String(personId ?? '');
}

function taskBodyIncludesDedupeKey(task = {}, dedupeKey) {
  const body = getTaskBody(task);
  return (
    String(body).includes(`Idempotency key: ${dedupeKey}`) ||
    String(body).includes(`Dedupe key: ${dedupeKey}`)
  );
}

function getTaskClassificationText(task = {}) {
  return [
    task.title,
    task.taskType,
    task.cadenceStage,
    task.latestTouchStatus,
    getTaskBody(task)
  ]
    .filter(Boolean)
    .join(' ');
}

function getTaskBody(task = {}) {
  if (typeof task.bodyV2 === 'string') {
    return task.bodyV2;
  }

  return task.bodyV2?.markdown ?? task.body ?? task.description ?? '';
}

function readMarkdownValue(body, label) {
  if (!body) {
    return null;
  }

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`^${escapedLabel}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() ?? null;
}

function summarizeTask(task = {}) {
  return {
    id: task.id ?? null,
    title: task.title ?? task.name ?? null,
    status: task.status ?? null,
    dueAt: task.dueAt ?? task.dueDate ?? null
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

function normalizeSelect(value) {
  return String(value ?? '').trim().toUpperCase();
}

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function stripEmpty(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

function toErrorPayload(error) {
  return {
    message: error.message,
    code: error.code,
    httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status,
    responseBody: error.twentyDiagnostics?.responseBody ?? error.response?.data
  };
}
