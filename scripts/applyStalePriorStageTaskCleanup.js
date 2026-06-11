import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { applyStalePriorStageTaskCleanupPlan } from '../src/workflows/outbound/applyStalePriorStageTaskCleanupWorkflow.js';

const DEFAULT_PLAN_PATH = 'data/stale-prior-stage-task-cleanup-plan.json';

async function main() {
  const config = loadConfig();
  const planPath = process.env.STALE_PRIOR_STAGE_TASK_CLEANUP_PLAN_PATH ?? DEFAULT_PLAN_PATH;
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
  const result = await applyStalePriorStageTaskCleanupPlan({
    plan,
    config,
    log: logger,
    options: {
      applyEnabled: process.env.STALE_PRIOR_STAGE_TASK_CLEANUP_ENABLED,
      liveTest: process.env.LIVE_TEST,
      batchSize: process.env.STALE_PRIOR_STAGE_TASK_CLEANUP_BATCH_SIZE,
      offset: process.env.STALE_PRIOR_STAGE_TASK_CLEANUP_OFFSET
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
      taskDueDate: operation.taskDueDate,
      taskCadenceStage: operation.taskCadenceStage,
      personId: operation.personId,
      personName: operation.personName,
      personCadenceStage: operation.personCadenceStage,
      currentQueueTaskId: operation.currentQueueTaskId,
      status: operation.status,
      skippedReason: operation.skippedReason,
      payload: operation.payload,
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
  console.error('Stale prior-stage task cleanup apply failed.');
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
