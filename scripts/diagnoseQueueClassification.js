import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { createTwentyQueueDataSource } from '../src/integrations/twenty/queueDataSource.js';
import { buildQueueClassificationDiagnostics } from '../src/services/queueService.js';

async function main() {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const personId = args.personId ?? process.env.PERSON_ID;
  const taskId = args.taskId ?? process.env.TASK_ID;
  const limit = args.limit ?? process.env.LIMIT ?? 50;
  const source = createTwentyQueueDataSource({
    config: config.twenty,
    log: logger
  });
  const records = await source.listAllQueueRecords({
    pageSize: Number(process.env.QUEUE_CLASSIFICATION_PAGE_SIZE ?? 100),
    maxPages: Number(process.env.QUEUE_CLASSIFICATION_MAX_PAGES ?? config.legacyRetrofit?.maxPages ?? 10)
  });
  const report = buildQueueClassificationDiagnostics({
    people: records.people,
    companies: records.companies,
    tasks: records.tasks,
    taskTargets: records.taskTargets,
    workspaceMembers: records.workspaceMembers,
    query: {
      personId,
      taskId,
      limit,
      includeTestRecords: args.includeTestRecords ?? process.env.INCLUDE_TEST_RECORDS
    },
    now: new Date()
  });

  console.log(
    JSON.stringify(
      {
        generatedAt: report.generatedAt,
        filters: {
          personId: personId ?? null,
          taskId: taskId ?? null,
          limit: Number(limit)
        },
        pagination: summarizePagination(records.pagination),
        warnings: records.warnings ?? [],
        count: report.count,
        items: report.items
      },
      null,
      2
    )
  );
}

function parseArgs(args = []) {
  return args.reduce((acc, arg) => {
    if (arg === '--include-test-records') {
      acc.includeTestRecords = 'true';
      return acc;
    }

    const match = arg.match(/^--([^=]+)=(.*)$/);

    if (!match) {
      return acc;
    }

    const [, key, value] = match;
    const normalizedKey = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    acc[normalizedKey] = value;
    return acc;
  }, {});
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

main().catch((error) => {
  console.error('Queue classification diagnostics failed.');
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
