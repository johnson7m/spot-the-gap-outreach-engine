import { createTwentyQueueDataSource } from '../../integrations/twenty/queueDataSource.js';
import { buildQueue, normalizeQueueQuery } from '../../services/queueService.js';

export async function getOutboundQueueWorkflow({
  queueSlug,
  query = {},
  config = {},
  log,
  workspaceUser,
  dataSource,
  now = new Date()
} = {}) {
  const normalizedQuery = normalizeQueueQuery(query, workspaceUser);
  const source =
    dataSource ??
    createTwentyQueueDataSource({
      config: config.twenty ?? config,
      log
    });
  const records =
    typeof source.listAllQueueRecords === 'function'
      ? await source.listAllQueueRecords({
          pageSize: 100,
          maxPages: config.queue?.maxPages ?? config.legacyRetrofit?.maxPages ?? 10,
          query: normalizedQuery
        })
      : await source.listQueueRecords({
          limit: Math.min(Math.max(normalizedQuery.limit + normalizedQuery.offset, 100), 250),
          offset: 0,
          query: normalizedQuery
        });
  const queue = buildQueue({
    queueSlug,
    people: records.people,
    tasks: records.tasks,
    taskTargets: records.taskTargets,
    noteTargets: records.noteTargets,
    timelineActivities: records.timelineActivities,
    workspaceMembers: records.workspaceMembers,
    workspaceUser,
    query: normalizedQuery,
    now
  });
  const warningBuckets = splitQueueWarnings({
    recordWarnings: records.warnings ?? [],
    paginationWarnings: buildPaginationWarnings(records.pagination)
  });

  return {
    ...queue,
    dataSource: source.provider ?? 'unknown',
    diagnostics: {
      ...(queue.diagnostics ?? {}),
      timelinePaginationWarning: warningBuckets.timelinePaginationWarning
    },
    warnings: [
      ...warningBuckets.userWarnings,
      ...(queue.warnings ?? [])
    ]
  };
}

function splitQueueWarnings({ recordWarnings = [], paginationWarnings = [] } = {}) {
  const timelineWarnings = [...recordWarnings, ...paginationWarnings].filter(isTimelinePaginationWarning);

  return {
    timelinePaginationWarning: timelineWarnings[0] ?? null,
    userWarnings: [...recordWarnings, ...paginationWarnings].filter(
      (warning) => !isTimelinePaginationWarning(warning)
    )
  };
}

function isTimelinePaginationWarning(warning = '') {
  return /timelineActivities pagination stopped/i.test(String(warning));
}

function buildPaginationWarnings(pagination) {
  if (!pagination?.objects) {
    return [];
  }

  return Object.entries(pagination.objects)
    .filter(([, value]) => value?.hasMore)
    .map(
      ([objectName, value]) =>
        `Twenty ${objectName} pagination stopped at ${value.pagesFetched} pages with more records available; queue relationship resolution may be incomplete.`
    );
}
