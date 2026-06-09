import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createSupabaseClient } from '../../integrations/supabase/client.js';

export const DEFAULT_SENT_INITIAL_FOLLOW_UP_APPLY_OUTPUT_PATH =
  'data/sent-initial-follow-up-apply-latest.json';
export const DEFAULT_SENT_INITIAL_FOLLOW_UP_RECOVERY_OUTPUT_PATH =
  'data/sent-initial-follow-up-recovery-latest.json';

export function buildSentInitialFollowUpApplyOutput({
  result = {},
  kind = 'apply',
  recoveryPlan,
  generatedAt = new Date(),
  correlationId = `sent-initial-follow-up-${kind}:${randomUUID()}`
} = {}) {
  const operations = (result.operations ?? []).map(mapSentInitialFollowUpOperationForOutput);

  return stripUndefined({
    ok: result.status !== 'failed',
    kind,
    status: result.status,
    dryRun: result.dryRun,
    liveEnabled: result.liveEnabled,
    timestamp: generatedAt.toISOString(),
    generatedAt: generatedAt.toISOString(),
    correlationId,
    operationCorrelationIds: operations.map((operation) => operation.correlationId).filter(Boolean),
    sourceApplyStatus: recoveryPlan?.sourceApplyStatus,
    recoverableOperationCount: recoveryPlan?.recoverableOperationCount,
    guard: result.guard,
    summary: {
      ...result.summary,
      auditIds: result.summary?.auditIds ?? operations.map((operation) => operation.auditId).filter(Boolean),
      outboundEventIds:
        result.summary?.outboundEventIds ??
        operations.map((operation) => operation.outboundEventId).filter(Boolean)
    },
    retryAfterSeconds: result.retryAfterSeconds,
    recommendedNextCommand: result.recommendedNextCommand,
    nextRecommendedCommand: result.nextRecommendedCommand,
    eligibleCount: result.eligibleCount,
    selectedCount: result.selectedCount,
    remainingEligibleCount: result.remainingEligibleCount,
    currentEligibleCount: result.currentEligibleCount,
    skippedExistingCount: result.skippedExistingCount,
    currentEligibilityChecked: result.currentEligibilityChecked,
    warnings: result.warnings ?? [],
    operations
  });
}

export function mapSentInitialFollowUpOperationForOutput(operation = {}) {
  return stripUndefined({
    correlationId: operation.correlationId,
    personId: operation.personId,
    personName: operation.personName,
    cadenceName: operation.cadenceName,
    oldCadenceStage: operation.oldCadenceStage ?? operation.cadenceStage,
    recommendedNextCadenceStage: operation.recommendedNextCadenceStage,
    latestTouchStatus: operation.latestTouchStatus,
    currentInitialTaskId: operation.currentInitialTaskId,
    recommendedTaskTitle: operation.recommendedTaskTitle,
    recommendedDueDate: operation.recommendedDueDate,
    originalRecommendedDueDate: operation.originalRecommendedDueDate,
    dueDateAdjusted: operation.dueDateAdjusted,
    dueDateAdjustmentReason: operation.dueDateAdjustmentReason,
    recommendedTaskType: operation.recommendedTaskType,
    personStageUpdateEnabled: operation.personStageUpdateEnabled,
    personStagePayload: operation.personStagePayload,
    status: operation.status,
    skippedReason: operation.skippedReason,
    dedupeKey: operation.dedupeKey,
    taskPayload: operation.taskPayload,
    taskId: operation.task?.id ?? operation.taskId,
    personTargetId: operation.personTarget?.id ?? operation.personTargetId,
    companyTargetId: operation.companyTarget?.id ?? operation.companyTargetId,
    personStageUpdate: operation.personStageUpdate,
    duplicateTaskSkipped: operation.duplicateTaskSkipped,
    retryAttempts: operation.retryAttempts,
    retryAfterSeconds: operation.retryAfterSeconds,
    verification: operation.verification,
    auditId: operation.audit?.id ?? operation.auditId,
    outboundEventId: operation.outboundEvent?.id ?? operation.outboundEventId,
    error: operation.error
  });
}

export async function writeSentInitialFollowUpOutputFile(outputPath, output) {
  const resolvedPath = resolve(outputPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return resolvedPath;
}

export async function loadSentInitialFollowUpApplyOutput({
  applyOutputPath = DEFAULT_SENT_INITIAL_FOLLOW_UP_APPLY_OUTPUT_PATH,
  config = {},
  supabaseClient,
  fallbackLoader = loadSentInitialFollowUpApplyOutputFromSupabase,
  now = new Date()
} = {}) {
  try {
    const output = JSON.parse(await readFile(resolve(applyOutputPath), 'utf8'));

    return {
      source: 'file',
      missingFile: false,
      output,
      warnings: []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    const fallbackOutput = await fallbackLoader({
      config,
      supabaseClient,
      now
    });

    if (fallbackOutput) {
      return {
        source: 'supabase_fallback',
        missingFile: true,
        output: fallbackOutput,
        warnings: [
          `Apply output file was not found at ${applyOutputPath}; reconstructed recovery input from Supabase audit logs.`
        ]
      };
    }

    return {
      source: 'missing',
      missingFile: true,
      output: buildMissingSentInitialFollowUpApplyOutput({
        applyOutputPath,
        now
      }),
      warnings: [
        `Apply output file was not found at ${applyOutputPath}, and no Supabase fallback logs were available.`
      ]
    };
  }
}

export async function loadSentInitialFollowUpApplyOutputFromSupabase({
  config = {},
  supabaseClient,
  limit = 25,
  now = new Date()
} = {}) {
  if (!config.supabase?.enabled && !supabaseClient) {
    return null;
  }

  const client = supabaseClient ?? createSupabaseClient(config.supabase);

  if (!client) {
    return null;
  }

  const crmResponse = await client
    .from('crm_sync_logs')
    .select('*')
    .eq('action', 'sent_initial_follow_up_create')
    .in('status', ['failed', 'skipped'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (crmResponse.error) {
    throw new Error(`Failed to read sent-initial CRM sync logs: ${crmResponse.error.message}`);
  }

  const crmSyncLogs = crmResponse.data ?? [];

  if (crmSyncLogs.length === 0) {
    const outboundResponse = await client
      .from('outbound_events')
      .select('*')
      .eq('event_type', 'sent_initial_follow_up_created')
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (outboundResponse.error) {
      throw new Error(`Failed to read sent-initial outbound events: ${outboundResponse.error.message}`);
    }

    if ((outboundResponse.data ?? []).length === 0) {
      return null;
    }

    return buildSentInitialFollowUpApplyOutputFromLogs({
      crmSyncLogs: [],
      outboundEvents: outboundResponse.data ?? [],
      generatedAt: now
    });
  }

  const correlationIds = [
    ...new Set(crmSyncLogs.map((record) => readField(record, 'correlation_id', 'correlationId')).filter(Boolean))
  ];
  let outboundEvents = [];

  if (correlationIds.length > 0) {
    const outboundResponse = await client
      .from('outbound_events')
      .select('*')
      .eq('event_type', 'sent_initial_follow_up_created')
      .in('correlation_id', correlationIds);

    if (outboundResponse.error) {
      throw new Error(`Failed to read sent-initial outbound events: ${outboundResponse.error.message}`);
    }

    outboundEvents = outboundResponse.data ?? [];
  }

  return buildSentInitialFollowUpApplyOutputFromLogs({
    crmSyncLogs,
    outboundEvents,
    generatedAt: now
  });
}

export function buildSentInitialFollowUpApplyOutputFromLogs({
  crmSyncLogs = [],
  outboundEvents = [],
  generatedAt = new Date(),
  correlationId = `sent-initial-follow-up-recovery-source:${randomUUID()}`
} = {}) {
  const eventsByCorrelationId = new Map(
    outboundEvents.map((event) => [readField(event, 'correlation_id', 'correlationId'), event])
  );
  const crmCorrelationIds = new Set(
    crmSyncLogs.map((log) => readField(log, 'correlation_id', 'correlationId')).filter(Boolean)
  );
  const operations = crmSyncLogs.map((log) => {
    const logCorrelationId = readField(log, 'correlation_id', 'correlationId');
    const event = eventsByCorrelationId.get(logCorrelationId) ?? {};
    const requestPayload = readField(log, 'request_payload', 'requestPayload') ?? {};
    const responsePayload = readField(log, 'response_payload', 'responsePayload') ?? {};
    const errorPayload = readField(log, 'error_payload', 'errorPayload') ?? null;
    const eventPayload = readField(event, 'payload') ?? {};
    const taskPayload = requestPayload.taskPayload ?? eventPayload.taskPayload ?? {};
    const personTarget = requestPayload.personTarget ?? {};

    return stripUndefined({
      correlationId: logCorrelationId,
      personId: eventPayload.personId ?? personTarget.targetPersonId ?? null,
      personName: eventPayload.personName ?? null,
      cadenceName: eventPayload.cadenceName ?? null,
      oldCadenceStage: eventPayload.oldCadenceStage ?? null,
      recommendedNextCadenceStage: eventPayload.recommendedNextCadenceStage ?? null,
      latestTouchStatus: eventPayload.latestTouchStatus ?? null,
      currentInitialTaskId: eventPayload.currentInitialTaskId ?? null,
      recommendedTaskTitle: eventPayload.recommendedTaskTitle ?? taskPayload.title ?? null,
      recommendedDueDate: eventPayload.recommendedDueDate ?? taskPayload.dueAt ?? null,
      originalRecommendedDueDate: eventPayload.originalRecommendedDueDate ?? null,
      dueDateAdjusted: eventPayload.dueDateAdjusted,
      dueDateAdjustmentReason: eventPayload.dueDateAdjustmentReason,
      recommendedTaskType: eventPayload.recommendedTaskType ?? null,
      status: normalizeLogStatus(readField(log, 'status')),
      skippedReason: responsePayload.skippedReason ?? null,
      dedupeKey: readField(log, 'dedupe_key', 'dedupeKey') ?? eventPayload.dedupeKey,
      taskPayload,
      taskId: responsePayload.task?.id ?? eventPayload.taskId ?? null,
      personTargetId: responsePayload.personTarget?.id ?? eventPayload.personTaskTargetId ?? null,
      companyTargetId: responsePayload.companyTarget?.id ?? eventPayload.companyTaskTargetId ?? null,
      personStageUpdate: responsePayload.personStageUpdate,
      duplicateTaskSkipped: responsePayload.duplicateTaskSkipped,
      retryAttempts: errorPayload?.retryAttempts ?? responsePayload.retryAttempts,
      retryAfterSeconds: errorPayload?.retryAfterSeconds ?? responsePayload.retryAfterSeconds,
      verification: responsePayload.verification ?? errorPayload,
      auditId: readField(log, 'id'),
      outboundEventId: readField(event, 'id'),
      error: errorPayload
    });
  });
  const eventOnlyOperations = outboundEvents
    .filter((event) => !crmCorrelationIds.has(readField(event, 'correlation_id', 'correlationId')))
    .map((event) => {
      const eventPayload = readField(event, 'payload') ?? {};

      return stripUndefined({
        correlationId: readField(event, 'correlation_id', 'correlationId'),
        personId: eventPayload.personId ?? null,
        personName: eventPayload.personName ?? null,
        cadenceName: eventPayload.cadenceName ?? null,
        oldCadenceStage: eventPayload.oldCadenceStage ?? null,
        recommendedNextCadenceStage: eventPayload.recommendedNextCadenceStage ?? null,
        latestTouchStatus: eventPayload.latestTouchStatus ?? null,
        currentInitialTaskId: eventPayload.currentInitialTaskId ?? null,
        recommendedTaskTitle: eventPayload.recommendedTaskTitle ?? eventPayload.taskPayload?.title ?? null,
        recommendedDueDate: eventPayload.recommendedDueDate ?? eventPayload.taskPayload?.dueAt ?? null,
        originalRecommendedDueDate: eventPayload.originalRecommendedDueDate ?? null,
        dueDateAdjusted: eventPayload.dueDateAdjusted,
        dueDateAdjustmentReason: eventPayload.dueDateAdjustmentReason,
        recommendedTaskType: eventPayload.recommendedTaskType ?? null,
        status: normalizeOutboundEventStatus(readField(event, 'status')),
        skippedReason: eventPayload.skippedReason ?? null,
        dedupeKey: eventPayload.dedupeKey,
        taskPayload: eventPayload.taskPayload,
        taskId: eventPayload.taskId ?? null,
        personTargetId: eventPayload.personTaskTargetId ?? null,
        companyTargetId: eventPayload.companyTaskTargetId ?? null,
        retryAttempts: readField(event, 'error_payload', 'errorPayload')?.retryAttempts,
        retryAfterSeconds: readField(event, 'error_payload', 'errorPayload')?.retryAfterSeconds,
        verification: readField(event, 'error_payload', 'errorPayload') ?? eventPayload.verification,
        outboundEventId: readField(event, 'id'),
        error: readField(event, 'error_payload', 'errorPayload')
      });
    });
  const allOperations = [...operations, ...eventOnlyOperations];
  const summary = summarizeOutputOperations(allOperations);

  return {
    ok: false,
    kind: 'recovery_source',
    source: 'supabase_logs',
    status: summary.succeeded > 0 && summary.failed > 0 ? 'partial_success' : 'failed',
    dryRun: false,
    liveEnabled: true,
    timestamp: generatedAt.toISOString(),
    generatedAt: generatedAt.toISOString(),
    correlationId,
    operationCorrelationIds: allOperations.map((operation) => operation.correlationId).filter(Boolean),
    summary,
    retryAfterSeconds: maxNumber(allOperations.map((operation) => operation.retryAfterSeconds)),
    recommendedNextCommand:
      'SENT_INITIAL_FOLLOW_UP_APPLY_ENABLED=true LIVE_TEST=true npm run queues:recover-sent-initial-follow-ups',
    warnings: [
      'This recovery source was reconstructed from Supabase crm_sync_logs/outbound_events because the latest apply output file was missing.'
    ],
    operations: allOperations
  };
}

export function buildMissingSentInitialFollowUpApplyOutput({
  applyOutputPath = DEFAULT_SENT_INITIAL_FOLLOW_UP_APPLY_OUTPUT_PATH,
  now = new Date()
} = {}) {
  return {
    ok: false,
    kind: 'recovery_source',
    source: 'missing',
    status: 'missing_apply_output',
    dryRun: true,
    liveEnabled: false,
    timestamp: now.toISOString(),
    generatedAt: now.toISOString(),
    correlationId: `sent-initial-follow-up-missing-output:${randomUUID()}`,
    summary: {
      planned: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      verificationFailed: 0,
      skipped: 0,
      taskIdsCreated: [],
      personIdsAffected: [],
      auditIds: [],
      outboundEventIds: []
    },
    retryAfterSeconds: null,
    recommendedNextCommand:
      'Re-run the apply command in dry-run mode or inspect Supabase crm_sync_logs for action=sent_initial_follow_up_create before recovery.',
    warnings: [
      `Missing ${applyOutputPath}. Recovery could not reconstruct operations without Supabase fallback logs.`
    ],
    operations: []
  };
}

function summarizeOutputOperations(operations = []) {
  return {
    planned: 0,
    attempted: operations.filter((operation) =>
      ['verification_succeeded', 'verification_failed', 'failed'].includes(operation.status)
    ).length,
    succeeded: operations.filter((operation) => operation.status === 'verification_succeeded').length,
    failed: operations.filter((operation) => operation.status === 'failed').length,
    verificationFailed: operations.filter((operation) => operation.status === 'verification_failed').length,
    skipped: operations.filter((operation) => operation.status === 'skipped').length,
    taskIdsCreated: operations
      .filter((operation) => operation.status === 'verification_succeeded' && !operation.duplicateTaskSkipped)
      .map((operation) => operation.taskId)
      .filter(Boolean),
    personIdsAffected: operations
      .filter((operation) => operation.status === 'verification_succeeded')
      .map((operation) => operation.personId)
      .filter(Boolean),
    auditIds: operations.map((operation) => operation.auditId).filter(Boolean),
    outboundEventIds: operations.map((operation) => operation.outboundEventId).filter(Boolean)
  };
}

function normalizeLogStatus(status) {
  if (status === 'succeeded') {
    return 'verification_succeeded';
  }

  if (status === 'skipped') {
    return 'skipped';
  }

  return 'failed';
}

function normalizeOutboundEventStatus(status) {
  if (status === 'sent') {
    return 'verification_succeeded';
  }

  if (status === 'cancelled') {
    return 'skipped';
  }

  return 'failed';
}

function readField(source = {}, ...keys) {
  for (const key of keys) {
    if (Object.hasOwn(source, key)) {
      return source[key];
    }
  }

  return undefined;
}

function maxNumber(values = []) {
  const normalized = values.filter((value) => Number.isFinite(Number(value))).map(Number);

  return normalized.length > 0 ? Math.max(...normalized) : null;
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}
