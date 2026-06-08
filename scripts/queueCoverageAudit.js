import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { createTwentyQueueDataSource } from '../src/integrations/twenty/queueDataSource.js';
import { buildQueueCoverageAudit } from '../src/services/queueService.js';

const AUDIT_PATH = 'data/queue-coverage-audit.json';
const SUMMARY_PATH = 'data/queue-coverage-summary.md';

async function main() {
  const config = loadConfig();
  const source = createTwentyQueueDataSource({
    config: config.twenty,
    queueRead: config.queueRead ?? {},
    log: logger
  });
  const records = await source.listAllQueueRecords({
    pageSize: Number(process.env.QUEUE_COVERAGE_PAGE_SIZE ?? process.env.LEGACY_RETROFIT_PAGE_SIZE ?? 100),
    maxPages: Number(process.env.QUEUE_COVERAGE_MAX_PAGES ?? process.env.LEGACY_RETROFIT_MAX_PAGES ?? 10),
    query: {
      ownerScope: 'all',
      assigneeScope: 'all'
    }
  });
  const audit = buildQueueCoverageAudit({
    people: records.people,
    companies: records.companies,
    tasks: records.tasks,
    taskTargets: records.taskTargets,
    workspaceMembers: records.workspaceMembers,
    query: {
      ownerScope: 'all',
      assigneeScope: 'all'
    },
    now: new Date()
  });
  const output = {
    ...audit,
    pagination: summarizePagination(records.pagination),
    readStatus: records.readStatus ?? null,
    warnings: records.warnings ?? []
  };

  await writeJson(AUDIT_PATH, output);
  await writeText(SUMMARY_PATH, buildMarkdownSummary(output));

  console.log(
    JSON.stringify(
      {
        generatedAt: output.generatedAt,
        pagination: output.pagination,
        readStatus: output.readStatus,
        summary: output.summary,
        warnings: output.warnings,
        outputs: {
          audit: resolve(AUDIT_PATH),
          summary: resolve(SUMMARY_PATH)
        }
      },
      null,
      2
    )
  );
}

async function writeJson(path, value) {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(path, value) {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, value, 'utf8');
}

function buildMarkdownSummary(audit) {
  const summary = audit.summary ?? {};
  const pipelineOnly = (audit.records ?? []).filter(
    (record) =>
      record.disposition === 'pipeline_review' &&
      record.matchedQueueCandidates?.length === 1 &&
      record.matchedQueueCandidates[0] === 'pipeline-review'
  );
  const unclassified = (audit.records ?? []).filter(
    (record) => record.disposition === 'unclassified_needs_rule'
  );

  return [
    '# Queue Coverage Audit',
    '',
    `Generated at: ${audit.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Total People: ${summary.totalPeople ?? 0}`,
    `- Hidden test records: ${summary.hiddenTestRecords ?? 0}`,
    `- Expected real People: ${summary.expectedRealPeople ?? 0}`,
    `- Accounted-for People: ${summary.accountedForPeople ?? 0}`,
    `- Unclassified People: ${summary.unclassifiedPeople ?? 0}`,
    `- Duplicate/multi-queue candidate count: ${summary.duplicateMultiQueueCandidateCount ?? 0}`,
    '',
    '## Counts By Final Queue',
    '',
    markdownTable(summary.countsByFinalQueue),
    '',
    '## Counts By Disposition',
    '',
    markdownTable(summary.countsByDisposition),
    '',
    '## Counts By Exclusion Reason',
    '',
    markdownTable(summary.countsByExclusionReason),
    '',
    '## Pipeline Review Only',
    '',
    pipelineOnly.length > 0
      ? [
          '| Person | Owner | Reasons | Recommended Fix |',
          '| --- | --- | --- | --- |',
          ...pipelineOnly
            .slice(0, 75)
            .map(
              (record) =>
                `| ${escapeMarkdown(record.personName ?? record.personId)} | ${escapeMarkdown(record.owner?.email ?? record.owner?.name ?? '')} | ${escapeMarkdown((record.exclusionReasons ?? []).join(', '))} | ${escapeMarkdown(record.recommendedFix ?? '')} |`
            )
        ].join('\n')
      : '_None._',
    '',
    '## Unclassified People',
    '',
    unclassified.length > 0
      ? [
          '| Person | Owner | Reasons | Recommended Fix |',
          '| --- | --- | --- | --- |',
          ...unclassified
            .slice(0, 75)
            .map(
              (record) =>
                `| ${escapeMarkdown(record.personName ?? record.personId)} | ${escapeMarkdown(record.owner?.email ?? record.owner?.name ?? '')} | ${escapeMarkdown((record.exclusionReasons ?? []).join(', '))} | ${escapeMarkdown(record.recommendedFix ?? '')} |`
            )
        ].join('\n')
      : '_None._',
    '',
    '## Notes',
    '',
    '- `accountedForPeople` excludes hidden test records and counts active queues, Pipeline Review, terminal closed records, and active clients as explicit dispositions.',
    '- Pipeline Review can be larger than active work queues because it is the explicit catch-all for data gaps, normalization gaps, missing tasks, and manual review reasons.',
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

function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

main().catch((error) => {
  console.error('Queue coverage audit failed.');
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
