import { randomUUID } from 'node:crypto';
import { createTwentyRestClient } from '../../integrations/twenty/restClient.js';
import { createOperationalStore } from '../../persistence/operationalStore.js';
import { invalidateWorkspaceSnapshot } from '../../services/workspaceSnapshotService.js';

const REPEATED_FAILURE_LIMIT = 2;
const DEFAULT_OWNER_JOIN_COLUMN = 'ownerId';

export function planLegacyOwnerCleanup({
  retrofitPlan = {},
  forceOverwrite = false,
  now = new Date()
} = {}) {
  const ownerMetadata = retrofitPlan.metadata?.fields?.owner ?? null;
  const ownerJoinColumnName = ownerMetadata?.joinColumnName ?? DEFAULT_OWNER_JOIN_COLUMN;
  const recommendations = (retrofitPlan.plans ?? [])
    .map((record) =>
      buildOwnerCleanupPlanRecord({
        record,
        ownerJoinColumnName,
        forceOverwrite
      })
    )
    .filter(Boolean);
  const warnings = [];

  if (ownerJoinColumnName !== DEFAULT_OWNER_JOIN_COLUMN) {
    warnings.push(
      `Person owner join column is ${ownerJoinColumnName}; expected ${DEFAULT_OWNER_JOIN_COLUMN}. Review before live apply.`
    );
  }

  return {
    status: 'dry_run',
    dryRun: true,
    generatedAt: now.toISOString(),
    metadata: {
      owner: ownerMetadata,
      payloadShape: {
        method: 'PATCH',
        objectPlural: 'people',
        relationField: 'owner',
        joinColumnName: ownerJoinColumnName,
        examplePayload: {
          [ownerJoinColumnName]: '<workspaceMemberId>'
        }
      }
    },
    summary: summarizeOwnerCleanupPlan(recommendations),
    warnings,
    recommendations
  };
}

export async function applyLegacyOwnerCleanup({
  plan = {},
  config = {},
  options = {},
  restClient,
  operationalStore,
  log,
  now = new Date()
} = {}) {
  const normalizedOptions = normalizeOwnerApplyOptions(options);
  const liveEnabled = Boolean(normalizedOptions.applyEnabled && normalizedOptions.liveTest);
  const selected = selectOwnerApplyCandidates(plan, normalizedOptions);
  const operations = selected.map((record) =>
    buildOwnerApplyOperation({
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
      summary: summarizeOwnerOperationResults({
        planned: operations.filter((operation) => operation.status === 'planned').length,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        verificationFailed: 0,
        skipped: operations.filter((operation) => operation.status === 'skipped').length
      }),
      operations,
      warnings: [
        'Legacy owner cleanup apply is in dry-run mode. Set LEGACY_OWNER_APPLY_ENABLED=true and LIVE_TEST=true to write.'
      ]
    };
  }

  if (!config.twenty?.apiKey && !restClient) {
    const error = new Error('TWENTY_API_KEY is required for live legacy owner cleanup apply.');
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
    const auditBase = buildOwnerCrmSyncLogEntry({
      operation,
      status: 'planned',
      startedAt
    });
    const eventBase = buildOwnerOutboundEventEntry({
      operation,
      status: 'planned',
      now
    });

    try {
      const response = await client.updateRecord('people', operation.personId, operation.payload);
      const verification = await verifyOwnerUpdate({
        client,
        operation
      });
      const finishedAt = new Date().toISOString();
      const succeeded = verification.ok;
      const audit = await store.appendCrmSyncLog({
        ...auditBase,
        status: succeeded ? 'succeeded' : 'failed',
        responsePayload: {
          update: response,
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
            personId: response?.id ?? operation.personId
          },
          verification
        },
        errorPayload: succeeded ? null : verification
      });

      consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
      results.push({
        ...operation,
        status: succeeded ? 'succeeded' : 'verification_failed',
        response,
        verification,
        audit,
        outboundEvent
      });
    } catch (error) {
      consecutiveFailures += 1;
      const finishedAt = new Date().toISOString();
      const errorPayload = toErrorPayload(error);
      const audit = await store.appendCrmSyncLog({
        ...auditBase,
        status: 'failed',
        errorPayload,
        finishedAt
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

  const summary = summarizeOwnerLiveResults(results);

  if ((summary.succeeded ?? 0) > 0) {
    invalidateWorkspaceSnapshot('legacy_owner_cleanup_apply');
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

export function normalizeOwnerApplyOptions(options = {}) {
  return {
    applyEnabled: toBoolean(options.applyEnabled),
    liveTest: toBoolean(options.liveTest),
    forceOverwrite: toBoolean(options.forceOverwrite),
    batchSize: normalizePositiveInt(options.batchSize, 5),
    offset: normalizeNonNegativeInt(options.offset, 0)
  };
}

export function selectOwnerApplyCandidates(plan = {}, options = {}) {
  const normalizedOptions = normalizeOwnerApplyOptions(options);
  const candidates = (plan.recommendations ?? []).filter((record) =>
    normalizedOptions.forceOverwrite ? record.safeToUpdate === true : record.safeToUpdate === true && !record.currentOwnerId
  );

  return candidates.slice(
    normalizedOptions.offset,
    normalizedOptions.offset + normalizedOptions.batchSize
  );
}

export function buildOwnerApplyOperation({ record, now = new Date() }) {
  const payload = buildOwnerUpdatePayload(record);
  const correlationId = `legacy-owner-cleanup:${record.personId}:${randomUUID()}`;
  const skippedReason = !record.personId
    ? 'Missing Person ID.'
    : !record.recommendedOwnerId
      ? 'Missing recommended owner ID.'
      : Object.keys(payload).length === 0
        ? 'No owner payload to update.'
        : null;

  return {
    personId: record.personId ?? null,
    name: record.name ?? null,
    correlationId,
    status: skippedReason ? 'skipped' : 'planned',
    skippedReason,
    payload,
    currentOwnerId: record.currentOwnerId ?? null,
    currentOwnerName: record.currentOwnerName ?? null,
    createdByName: record.createdByName ?? null,
    recommendedOwnerId: record.recommendedOwnerId ?? null,
    recommendedOwnerName: record.recommendedOwnerName ?? null,
    recommendedOwnerEmail: record.recommendedOwnerEmail ?? null,
    generatedAt: now.toISOString()
  };
}

export function buildOwnerUpdatePayload(record = {}) {
  return record.recommendedOwnerId
    ? {
        ownerId: record.recommendedOwnerId
      }
    : {};
}

function buildOwnerCleanupPlanRecord({ record = {}, ownerJoinColumnName, forceOverwrite }) {
  const recommendation = record.ownerRecommendation;
  const futureOwnerRecommendation = recommendation?.futureOwnerRecommendation;
  const recommendedOwnerId =
    futureOwnerRecommendation?.[ownerJoinColumnName] ??
    futureOwnerRecommendation?.ownerId ??
    recommendation?.recommendedOwnerWorkspaceMemberId ??
    null;
  const currentOwnerId = record.ownerId ?? null;
  const currentOwnerName = currentOwnerId ? record.ownerName ?? null : null;

  if (!recommendation || !recommendedOwnerId) {
    return null;
  }

  if (currentOwnerId && !forceOverwrite) {
    return {
      personId: record.personId,
      name: record.name,
      currentOwnerId,
      currentOwnerName,
      createdByName: record.createdByName ?? null,
      recommendedOwnerId,
      recommendedOwnerName: recommendation.recommendedOwnerName ?? record.inferredOwnerName ?? null,
      recommendedOwnerEmail: recommendation.recommendedOwnerEmail ?? record.inferredOwnerEmail ?? null,
      reason: 'Existing owner present; skipped unless LEGACY_OWNER_FORCE_OVERWRITE=true.',
      safeToUpdate: false,
      warnings: ['Existing owner present; owner cleanup will not overwrite by default.']
    };
  }

  return {
    personId: record.personId,
    name: record.name,
    currentOwnerId,
    currentOwnerName,
    createdByName: record.createdByName ?? null,
    recommendedOwnerId,
    recommendedOwnerName: recommendation.recommendedOwnerName ?? record.inferredOwnerName ?? null,
    recommendedOwnerEmail: recommendation.recommendedOwnerEmail ?? record.inferredOwnerEmail ?? null,
    reason: currentOwnerId
      ? 'Existing owner overwrite explicitly requested.'
      : `Owner missing; inferred from Created By ${record.createdByName ?? 'unknown'}.`,
    safeToUpdate: Boolean(record.personId && recommendedOwnerId && (!currentOwnerId || forceOverwrite)),
    warnings: []
  };
}

function summarizeOwnerCleanupPlan(recommendations = []) {
  return {
    totalRecommendations: recommendations.length,
    safeToUpdate: recommendations.filter((record) => record.safeToUpdate).length,
    skippedExistingOwner: recommendations.filter((record) =>
      record.warnings?.some((warning) => /Existing owner/.test(warning))
    ).length,
    byRecommendedOwnerEmail: countByValue(
      recommendations.filter((record) => record.recommendedOwnerEmail),
      (record) => record.recommendedOwnerEmail
    ),
    byCreatedBy: countByValue(recommendations, (record) => record.createdByName ?? 'Missing Created By')
  };
}

async function verifyOwnerUpdate({ client, operation }) {
  const record = await client.getRecord('people', operation.personId);
  const actualOwnerId = record?.ownerId ?? record?.owner?.id ?? null;
  const ok = String(actualOwnerId ?? '') === String(operation.recommendedOwnerId ?? '');

  return {
    ok,
    expectedOwnerId: operation.recommendedOwnerId,
    actualOwnerId,
    personId: operation.personId
  };
}

function buildOwnerCrmSyncLogEntry({ operation, status, startedAt }) {
  return {
    assessmentSubmissionId: null,
    workflowJobId: null,
    correlationId: operation.correlationId,
    provider: 'twenty',
    objectName: 'person',
    action: 'legacy_owner_cleanup_update',
    dedupeKey: `legacy-owner-cleanup:person:${operation.personId}`,
    status,
    attempt: 1,
    requestPayload: {
      id: operation.personId,
      object: 'people',
      payload: operation.payload
    },
    responsePayload: null,
    errorPayload: null,
    startedAt,
    finishedAt: status === 'dry_run' ? startedAt : null
  };
}

function buildOwnerOutboundEventEntry({ operation, status, now }) {
  return {
    assessmentSubmissionId: null,
    correlationId: operation.correlationId,
    eventType: 'legacy_owner_cleanup_applied',
    channel: 'crm',
    status,
    actorType: 'system',
    requiresApproval: false,
    payload: {
      personId: operation.personId,
      name: operation.name,
      payload: operation.payload,
      currentOwnerId: operation.currentOwnerId,
      currentOwnerName: operation.currentOwnerName,
      createdByName: operation.createdByName,
      recommendedOwnerId: operation.recommendedOwnerId,
      recommendedOwnerName: operation.recommendedOwnerName,
      recommendedOwnerEmail: operation.recommendedOwnerEmail
    },
    approvalPayload: null,
    errorPayload: null,
    scheduledFor: now.toISOString()
  };
}

function summarizeOwnerOperationResults(summary) {
  return {
    planned: summary.planned ?? 0,
    attempted: summary.attempted ?? 0,
    succeeded: summary.succeeded ?? 0,
    failed: summary.failed ?? 0,
    verificationFailed: summary.verificationFailed ?? 0,
    skipped: summary.skipped ?? 0,
    personIdsUpdated: summary.personIdsUpdated ?? [],
    auditIds: summary.auditIds ?? [],
    outboundEventIds: summary.outboundEventIds ?? []
  };
}

function summarizeOwnerLiveResults(results = []) {
  return summarizeOwnerOperationResults({
    planned: 0,
    attempted: results.filter((result) =>
      ['succeeded', 'failed', 'verification_failed'].includes(result.status)
    ).length,
    succeeded: results.filter((result) => result.status === 'succeeded').length,
    failed: results.filter((result) => result.status === 'failed').length,
    verificationFailed: results.filter((result) => result.status === 'verification_failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    personIdsUpdated: results
      .filter((result) => result.status === 'succeeded')
      .map((result) => result.response?.id ?? result.personId)
      .filter(Boolean),
    auditIds: results.map((result) => result.audit?.id).filter(Boolean),
    outboundEventIds: results.map((result) => result.outboundEvent?.id).filter(Boolean)
  });
}

function buildGuardState(options) {
  return {
    applyEnabled: options.applyEnabled,
    liveTest: options.liveTest,
    forceOverwrite: options.forceOverwrite,
    batchSize: options.batchSize,
    offset: options.offset
  };
}

function countByValue(records, getValue) {
  return records.reduce((acc, record) => {
    const key = getValue(record);

    if (!key) {
      return acc;
    }

    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
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
