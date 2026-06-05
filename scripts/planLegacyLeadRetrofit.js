import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { planLegacyLeadRetrofit } from '../src/workflows/outbound/legacyLeadRetrofitWorkflow.js';

async function main() {
  const config = loadConfig();
  const limit = Number(process.env.LEGACY_RETROFIT_LIMIT ?? 100);
  const all = isEnabled(process.env.LEGACY_RETROFIT_ALL);
  const pageSize = Number(process.env.LEGACY_RETROFIT_PAGE_SIZE ?? 100);
  const maxPages = Number(process.env.LEGACY_RETROFIT_MAX_PAGES ?? 10);
  const result = await planLegacyLeadRetrofit({
    config,
    log: logger,
    limit,
    all,
    pageSize,
    maxPages
  });
  const compact = {
    status: result.status,
    dryRun: result.dryRun,
    generatedAt: result.generatedAt,
    pagination: {
      requestedMode: result.pagination?.requestedMode,
      pageSize: result.pagination?.pageSize,
      pagesFetched: result.pagination?.pagesFetched,
      totalFetched: result.pagination?.totalFetched,
      totalCount: result.pagination?.totalCount,
      hasMore: result.pagination?.hasMore,
      nextCursor: result.pagination?.nextCursor,
      finalPlanCount: result.pagination?.finalPlanCount
    },
    metadataStatus: result.metadata.status,
    legacyFields: {
      eventBoolean: result.metadata.fields?.eventBoolean,
      manualLeadStage: result.metadata.fields?.manualLeadStage,
      owner: result.metadata.fields?.owner,
      createdBy: result.metadata.fields?.createdBy
    },
    summary: result.summary,
    warnings: result.warnings,
    samplePlans: result.plans.slice(0, 5)
  };

  console.log(JSON.stringify(compact, null, 2));

  if (process.env.WRITE_LEGACY_RETROFIT_PLAN === 'true') {
    const outputPath = resolve('data/legacy-retrofit-plan.json');
    const summaryPath = resolve('data/legacy-retrofit-summary.md');
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeFile(summaryPath, buildMarkdownSummary(result), 'utf8');
    console.log(`Wrote dry-run retrofit plan to ${outputPath}`);
    console.log(`Wrote dry-run retrofit summary to ${summaryPath}`);
  }
}

function buildMarkdownSummary(result) {
  const summary = result.summary ?? {};

  return [
    '# Legacy Retrofit Dry-Run Summary',
    '',
    `Generated at: ${result.generatedAt}`,
    '',
    '## Status',
    '',
    `- Mode: ${result.status}`,
    `- Dry run: ${result.dryRun ? 'yes' : 'no'}`,
    `- Metadata status: ${result.metadata?.status ?? 'unknown'}`,
    `- Requested fetch mode: ${result.pagination?.requestedMode ?? 'unknown'}`,
    `- Page size: ${result.pagination?.pageSize ?? 'unknown'}`,
    `- Pages fetched: ${result.pagination?.pagesFetched ?? 'unknown'}`,
    `- Total fetched: ${result.pagination?.totalFetched ?? 'unknown'}`,
    `- Twenty totalCount: ${result.pagination?.totalCount ?? 'unknown'}`,
    `- Has more: ${result.pagination?.hasMore ? 'yes' : 'no'}`,
    `- Next cursor: ${result.pagination?.nextCursor ?? 'none'}`,
    `- Final plan count: ${result.pagination?.finalPlanCount ?? summary.totalRecords ?? 0}`,
    `- Total records: ${summary.totalRecords ?? 0}`,
    `- Already retrofitted: ${summary.alreadyRetrofitted ?? 0}`,
    `- Records needing update: ${summary.needingUpdate ?? 0}`,
    `- Safe to update: ${summary.safeToUpdate ?? 0}`,
    `- Requires manual review: ${summary.requiresManualReview ?? 0}`,
    '',
    '## Owner Resolution',
    '',
    `- Resolved owners: ${summary.recordsWithResolvedOwner ?? 0}`,
    `- Missing owners: ${summary.recordsWithMissingOwner ?? 0}`,
    `- Unresolved owners: ${summary.recordsWithUnresolvedOwner ?? 0}`,
    `- Inferred from Created By: ${summary.recordsInferredFromCreatedBy ?? 0}`,
    `- Still missing owner after Created By inference: ${summary.recordsStillMissingOwner ?? 0}`,
    `- Legacy Visible Gap owner: ${summary.recordsOwnedByVisibleGap ?? 0}`,
    '',
    '### Records By Owner',
    '',
    markdownTable(summary.recordsByOwner),
    '',
    '### Records By Created By',
    '',
    markdownTable(summary.recordsByCreatedBy),
    '',
    '### Records By Recommended Workspace Email',
    '',
    markdownTable(summary.recordsByRecommendedWorkspaceEmail),
    '',
    '### Owner Recommendations By Person',
    '',
    ownerRecommendationTable(summary.ownerRecommendationsByPerson),
    '',
    '## Pipeline Breakdown',
    '',
    markdownTable(summary.byPipelineType),
    '',
    '## Cadence Stage Breakdown',
    '',
    markdownTable(summary.byCadenceStage),
    '',
    '## Owner Resolution Warnings',
    '',
    ...buildOwnerWarningLines(result.plans ?? []),
    ''
  ].join('\n');
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
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

function ownerRecommendationTable(recommendations = {}) {
  const entries = Object.entries(recommendations ?? {}).sort(([, left], [, right]) =>
    String(left.name ?? '').localeCompare(String(right.name ?? ''))
  );

  if (entries.length === 0) {
    return '_None._';
  }

  return [
    '| Person ID | Name | Created By | Recommended Owner | Recommended Email | Source |',
    '| --- | --- | --- | --- | --- | --- |',
    ...entries.map(([personId, recommendation]) =>
      [
        escapeMarkdown(personId),
        escapeMarkdown(recommendation.name),
        escapeMarkdown(recommendation.createdByName),
        escapeMarkdown(recommendation.recommendedOwnerName),
        escapeMarkdown(recommendation.recommendedOwnerEmail),
        escapeMarkdown(recommendation.source)
      ].join(' | ')
    ).map((row) => `| ${row} |`)
  ].join('\n');
}

function buildOwnerWarningLines(plans = []) {
  const warningPlans = plans.filter((plan) =>
    ['missing', 'unresolved', 'legacy_visible_gap'].includes(plan.ownerResolutionStatus)
  );

  if (warningPlans.length === 0) {
    return ['_None._'];
  }

  return warningPlans.map((plan) =>
    `- ${escapeMarkdown(plan.name ?? plan.personId ?? 'Unknown person')}: ${plan.ownerResolutionStatus} owner; Created By ${plan.createdByName ?? 'none'}; recommended email ${plan.recommendedWorkspaceEmail ?? 'none'}.`
  );
}

function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

main().catch((error) => {
  console.error('Legacy lead retrofit planning failed.');
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
