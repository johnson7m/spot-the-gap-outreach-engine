import { createTwentyRestClient } from './restClient.js';

const DEFAULT_FETCH_LIMIT = 120;
const MAX_FETCH_LIMIT = 250;
const CRITICAL_QUEUE_OBJECTS = new Set(['people', 'tasks', 'taskTargets']);
const RETRYABLE_READ_STATUSES = new Set([429, 502, 503, 504]);
const queueReadCache = new Map();

export function createTwentyQueueDataSource({ config = {}, queueRead = {}, log, restClient } = {}) {
  const client = restClient ?? (config.apiKey ? createTwentyRestClient(config) : null);
  const retryOptions = normalizeRetryOptions(queueRead);
  const baseCacheOptions = normalizeCacheOptions(queueRead);

  return {
    provider: 'twenty',

    async listQueueRecords({ limit = DEFAULT_FETCH_LIMIT, offset = 0, query = {} } = {}) {
      if (!client) {
        return buildMissingCredentialsRecords({ pageSize: limit, maxPages: 1 });
      }

      const fetchLimit = Math.min(Math.max(Number(limit) || DEFAULT_FETCH_LIMIT, 1), MAX_FETCH_LIMIT);
      const fetchOffset = Math.max(Number(offset) || 0, 0);
      const criticalObjects = getCriticalQueueObjects(query);
      const cacheOptions = getCacheOptionsForQuery(baseCacheOptions, query);
      const cacheKey = buildQueueCacheKey({
        mode: 'page',
        limit: fetchLimit,
        offset: fetchOffset,
        criticalObjects: [...criticalObjects].sort()
      });

      try {
        const objectResults = await readQueueObjects({
          client,
          criticalObjects,
          retryOptions,
          readObject: (objectPlural) => {
            const params =
              objectPlural === 'workspaceMembers'
                ? { limit: 100 }
                : { limit: fetchLimit, offset: fetchOffset };

            return safeListRecords(client, objectPlural, params, retryOptions);
          }
        });

        return finalizeQueueRead({
          objectResults,
          criticalObjects,
          cacheKey,
          cacheOptions
        });
      } catch (error) {
        throw buildQueueReadError(error, 'Twenty queue data fetch failed', log);
      }
    },

    async listAllQueueRecords({ pageSize = 100, maxPages = 10, query = {} } = {}) {
      if (!client) {
        return buildMissingCredentialsRecords({ pageSize, maxPages });
      }

      const fetchPageSize = Math.min(Math.max(Number(pageSize) || 100, 1), MAX_FETCH_LIMIT);
      const fetchMaxPages = Math.max(Number(maxPages) || 10, 1);
      const criticalObjects = getCriticalQueueObjects(query);
      const cacheOptions = getCacheOptionsForQuery(baseCacheOptions, query);
      const cacheKey = buildQueueCacheKey({
        mode: 'all',
        pageSize: fetchPageSize,
        maxPages: fetchMaxPages,
        criticalObjects: [...criticalObjects].sort()
      });

      try {
        const objectResults = await readQueueObjects({
          client,
          criticalObjects,
          retryOptions,
          readObject: (objectPlural) => safeListAllRecords(
            client,
            objectPlural,
            {
              pageSize: objectPlural === 'workspaceMembers'
                ? Math.min(fetchPageSize, 100)
                : fetchPageSize,
              maxPages: fetchMaxPages
            },
            retryOptions
          )
        });
        const pagination = {
          requestedMode: 'all',
          pageSize: fetchPageSize,
          maxPages: fetchMaxPages,
          objects: {
            people: objectResults.people.pagination,
            companies: objectResults.companies.pagination,
            tasks: objectResults.tasks.pagination,
            taskTargets: objectResults.taskTargets.pagination,
            noteTargets: objectResults.noteTargets.pagination,
            timelineActivities: objectResults.timelineActivities.pagination,
            workspaceMembers: objectResults.workspaceMembers.pagination
          }
        };

        return finalizeQueueRead({
          objectResults,
          criticalObjects,
          cacheKey,
          cacheOptions,
          pagination
        });
      } catch (error) {
        throw buildQueueReadError(error, 'Twenty full queue data fetch failed', log);
      }
    }
  };
}

export function clearTwentyQueueReadCache() {
  queueReadCache.clear();
}

async function readQueueObjects({ client, readObject }) {
  const [
    people,
    companies,
    tasks,
    taskTargets,
    noteTargets,
    timelineActivities,
    workspaceMembers
  ] = await Promise.all([
    readObject('people'),
    readObject('companies'),
    readObject('tasks'),
    readObject('taskTargets'),
    readObject('noteTargets'),
    readObject('timelineActivities'),
    readObject('workspaceMembers')
  ]);

  return {
    people,
    companies,
    tasks,
    taskTargets,
    noteTargets,
    timelineActivities,
    workspaceMembers
  };
}

async function safeListRecords(client, objectPlural, params = {}, retryOptions = {}) {
  try {
    const records = await withQueueReadRetry(
      () => client.listRecords(objectPlural, params),
      {
        objectPlural,
        retryOptions
      }
    );

    return {
      objectPlural,
      records,
      warnings: [],
      error: null
    };
  } catch (error) {
    return buildFailedObjectResult({
      objectPlural,
      error,
      warningPrefix: 'Twenty queue read skipped'
    });
  }
}

async function safeListAllRecords(client, objectPlural, options = {}, retryOptions = {}) {
  try {
    if (typeof client.listAllRecords !== 'function') {
      const records = await withQueueReadRetry(
        () => client.listRecords(objectPlural, {
          limit: options.pageSize
        }),
        {
          objectPlural,
          retryOptions
        }
      );

      return {
        objectPlural,
        records,
        warnings: [
          `Twenty client does not expose cursor pagination for ${objectPlural}; fetched one page only.`
        ],
        error: null,
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

    const result = await withQueueReadRetry(
      () => client.listAllRecords(objectPlural, options),
      {
        objectPlural,
        retryOptions
      }
    );

    return {
      objectPlural,
      records: result.records ?? result ?? [],
      warnings: result.warnings ?? [],
      error: null,
      pagination: result.pagination
    };
  } catch (error) {
    return buildFailedObjectResult({
      objectPlural,
      error,
      warningPrefix: 'Twenty full queue read skipped',
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
    });
  }
}

async function withQueueReadRetry(readFn, { objectPlural, retryOptions = {} } = {}) {
  const maxAttempts = retryOptions.enabled ? retryOptions.maxAttempts : 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await readFn();
    } catch (error) {
      lastError = error;

      if (!isRetryableQueueReadError(error) || attempt >= maxAttempts) {
        break;
      }

      await sleep(getQueueRetryDelayMs(error, {
        attempt,
        baseMs: retryOptions.baseMs
      }));
    }
  }

  lastError.queueReadDiagnostics = {
    objectPlural,
    attempts: maxAttempts,
    retryable: isRetryableQueueReadError(lastError),
    retryAfterSeconds: getRetryAfterSeconds(lastError)
  };
  throw lastError;
}

function finalizeQueueRead({ objectResults, criticalObjects, cacheKey, cacheOptions, pagination = null }) {
  const readStatus = summarizeObjectReadStatus({
    objectResults,
    criticalObjects
  });
  readStatus.cache = buildQueueCacheDiagnostics({
    cacheKey,
    cacheOptions,
    status: cacheOptions.bypass ? 'bypassed' : 'miss'
  });
  const records = buildQueueRecordsFromObjectResults({
    objectResults,
    warnings: buildObjectWarnings(objectResults),
    readStatus,
    pagination
  });

  if (readStatus.status === 'ok' || (readStatus.isPartial && readStatus.criticalFailures.length === 0)) {
    writeQueueCache(cacheKey, records, cacheOptions);
  }

  if (readStatus.criticalFailures.length > 0) {
    const cached = readQueueCache(cacheKey, cacheOptions);

    if (cached) {
      return buildStaleCacheRecords({
        cached,
        readStatus,
        cacheOptions
      });
    }
  }

  return records;
}

function buildQueueRecordsFromObjectResults({ objectResults, warnings, readStatus, pagination = null }) {
  return {
    people: objectResults.people.records,
    companies: objectResults.companies.records,
    tasks: objectResults.tasks.records,
    taskTargets: objectResults.taskTargets.records,
    noteTargets: objectResults.noteTargets.records,
    timelineActivities: objectResults.timelineActivities.records,
    workspaceMembers: objectResults.workspaceMembers.records,
    warnings,
    ...(pagination ? { pagination } : {}),
    readStatus
  };
}

function buildObjectWarnings(objectResults) {
  return Object.values(objectResults).flatMap((result) => result.warnings ?? []);
}

function summarizeObjectReadStatus({ objectResults, criticalObjects }) {
  const failures = Object.values(objectResults)
    .map((result) => result.error)
    .filter(Boolean);
  const criticalFailures = failures.filter((failure) => criticalObjects.has(failure.objectPlural));
  const nonCriticalFailures = failures.filter((failure) => !criticalObjects.has(failure.objectPlural));
  const rateLimited = criticalFailures.some((failure) => failure.httpStatus === 429);
  const retryAfterSeconds = firstNumber(
    ...criticalFailures.map((failure) => failure.retryAfterSeconds),
    ...nonCriticalFailures.map((failure) => failure.retryAfterSeconds)
  );

  if (criticalFailures.length === 0) {
    return buildReadStatus({
      status: 'ok',
      isPartial: nonCriticalFailures.length > 0,
      partialReason: nonCriticalFailures.length > 0 ? 'twenty_non_critical_read_failed' : null,
      retryAfterSeconds,
      criticalFailures,
      nonCriticalFailures
    });
  }

  return buildReadStatus({
    status: rateLimited ? 'degraded_rate_limited' : 'degraded',
    isPartial: true,
    partialReason: rateLimited ? 'twenty_rate_limited' : 'twenty_critical_read_failed',
    retryAfterSeconds,
    criticalFailures,
    nonCriticalFailures
  });
}

function buildReadStatus({
  status,
  isPartial = false,
  partialReason = null,
  retryAfterSeconds = null,
  criticalFailures = [],
  nonCriticalFailures = []
} = {}) {
  return {
    status,
    isPartial,
    partialReason,
    retryAfterSeconds: retryAfterSeconds ?? null,
    criticalFailures,
    nonCriticalFailures,
    staleCacheGuidance:
      status === 'degraded_rate_limited'
        ? 'Queue data is temporarily rate-limited by Twenty. Retry shortly.'
        : null
  };
}

function buildStaleCacheRecords({ cached, readStatus, cacheOptions }) {
  const ageSeconds = Math.max(Math.round((Date.now() - cached.cachedAt) / 1000), 0);

  return {
    ...cached.records,
    warnings: [
      ...(cached.records.warnings ?? []),
      'Twenty queue read was rate-limited; returning the last successful queue snapshot.'
    ],
    readStatus: {
      ...readStatus,
      status: 'stale_cache',
      isPartial: false,
      partialReason: 'twenty_rate_limited',
      staleCacheGuidance: 'Showing recently cached queue data because Twenty is rate-limited. Refresh shortly.',
      cache: {
        status: 'hit',
        cacheKey: cached.cacheKey ?? null,
        cachedAt: new Date(cached.cachedAt).toISOString(),
        cacheGeneratedAt: new Date(cached.cachedAt).toISOString(),
        ageSeconds,
        ttlSeconds: cacheOptions.ttlSeconds
      }
    }
  };
}

function buildFailedObjectResult({ objectPlural, error, warningPrefix, pagination = null }) {
  const failure = toObjectReadFailure(objectPlural, error);

  return {
    objectPlural,
    records: [],
    warnings: [
      `${warningPrefix} ${objectPlural}: ${error.message}`
    ],
    error: failure,
    pagination
  };
}

function toObjectReadFailure(objectPlural, error) {
  return {
    objectPlural,
    message: error.message,
    httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status ?? null,
    responseBody: error.twentyDiagnostics?.responseBody ?? error.response?.data ?? null,
    retryable: isRetryableQueueReadError(error),
    retryAfterSeconds: getRetryAfterSeconds(error),
    attempts: error.queueReadDiagnostics?.attempts ?? null
  };
}

function getCriticalQueueObjects(query = {}) {
  const objects = new Set(CRITICAL_QUEUE_OBJECTS);

  if (query.ownerScope === 'mine' || query.assigneeScope === 'mine') {
    objects.add('workspaceMembers');
  }

  return objects;
}

function writeQueueCache(cacheKey, records, cacheOptions) {
  if (!cacheOptions.enabled || cacheOptions.bypass) {
    return;
  }

  queueReadCache.set(cacheKey, {
    cachedAt: Date.now(),
    cacheKey,
    records
  });
}

function readQueueCache(cacheKey, cacheOptions) {
  if (!cacheOptions.enabled || cacheOptions.bypass) {
    return null;
  }

  const cached = queueReadCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.cachedAt > cacheOptions.ttlSeconds * 1000) {
    queueReadCache.delete(cacheKey);
    return null;
  }

  return cached;
}

function buildQueueCacheKey(parts) {
  return JSON.stringify(parts);
}

function buildQueueCacheDiagnostics({ cacheKey, cacheOptions, status = 'miss' } = {}) {
  return {
    status: cacheOptions.enabled ? status : 'disabled',
    cacheKey: cacheKey ?? null,
    cacheGeneratedAt: null,
    cachedAt: null,
    ageSeconds: null,
    ttlSeconds: cacheOptions.ttlSeconds,
    bypass: Boolean(cacheOptions.bypass)
  };
}

function buildMissingCredentialsRecords({ pageSize, maxPages }) {
  return {
    people: [],
    companies: [],
    tasks: [],
    taskTargets: [],
    noteTargets: [],
    timelineActivities: [],
    workspaceMembers: [],
    warnings: [
      'Twenty queue reads skipped because TWENTY_API_KEY is not configured.'
    ],
    pagination: buildEmptyPagination({ pageSize, maxPages }),
    readStatus: buildReadStatus({
      status: 'degraded_missing_credentials',
      isPartial: true,
      partialReason: 'twenty_credentials_missing'
    })
  };
}

function buildQueueReadError(error, label, log) {
  log?.warn?.(
    {
      error: error.message,
      status: error.twentyDiagnostics?.httpStatus ?? error.response?.status
    },
    `${label}.`
  );

  const queueError = new Error(`${label}: ${error.message}`);
  queueError.code = 'TWENTY_QUEUE_READ_FAILED';
  queueError.statusCode = 502;
  queueError.details = {
    httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status,
    responseBody: error.twentyDiagnostics?.responseBody ?? error.response?.data
  };

  return queueError;
}

function isRetryableQueueReadError(error) {
  const status = error.twentyDiagnostics?.httpStatus ?? error.response?.status;
  return RETRYABLE_READ_STATUSES.has(Number(status));
}

function getQueueRetryDelayMs(error, { attempt, baseMs }) {
  const retryAfterSeconds = getRetryAfterSeconds(error);

  if (retryAfterSeconds !== null) {
    return retryAfterSeconds * 1000;
  }

  return baseMs * 2 ** Math.max(attempt - 1, 0);
}

function getRetryAfterSeconds(error) {
  const retryAfter =
    error.twentyDiagnostics?.retryAfter ??
    error.response?.headers?.['retry-after'] ??
    error.response?.headers?.['Retry-After'];

  if (retryAfter === undefined || retryAfter === null || retryAfter === '') {
    return null;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds)) {
    return Math.max(seconds, 0);
  }

  const dateMs = Date.parse(retryAfter);

  if (Number.isNaN(dateMs)) {
    return null;
  }

  return Math.max(Math.ceil((dateMs - Date.now()) / 1000), 0);
}

function normalizeRetryOptions(queueRead = {}) {
  return {
    enabled: queueRead.retryEnabled ?? true,
    maxAttempts: normalizePositiveInt(queueRead.retryMaxAttempts, 2),
    baseMs: normalizeNonNegativeInt(queueRead.retryBaseMs, 500)
  };
}

function normalizeCacheOptions(queueRead = {}) {
  return {
    enabled: Boolean(queueRead.cacheEnabled),
    ttlSeconds: normalizePositiveInt(queueRead.cacheTtlSeconds, 90),
    bypass: false
  };
}

function getCacheOptionsForQuery(cacheOptions = {}, query = {}) {
  return {
    ...cacheOptions,
    bypass: normalizeBoolean(query.bypassCache ?? process.env.BYPASS_QUEUE_CACHE)
  };
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function normalizeNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function firstNumber(...values) {
  return values.find((value) => typeof value === 'number' && Number.isFinite(value)) ?? null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function sleep(ms) {
  if (!ms) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildEmptyPagination({ pageSize, maxPages }) {
  return {
    requestedMode: 'all',
    pageSize,
    maxPages,
    objects: {}
  };
}
