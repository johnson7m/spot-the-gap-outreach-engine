import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import {
  applySentInitialFollowUpPlan,
  buildSentInitialFollowUpRecoveryPlan
} from '../src/workflows/outbound/applySentInitialFollowUpsWorkflow.js';

const DEFAULT_PLAN_PATH = 'data/sent-initial-follow-up-plan.json';
const DEFAULT_APPLY_OUTPUT_PATH = 'data/sent-initial-follow-up-apply-latest.json';
const DEFAULT_RECOVERY_OUTPUT_PATH = 'data/sent-initial-follow-up-recovery-latest.json';

async function main() {
  const config = loadConfig();
  const planPath = process.env.SENT_INITIAL_FOLLOW_UP_PLAN_PATH ?? DEFAULT_PLAN_PATH;
  const applyOutputPath =
    process.env.SENT_INITIAL_FOLLOW_UP_APPLY_OUTPUT_PATH ?? DEFAULT_APPLY_OUTPUT_PATH;
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
  const applyOutput = JSON.parse(await readFile(resolve(applyOutputPath), 'utf8'));
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
  const output = {
    status: result.status,
    dryRun: result.dryRun,
    liveEnabled: result.liveEnabled,
    sourceApplyStatus: recoveryPlan.sourceApplyStatus,
    recoverableOperationCount: recoveryPlan.recoverableOperationCount,
    guard: result.guard,
    summary: result.summary,
    retryAfterSeconds: result.retryAfterSeconds,
    recommendedNextCommand: result.recommendedNextCommand,
    warnings: result.warnings,
    operations: result.operations.map((operation) => ({
      personId: operation.personId,
      personName: operation.personName,
      cadenceName: operation.cadenceName,
      oldCadenceStage: operation.cadenceStage,
      recommendedNextCadenceStage: operation.recommendedNextCadenceStage,
      latestTouchStatus: operation.latestTouchStatus,
      currentInitialTaskId: operation.currentInitialTaskId,
      recommendedTaskTitle: operation.recommendedTaskTitle,
      recommendedDueDate: operation.recommendedDueDate,
      status: operation.status,
      skippedReason: operation.skippedReason,
      dedupeKey: operation.dedupeKey,
      taskId: operation.task?.id,
      personTargetId: operation.personTarget?.id,
      companyTargetId: operation.companyTarget?.id,
      duplicateTaskSkipped: operation.duplicateTaskSkipped,
      retryAttempts: operation.retryAttempts,
      retryAfterSeconds: operation.retryAfterSeconds,
      verification: operation.verification,
      auditId: operation.audit?.id,
      outboundEventId: operation.outboundEvent?.id,
      error: operation.error
    }))
  };

  console.log(JSON.stringify(output, null, 2));
  await writeFile(
    resolve(process.env.SENT_INITIAL_FOLLOW_UP_RECOVERY_OUTPUT_PATH ?? DEFAULT_RECOVERY_OUTPUT_PATH),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8'
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
