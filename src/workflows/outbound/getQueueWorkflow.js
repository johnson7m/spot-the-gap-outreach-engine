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
      queueRead: config.queueRead ?? {},
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
  const readStatus = normalizeQueueReadStatus(records.readStatus);
  const readWarnings = buildQueueReadWarnings(readStatus);
  const queueWarnings = [
    ...warningBuckets.userWarnings,
    ...readWarnings,
    ...(queue.warnings ?? [])
  ];

  if (isCriticalReadDegraded(readStatus)) {
    return {
      queueName: queue.queueName,
      queueSlug: queue.queueSlug,
      items: [],
      count: null,
      limit: queue.limit,
      offset: queue.offset,
      ownerScope: queue.ownerScope,
      assigneeScope: queue.assigneeScope,
      dataSource: source.provider ?? 'unknown',
      status: readStatus.status,
      isPartial: true,
      partialReason: readStatus.partialReason,
      retryAfterSeconds: readStatus.retryAfterSeconds,
      diagnostics: {
        ...(queue.diagnostics ?? {}),
        timelinePaginationWarning: warningBuckets.timelinePaginationWarning,
        queueReadStatus: readStatus,
        staleCacheGuidance: readStatus.staleCacheGuidance
      },
      warnings: queueWarnings
    };
  }

  return {
    ...queue,
    dataSource: source.provider ?? 'unknown',
    status: readStatus.status,
    isPartial: Boolean(readStatus.isPartial),
    partialReason: readStatus.partialReason,
    retryAfterSeconds: readStatus.retryAfterSeconds,
    diagnostics: {
      ...(queue.diagnostics ?? {}),
      timelinePaginationWarning: warningBuckets.timelinePaginationWarning,
      queueReadStatus: readStatus,
      staleCacheGuidance: readStatus.staleCacheGuidance
    },
    warnings: queueWarnings
  };
}

function isCriticalReadDegraded(readStatus = {}) {
  return Boolean(
    readStatus.isPartial &&
      readStatus.criticalFailures?.length > 0 &&
      readStatus.status !== 'stale_cache'
  );
}

function normalizeQueueReadStatus(readStatus = {}) {
  return {
    status: readStatus.status ?? 'ok',
    isPartial: Boolean(readStatus.isPartial),
    partialReason: readStatus.partialReason ?? null,
    retryAfterSeconds: readStatus.retryAfterSeconds ?? null,
    criticalFailures: readStatus.criticalFailures ?? [],
    nonCriticalFailures: readStatus.nonCriticalFailures ?? [],
    staleCacheGuidance: readStatus.staleCacheGuidance ?? null,
    cache: readStatus.cache ?? null
  };
}

function buildQueueReadWarnings(readStatus = {}) {
  if (readStatus.status === 'stale_cache') {
    return [readStatus.staleCacheGuidance].filter(Boolean);
  }

  if (readStatus.status === 'degraded_rate_limited') {
    return [
      readStatus.staleCacheGuidance ??
        'Queue data is temporarily rate-limited by Twenty. Retry shortly.'
    ];
  }

  if (readStatus.criticalFailures?.length > 0) {
    return ['Queue data is degraded because one or more critical Twenty reads failed.'];
  }

  return [];
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
