import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import {
  applySentInitialFollowUpPlan,
  buildSentInitialFollowUpRecoveryPlan
} from '../src/workflows/outbound/applySentInitialFollowUpsWorkflow.js';
import {
  buildSentInitialFollowUpApplyOutput,
  DEFAULT_SENT_INITIAL_FOLLOW_UP_APPLY_OUTPUT_PATH,
  DEFAULT_SENT_INITIAL_FOLLOW_UP_RECOVERY_OUTPUT_PATH,
  loadSentInitialFollowUpApplyOutput,
  writeSentInitialFollowUpOutputFile
} from '../src/workflows/outbound/sentInitialFollowUpApplyOutput.js';

const DEFAULT_PLAN_PATH = 'data/sent-initial-follow-up-plan.json';

async function main() {
  const config = loadConfig();
  const planPath = process.env.SENT_INITIAL_FOLLOW_UP_PLAN_PATH ?? DEFAULT_PLAN_PATH;
  const applyOutputPath =
    process.env.SENT_INITIAL_FOLLOW_UP_APPLY_OUTPUT_PATH ??
    DEFAULT_SENT_INITIAL_FOLLOW_UP_APPLY_OUTPUT_PATH;
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
  const applyOutputSource = await loadSentInitialFollowUpApplyOutput({
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
    await writeSentInitialFollowUpOutputFile(
      process.env.SENT_INITIAL_FOLLOW_UP_RECOVERY_OUTPUT_PATH ??
        DEFAULT_SENT_INITIAL_FOLLOW_UP_RECOVERY_OUTPUT_PATH,
      output
    );
    process.exitCode = 1;
    return;
  }

  const recoveryPlan = buildSentInitialFollowUpRecoveryPlan({
    plan,
    applyOutput
  });
  const result = await applySentInitialFollowUpPlan({
    plan: recoveryPlan,
    config,
    log: logger,
    options: {
      applyEnabled: process.env.SENT_INITIAL_FOLLOW_UP_APPLY_ENABLED,
      liveTest: process.env.LIVE_TEST,
      batchSize: process.env.SENT_INITIAL_FOLLOW_UP_BATCH_SIZE,
      offset: process.env.SENT_INITIAL_FOLLOW_UP_OFFSET ?? 0,
      updatePersonStage: process.env.SENT_INITIAL_FOLLOW_UP_UPDATE_PERSON_STAGE,
      linkCompany: process.env.SENT_INITIAL_FOLLOW_UP_LINK_COMPANY,
      includeReview: 'true',
      includeTestRecords: process.env.SENT_INITIAL_FOLLOW_UP_INCLUDE_TEST_RECORDS,
      force: process.env.SENT_INITIAL_FOLLOW_UP_FORCE,
      writeDelayMs: process.env.SENT_INITIAL_FOLLOW_UP_WRITE_DELAY_MS,
      retryAfter429: process.env.SENT_INITIAL_FOLLOW_UP_RETRY_AFTER_429,
      maxRetryAttempts: process.env.SENT_INITIAL_FOLLOW_UP_MAX_RETRY_ATTEMPTS,
      retryFallbackMs: process.env.SENT_INITIAL_FOLLOW_UP_429_FALLBACK_DELAY_MS
    }
  });
  const output = buildSentInitialFollowUpApplyOutput({
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
  await writeSentInitialFollowUpOutputFile(
    process.env.SENT_INITIAL_FOLLOW_UP_RECOVERY_OUTPUT_PATH ??
      DEFAULT_SENT_INITIAL_FOLLOW_UP_RECOVERY_OUTPUT_PATH,
    recoveryOutput
  );

  if (!result.dryRun && (result.summary.failed > 0 || result.summary.verificationFailed > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Sent-initial follow-up recovery failed.');
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
