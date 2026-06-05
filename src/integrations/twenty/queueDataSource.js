import { createTwentyRestClient } from './restClient.js';

const DEFAULT_FETCH_LIMIT = 120;
const MAX_FETCH_LIMIT = 250;

export function createTwentyQueueDataSource({ config = {}, log, restClient } = {}) {
  const client = restClient ?? (config.apiKey ? createTwentyRestClient(config) : null);

  return {
    provider: 'twenty',

    async listQueueRecords({ limit = DEFAULT_FETCH_LIMIT, offset = 0 } = {}) {
      if (!client) {
        return {
          people: [],
          tasks: [],
          warnings: [
            'Twenty queue reads skipped because TWENTY_API_KEY is not configured.'
          ]
        };
      }

      const fetchLimit = Math.min(Math.max(Number(limit) || DEFAULT_FETCH_LIMIT, 1), MAX_FETCH_LIMIT);
      const fetchOffset = Math.max(Number(offset) || 0, 0);

      try {
        const [
          peopleResult,
          tasksResult,
          taskTargetsResult,
          noteTargetsResult,
          timelineActivitiesResult,
          workspaceMembersResult
        ] = await Promise.all([
          safeListRecords(client, 'people', {
            limit: fetchLimit,
            offset: fetchOffset
          }),
          safeListRecords(client, 'tasks', {
            limit: fetchLimit,
            offset: fetchOffset
          }),
          safeListRecords(client, 'taskTargets', {
            limit: fetchLimit,
            offset: fetchOffset
          }),
          safeListRecords(client, 'noteTargets', {
            limit: fetchLimit,
            offset: fetchOffset
          }),
          safeListRecords(client, 'timelineActivities', {
            limit: fetchLimit,
            offset: fetchOffset
          }),
          safeListRecords(client, 'workspaceMembers', {
            limit: 100
          })
        ]);

        return {
          people: peopleResult.records,
          tasks: tasksResult.records,
          taskTargets: taskTargetsResult.records,
          noteTargets: noteTargetsResult.records,
          timelineActivities: timelineActivitiesResult.records,
          workspaceMembers: workspaceMembersResult.records,
          warnings: [
            ...peopleResult.warnings,
            ...tasksResult.warnings,
            ...taskTargetsResult.warnings,
            ...noteTargetsResult.warnings,
            ...timelineActivitiesResult.warnings,
            ...workspaceMembersResult.warnings
          ]
        };
      } catch (error) {
        log?.warn?.(
          {
            error: error.message,
            status: error.twentyDiagnostics?.httpStatus ?? error.response?.status
          },
          'Twenty queue data fetch failed.'
        );

        const queueError = new Error(`Twenty queue data fetch failed: ${error.message}`);
        queueError.code = 'TWENTY_QUEUE_READ_FAILED';
        queueError.statusCode = 502;
        queueError.details = {
          httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status,
          responseBody: error.twentyDiagnostics?.responseBody ?? error.response?.data
        };

        throw queueError;
      }
    },

    async listAllQueueRecords({ pageSize = 100, maxPages = 10 } = {}) {
      if (!client) {
        return {
          people: [],
          tasks: [],
          taskTargets: [],
          noteTargets: [],
          timelineActivities: [],
          workspaceMembers: [],
          warnings: [
            'Twenty queue reads skipped because TWENTY_API_KEY is not configured.'
          ],
          pagination: buildEmptyPagination({ pageSize, maxPages })
        };
      }

      const fetchPageSize = Math.min(Math.max(Number(pageSize) || 100, 1), MAX_FETCH_LIMIT);
      const fetchMaxPages = Math.max(Number(maxPages) || 10, 1);

      try {
        const [
          peopleResult,
          tasksResult,
          taskTargetsResult,
          noteTargetsResult,
          timelineActivitiesResult,
          workspaceMembersResult
        ] = await Promise.all([
          safeListAllRecords(client, 'people', {
            pageSize: fetchPageSize,
            maxPages: fetchMaxPages
          }),
          safeListAllRecords(client, 'tasks', {
            pageSize: fetchPageSize,
            maxPages: fetchMaxPages
          }),
          safeListAllRecords(client, 'taskTargets', {
            pageSize: fetchPageSize,
            maxPages: fetchMaxPages
          }),
          safeListAllRecords(client, 'noteTargets', {
            pageSize: fetchPageSize,
            maxPages: fetchMaxPages
          }),
          safeListAllRecords(client, 'timelineActivities', {
            pageSize: fetchPageSize,
            maxPages: fetchMaxPages
          }),
          safeListAllRecords(client, 'workspaceMembers', {
            pageSize: Math.min(fetchPageSize, 100),
            maxPages: fetchMaxPages
          })
        ]);

        return {
          people: peopleResult.records,
          tasks: tasksResult.records,
          taskTargets: taskTargetsResult.records,
          noteTargets: noteTargetsResult.records,
          timelineActivities: timelineActivitiesResult.records,
          workspaceMembers: workspaceMembersResult.records,
          warnings: [
            ...peopleResult.warnings,
            ...tasksResult.warnings,
            ...taskTargetsResult.warnings,
            ...noteTargetsResult.warnings,
            ...timelineActivitiesResult.warnings,
            ...workspaceMembersResult.warnings
          ],
          pagination: {
            requestedMode: 'all',
            pageSize: fetchPageSize,
            maxPages: fetchMaxPages,
            objects: {
              people: peopleResult.pagination,
              tasks: tasksResult.pagination,
              taskTargets: taskTargetsResult.pagination,
              noteTargets: noteTargetsResult.pagination,
              timelineActivities: timelineActivitiesResult.pagination,
              workspaceMembers: workspaceMembersResult.pagination
            }
          }
        };
      } catch (error) {
        log?.warn?.(
          {
            error: error.message,
            status: error.twentyDiagnostics?.httpStatus ?? error.response?.status
          },
          'Twenty full queue data fetch failed.'
        );

        const queueError = new Error(`Twenty full queue data fetch failed: ${error.message}`);
        queueError.code = 'TWENTY_QUEUE_READ_FAILED';
        queueError.statusCode = 502;
        queueError.details = {
          httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status,
          responseBody: error.twentyDiagnostics?.responseBody ?? error.response?.data
        };

        throw queueError;
      }
    }
  };
}

async function safeListRecords(client, objectPlural, params = {}) {
  try {
    return {
      records: await client.listRecords(objectPlural, params),
      warnings: []
    };
  } catch (error) {
    return {
      records: [],
      warnings: [
        `Twenty queue read skipped ${objectPlural}: ${error.message}`
      ]
    };
  }
}

async function safeListAllRecords(client, objectPlural, options = {}) {
  try {
    if (typeof client.listAllRecords !== 'function') {
      const records = await client.listRecords(objectPlural, {
        limit: options.pageSize
      });

      return {
        records,
        warnings: [
          `Twenty client does not expose cursor pagination for ${objectPlural}; fetched one page only.`
        ],
        pagination: {
          objectPlural,
          mechanism: 'single_page_fallback',
          pageSize: options.pageSize,
          maxPages: options.maxPages,
          pagesFetched: 1,
          totalFetched: records.length,
          totalCount: null,
          hasMore: records.length >= options.pageSize,
          nextCursor: null
        }
      };
    }

    return await client.listAllRecords(objectPlural, options);
  } catch (error) {
    return {
      records: [],
      warnings: [
        `Twenty full queue read skipped ${objectPlural}: ${error.message}`
      ],
      pagination: {
        objectPlural,
        mechanism: 'cursor',
        pageSize: options.pageSize,
        maxPages: options.maxPages,
        pagesFetched: 0,
        totalFetched: 0,
        totalCount: null,
        hasMore: false,
        nextCursor: null,
        error: error.message
      }
    };
  }
}

function buildEmptyPagination({ pageSize, maxPages }) {
  return {
    requestedMode: 'all',
    pageSize,
    maxPages,
    objects: {}
  };
}
