import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { planMissingNextTasks } from '../src/workflows/outbound/missingNextTaskPlanner.js';

const PLAN_PATH = 'data/missing-next-task-plan.json';
const SUMMARY_PATH = 'data/missing-next-task-summary.md';

async function main() {
  const config = loadConfig();
  const includeTestRecords = process.env.INCLUDE_TEST_RECORDS === 'true';
  const result = await planMissingNextTasks({
    config,
    log: logger,
    includeTestRecords,
    pageSize: Number(process.env.MISSING_NEXT_TASK_PAGE_SIZE ?? process.env.LEGACY_RETROFIT_PAGE_SIZE ?? 100),
    maxPages: Number(process.env.MISSING_NEXT_TASK_MAX_PAGES ?? process.env.LEGACY_RETROFIT_MAX_PAGES ?? 10)
  });
  const compact = {
    status: result.status,
    dryRun: result.dryRun,
    generatedAt: result.generatedAt,
    includeTestRecords: result.includeTestRecords,
    pagination: summarizePagination(result.pagination),
    summary: result.summary,
    warnings: result.warnings,
    samplePlans: result.plans.slice(0, 10)
  };

  console.log(JSON.stringify(compact, null, 2));

  const outputPath = resolve(PLAN_PATH);
  const summaryPath = resolve(SUMMARY_PATH);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFile(summaryPath, buildMarkdownSummary(result), 'utf8');
  console.log(`Wrote missing next-task plan to ${outputPath}`);
  console.log(`Wrote missing next-task summary to ${summaryPath}`);
}

function summarizePagination(pagination) {
  if (!pagination?.objects) {
    return pagination ?? null;
  }

  return Object.fromEntries(
    Object.entries(pagination.objects).map(([objectName, value]) => [
      objectName,
      {
        pagesFetched: value.pagesFetched,
        totalFetched: value.totalFetched,
        totalCount: value.totalCount,
        hasMore: value.hasMore
      }
    ])
  );
}

function buildMarkdownSummary(result) {
  const summary = result.summary ?? {};
  const safePlans = (result.plans ?? []).filter((plan) => plan.safeToCreate);

  return [
    '# Missing Next-Task Dry-Run Summary',
    '',
    `Generated at: ${result.generatedAt}`,
    '',
    '## Status',
    '',
    `- Mode: ${result.status}`,
    `- Dry run: ${result.dryRun ? 'yes' : 'no'}`,
    `- Include test records: ${result.includeTestRecords ? 'yes' : 'no'}`,
    `- Missing next-task candidates: ${summary.missingNextTaskCount ?? 0}`,
    `- Safe task creation candidates: ${summary.safeToCreate ?? 0}`,
    `- Requires review: ${summary.requiresReview ?? 0}`,
    `- Test records hidden: ${summary.hiddenTestRecords ?? 0}`,
    `- Test records included: ${summary.includedTestRecords ?? 0}`,
    '',
    '## By Cadence',
    '',
    markdownTable(summary.byCadenceName),
    '',
    '## By Cadence Stage',
    '',
    markdownTable(summary.byCadenceStage),
    '',
    '## By Confidence',
    '',
    markdownTable(summary.byConfidence),
    '',
    '## Safe Candidates',
    '',
    safePlans.length > 0
      ? [
          '| Person | Cadence | Stage | Task | Due | Owner |',
          '| --- | --- | --- | --- | --- | --- |',
          ...safePlans
            .slice(0, 50)
            .map(
              (plan) =>
                `| ${escapeMarkdown(plan.personName ?? plan.personId)} | ${escapeMarkdown(plan.cadenceName)} | ${escapeMarkdown(plan.cadenceStage)} | ${escapeMarkdown(plan.recommendedTaskTitle)} | ${escapeMarkdown(plan.recommendedDueDate)} | ${escapeMarkdown(plan.owner?.email ?? plan.owner?.name ?? 'Unresolved')} |`
            )
        ].join('\n')
      : '_None._',
    '',
    '## Future Apply Stub',
    '',
    '`queues:apply-missing-next-tasks` is implemented as a guarded apply path. It remains dry-run by default and requires explicit live guards plus a batch size before any Task creation.',
    ''
  ].join('\n');
}

function markdownTable(counts = {}) {
  const entries = Object.entries(counts ?? {}).sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    return '_None._';
  }

  return [
    '| Value | Count |',
    '| --- | ---: |',
    ...entries.map(([value, count]) => `| ${escapeMarkdown(value)} | ${count} |`)
  ].join('\n');
}

function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

main().catch((error) => {
  console.error('Missing next-task planning failed.');
  console.error(
    JSON.stringify(
      {
        message: error.message,
        code: error.code,
        httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
