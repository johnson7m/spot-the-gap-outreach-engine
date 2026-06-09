import { createTwentyQueueDataSource } from '../../integrations/twenty/queueDataSource.js';
import { normalizeQueueQuery } from '../../services/queueService.js';

export async function loadReportingSourceRecords({
  query = {},
  config = {},
  log,
  workspaceUser,
  dataSource
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
    isCriticalDegraded: isCriticalReadDegraded(readStatus)
  };
}

export function buildDegradedReportingResult({
  reportName,
  readStatus = {},
  dataSource = 'unknown',
  warnings = [],
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
    metrics: null,
    diagnostics: {
      queueReadStatus: readStatus,
      staleCacheGuidance: readStatus.staleCacheGuidance,
      ...diagnostics
    },
    warnings: uniqueStrings(warnings)
  };
}

export function attachReportingReadMetadata({
  report,
  source,
  readStatus,
  warnings = [],
  diagnostics = {}
} = {}) {
  return {
    ...report,
    dataSource: source.provider ?? 'unknown',
    status: readStatus.status,
    isPartial: Boolean(readStatus.isPartial),
    partialReason: readStatus.partialReason,
    retryAfterSeconds: readStatus.retryAfterSeconds,
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
