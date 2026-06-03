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
        const [people, tasks] = await Promise.all([
          client.listRecords('people', {
            limit: fetchLimit,
            offset: fetchOffset
          }),
          client.listRecords('tasks', {
            limit: fetchLimit,
            offset: fetchOffset
          })
        ]);

        return {
          people,
          tasks,
          warnings: []
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
    }
  };
}
