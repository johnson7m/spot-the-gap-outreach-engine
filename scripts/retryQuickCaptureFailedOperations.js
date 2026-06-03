import { loadConfig } from '../src/config/env.js';
import { createCrmAdapter } from '../src/integrations/crm/crmAdapter.js';
import { createSupabaseClient } from '../src/integrations/supabase/client.js';
import { createOperationalStore } from '../src/persistence/operationalStore.js';
import {
  extractRetryAfterMs,
  isRetryableTwentyError
} from '../src/utils/retryPolicy.js';
import { evaluateQuickCaptureSyncTestMode } from '../src/utils/syncTestGuards.js';

async function main() {
  const config = loadConfig();
  const guard = evaluateQuickCaptureSyncTestMode({
    liveTest: process.env.LIVE_TEST,
    quickCaptureSyncEnabled: config.quickCapture?.syncEnabled,
    twentySyncEnabled: config.twenty?.syncEnabled,
    twentyApiKey: config.twenty?.apiKey,
    supabaseEnabled: config.supabase?.enabled,
    supabaseUrl: config.supabase?.url,
    supabaseServiceRoleKey: config.supabase?.serviceRoleKey
  });

  if (!guard.ok || guard.mode !== 'live') {
    printGuardFailure(guard);
    process.exitCode = 1;
    return;
  }

  if (!config.supabase?.enabled) {
    console.error('Quick Capture recovery requires SUPABASE_ENABLED=true.');
    process.exitCode = 1;
    return;
  }

  const supabase = createSupabaseClient(config.supabase);
  const store = createOperationalStore({ config, log: console, supabaseClient: supabase });
  const recoveryPlan = await findLatestRetryableQuickCaptureFailure({
    supabase,
    maxRetries: config.quickCapture.maxRetries
  });

  printRecoveryPlan(recoveryPlan, config);

  if (!recoveryPlan.ok) {
    process.exitCode = 1;
    return;
  }

  if (recoveryPlan.retryDelayMs > 0) {
    console.log(`Waiting ${recoveryPlan.retryDelayMs}ms before retrying per retry_after metadata.`);
    await sleep(recoveryPlan.retryDelayMs);
  }

  const adapter = createCrmAdapter({
    provider: config.crmProvider ?? 'twenty',
    config: {
      ...config,
      quickCapture: {
        ...config.quickCapture,
        maxRetries: recoveryPlan.operationRetryLimit
      }
    },
    log: console
  });
  const startedAt = new Date().toISOString();
  const crmSync = await adapter.syncQuickCaptureOperations({
    lead: recoveryPlan.lead,
    operations: [recoveryPlan.operation]
  });
  const finishedAt = new Date().toISOString();
  const auditLogs = await appendRecoveryAuditLogs({
    store,
    plan: recoveryPlan,
    crmSync,
    startedAt,
    finishedAt
  });
  const outboundEvent = await updateOutboundEventRecoveryStatus({
    supabase,
    plan: recoveryPlan,
    crmSync,
    auditLogs,
    finishedAt
  });

  printRecoveryResult({ crmSync, auditLogs, outboundEvent, plan: recoveryPlan });

  if (['failed', 'partial_failure', 'blocked_configuration'].includes(crmSync.status)) {
    process.exitCode = 1;
  }
}

async function findLatestRetryableQuickCaptureFailure({ supabase, maxRetries }) {
  const response = await supabase
    .from('crm_sync_logs')
    .select('*')
    .eq('provider', 'twenty')
    .like('correlation_id', 'quick-capture:%')
    .in('status', ['failed', 'succeeded', 'skipped'])
    .order('created_at', { ascending: false })
    .limit(100);

  if (response.error) {
    throw new Error(`Failed to inspect Quick Capture CRM audit logs: ${response.error.message}`);
  }

  const rows = response.data ?? [];
  const failedRows = rows.filter(
    (row) => row.status === 'failed' && isRetryableTwentyError(row.error_payload)
  );

  for (const failedRow of failedRows) {
    const sameOperationRows = rows.filter((row) => operationKey(row) === operationKey(failedRow));
    const newerSuccess = sameOperationRows.some(
      (row) =>
        ['succeeded', 'skipped'].includes(row.status) &&
        Date.parse(row.created_at) >= Date.parse(failedRow.created_at)
    );

    if (newerSuccess) {
      continue;
    }

    const maxPriorAttempt = Math.max(
      1,
      ...sameOperationRows.map((row) => Number(row.attempt ?? 1))
    );
    const maxAllowedAttempt = Number(maxRetries ?? 3) + 1;

    if (maxPriorAttempt >= maxAllowedAttempt) {
      return {
        ok: false,
        reason: 'max_retries_exhausted',
        failedLog: failedRow,
        maxPriorAttempt,
        maxAllowedAttempt,
        operation: toOperation(failedRow)
      };
    }

    const outboundEvent = await findOutboundEvent(supabase, failedRow.correlation_id);
    const retryDelayMs = getRemainingRetryDelayMs(failedRow);
    const remainingAttempts = maxAllowedAttempt - maxPriorAttempt;

    return {
      ok: true,
      failedLog: failedRow,
      sameOperationRows,
      maxPriorAttempt,
      maxAllowedAttempt,
      nextAttempt: maxPriorAttempt + 1,
      operationRetryLimit: Math.max(0, remainingAttempts - 1),
      retryDelayMs,
      outboundEvent,
      lead: outboundEvent?.payload?.lead ?? {},
      operation: toOperation(failedRow)
    };
  }

  return {
    ok: false,
    reason: 'no_retryable_quick_capture_failure_found',
    inspectedLogCount: rows.length
  };
}

async function findOutboundEvent(supabase, correlationId) {
  const response = await supabase
    .from('outbound_events')
    .select('*')
    .eq('correlation_id', correlationId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (response.error) {
    throw new Error(`Failed to inspect Quick Capture outbound event: ${response.error.message}`);
  }

  return response.data?.[0] ?? null;
}

async function appendRecoveryAuditLogs({ store, plan, crmSync, startedAt, finishedAt }) {
  const logs = [];

  for (const operation of crmSync.operations) {
    logs.push(
      await store.appendCrmSyncLog({
        assessmentSubmissionId: null,
        workflowJobId: null,
        correlationId: plan.failedLog.correlation_id,
        provider: crmSync.provider,
        objectName: operation.object,
        action: operation.action,
        dedupeKey: operation.dedupeKey,
        status: normalizeAuditStatus(operation.status),
        attempt: plan.maxPriorAttempt + (operation.attempts ?? 1),
        requestPayload: {
          payload: operation.payload,
          fieldNames: Object.keys(operation.payload ?? {}),
          dedupeStrategy: plan.lead?.dedupe?.strategy ?? null,
          payloadValidation: operation.payloadValidation
        },
        responsePayload: operation.response,
        errorPayload: operation.error,
        startedAt,
        finishedAt
      })
    );
  }

  return logs;
}

async function updateOutboundEventRecoveryStatus({ supabase, plan, crmSync, auditLogs, finishedAt }) {
  if (!plan.outboundEvent?.id) {
    return null;
  }

  const failed = crmSync.operations.find((operation) => operation.status === 'failed');
  const nextPayload = {
    ...(plan.outboundEvent.payload ?? {}),
    latestRecovery: {
      recoveredAt: finishedAt,
      status: crmSync.status,
      object: plan.operation.object,
      dedupeKey: plan.operation.dedupeKey,
      auditLogIds: auditLogs.map((record) => record.id)
    }
  };
  const response = await supabase
    .from('outbound_events')
    .update({
      status: failed ? 'failed' : 'planned',
      payload: nextPayload,
      error_payload: failed?.error ?? null
    })
    .eq('id', plan.outboundEvent.id)
    .select()
    .single();

  if (response.error) {
    throw new Error(`Failed to update Quick Capture outbound event: ${response.error.message}`);
  }

  return response.data;
}

function toOperation(row) {
  const requestPayload = row.request_payload?.payload ?? row.request_payload;

  return {
    object: row.object_name,
    action: row.action,
    dedupeKey: row.dedupe_key,
    payload: requestPayload,
    payloadValidation: row.request_payload?.payloadValidation
  };
}

function getRemainingRetryDelayMs(row) {
  const retryAfterMs = extractRetryAfterMs(row.error_payload);

  if (!retryAfterMs) {
    return 0;
  }

  const retryAt = Date.parse(row.created_at) + retryAfterMs;

  return Math.max(0, retryAt - Date.now());
}

function operationKey(row) {
  return [row.correlation_id, row.object_name, row.dedupe_key].join(':');
}

function normalizeAuditStatus(status) {
  if (['dry_run', 'skipped', 'failed'].includes(status)) {
    return status;
  }

  return 'succeeded';
}

function printRecoveryPlan(plan, config) {
  console.log('');
  console.log('Quick Capture Failed Operation Recovery - Plan');
  console.log('==============================================');
  console.log(
    JSON.stringify(
      {
        ok: plan.ok,
        reason: plan.reason,
        retryConfig: {
          maxRetries: config.quickCapture.maxRetries,
          retryBaseMs: config.quickCapture.retryBaseMs
        },
        failedOperation: plan.failedLog
          ? {
              logId: plan.failedLog.id,
              correlationId: plan.failedLog.correlation_id,
              object: plan.failedLog.object_name,
              action: plan.failedLog.action,
              dedupeKey: plan.failedLog.dedupe_key,
              priorAttempt: plan.failedLog.attempt,
              status: plan.failedLog.status,
              error: plan.failedLog.error_payload
            }
          : null,
        nextAttempt: plan.nextAttempt,
        maxAllowedAttempt: plan.maxAllowedAttempt,
        operationRetryLimit: plan.operationRetryLimit,
        retryDelayMs: plan.retryDelayMs,
        outboundEventId: plan.outboundEvent?.id,
        skippedPreviouslySucceededObjects: ['person', 'task']
      },
      null,
      2
    )
  );
  console.log('');
}

function printRecoveryResult({ crmSync, auditLogs, outboundEvent, plan }) {
  console.log('');
  console.log('Quick Capture Failed Operation Recovery - Result');
  console.log('================================================');
  console.log(
    JSON.stringify(
      {
        status: crmSync.status,
        operationRetried: {
          object: plan.operation.object,
          dedupeKey: plan.operation.dedupeKey
        },
        crmResults: crmSync.operations.map((operation) => ({
          object: operation.object,
          action: operation.action,
          status: operation.status,
          id: operation.response?.id,
          duplicateAvoided: operation.duplicateAvoided,
          matchedBy: operation.matchedBy,
          attempts: operation.attempts,
          retryCount: operation.retryCount,
          error: operation.error
        })),
        auditLogs: {
          persisted: auditLogs.length > 0,
          ids: auditLogs.map((record) => record.id),
          attempts: auditLogs.map((record) => record.attempt ?? record.attempt_number)
        },
        outboundEvent: outboundEvent
          ? {
              id: outboundEvent.id,
              status: outboundEvent.status
            }
          : null,
        personAndTaskWereNotRetried: true
      },
      null,
      2
    )
  );
  console.log('');
}

function printGuardFailure(guard) {
  console.error('Quick Capture recovery was not run.');
  console.error('Recovery requires QUICK_CAPTURE_SYNC_ENABLED=true, TWENTY_SYNC_ENABLED=true, and LIVE_TEST=true.');

  for (const error of guard.errors) {
    console.error(`BLOCKER: ${error}`);
  }

  for (const warning of guard.warnings) {
    console.error(`WARN: ${warning}`);
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

main().catch((error) => {
  console.error('Quick Capture failed-operation recovery failed unexpectedly.');
  console.error(
    JSON.stringify(
      {
        message: error.message,
        details: error.details,
        code: error.code
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
