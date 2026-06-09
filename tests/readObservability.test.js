import { describe, expect, it, beforeEach } from 'vitest';
import { createTwentyQueueDataSource } from '../src/integrations/twenty/queueDataSource.js';
import {
  buildReadObservabilityReport,
  getTwentyReadEvents,
  recordTwentyRead,
  resetTwentyReadObservability
} from '../src/services/readObservabilityService.js';
import { handleReadObservabilityReportingFetch } from '../src/routes/api/reportingRoutes.js';

describe('read observability', () => {
  beforeEach(() => {
    resetTwentyReadObservability();
  });

  it('records Twenty queue data source reads with endpoint and workflow context', async () => {
    const dataSource = createTwentyQueueDataSource({
      config: {
        apiKey: 'test-key'
      },
      queueRead: {
        cacheEnabled: true,
        cacheTtlSeconds: 90
      },
      restClient: fakeRestClient({
        people: 2,
        tasks: 1,
        taskTargets: 1,
        workspaceMembers: 1
      })
    });

    await dataSource.listAllQueueRecords({
      pageSize: 100,
      maxPages: 10,
      query: {
        ownerScope: 'all'
      },
      observabilityContext: {
        endpoint: '/api/queues/follow-ups',
        workflow: 'queue:follow-ups',
        requestSource: 'workspace_api'
      }
    });

    const events = getTwentyReadEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      endpoint: '/api/queues/follow-ups',
      workflow: 'queue:follow-ups',
      requestSource: 'workspace_api',
      cacheHit: false,
      cacheMiss: true,
      cacheStatus: 'miss',
      readStatus: 'ok',
      recordsFetched: 5,
      pagesFetched: 7,
      mode: 'all',
      provider: 'twenty'
    });
    expect(events[0].objectTypesRead).toEqual([
      'people',
      'companies',
      'tasks',
      'taskTargets',
      'noteTargets',
      'timelineActivities',
      'workspaceMembers'
    ]);
  });

  it('aggregates read metrics, duplicate estimates, and snapshot opportunities', () => {
    const timestamp = new Date('2026-06-09T15:00:00.000Z');
    recordTwentyRead({
      endpoint: '/api/reporting/executive',
      workflow: 'reporting:executive',
      requestSource: 'workspace_api',
      timestamp,
      durationMs: 120,
      cacheStatus: 'miss',
      readStatus: 'ok',
      recordsFetched: 500,
      pagesFetched: 12,
      objectTypesRead: ['people', 'tasks', 'taskTargets'],
      mode: 'all'
    });
    recordTwentyRead({
      endpoint: '/api/reporting/queue-health',
      workflow: 'reporting:queue-health',
      requestSource: 'workspace_api',
      timestamp: new Date('2026-06-09T15:00:30.000Z'),
      durationMs: 180,
      cacheStatus: 'miss',
      readStatus: 'ok',
      recordsFetched: 500,
      pagesFetched: 12,
      objectTypesRead: ['people', 'tasks', 'taskTargets'],
      mode: 'all'
    });
    recordTwentyRead({
      endpoint: '/api/queues/summary',
      workflow: 'queue:summary',
      requestSource: 'workspace_api',
      timestamp: new Date('2026-06-09T15:03:00.000Z'),
      durationMs: 80,
      cacheStatus: 'hit',
      readStatus: 'stale_cache',
      recordsFetched: 500,
      pagesFetched: 12,
      objectTypesRead: ['people', 'tasks', 'taskTargets'],
      mode: 'all'
    });

    const report = buildReadObservabilityReport({
      now: new Date('2026-06-09T15:04:00.000Z')
    });

    expect(report.metrics).toMatchObject({
      totalTwentyReads: 3,
      averageDurationMs: 127,
      cacheHits: 1,
      cacheMisses: 2,
      cacheHitRate: 0.3333,
      cacheMissRate: 0.6667,
      estimatedDuplicateReads: 1
    });
    expect(report.readsByEndpoint).toMatchObject({
      '/api/reporting/executive': 1,
      '/api/reporting/queue-health': 1,
      '/api/queues/summary': 1
    });
    expect(report.snapshotLayerOpportunities.map((item) => item.type)).toContain(
      'reporting_bundle_or_snapshot'
    );
    expect(report.mostExpensiveReads[0]).toMatchObject({
      endpoint: '/api/reporting/queue-health',
      durationMs: 180
    });
  });

  it('returns the read-observability API envelope', async () => {
    recordTwentyRead({
      endpoint: '/api/queues/summary',
      workflow: 'queue:summary',
      requestSource: 'workspace_api',
      timestamp: new Date('2026-06-09T15:00:00.000Z'),
      durationMs: 20,
      cacheStatus: 'miss',
      readStatus: 'ok',
      recordsFetched: 10,
      pagesFetched: 1,
      objectTypesRead: ['people']
    });

    const { req, res, next } = createMockExchange();

    await handleReadObservabilityReportingFetch(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      correlationId: 'read-observability-correlation',
      data: {
        reportName: 'read-observability',
        metrics: {
          totalTwentyReads: 1
        }
      },
      errors: []
    });
  });
});

function fakeRestClient(recordCounts = {}) {
  return {
    async listAllRecords(objectPlural) {
      const count = recordCounts[objectPlural] ?? 0;

      return {
        records: Array.from({ length: count }, (_, index) => ({
          id: `${objectPlural}-${index + 1}`
        })),
        pagination: {
          objectPlural,
          mechanism: 'cursor',
          pageSize: 100,
          maxPages: 10,
          pagesFetched: 1,
          totalFetched: count,
          totalCount: count,
          hasMore: false,
          nextCursor: null
        }
      };
    }
  };
}

function createMockExchange() {
  const req = {
    query: {},
    correlationId: 'read-observability-correlation',
    workspaceUser: {
      role: 'admin',
      roleSource: 'profile'
    }
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  const next = (error) => {
    res.error = error;
  };

  return {
    req,
    res,
    next
  };
}
