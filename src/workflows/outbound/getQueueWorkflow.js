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
  const fetchLimit = Math.min(
    Math.max(normalizedQuery.limit + normalizedQuery.offset, 100),
    250
  );
  const records = await source.listQueueRecords({
    limit: fetchLimit,
    offset: 0,
    query: normalizedQuery
  });
  const queue = buildQueue({
    queueSlug,
    people: records.people,
    tasks: records.tasks,
    workspaceUser,
    query: normalizedQuery,
    now
  });

  return {
    ...queue,
    dataSource: source.provider ?? 'unknown',
    warnings: [
      ...(records.warnings ?? []),
      ...(queue.warnings ?? [])
    ]
  };
}
