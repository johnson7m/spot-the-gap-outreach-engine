import sampleSubmission from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { loadConfig } from '../src/config/env.js';
import { createOperationalStore } from '../src/persistence/operationalStore.js';
import { buildAssessmentCrmPayloads } from '../src/integrations/twenty/payloadBuilders.js';
import { createTwentyMetadataClient } from '../src/integrations/twenty/metadataClient.js';
import { validateTwentyRelationships } from '../src/integrations/twenty/relationshipValidator.js';
import { validateTwentySchema } from '../src/integrations/twenty/schemaValidator.js';
import { normalizeNetlifySubmission } from '../src/integrations/netlifyWebhook.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import { createAssessmentIdempotency } from '../src/utils/idempotency.js';
import { scoreAssessment } from '../src/utils/leadScoring.js';
import { evaluateSyncTestMode } from '../src/utils/syncTestGuards.js';

async function main() {
  const config = loadConfig();
  const guard = evaluateSyncTestMode({
    liveTest: process.env.LIVE_TEST,
    twentySyncEnabled: config.twenty.syncEnabled,
    supabaseEnabled: config.supabase.enabled,
    twentyApiKey: config.twenty.apiKey,
    supabaseUrl: config.supabase.url,
    supabaseServiceRoleKey: config.supabase.serviceRoleKey
  });

  if (!guard.ok) {
    printGuardFailure(guard);
    process.exitCode = 1;
    return;
  }

  if (guard.mode === 'dry_run') {
    config.twenty.syncEnabled = false;
  }

  const body = createMarkedTestPayload();
  const submission = normalizeNetlifySubmission(body);
  const score = scoreAssessment(submission.assessment.answers);
  const idempotency = createAssessmentIdempotency({ submission, score });
  const payloads = buildAssessmentCrmPayloads({ submission, score });
  const schemaSummary = await getSchemaSummary(config);

  printExecutionPlan({
    mode: guard.mode,
    warnings: guard.warnings,
    submission,
    score,
    idempotency,
    payloads,
    schemaSummary
  });

  const operationalStore = createOperationalStore({
    config,
    log: console
  });
  const result = await processAssessmentSubmission({
    body,
    headers: {
      'x-correlation-id': `manual-sync-test-${guard.mode}`
    },
    config,
    log: console,
    operationalStore
  });

  printExecutionResult(result);

  if (['failed', 'partial_failure'].includes(result.status)) {
    process.exitCode = 1;
  }
}

function createMarkedTestPayload() {
  const payload = structuredClone(sampleSubmission);

  payload.payload.id = process.env.TEST_SUBMISSION_ID ?? 'staging-live-sync-test-001';
  payload.payload.created_at = process.env.TEST_SUBMITTED_AT ?? '2026-05-23T18:30:00.000Z';
  payload.payload.data.name = process.env.TEST_CONTACT_NAME ?? 'Visible Gap Sync Test';
  payload.payload.data.email =
    process.env.TEST_CONTACT_EMAIL ?? 'visiblegap.sync-test@example.com';
  payload.payload.data.company =
    process.env.TEST_COMPANY_NAME ?? 'Visible Gap Sync Test Company';
  payload.payload.data.businessType = 'Internal staging CRM sync test';

  return payload;
}

async function getSchemaSummary(config) {
  if (!config.twenty.apiKey) {
    return {
      status: 'skipped',
      reason: 'TWENTY_API_KEY is not configured.'
    };
  }

  const metadataClient = createTwentyMetadataClient(config.twenty);
  const schema = await metadataClient.discoverSchema();
  const schemaValidation = validateTwentySchema(schema);
  const relationshipValidation = validateTwentyRelationships(schema);

  return {
    status: 'checked',
    schemaOk: schemaValidation.ok,
    schemaErrors: schemaValidation.errors,
    schemaWarnings: schemaValidation.warnings,
    relationshipsOk: relationshipValidation.ok,
    relationshipWarnings: relationshipValidation.warnings,
    relationshipMappings: relationshipValidation.mappings.map((mapping) => ({
      key: mapping.key,
      relationType: mapping.relationType,
      joinColumnName: mapping.joinColumnName,
      writeEnabled: mapping.writeEnabled
    }))
  };
}

function printExecutionPlan({
  mode,
  warnings,
  submission,
  score,
  idempotency,
  payloads,
  schemaSummary
}) {
  const plan = {
    mode,
    guardWarnings: warnings,
    liveWritesEnabled: mode === 'live',
    testRecord: {
      submissionId: submission.submissionId,
      personEmail: submission.person.email,
      companyName: submission.company.name,
      idempotencyKey: idempotency.idempotencyKey,
      payloadHash: idempotency.payloadHash
    },
    score: {
      score: score.score,
      grade: score.grade,
      label: score.label
    },
    expectedCrmOperations: Object.values(payloads).map((operation) => ({
      object: operation.object,
      action: operation.action,
      dedupeKey: operation.dedupeKey,
      payload: operation.payload
    })),
    schemaSummary
  };

  console.log('');
  console.log('Assessment Sync Test - Execution Plan');
  console.log('=====================================');
  console.log(JSON.stringify(plan, null, 2));
  console.log('');
}

function printExecutionResult(result) {
  const crmIds = result.crmSync.operations.map((operation) => ({
    object: operation.object,
    action: operation.action,
    status: operation.status,
    id: operation.response?.id,
    dedupeKey: operation.dedupeKey,
    error: operation.error?.message
  }));

  console.log('');
  console.log('Assessment Sync Test - Result');
  console.log('=============================');
  console.log(
    JSON.stringify(
      {
        status: result.status,
        duplicate: result.duplicate,
        replayProtected: result.replayProtected,
        correlationId: result.correlationId,
        persistence: result.persistence,
        workflowSummary: result.workflowSummary,
        crmSync: {
          provider: result.crmSync.provider,
          status: result.crmSync.status,
          dryRun: result.crmSync.dryRun,
          reason: result.crmSync.reason
        },
        crmIds
      },
      null,
      2
    )
  );
  console.log('');
}

function printGuardFailure(guard) {
  console.error('');
  console.error('Assessment sync test blocked before execution.');
  console.error('==============================================');
  for (const error of guard.errors) {
    console.error(`BLOCKER: ${error}`);
  }

  for (const warning of guard.warnings) {
    console.error(`WARN: ${warning}`);
  }
  console.error('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Assessment sync test failed unexpectedly.');
    console.error(error);
    process.exitCode = 1;
  });
}
