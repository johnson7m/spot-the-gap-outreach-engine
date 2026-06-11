import { createTwentyQueueDataSource } from '../../integrations/twenty/queueDataSource.js';
import { createSupabaseClient } from '../../integrations/supabase/client.js';
import { normalizeQueueQuery } from '../../services/queueService.js';
import {
  getWorkspaceSnapshot,
  isWorkspaceSnapshotEnabled
} from '../../services/workspaceSnapshotService.js';

export async function loadReportingSourceRecords({
  query = {},
  config = {},
  log,
  workspaceUser,
  dataSource,
  observabilityContext = {}
} = {}) {
  const normalizedQuery = normalizeQueueQuery(query, workspaceUser);
  const source =
    dataSource ??
    createTwentyQueueDataSource({
      config: config.twenty ?? config,
      queueRead: config.queueRead ?? {},
      log
    });
  const sourceContext = await loadReportingQueueRecords({
    source,
    normalizedQuery,
    config,
    log,
    workspaceUser,
    observabilityContext
  });
  const { records, snapshotMetadata } = sourceContext;
  const readStatus = normalizeReportingReadStatus(records.readStatus);
  const warnings = uniqueStrings([
    ...(records.warnings ?? []),
    ...buildReportingReadWarnings(readStatus)
  ]);

  return {
    records,
    source,
    readStatus,
    warnings,
    isCriticalDegraded: isCriticalReadDegraded(readStatus),
    snapshotMetadata
  };
}

export async function loadReportingActivityRecords({
  query = {},
  config = {},
  activitySource,
  supabaseClient
} = {}) {
  if (activitySource?.listReportingActivityRecords) {
    const result = await activitySource.listReportingActivityRecords({ query, config });
    return {
      ...result,
      dataSource: result.dataSource ?? 'activity-source'
    };
  }

  const client = supabaseClient ?? createSupabaseClient(config.supabase ?? {});

  if (!client) {
    return {
      outboundEvents: [],
      crmSyncLogs: [],
      assessmentSubmissions: [],
      dataSource: activitySource ? 'activity-source' : 'none',
      warnings: ['Supabase is not configured; activity-based reporting metrics are unavailable.']
    };
  }

  const dateRange = resolveActivityDateRange(query);
  const [outboundEvents, crmSyncLogs, assessmentSubmissions] = await Promise.all([
    readSupabaseTable({
      client,
      table: 'outbound_events',
      startDate: dateRange.startDate,
      endDate: dateRange.endDate
    }),
    readSupabaseTable({
      client,
      table: 'crm_sync_logs',
      startDate: dateRange.startDate,
      endDate: dateRange.endDate
    }),
    readSupabaseTable({
      client,
      table: 'assessment_submissions',
      startDate: dateRange.startDate,
      endDate: dateRange.endDate
    })
  ]);

  return {
    outboundEvents: outboundEvents.records,
    crmSyncLogs: crmSyncLogs.records,
    assessmentSubmissions: assessmentSubmissions.records,
    dataSource: activitySource ? 'activity-source' : 'supabase',
    warnings: uniqueStrings([
      ...outboundEvents.warnings,
      ...crmSyncLogs.warnings,
      ...assessmentSubmissions.warnings
    ])
  };
}

export function buildDegradedReportingResult({
  reportName,
  readStatus = {},
  dataSource = 'unknown',
  warnings = [],
  snapshot,
  diagnostics = {}
} = {}) {
  return {
    reportName,
    generatedAt: new Date().toISOString(),
    dataSource,
    status: readStatus.status,
    isPartial: true,
    partialReason: readStatus.partialReason,
    retryAfterSeconds: readStatus.retryAfterSeconds,
    snapshot,
    metrics: null,
    diagnostics: {
      queueReadStatus: readStatus,
      staleCacheGuidance: readStatus.staleCacheGuidance,
      ...diagnostics
    },
    warnings: uniqueStrings(warnings)
  };
}

async function readSupabaseTable({ client, table, startDate, endDate }) {
  const response = await client
    .from(table)
    .select('*')
    .gte('created_at', startDate.toISOString())
    .lte('created_at', endDate.toISOString())
    .order('created_at', { ascending: false })
    .limit(10000);

  if (response.error) {
    return {
      records: [],
      warnings: [`Supabase reporting read skipped ${table}: ${response.error.message}`]
    };
  }

  return {
    records: response.data ?? [],
    warnings: []
  };
}

function resolveActivityDateRange(query = {}, now = new Date()) {
  const endDate =
    normalizeDateInput(query.endDate ?? query.to ?? query.until) ??
    new Date(now);
  const startDate =
    normalizeDateInput(query.startDate ?? query.from ?? query.since) ??
    addDays(endDate, -30);

  return {
    startDate,
    endDate: endOfDay(endDate)
  };
}

function normalizeDateInput(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function endOfDay(value) {
  const source = normalizeDateInput(value) ?? new Date();
  const date = new Date(source.getTime());
  date.setUTCHours(23, 59, 59, 999);
  return date;
}

function addDays(value, days) {
  const source = normalizeDateInput(value) ?? new Date();
  const date = new Date(source.getTime());
  date.setDate(date.getDate() + days);
  return date;
}

export function attachReportingReadMetadata({
  report,
  source,
  readStatus,
  warnings = [],
  snapshot,
  diagnostics = {}
} = {}) {
  return {
    ...report,
    dataSource: source.provider ?? 'unknown',
    status: readStatus.status,
    isPartial: Boolean(readStatus.isPartial),
    partialReason: readStatus.partialReason,
    retryAfterSeconds: readStatus.retryAfterSeconds,
    snapshot,
    diagnostics: report.diagnostics
      ? {
          ...report.diagnostics,
          queueReadStatus: readStatus,
          staleCacheGuidance: readStatus.staleCacheGuidance,
          ...diagnostics
        }
      : undefined,
    warnings: uniqueStrings([...(report.warnings ?? []), ...warnings])
  };
}

function isCriticalReadDegraded(readStatus = {}) {
  return Boolean(
    readStatus.isPartial &&
      readStatus.criticalFailures?.length > 0 &&
      readStatus.status !== 'stale_cache'
  );
}

function normalizeReportingReadStatus(readStatus = {}) {
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

function buildReportingReadWarnings(readStatus = {}) {
  if (readStatus.status === 'stale_cache') {
    return [readStatus.staleCacheGuidance].filter(Boolean);
  }

  if (readStatus.status === 'degraded_rate_limited') {
    return [
      readStatus.staleCacheGuidance ??
        'Reporting data is temporarily rate-limited by Twenty. Retry shortly.'
    ];
  }

  if (readStatus.criticalFailures?.length > 0) {
    return ['Reporting data is degraded because one or more critical Twenty reads failed.'];
  }

  return [];
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.length > 0)));
}

async function loadReportingQueueRecords({
  source,
  normalizedQuery,
  config = {},
  log,
  workspaceUser,
  observabilityContext = {}
} = {}) {
  const resolvedObservabilityContext = buildReportingObservabilityContext({
    observabilityContext,
    workspaceUser
  });

  if (isWorkspaceSnapshotEnabled(config)) {
    const snapshot = await getWorkspaceSnapshot({
      forceRefresh: normalizedQuery.forceRefresh,
      query: normalizedQuery,
      config,
      log,
      workspaceUser,
      dataSource: source,
      observabilityContext: resolvedObservabilityContext
    });

    return {
      records: snapshot.records,
      snapshotMetadata: snapshot.metadata
    };
  }

  const records =
    typeof source.listAllQueueRecords === 'function'
      ? await source.listAllQueueRecords({
          pageSize: 100,
          maxPages: config.queue?.maxPages ?? config.legacyRetrofit?.maxPages ?? 10,
          query: normalizedQuery,
          observabilityContext: resolvedObservabilityContext
        })
      : await source.listQueueRecords({
          limit: Math.min(Math.max(normalizedQuery.limit + normalizedQuery.offset, 100), 250),
          offset: 0,
          query: normalizedQuery,
          observabilityContext: resolvedObservabilityContext
        });

  return {
    records,
    snapshotMetadata: {
      enabled: false,
      cacheStatus: 'disabled',
      generatedAt: null,
      ageSeconds: null,
      ttlSeconds: config.workspaceSnapshot?.ttlSeconds ?? 120,
      forceRefresh: false,
      sourceReadStatus: null,
      readDurationMs: null
    }
  };
}

function buildReportingObservabilityContext({
  observabilityContext = {},
  workspaceUser = {}
} = {}) {
  const workflow = observabilityContext.workflow ?? 'reporting:unknown';

  return {
    endpoint: observabilityContext.endpoint ?? workflow.replace(/^reporting:/, '/api/reporting/'),
    workflow,
    requestSource:
      observabilityContext.requestSource ??
      (workspaceUser?.roleSource === 'diagnostic_script' ? 'diagnostic_script' : 'workspace_api'),
    correlationId: observabilityContext.correlationId
  };
}
