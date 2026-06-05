import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { planLegacyOwnerCleanup } from '../src/workflows/outbound/legacyOwnerCleanupWorkflow.js';

async function main() {
  const retrofitPlanPath =
    process.env.LEGACY_RETROFIT_PLAN_PATH || 'data/legacy-retrofit-plan.json';
  const outputPath =
    process.env.LEGACY_OWNER_PLAN_PATH || 'data/legacy-owner-cleanup-plan.json';
  const summaryPath = 'data/legacy-owner-cleanup-summary.md';
  const retrofitPlan = JSON.parse(await readFile(resolve(retrofitPlanPath), 'utf8'));
  const plan = planLegacyOwnerCleanup({
    retrofitPlan,
    forceOverwrite: process.env.LEGACY_OWNER_FORCE_OVERWRITE === 'true'
  });

  await writeFile(resolve(outputPath), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  await writeFile(resolve(summaryPath), buildMarkdownSummary(plan), 'utf8');

  console.log(
    JSON.stringify(
      {
        status: plan.status,
        dryRun: plan.dryRun,
        generatedAt: plan.generatedAt,
        metadata: plan.metadata,
        summary: plan.summary,
        warnings: plan.warnings,
        sampleRecommendations: plan.recommendations.slice(0, 5)
      },
      null,
      2
    )
  );
  console.log(`Wrote owner cleanup plan to ${resolve(outputPath)}`);
  console.log(`Wrote owner cleanup summary to ${resolve(summaryPath)}`);
}

function buildMarkdownSummary(plan) {
  const summary = plan.summary ?? {};

  return [
    '# Legacy Owner Cleanup Dry-Run Summary',
    '',
    `Generated at: ${plan.generatedAt}`,
    '',
    '## Status',
    '',
    `- Mode: ${plan.status}`,
    `- Dry run: ${plan.dryRun ? 'yes' : 'no'}`,
    `- Total recommendations: ${summary.totalRecommendations ?? 0}`,
    `- Safe to update: ${summary.safeToUpdate ?? 0}`,
    `- Skipped existing owner: ${summary.skippedExistingOwner ?? 0}`,
    '',
    '## Payload Shape',
    '',
    `- Method: ${plan.metadata?.payloadShape?.method ?? 'PATCH'}`,
    `- Object: ${plan.metadata?.payloadShape?.objectPlural ?? 'people'}`,
    `- Relation field: ${plan.metadata?.payloadShape?.relationField ?? 'owner'}`,
    `- Join column: ${plan.metadata?.payloadShape?.joinColumnName ?? 'ownerId'}`,
    '',
    '## By Recommended Owner Email',
    '',
    markdownTable(summary.byRecommendedOwnerEmail),
    '',
    '## By Created By',
    '',
    markdownTable(summary.byCreatedBy),
    '',
    '## Recommendations',
    '',
    recommendationTable(plan.recommendations ?? []),
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

function recommendationTable(recommendations = []) {
  if (recommendations.length === 0) {
    return '_None._';
  }

  return [
    '| Person ID | Name | Current Owner | Created By | Recommended Owner | Recommended Email | Safe |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...recommendations.map((recommendation) =>
      [
        escapeMarkdown(recommendation.personId),
        escapeMarkdown(recommendation.name),
        escapeMarkdown(recommendation.currentOwnerName ?? recommendation.currentOwnerId ?? ''),
        escapeMarkdown(recommendation.createdByName),
        escapeMarkdown(recommendation.recommendedOwnerName),
        escapeMarkdown(recommendation.recommendedOwnerEmail),
        recommendation.safeToUpdate ? 'yes' : 'no'
      ].join(' | ')
    ).map((row) => `| ${row} |`)
  ].join('\n');
}

function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

main().catch((error) => {
  console.error('Legacy owner cleanup planning failed.');
  console.error(
    JSON.stringify(
      {
        message: error.message,
        code: error.code,
        details: error.details
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
