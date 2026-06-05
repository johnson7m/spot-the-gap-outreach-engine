import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { planLegacyTaskRetrofit } from '../src/workflows/outbound/legacyTaskRetrofitWorkflow.js';

async function main() {
  const config = loadConfig();
  const result = await planLegacyTaskRetrofit({
    config,
    log: logger,
    pageSize: Number(process.env.LEGACY_RETROFIT_PAGE_SIZE ?? 100),
    maxPages: Number(process.env.LEGACY_RETROFIT_MAX_PAGES ?? 10),
    limit: Number(process.env.LIMIT ?? 100)
  });
  const compact = {
    status: result.status,
    dryRun: result.dryRun,
    generatedAt: result.generatedAt,
    pagination: summarizePagination(result.pagination),
    summary: result.summary,
    warnings: result.warnings,
    samplePlans: result.plans.slice(0, 10)
  };

  console.log(JSON.stringify(compact, null, 2));

  if (process.env.WRITE_LEGACY_TASK_RETROFIT_PLAN !== 'false') {
    const outputPath = resolve('data/legacy-task-retrofit-plan.json');
    const summaryPath = resolve('data/legacy-task-retrofit-summary.md');
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeFile(summaryPath, buildMarkdownSummary(result), 'utf8');
    console.log(`Wrote dry-run task retrofit plan to ${outputPath}`);
    console.log(`Wrote dry-run task retrofit summary to ${summaryPath}`);
  }
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

  return [
    '# Legacy Task Retrofit Dry-Run Summary',
    '',
    `Generated at: ${result.generatedAt}`,
    '',
    '## Status',
    '',
    `- Mode: ${result.status}`,
    `- Dry run: ${result.dryRun ? 'yes' : 'no'}`,
    `- Total tasks: ${summary.totalTasks ?? 0}`,
    `- Existing Person targets: ${summary.currentPersonTargets ?? 0}`,
    `- Inferred Person targets: ${summary.inferredPersonTargets ?? 0}`,
    `- Safe to update in a future task-target apply: ${summary.safeToUpdate ?? 0}`,
    `- Manual review: ${summary.manualReview ?? 0}`,
    `- Unassigned tasks: ${summary.unassignedTasks ?? 0}`,
    '',
    '## Recommended Actions',
    '',
    markdownTable(summary.byRecommendedAction),
    '',
    '## Confidence',
    '',
    markdownTable(summary.byConfidence),
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
  console.error('Legacy task retrofit planning failed.');
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
