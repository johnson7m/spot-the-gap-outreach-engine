import { randomUUID } from 'node:crypto';
import { createTwentyRestClient } from '../../integrations/twenty/restClient.js';
import { createOperationalStore } from '../../persistence/operationalStore.js';

export const MANUAL_LEAD_NORMALIZATION_ALLOWED_FIELDS = [
  'outboundPipelineType',
  'cadenceName',
  'cadenceStage',
  'latestTouchChannel',
  'latestTouchStatus',
  'outreachAngle',
  'leadHealthScore',
  'icpFitScore',
  'nextOutboundTouchDate',
  'enrichmentStatus',
  'discoveryReadiness',
  'staleRisk'
];

export const MANUAL_LEAD_NORMALIZATION_PROTECTED_FIELDS = [
  'assessmentCompleted',
  'assessmentScore',
  'lastTouchDate',
  'leadstageAuto',
  'messageAngle',
  'nextFollowUpDate'
];

const REPEATED_FAILURE_LIMIT = 2;

export async function applyManualLeadNormalizationPlan({
  plan = {},
  config = {},
  options = {},
  restClient,
  operationalStore,
  log,
  now = new Date()
} = {}) {
  const normalizedOptions = normalizeManualLeadNormalizationApplyOptions(options);
  const protectedValidation = validateManualLeadNormalizationPlan(plan);

  if (!protectedValidation.ok) {
    const error = new Error('Manual lead normalization plan contains protected assessment fields.');
    error.code = 'MANUAL_LEAD_NORMALIZATION_PROTECTED_FIELDS';
    error.details = protectedValidation.errors;
    throw error;
  }

  const liveEnabled = Boolean(normalizedOptions.applyEnabled && normalizedOptions.liveTest);

  if (liveEnabled && !normalizedOptions.batchSizeProvided) {
    const error = new Error(
      'MANUAL_LEAD_NORMALIZATION_BATCH_SIZE is required for live manual lead normalization apply.'
    );
    error.code = 'MANUAL_LEAD_NORMALIZATION_BATCH_SIZE_REQUIRED';
    throw error;
  }

  const selected = selectManualLeadNormalizationCandidates(plan, normalizedOptions);
  const operations = selected.map((record) =>
    buildManualLeadNormalizationOperation({
      record,
      force: normalizedOptions.force,
      now
    })
  );

  if (!liveEnabled) {
    return {
      status: 'dry_run',
      dryRun: true,
      liveEnabled: false,
      guard: buildGuardState(normalizedOptions),
      summary: summarizeManualLeadNormalizationOperationResults({
        planned: operations.filter((operation) => operation.status === 'planned').length,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        verificationFailed: 0,
        skipped: operations.filter((operation) => operation.status === 'skipped').length
      }),
      operations,
      warnings: [
        'Manual lead normalization apply is in dry-run mode. Set MANUAL_LEAD_NORMALIZATION_APPLY_ENABLED=true, LIVE_TEST=true, and MANUAL_LEAD_NORMALIZATION_BATCH_SIZE to update People.'
      ]
    };
  }

  if (!config.twenty?.apiKey && !restClient) {
    const error = new Error('TWENTY_API_KEY is required for live manual lead normalization apply.');
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
    const auditBase = buildManualLeadNormalizationCrmSyncLogEntry({
      operation,
      status: 'planned',
      startedAt
    });
    const eventBase = buildManualLeadNormalizationOutboundEventEntry({
      operation,
      status: 'planned',
      now
    });

    try {
      const before = await client.getRecord('people', operation.personId);
      const livePayload = buildManualLeadNormalizationPayload({
        record: {
          ...operation.record,
          currentOutboundFields: buildCurrentOutboundFields(before)
        },
        force: normalizedOptions.force
      });

      if (Object.keys(livePayload).length === 0) {
        const audit = await store.appendCrmSyncLog({
          ...auditBase,
          status: 'skipped',
          requestPayload: {
            ...auditBase.requestPayload,
            payload: livePayload,
            skippedReason: 'No eligible missing outbound fields remain after live Person recheck.'
          },
          responsePayload: {
            skippedReason: 'No eligible missing outbound fields remain after live Person recheck.',
            before: summarizePersonFields(before)
          },
          finishedAt: new Date().toISOString()
        });
        const outboundEvent = await store.appendOutboundEvent({
          ...eventBase,
          status: 'cancelled',
          payload: {
            ...eventBase.payload,
            payload: livePayload,
            skippedReason: 'No eligible missing outbound fields remain after live Person recheck.'
          }
        });

        consecutiveFailures = 0;
        results.push({
          ...operation,
          payload: livePayload,
          status: 'skipped',
          skippedReason: 'No eligible missing outbound fields remain after live Person recheck.',
          before,
          audit,
          outboundEvent
        });
        continue;
      }

      const response = await client.updateRecord('people', operation.personId, livePayload);
      const after = await client.getRecord('people', operation.personId);
      const verification = verifyManualLeadNormalizationUpdate({
        before,
        after,
        payload: livePayload,
        force: normalizedOptions.force
      });
      const succeeded = verification.ok;
      const finishedAt = new Date().toISOString();
      const audit = await store.appendCrmSyncLog({
        ...auditBase,
        status: succeeded ? 'succeeded' : 'failed',
        requestPayload: {
          ...auditBase.requestPayload,
          payload: livePayload
        },
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
          payload: livePayload,
          fieldsUpdated: Object.keys(livePayload),
          verification
        },
        errorPayload: succeeded ? null : verification
      });

      consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
      results.push({
        ...operation,
        payload: livePayload,
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

  const summary = summarizeManualLeadNormalizationLiveResults(results);

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

export function normalizeManualLeadNormalizationApplyOptions(options = {}) {
  const rawBatchSize = options.batchSize;
  const batchSizeProvided = rawBatchSize !== undefined && rawBatchSize !== null && rawBatchSize !== '';

  return {
    applyEnabled: toBoolean(options.applyEnabled),
    liveTest: toBoolean(options.liveTest),
    includeReview: toBoolean(options.includeReview),
    includeTestRecords: toBoolean(options.includeTestRecords),
    force: toBoolean(options.force),
    batchSize: normalizePositiveInt(rawBatchSize, 5),
    batchSizeProvided,
    offset: normalizeNonNegativeInt(options.offset, 0)
  };
}

export function validateManualLeadNormalizationPlan(plan = {}) {
  const errors = [];

  for (const record of plan.plans ?? []) {
    const protectedFields = Object.keys(record.recommendedUpdates ?? {}).filter((fieldName) =>
      MANUAL_LEAD_NORMALIZATION_PROTECTED_FIELDS.includes(fieldName)
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

export function selectManualLeadNormalizationCandidates(plan = {}, options = {}) {
  const normalizedOptions = normalizeManualLeadNormalizationApplyOptions(options);
  const candidates = (plan.plans ?? []).filter((record) =>
    isEligibleManualLeadNormalizationRecord(record, normalizedOptions)
  );

  return candidates.slice(
    normalizedOptions.offset,
    normalizedOptions.offset + normalizedOptions.batchSize
  );
}

export function isEligibleManualLeadNormalizationRecord(record = {}, options = {}) {
  const normalizedOptions = normalizeManualLeadNormalizationApplyOptions(options);

  if (record.isTestRecord && !normalizedOptions.includeTestRecords) {
    return false;
  }

  if (!record.safeToNormalize && !(normalizedOptions.includeReview && normalizedOptions.force)) {
    return false;
  }

  if (!record.personId) {
    return false;
  }

  return Object.keys(record.recommendedUpdates ?? {}).some((fieldName) =>
    MANUAL_LEAD_NORMALIZATION_ALLOWED_FIELDS.includes(fieldName)
  );
}

export function buildManualLeadNormalizationOperation({ record = {}, force = false, now = new Date() } = {}) {
  const payload = buildManualLeadNormalizationPayload({
    record,
    force
  });
  const correlationId = `manual-lead-normalization:${record.personId}:${randomUUID()}`;
  const skippedReason = !record.personId
    ? 'Missing Person ID.'
    : Object.keys(payload).length === 0
      ? 'No eligible missing outbound fields to update.'
      : null;

  return {
    record,
    personId: record.personId ?? null,
    personName: record.personName ?? null,
    companyId: record.companyId ?? null,
    companyName: record.companyName ?? null,
    assignedRep: record.assignedRep ?? null,
    leadStage: record.leadStage ?? null,
    recommendedTaskAction: record.recommendedTaskAction ?? null,
    correlationId,
    status: skippedReason ? 'skipped' : 'planned',
    skippedReason,
    payload,
    currentOutboundFields: record.currentOutboundFields ?? {},
    recommendedUpdates: record.recommendedUpdates ?? {},
    safeToNormalize: Boolean(record.safeToNormalize),
    isTestRecord: Boolean(record.isTestRecord),
    generatedAt: now.toISOString(),
    crmSyncLog: {
      planned: buildManualLeadNormalizationCrmSyncLogEntry({
        operation: {
          personId: record.personId ?? null,
          personName: record.personName ?? null,
          correlationId,
          payload,
          assignedRep: record.assignedRep ?? null
        },
        status: 'dry_run',
        startedAt: now.toISOString()
      }),
      persisted: null
    },
    outboundEvent: {
      planned: buildManualLeadNormalizationOutboundEventEntry({
        operation: {
          personId: record.personId ?? null,
          personName: record.personName ?? null,
          companyId: record.companyId ?? null,
          companyName: record.companyName ?? null,
          assignedRep: record.assignedRep ?? null,
          leadStage: record.leadStage ?? null,
          recommendedTaskAction: record.recommendedTaskAction ?? null,
          correlationId,
          payload
        },
        status: 'planned',
        now
      }),
      persisted: null
    }
  };
}

export function buildManualLeadNormalizationPayload({ record = {}, force = false } = {}) {
  const updates = record.recommendedUpdates ?? {};
  const currentFields = record.currentOutboundFields ?? record.currentFields ?? {};
  const payload = {};

  for (const [fieldName, value] of Object.entries(updates)) {
    if (!MANUAL_LEAD_NORMALIZATION_ALLOWED_FIELDS.includes(fieldName)) {
      continue;
    }

    if (MANUAL_LEAD_NORMALIZATION_PROTECTED_FIELDS.includes(fieldName)) {
      continue;
    }

    if (!force && !isMissingValue(currentFields[fieldName])) {
      continue;
    }

    if (isMissingValue(value)) {
      continue;
    }

    payload[fieldName] = value;
  }

  return payload;
}

export function verifyManualLeadNormalizationUpdate({ before = {}, after = {}, payload = {}, force = false } = {}) {
  const fieldResults = Object.entries(payload).map(([fieldName, expectedValue]) => {
    const actualValue = after?.[fieldName];

    return {
      fieldName,
      expectedValue,
      actualValue,
      ok: valuesEqual(actualValue, expectedValue)
    };
  });
  const protectedFieldResults = MANUAL_LEAD_NORMALIZATION_PROTECTED_FIELDS.map((fieldName) => ({
    fieldName,
    beforeValue: before?.[fieldName],
    afterValue: after?.[fieldName],
    ok: valuesEqual(before?.[fieldName], after?.[fieldName])
  }));
  const nonOverwriteResults = force
    ? []
    : MANUAL_LEAD_NORMALIZATION_ALLOWED_FIELDS
        .filter((fieldName) => !Object.hasOwn(payload, fieldName) && !isMissingValue(before?.[fieldName]))
        .map((fieldName) => ({
          fieldName,
          beforeValue: before?.[fieldName],
          afterValue: after?.[fieldName],
          ok: valuesEqual(before?.[fieldName], after?.[fieldName])
        }));

  return {
    ok:
      fieldResults.every((result) => result.ok) &&
      protectedFieldResults.every((result) => result.ok) &&
      nonOverwriteResults.every((result) => result.ok),
    fieldResults,
    protectedFieldResults,
    nonOverwriteResults,
    protectedFieldsUnchanged: protectedFieldResults.every((result) => result.ok),
    nonEmptyFieldsPreserved: nonOverwriteResults.every((result) => result.ok),
    fieldsUpdated: Object.keys(payload)
  };
}

function buildManualLeadNormalizationCrmSyncLogEntry({ operation, status, startedAt }) {
  return {
    assessmentSubmissionId: null,
    workflowJobId: null,
    correlationId: operation.correlationId,
    provider: 'twenty',
    objectName: 'person',
    action: 'manual_lead_normalization_update',
    dedupeKey: `manual-lead-normalization:person:${operation.personId}`,
    status,
    attempt: 1,
    requestPayload: {
      id: operation.personId,
      object: 'people',
      payload: operation.payload,
      assignedRep: operation.assignedRep ?? null
    },
    responsePayload: null,
    errorPayload: null,
    startedAt,
    finishedAt: status === 'dry_run' ? startedAt : null
  };
}

function buildManualLeadNormalizationOutboundEventEntry({ operation, status, now }) {
  return {
    assessmentSubmissionId: null,
    correlationId: operation.correlationId,
    eventType: 'manual_lead_normalized',
    channel: 'crm',
    status,
    actorType: 'system',
    requiresApproval: false,
    payload: {
      personId: operation.personId,
      personName: operation.personName,
      companyId: operation.companyId ?? null,
      companyName: operation.companyName ?? null,
      assignedRep: operation.assignedRep ?? null,
      leadStage: operation.leadStage ?? null,
      recommendedTaskAction: operation.recommendedTaskAction ?? null,
      payload: operation.payload
    },
    approvalPayload: null,
    errorPayload: null,
    scheduledFor: now.toISOString()
  };
}

function summarizeManualLeadNormalizationOperationResults(summary) {
  return {
    planned: summary.planned ?? 0,
    attempted: summary.attempted ?? 0,
    succeeded: summary.succeeded ?? 0,
    failed: summary.failed ?? 0,
    verificationFailed: summary.verificationFailed ?? 0,
    skipped: summary.skipped ?? 0,
    personIdsAffected: summary.personIdsAffected ?? [],
    fieldsUpdatedByPerson: summary.fieldsUpdatedByPerson ?? {},
    auditIds: summary.auditIds ?? [],
    outboundEventIds: summary.outboundEventIds ?? []
  };
}

function summarizeManualLeadNormalizationLiveResults(results = []) {
  return summarizeManualLeadNormalizationOperationResults({
    planned: 0,
    attempted: results.filter((result) =>
      ['verification_succeeded', 'verification_failed', 'failed'].includes(result.status)
    ).length,
    succeeded: results.filter((result) => result.status === 'verification_succeeded').length,
    failed: results.filter((result) => result.status === 'failed').length,
    verificationFailed: results.filter((result) => result.status === 'verification_failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    personIdsAffected: results
      .filter((result) => result.status === 'verification_succeeded')
      .map((result) => result.personId)
      .filter(Boolean),
    fieldsUpdatedByPerson: Object.fromEntries(
      results
        .filter((result) => result.status === 'verification_succeeded')
        .map((result) => [result.personId, Object.keys(result.payload ?? {})])
    ),
    auditIds: results.map((result) => result.audit?.id).filter(Boolean),
    outboundEventIds: results.map((result) => result.outboundEvent?.id).filter(Boolean)
  });
}

function buildGuardState(options) {
  return {
    applyEnabled: options.applyEnabled,
    liveTest: options.liveTest,
    includeReview: options.includeReview,
    includeTestRecords: options.includeTestRecords,
    force: options.force,
    batchSize: options.batchSize,
    batchSizeProvided: options.batchSizeProvided,
    offset: options.offset
  };
}

function buildCurrentOutboundFields(person = {}) {
  return Object.fromEntries(
    MANUAL_LEAD_NORMALIZATION_ALLOWED_FIELDS.map((fieldName) => [fieldName, person?.[fieldName] ?? null])
  );
}

function summarizePersonFields(person = {}) {
  return {
    id: person?.id ?? null,
    ...buildCurrentOutboundFields(person),
    protectedFields: Object.fromEntries(
      MANUAL_LEAD_NORMALIZATION_PROTECTED_FIELDS.map((fieldName) => [fieldName, person?.[fieldName] ?? null])
    )
  };
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

function valuesEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
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
