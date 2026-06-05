import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { applyLegacyRetrofitPlan } from '../src/workflows/outbound/applyLegacyRetrofitWorkflow.js';

async function main() {
  const config = loadConfig();
  const planPath = config.legacyRetrofit.planPath;
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
  const result = await applyLegacyRetrofitPlan({
    plan,
    config,
    log: logger,
    options: {
      applyEnabled: config.legacyRetrofit.applyEnabled,
      liveTest: process.env.LIVE_TEST,
      batchSize: config.legacyRetrofit.batchSize,
      offset: config.legacyRetrofit.offset,
      includeManualReview: config.legacyRetrofit.includeManualReview,
      forceOverwrite: config.legacyRetrofit.forceOverwrite
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
      name: operation.name,
      status: operation.status,
      skippedReason: operation.skippedReason,
      payload: operation.payload,
      ownerRecommendation: operation.ownerRecommendation,
      recommendedWorkspaceEmail: operation.recommendedWorkspaceEmail,
      auditId: operation.audit?.id,
      outboundEventId: operation.outboundEvent?.id,
      error: operation.error
    }))
  };

  console.log(JSON.stringify(output, null, 2));

  if (!result.dryRun && result.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Legacy retrofit apply failed.');
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
