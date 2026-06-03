import sampleLead from '../data/sample-quick-capture-lead.json' with { type: 'json' };
import { loadConfig } from '../src/config/env.js';
import { createCrmAdapter } from '../src/integrations/crm/crmAdapter.js';
import { createOperationalStore } from '../src/persistence/operationalStore.js';
import { evaluateQuickCaptureSyncTestMode } from '../src/utils/syncTestGuards.js';
import {
  assertFakeQuickCaptureLead,
  normalizeQuickCaptureLead
} from '../src/workflows/outbound/leadIntakeWorkflow.js';
import { processQuickCaptureLead } from '../src/workflows/outbound/quickCaptureWorkflow.js';

const LIVE_TEST_NOW = new Date('2026-05-27T14:00:00.000Z');

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
  const input = createMarkedTestLead();
  const normalizedForSafety = normalizeQuickCaptureLead(input);

  assertFakeQuickCaptureLead(normalizedForSafety);

  const dryRunPlan = await processQuickCaptureLead({
    input,
    config: {
      ...config,
      twenty: {
        ...config.twenty,
        syncEnabled: false
      }
    },
    dryRun: true,
    persistEvents: false,
    now: LIVE_TEST_NOW
  });

  printExecutionPlan({ guard, plan: dryRunPlan });

  if (!guard.ok || guard.mode !== 'live') {
    printGuardFailure(guard);
    process.exitCode = 1;
    return;
  }

  if (!dryRunPlan.schemaValidation.ok) {
    console.error('Quick Capture live test blocked because outbound schema validation failed.');
    console.error(JSON.stringify(dryRunPlan.schemaValidation, null, 2));
    process.exitCode = 1;
    return;
  }

  const operationalStore = config.supabase?.enabled
    ? createOperationalStore({ config, log: console })
    : null;
  const livePlan = await processQuickCaptureLead({
    input,
    config,
    operationalStore,
    dryRun: false,
    persistEvents: Boolean(config.supabase?.enabled),
    now: LIVE_TEST_NOW
  });

  if (!livePlan.schemaValidation.ok) {
    console.error('Quick Capture live test blocked because live outbound schema validation failed.');
    console.error(JSON.stringify(livePlan.schemaValidation, null, 2));
    process.exitCode = 1;
    return;
  }

  if (!livePlan.crmPayloads?.person?.payloadValidation?.ok) {
    console.error('Quick Capture live test blocked because Person payload validation failed.');
    console.error(JSON.stringify(livePlan.crmPayloads.person.payloadValidation, null, 2));
    process.exitCode = 1;
    return;
  }

  const adapter = createCrmAdapter({
    provider: config.crmProvider ?? 'twenty',
    config,
    log: console
  });
  const crmSync = await adapter.syncQuickCaptureLead({
    lead: livePlan.normalizedLead,
    payloads: livePlan.crmPayloads
  });
  const auditLogs = operationalStore
    ? await appendQuickCaptureCrmAuditLogs({
        store: operationalStore,
        plan: livePlan,
        crmSync,
        startedAt: LIVE_TEST_NOW.toISOString(),
        finishedAt: new Date().toISOString()
      })
    : [];

  printExecutionResult({ plan: livePlan, crmSync, auditLogs });

  if (['failed', 'partial_failure', 'blocked_configuration'].includes(crmSync.status)) {
    process.exitCode = 1;
  }
}

function createMarkedTestLead() {
  return {
    ...sampleLead,
    fullName: process.env.TEST_QUICK_CAPTURE_NAME ?? sampleLead.fullName,
    email: process.env.TEST_QUICK_CAPTURE_EMAIL ?? sampleLead.email,
    companyName: process.env.TEST_QUICK_CAPTURE_COMPANY ?? sampleLead.companyName,
    linkedinUrl: process.env.TEST_QUICK_CAPTURE_LINKEDIN_URL ?? sampleLead.linkedinUrl
  };
}

function printExecutionPlan({ guard, plan }) {
  console.log('');
  console.log('Quick Capture Live Test - Execution Plan');
  console.log('========================================');
  console.log(
    JSON.stringify(
      {
        mode: guard.mode,
        guardOk: guard.ok,
        guardWarnings: guard.warnings,
        guardErrors: guard.errors,
        liveWritesEnabled: guard.mode === 'live' && guard.ok,
        normalizedLead: plan.normalizedLead,
        crmPayloads: plan.crmPayloads,
        personPayloadValidation: plan.crmPayloads?.person?.payloadValidation,
        cadence: plan.cadence,
        schemaValidation: plan.schemaValidation,
        protectedAssessmentFields: {
          excluded: true,
          fields: [
            'assessmentCompleted',
            'assessmentScore',
            'lastTouchDate',
            'leadstageAuto',
            'messageAngle',
            'nextFollowUpDate'
          ]
        },
        relationshipWrites: {
          enabled: false,
          reason: 'Quick Capture live test does not write Person/Company/Task relationship links yet.'
        }
      },
      null,
      2
    )
  );
  console.log('');
}

async function appendQuickCaptureCrmAuditLogs({ store, plan, crmSync, startedAt, finishedAt }) {
  const logs = [];

  for (const operation of crmSync.operations) {
    logs.push(
      await store.appendCrmSyncLog({
        assessmentSubmissionId: null,
        workflowJobId: null,
        correlationId: plan.outboundEvent.planned.correlationId,
        provider: crmSync.provider,
        objectName: operation.object,
        action: operation.action,
        dedupeKey: operation.dedupeKey,
        status: normalizeAuditStatus(operation.status),
        attempt: operation.attempts ?? 1,
        requestPayload: {
          payload: operation.payload,
          fieldNames: Object.keys(operation.payload ?? {}),
          dedupeStrategy: plan.normalizedLead?.dedupe?.strategy ?? null,
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

function normalizeAuditStatus(status) {
  if (['dry_run', 'skipped', 'failed'].includes(status)) {
    return status;
  }

  return 'succeeded';
}

function printExecutionResult({ plan, crmSync, auditLogs }) {
  console.log('');
  console.log('Quick Capture Live Test - Result');
  console.log('================================');
  console.log(
    JSON.stringify(
      {
        status: crmSync.status,
        dryRun: crmSync.dryRun,
        reason: crmSync.reason,
        outboundEvent: {
          persisted: Boolean(plan.outboundEvent.persisted),
          id: plan.outboundEvent.persisted?.id,
          status: plan.outboundEvent.persisted?.status
        },
        auditLogs: {
          persisted: auditLogs.length > 0,
          count: auditLogs.length,
          ids: auditLogs.map((record) => record.id)
        },
        crmResults: crmSync.operations.map((operation) => ({
          object: operation.object,
          action: operation.action,
          status: operation.status,
          id: operation.response?.id,
          duplicateAvoided: operation.duplicateAvoided,
          matchedBy: operation.matchedBy,
          dedupeKey: operation.dedupeKey,
          error: operation.error?.message
        })),
        skippedRelationships: crmSync.skippedRelationships,
        protectedAssessmentFieldsUntouched: true
      },
      null,
      2
    )
  );
  console.log('');
}

function printGuardFailure(guard) {
  console.error('Quick Capture live execution was not run.');
  console.error('Live writes require QUICK_CAPTURE_SYNC_ENABLED=true, TWENTY_SYNC_ENABLED=true, and LIVE_TEST=true.');

  for (const error of guard.errors) {
    console.error(`BLOCKER: ${error}`);
  }

  for (const warning of guard.warnings) {
    console.error(`WARN: ${warning}`);
  }
}

main().catch((error) => {
  console.error('Quick Capture live test failed unexpectedly.');
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
