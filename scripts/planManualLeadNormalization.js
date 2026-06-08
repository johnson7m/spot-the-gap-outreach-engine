import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { planManualLeadNormalization } from '../src/workflows/outbound/manualLeadNormalizationPlanner.js';

const PLAN_PATH = 'data/manual-lead-normalization-plan.json';
const SUMMARY_PATH = 'data/manual-lead-normalization-summary.md';

async function main() {
  const config = loadConfig();
  const includeTestRecords = process.env.INCLUDE_TEST_RECORDS === 'true';
  const result = await planManualLeadNormalization({
    config,
    log: logger,
    includeTestRecords,
    pageSize: Number(process.env.MANUAL_LEAD_NORMALIZATION_PAGE_SIZE ?? process.env.LEGACY_RETROFIT_PAGE_SIZE ?? 100),
    maxPages: Number(process.env.MANUAL_LEAD_NORMALIZATION_MAX_PAGES ?? process.env.LEGACY_RETROFIT_MAX_PAGES ?? 10)
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
  console.log(`Wrote manual lead normalization plan to ${outputPath}`);
  console.log(`Wrote manual lead normalization summary to ${summaryPath}`);
}

function buildMarkdownSummary(result) {
  const summary = result.summary ?? {};
  const safePlans = (result.plans ?? []).filter((plan) => plan.safeToNormalize);

  return [
    '# Manual Lead Normalization Dry-Run Summary',
    '',
    `Generated at: ${result.generatedAt}`,
    '',
    '## Status',
    '',
    `- Mode: ${result.status}`,
    `- Dry run: ${result.dryRun ? 'yes' : 'no'}`,
    `- Include test records: ${result.includeTestRecords ? 'yes' : 'no'}`,
    `- Manual lead normalization candidates: ${summary.manualLeadNormalizationCount ?? 0}`,
    `- Safe to normalize: ${summary.safeToNormalize ?? 0}`,
    `- Requires review: ${summary.requiresReview ?? 0}`,
    `- Test records hidden: ${summary.hiddenTestRecords ?? 0}`,
    `- Test records included: ${summary.includedTestRecords ?? 0}`,
    '',
    '## By Lead Stage',
    '',
    markdownTable(summary.byLeadStage),
    '',
    '## By Recommended Pipeline',
    '',
    markdownTable(summary.byRecommendedPipeline),
    '',
    '## By Recommended Cadence Stage',
    '',
    markdownTable(summary.byRecommendedCadenceStage),
    '',
    '## By Recommended Task Action',
    '',
    markdownTable(summary.byRecommendedTaskAction),
    '',
    '## Safe Candidates',
    '',
    safePlans.length > 0
      ? [
          '| Person | Lead Stage | Company | Owner | Pipeline | Cadence Stage | Task Action |',
          '| --- | --- | --- | --- | --- | --- | --- |',
          ...safePlans
            .slice(0, 50)
            .map(
              (plan) =>
                `| ${escapeMarkdown(plan.personName ?? plan.personId)} | ${escapeMarkdown(plan.leadStage)} | ${escapeMarkdown(plan.companyName ?? 'Unresolved')} | ${escapeMarkdown(plan.assignedRep ?? 'Unresolved')} | ${escapeMarkdown(plan.recommendedUpdates.outboundPipelineType)} | ${escapeMarkdown(plan.recommendedUpdates.cadenceStage)} | ${escapeMarkdown(plan.recommendedTaskAction)} |`
            )
        ].join('\n')
      : '_None._',
    '',
    '## Guarded Apply',
    '',
    '`queues:apply-manual-lead-normalization` is dry-run by default. Live apply requires `MANUAL_LEAD_NORMALIZATION_APPLY_ENABLED=true`, `LIVE_TEST=true`, and `MANUAL_LEAD_NORMALIZATION_BATCH_SIZE`. The guarded apply path updates only missing outbound fields, excludes protected assessment fields, and keeps Task creation in separate explicit task apply flows.',
    ''
  ].join('\n');
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
  console.error('Manual lead normalization planning failed.');
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
