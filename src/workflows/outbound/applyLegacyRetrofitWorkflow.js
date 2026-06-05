import { randomUUID } from 'node:crypto';
import { createTwentyRestClient } from '../../integrations/twenty/restClient.js';
import { createOperationalStore } from '../../persistence/operationalStore.js';
import { PROTECTED_ASSESSMENT_FIELDS } from '../../integrations/twenty/quickCaptureClient.js';

export const LEGACY_RETROFIT_OWNER_FIELDS = [
  'owner',
  'ownerId',
  'ownerName',
  'ownerEmail',
  'ownerWorkspaceMemberId',
  'createdBy',
  'createdById',
  'createdByName',
  'createdByEmail',
  'ownerRecommendation',
  'recommendedWorkspaceEmail'
];

const REPEATED_FAILURE_LIMIT = 2;

export async function applyLegacyRetrofitPlan({
  plan,
  config = {},
  options = {},
  restClient,
  operationalStore,
  log,
  now = new Date()
} = {}) {
  const normalizedOptions = normalizeApplyOptions(options);
  const protectedValidation = validateNoProtectedFields(plan);

  if (!protectedValidation.ok) {
    const error = new Error('Legacy retrofit plan contains protected assessment fields.');
    error.code = 'LEGACY_RETROFIT_PROTECTED_FIELDS';
    error.details = protectedValidation.errors;
    throw error;
  }

  const liveEnabled = Boolean(normalizedOptions.applyEnabled && normalizedOptions.liveTest);
  const selected = selectApplyCandidates(plan, normalizedOptions);
  const operations = selected.map((record) =>
    buildApplyOperation({
      record,
      forceOverwrite: normalizedOptions.forceOverwrite,
      now
    })
  );
  const dryRun = !liveEnabled;

  if (dryRun) {
    return {
      status: 'dry_run',
      dryRun: true,
      liveEnabled: false,
      guard: buildGuardState(normalizedOptions),
      summary: summarizeOperationResults({
        planned: operations.filter((operation) => operation.status === 'planned').length,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: operations.filter((operation) => operation.status === 'skipped').length
      }),
      operations,
      warnings: [
        'Legacy retrofit apply is in dry-run mode. Set LEGACY_RETROFIT_APPLY_ENABLED=true and LIVE_TEST=true to write.'
      ]
    };
  }

  if (!config.twenty?.apiKey && !restClient) {
    const error = new Error('TWENTY_API_KEY is required for live legacy retrofit apply.');
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
    const auditBase = buildCrmSyncLogEntry({
      operation,
      status: 'planned',
      startedAt
    });
    const eventBase = buildOutboundEventEntry({
      operation,
      status: 'planned',
      now
    });

    try {
      const response = await client.updateRecord('people', operation.personId, operation.payload);
      const finishedAt = new Date().toISOString();
      const audit = await store.appendCrmSyncLog({
        ...auditBase,
        status: 'succeeded',
        responsePayload: {
          id: response?.id ?? operation.personId,
          record: response
        },
        finishedAt
      });
      const outboundEvent = await store.appendOutboundEvent({
        ...eventBase,
        status: 'sent',
        payload: {
          ...eventBase.payload,
          response: {
            personId: response?.id ?? operation.personId
          }
        }
      });

      consecutiveFailures = 0;
      results.push({
        ...operation,
        status: 'succeeded',
        response,
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

  const summary = summarizeLiveResults(results);

  return {
    status: summary.failed > 0 ? 'failed' : 'succeeded',
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

export function normalizeApplyOptions(options = {}) {
  return {
    applyEnabled: toBoolean(options.applyEnabled),
    liveTest: toBoolean(options.liveTest),
    includeManualReview: toBoolean(options.includeManualReview),
    forceOverwrite: toBoolean(options.forceOverwrite),
    batchSize: normalizePositiveInt(options.batchSize, 5),
    offset: normalizeNonNegativeInt(options.offset, 0)
  };
}

export function validateNoProtectedFields(plan = {}) {
  const errors = [];

  for (const record of plan.plans ?? []) {
    const protectedFields = Object.keys(record.recommendedUpdates ?? {}).filter((fieldName) =>
      PROTECTED_ASSESSMENT_FIELDS.includes(fieldName)
    );

    if (protectedFields.length > 0) {
      errors.push({
        personId: record.personId,
        protectedFields
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function selectApplyCandidates(plan = {}, options = {}) {
  const normalizedOptions = normalizeApplyOptions(options);
  const candidates = (plan.plans ?? []).filter((record) =>
    normalizedOptions.includeManualReview
      ? hasRecommendedUpdates(record)
      : record.safeToUpdate === true && hasRecommendedUpdates(record)
  );

  return candidates.slice(
    normalizedOptions.offset,
    normalizedOptions.offset + normalizedOptions.batchSize
  );
}

export function buildApplyOperation({ record, forceOverwrite = false, now = new Date() }) {
  const payload = buildPersonUpdatePayload({
    record,
    forceOverwrite
  });
  const correlationId = `legacy-retrofit:${record.personId}:${randomUUID()}`;
  const skippedReason = !record.personId
    ? 'Missing Person ID.'
    : Object.keys(payload).length === 0
      ? 'No eligible missing outbound fields to update.'
      : null;

  return {
    personId: record.personId ?? null,
    name: record.name ?? null,
    correlationId,
    status: skippedReason ? 'skipped' : 'planned',
    skippedReason,
    payload,
    currentFields: record.currentFields ?? {},
    ownerRecommendation: record.ownerRecommendation ?? null,
    recommendedWorkspaceEmail: record.recommendedWorkspaceEmail ?? null,
    safeToUpdate: Boolean(record.safeToUpdate),
    generatedAt: now.toISOString(),
    crmSyncLog: {
      planned: buildCrmSyncLogEntry({
        operation: {
          personId: record.personId ?? null,
          correlationId,
          payload
        },
        status: 'dry_run',
        startedAt: now.toISOString()
      }),
      persisted: null
    },
    outboundEvent: {
      planned: buildOutboundEventEntry({
        operation: {
          personId: record.personId ?? null,
          correlationId,
          payload,
          name: record.name ?? null,
          ownerRecommendation: record.ownerRecommendation ?? null,
          recommendedWorkspaceEmail: record.recommendedWorkspaceEmail ?? null
        },
        status: 'planned',
        now
      }),
      persisted: null
    }
  };
}

export function buildPersonUpdatePayload({ record = {}, forceOverwrite = false } = {}) {
  const updates = record.recommendedUpdates ?? {};
  const currentFields = record.currentFields ?? {};
  const payload = {};

  for (const [fieldName, value] of Object.entries(updates)) {
    if (PROTECTED_ASSESSMENT_FIELDS.includes(fieldName)) {
      continue;
    }

    if (LEGACY_RETROFIT_OWNER_FIELDS.includes(fieldName)) {
      continue;
    }

    if (!forceOverwrite && !isMissingValue(currentFields[fieldName])) {
      continue;
    }

    if (isMissingValue(value)) {
      continue;
    }

    payload[fieldName] = value;
  }

  return payload;
}

function buildCrmSyncLogEntry({ operation, status, startedAt }) {
  return {
    assessmentSubmissionId: null,
    workflowJobId: null,
    correlationId: operation.correlationId,
    provider: 'twenty',
    objectName: 'person',
    action: 'legacy_retrofit_update',
    dedupeKey: `legacy-retrofit:person:${operation.personId}`,
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

function buildOutboundEventEntry({ operation, status, now }) {
  return {
    assessmentSubmissionId: null,
    correlationId: operation.correlationId,
    eventType: 'legacy_retrofit_applied',
    channel: 'crm',
    status,
    actorType: 'system',
    requiresApproval: false,
    payload: {
      personId: operation.personId,
      name: operation.name,
      payload: operation.payload,
      ownerRecommendation: operation.ownerRecommendation ?? null,
      recommendedWorkspaceEmail: operation.recommendedWorkspaceEmail ?? null
    },
    approvalPayload: null,
    errorPayload: null,
    scheduledFor: now.toISOString()
  };
}

function summarizeOperationResults(summary) {
  return {
    planned: summary.planned ?? 0,
    attempted: summary.attempted ?? 0,
    succeeded: summary.succeeded ?? 0,
    failed: summary.failed ?? 0,
    skipped: summary.skipped ?? 0,
    personIdsUpdated: summary.personIdsUpdated ?? [],
    auditIds: summary.auditIds ?? [],
    outboundEventIds: summary.outboundEventIds ?? []
  };
}

function summarizeLiveResults(results = []) {
  return summarizeOperationResults({
    planned: 0,
    attempted: results.filter((result) => ['succeeded', 'failed'].includes(result.status)).length,
    succeeded: results.filter((result) => result.status === 'succeeded').length,
    failed: results.filter((result) => result.status === 'failed').length,
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
    includeManualReview: options.includeManualReview,
    forceOverwrite: options.forceOverwrite,
    batchSize: options.batchSize,
    offset: options.offset
  };
}

function hasRecommendedUpdates(record = {}) {
  return Object.keys(record.recommendedUpdates ?? {}).length > 0;
}

function isMissingValue(value) {
  if (value === undefined || value === null || value === '') {
    return true;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value).every((entry) => isMissingValue(entry));
  }

  return false;
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
