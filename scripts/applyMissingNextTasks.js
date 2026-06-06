import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { applyMissingNextTaskPlan } from '../src/workflows/outbound/applyMissingNextTasksWorkflow.js';

const DEFAULT_PLAN_PATH = 'data/missing-next-task-plan.json';

async function main() {
  const config = loadConfig();
  const planPath = process.env.MISSING_NEXT_TASK_PLAN_PATH ?? DEFAULT_PLAN_PATH;
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
  const result = await applyMissingNextTaskPlan({
    plan,
    config,
    log: logger,
    options: {
      applyEnabled: process.env.MISSING_NEXT_TASK_APPLY_ENABLED,
      liveTest: process.env.LIVE_TEST,
      batchSize: process.env.MISSING_NEXT_TASK_BATCH_SIZE,
      offset: process.env.MISSING_NEXT_TASK_OFFSET,
      includeReview: process.env.MISSING_NEXT_TASK_INCLUDE_REVIEW,
      includeTestRecords: process.env.MISSING_NEXT_TASK_INCLUDE_TEST_RECORDS,
      force: process.env.MISSING_NEXT_TASK_FORCE,
      linkCompany: process.env.MISSING_NEXT_TASK_LINK_COMPANY,
      allowPastDue: process.env.MISSING_NEXT_TASK_ALLOW_PAST_DUE
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
      cadenceName: operation.cadenceName,
      cadenceStage: operation.cadenceStage,
      recommendedTaskTitle: operation.recommendedTaskTitle,
      recommendedDueDate: operation.recommendedDueDate,
      originalRecommendedDueDate: operation.originalRecommendedDueDate,
      originalNextOutboundTouchDate: operation.originalNextOutboundTouchDate,
      dueDateAdjusted: operation.dueDateAdjusted,
      dueDateAdjustmentReason: operation.dueDateAdjustmentReason,
      recommendedTaskType: operation.recommendedTaskType,
      status: operation.status,
      skippedReason: operation.skippedReason,
      dedupeKey: operation.dedupeKey,
      taskPayload: operation.taskPayload,
      taskId: operation.task?.id,
      personTargetId: operation.personTarget?.id,
      companyTargetId: operation.companyTarget?.id,
      duplicateTaskSkipped: operation.duplicateTaskSkipped,
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
  console.error('Missing next-task apply failed.');
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
