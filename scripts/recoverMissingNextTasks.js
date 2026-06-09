import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import {
  applyMissingNextTaskPlan,
  buildMissingNextTaskRecoveryPlan
} from '../src/workflows/outbound/applyMissingNextTasksWorkflow.js';
import {
  buildMissingNextTaskApplyOutput,
  DEFAULT_MISSING_NEXT_TASK_APPLY_OUTPUT_PATH,
  DEFAULT_MISSING_NEXT_TASK_RECOVERY_OUTPUT_PATH,
  loadMissingNextTaskApplyOutput,
  writeMissingNextTaskOutputFile
} from '../src/workflows/outbound/missingNextTaskApplyOutput.js';

const DEFAULT_PLAN_PATH = 'data/missing-next-task-plan.json';

async function main() {
  const config = loadConfig();
  const planPath = process.env.MISSING_NEXT_TASK_PLAN_PATH ?? DEFAULT_PLAN_PATH;
  const applyOutputPath =
    process.env.MISSING_NEXT_TASK_APPLY_OUTPUT_PATH ?? DEFAULT_MISSING_NEXT_TASK_APPLY_OUTPUT_PATH;
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
  const applyOutputSource = await loadMissingNextTaskApplyOutput({
    applyOutputPath,
    config
  });
  const applyOutput = applyOutputSource.output;

  if (applyOutputSource.source === 'missing') {
    const output = {
      ...applyOutput,
      warnings: [...(applyOutput.warnings ?? []), ...(applyOutputSource.warnings ?? [])]
    };

    console.log(JSON.stringify(output, null, 2));
    await writeMissingNextTaskOutputFile(
      process.env.MISSING_NEXT_TASK_RECOVERY_OUTPUT_PATH ??
        DEFAULT_MISSING_NEXT_TASK_RECOVERY_OUTPUT_PATH,
      output
    );
    process.exitCode = 1;
    return;
  }

  const recoveryPlan = buildMissingNextTaskRecoveryPlan({
    plan,
    applyOutput
  });
  const result = await applyMissingNextTaskPlan({
    plan: recoveryPlan,
    config,
    log: logger,
    options: {
      applyEnabled: process.env.MISSING_NEXT_TASK_APPLY_ENABLED,
      liveTest: process.env.LIVE_TEST,
      batchSize: process.env.MISSING_NEXT_TASK_BATCH_SIZE,
      offset: process.env.MISSING_NEXT_TASK_OFFSET ?? 0,
      includeReview: 'true',
      includeTestRecords: process.env.MISSING_NEXT_TASK_INCLUDE_TEST_RECORDS,
      force: process.env.MISSING_NEXT_TASK_FORCE,
      linkCompany: process.env.MISSING_NEXT_TASK_LINK_COMPANY,
      allowPastDue: process.env.MISSING_NEXT_TASK_ALLOW_PAST_DUE,
      writeDelayMs: process.env.MISSING_NEXT_TASK_WRITE_DELAY_MS,
      retryAfter429: process.env.MISSING_NEXT_TASK_RETRY_AFTER_429,
      maxRetryAttempts: process.env.MISSING_NEXT_TASK_MAX_RETRY_ATTEMPTS,
      retryFallbackMs: process.env.MISSING_NEXT_TASK_429_FALLBACK_DELAY_MS
    }
  });
  const output = buildMissingNextTaskApplyOutput({
    result,
    kind: 'recovery',
    recoveryPlan
  });
  const recoveryOutput = {
    ...output,
    applyOutputSource: applyOutputSource.source,
    missingApplyOutputFile: applyOutputSource.missingFile,
    sourceApplyStatus: recoveryPlan.sourceApplyStatus,
    recoverableOperationCount: recoveryPlan.recoverableOperationCount,
    warnings: [...(applyOutputSource.warnings ?? []), ...(output.warnings ?? [])]
  };

  console.log(JSON.stringify(recoveryOutput, null, 2));
  await writeMissingNextTaskOutputFile(
    process.env.MISSING_NEXT_TASK_RECOVERY_OUTPUT_PATH ??
      DEFAULT_MISSING_NEXT_TASK_RECOVERY_OUTPUT_PATH,
    recoveryOutput
  );

  if (!result.dryRun && (result.summary.failed > 0 || result.summary.verificationFailed > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Missing next-task recovery failed.');
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
