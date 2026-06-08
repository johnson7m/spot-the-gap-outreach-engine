import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { applyManualLeadNormalizationPlan } from '../src/workflows/outbound/applyManualLeadNormalizationWorkflow.js';

const DEFAULT_PLAN_PATH = 'data/manual-lead-normalization-plan.json';

async function main() {
  const config = loadConfig();
  const planPath = process.env.MANUAL_LEAD_NORMALIZATION_PLAN_PATH ?? DEFAULT_PLAN_PATH;
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
  const result = await applyManualLeadNormalizationPlan({
    plan,
    config,
    log: logger,
    options: {
      applyEnabled: process.env.MANUAL_LEAD_NORMALIZATION_APPLY_ENABLED,
      liveTest: process.env.LIVE_TEST,
      batchSize: process.env.MANUAL_LEAD_NORMALIZATION_BATCH_SIZE,
      offset: process.env.MANUAL_LEAD_NORMALIZATION_OFFSET,
      includeReview: process.env.MANUAL_LEAD_NORMALIZATION_INCLUDE_REVIEW,
      includeTestRecords: process.env.MANUAL_LEAD_NORMALIZATION_INCLUDE_TEST_RECORDS,
      force: process.env.MANUAL_LEAD_NORMALIZATION_FORCE
    }
  });
  const output = {
    status: result.status,
    dryRun: result.dryRun,
    liveEnabled: result.liveEnabled,
    guard: result.guard,
    summary: result.summary,
    warnings: result.warnings,
    operations: result.operations.map((operation) => ({
      personId: operation.personId,
      personName: operation.personName,
      companyId: operation.companyId,
      companyName: operation.companyName,
      assignedRep: operation.assignedRep,
      leadStage: operation.leadStage,
      recommendedTaskAction: operation.recommendedTaskAction,
      status: operation.status,
      skippedReason: operation.skippedReason,
      payload: operation.payload,
      fieldsUpdated: Object.keys(operation.payload ?? {}),
      verification: operation.verification,
      auditId: operation.audit?.id,
      outboundEventId: operation.outboundEvent?.id,
      error: operation.error
    }))
  };

  console.log(JSON.stringify(output, null, 2));

  if (!result.dryRun && (result.summary.failed > 0 || result.summary.verificationFailed > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Manual lead normalization apply failed.');
  console.error(
    JSON.stringify(
      {
        message: error.message,
        code: error.code,
        details: error.details,
        httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
