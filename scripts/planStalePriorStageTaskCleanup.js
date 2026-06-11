import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { createTwentyQueueDataSource } from '../src/integrations/twenty/queueDataSource.js';
import { buildStalePriorStageTaskCleanupPlan } from '../src/services/queueService.js';

const DEFAULT_JSON_PATH = 'data/stale-prior-stage-task-cleanup-plan.json';
const DEFAULT_SUMMARY_PATH = 'data/stale-prior-stage-task-cleanup-summary.md';

async function main() {
  const config = loadConfig();
  const source = createTwentyQueueDataSource({
    config: config.twenty,
    queueRead: {
      ...(config.queueRead ?? {}),
      cacheEnabled: false
    }
  });
  const records = await source.listAllQueueRecords({
    pageSize: Number(process.env.TASK_CLEANUP_PAGE_SIZE ?? 100),
    maxPages: Number(process.env.TASK_CLEANUP_MAX_PAGES ?? config.legacyRetrofit?.maxPages ?? 10),
    query: {
      bypassCache: true
    },
    observabilityContext: {
      endpoint: 'script:tasks:plan-stale-prior-stage-cleanup',
      workflow: 'tasks:plan-stale-prior-stage-cleanup',
      requestSource: 'cli'
    }
  });
  const plan = buildStalePriorStageTaskCleanupPlan({
    people: records.people,
    companies: records.companies,
    tasks: records.tasks,
    taskTargets: records.taskTargets,
    workspaceMembers: records.workspaceMembers
  });
  const jsonPath = process.env.STALE_PRIOR_STAGE_TASK_CLEANUP_PLAN_PATH ?? DEFAULT_JSON_PATH;
  const summaryPath =
    process.env.STALE_PRIOR_STAGE_TASK_CLEANUP_SUMMARY_PATH ?? DEFAULT_SUMMARY_PATH;

  await writeJson(jsonPath, plan);
  await writeText(summaryPath, renderSummary(plan));

  console.log(JSON.stringify({
    summary: plan.summary,
    jsonPath,
    summaryPath
  }, null, 2));
}

function renderSummary(plan) {
  const topRows = plan.records.slice(0, 25).map((record) =>
    `| ${record.staleTaskId} | ${record.personName} | ${record.personCadenceStage} | ${record.staleTaskCadenceStage} | ${record.staleTaskDueDate ?? ''} | ${record.currentQueueTaskId ?? ''} |`
  );

  return [
    '# Stale Prior-Stage Task Cleanup Plan',
    '',
    `Generated at: ${plan.generatedAt}`,
    '',
    `- Total People: ${plan.summary.totalPeople}`,
    `- Total Tasks: ${plan.summary.totalTasks}`,
    `- Stale prior-stage tasks: ${plan.summary.stalePriorStageTasks}`,
    `- People affected: ${plan.summary.peopleAffected}`,
    '',
    '## Top Candidates',
    '',
    '| Task ID | Person | Person Stage | Task Stage | Task Due Date | Current Queue Task |',
    '| --- | --- | --- | --- | --- | --- |',
    ...(topRows.length > 0 ? topRows : ['| None |  |  |  |  |  |']),
    ''
  ].join('\n');
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
