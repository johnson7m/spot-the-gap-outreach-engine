import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { applyLegacyTaskRetrofitPlan } from '../src/workflows/outbound/applyLegacyTaskRetrofitWorkflow.js';

async function main() {
  const config = loadConfig();
  const planPath = config.legacyTaskRetrofit.planPath;
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
  const result = await applyLegacyTaskRetrofitPlan({
    plan,
    config,
    log: logger,
    options: {
      applyEnabled: config.legacyTaskRetrofit.applyEnabled,
      liveTest: process.env.LIVE_TEST,
      batchSize: config.legacyTaskRetrofit.batchSize,
      offset: config.legacyTaskRetrofit.offset,
      linkCompany: config.legacyTaskRetrofit.linkCompany
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
      taskId: operation.taskId,
      taskTitle: operation.taskTitle,
      taskStatus: operation.taskStatus,
      status: operation.status,
      skippedReason: operation.skippedReason,
      personTargetPayload: operation.personTargetPayload,
      companyTargetPayload: operation.companyTargetPayload,
      inferredTargetPersonId: operation.inferredTargetPersonId,
      inferredTargetCompanyId: operation.inferredTargetCompanyId,
      confidence: operation.confidence,
      duplicateSkipped: operation.duplicateSkipped,
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
  console.error('Legacy task retrofit apply failed.');
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
