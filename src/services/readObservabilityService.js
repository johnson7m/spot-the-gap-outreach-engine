const MAX_READ_EVENTS = 1000;
const DEFAULT_TOP_LIMIT = 10;
const DUPLICATE_WINDOW_MS = 120000;
const twentyReadEvents = [];

export function recordTwentyRead(event = {}) {
  const normalized = normalizeTwentyReadEvent(event);
  twentyReadEvents.push(normalized);

  if (twentyReadEvents.length > MAX_READ_EVENTS) {
    twentyReadEvents.splice(0, twentyReadEvents.length - MAX_READ_EVENTS);
  }

  return normalized;
}

export function getTwentyReadEvents({
  since,
  limit = MAX_READ_EVENTS
} = {}) {
  const sinceDate = normalizeDate(since);
  const filtered = sinceDate
    ? twentyReadEvents.filter((event) => new Date(event.timestamp) >= sinceDate)
    : [...twentyReadEvents];

  return filtered.slice(-Math.max(Number(limit) || MAX_READ_EVENTS, 1));
}

export function resetTwentyReadObservability() {
  twentyReadEvents.length = 0;
}

export function buildReadObservabilityReport({
  events = getTwentyReadEvents(),
  now = new Date(),
  topLimit = DEFAULT_TOP_LIMIT
} = {}) {
  const safeEvents = events.map(normalizeTwentyReadEvent);
  const totalTwentyReads = safeEvents.length;
  const totalDuration = sumNumbers(safeEvents.map((event) => event.durationMs));
  const cacheHits = safeEvents.filter((event) => event.cacheHit).length;
  const cacheMisses = safeEvents.filter((event) => event.cacheMiss).length;
  const failedReads = safeEvents.filter((event) => event.status === 'failed').length;
  const degradedReads = safeEvents.filter((event) =>
    ['degraded', 'degraded_rate_limited', 'stale_cache'].includes(event.readStatus)
  ).length;
  const duplicateEstimate = estimateDuplicateReads(safeEvents);

  return {
    reportName: 'read-observability',
    generatedAt: now.toISOString(),
    window: {
      retainedEvents: safeEvents.length,
      maxRetainedEvents: MAX_READ_EVENTS
    },
    metrics: {
      totalTwentyReads,
      failedReads,
      degradedReads,
      averageDurationMs: totalTwentyReads > 0 ? Math.round(totalDuration / totalTwentyReads) : 0,
      cacheHits,
      cacheMisses,
      cacheHitRate: ratio(cacheHits, totalTwentyReads),
      cacheMissRate: ratio(cacheMisses, totalTwentyReads),
      totalRecordsFetched: sumNumbers(safeEvents.map((event) => event.recordsFetched)),
      totalPagesFetched: sumNumbers(safeEvents.map((event) => event.pagesFetched)),
      estimatedDuplicateReads: duplicateEstimate.estimatedDuplicateReads
    },
    readsByEndpoint: countAndSort(safeEvents, (event) => event.endpoint),
    readsByWorkflow: countAndSort(safeEvents, (event) => event.workflow),
    readsByRequestSource: countAndSort(safeEvents, (event) => event.requestSource),
    readsByCacheStatus: countAndSort(safeEvents, (event) => event.cacheStatus),
    topEndpoints: aggregateReadStats(safeEvents, (event) => event.endpoint, topLimit),
    topWorkflows: aggregateReadStats(safeEvents, (event) => event.workflow, topLimit),
    mostExpensiveReads: safeEvents
      .slice()
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, topLimit)
      .map(summarizeReadEvent),
    mostFrequentReads: aggregateReadStats(
      safeEvents,
      (event) => `${event.endpoint} :: ${event.workflow}`,
      topLimit
    ),
    duplicateReadEstimate: duplicateEstimate,
    snapshotLayerOpportunities: buildSnapshotLayerOpportunities({
      events: safeEvents,
      duplicateEstimate
    }),
    recentReads: safeEvents.slice(-topLimit).reverse().map(summarizeReadEvent),
    warnings: buildReadObservabilityWarnings(safeEvents)
  };
}

export function normalizeTwentyReadEvent(event = {}) {
  const timestamp = normalizeDate(event.timestamp) ?? new Date();
  const objectTypesRead = normalizeStringArray(event.objectTypesRead);
  const recordsFetchedByObject = normalizeNumberMap(event.recordsFetchedByObject);
  const pagesFetchedByObject = normalizeNumberMap(event.pagesFetchedByObject);
  const recordsFetched =
    firstFiniteNumber(event.recordsFetched) ?? sumNumbers(Object.values(recordsFetchedByObject));
  const pagesFetched =
    firstFiniteNumber(event.pagesFetched) ?? sumNumbers(Object.values(pagesFetchedByObject));
  const cacheStatus = normalizeString(event.cacheStatus, 'unknown');

  return {
    id: normalizeString(event.id, `${timestamp.toISOString()}-${Math.random().toString(36).slice(2)}`),
    endpoint: normalizeString(event.endpoint, 'unknown'),
    workflow: normalizeString(event.workflow, 'unknown'),
    requestSource: normalizeString(event.requestSource, 'unknown'),
    timestamp: timestamp.toISOString(),
    durationMs: Math.max(firstFiniteNumber(event.durationMs) ?? 0, 0),
    cacheHit: Boolean(event.cacheHit ?? cacheStatus === 'hit'),
    cacheMiss: Boolean(event.cacheMiss ?? cacheStatus === 'miss'),
    cacheStatus,
    readStatus: normalizeString(event.readStatus, 'unknown'),
    status: normalizeString(event.status, 'completed'),
    recordsFetched,
    recordsFetchedByObject,
    pagesFetched,
    pagesFetchedByObject,
    objectTypesRead,
    mode: normalizeString(event.mode, 'unknown'),
    provider: normalizeString(event.provider, 'twenty'),
    errorMessage: event.errorMessage ? String(event.errorMessage) : null
  };
}

function aggregateReadStats(events, keyFn, limit) {
  const buckets = new Map();

  for (const event of events) {
    const key = normalizeString(keyFn(event), 'unknown');
    const current = buckets.get(key) ?? {
      key,
      count: 0,
      totalDurationMs: 0,
      totalRecordsFetched: 0,
      totalPagesFetched: 0,
      cacheHits: 0,
      cacheMisses: 0
    };

    current.count += 1;
    current.totalDurationMs += event.durationMs;
    current.totalRecordsFetched += event.recordsFetched;
    current.totalPagesFetched += event.pagesFetched;
    current.cacheHits += event.cacheHit ? 1 : 0;
    current.cacheMisses += event.cacheMiss ? 1 : 0;
    buckets.set(key, current);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      averageDurationMs: bucket.count > 0 ? Math.round(bucket.totalDurationMs / bucket.count) : 0,
      cacheHitRate: ratio(bucket.cacheHits, bucket.count),
      cacheMissRate: ratio(bucket.cacheMisses, bucket.count)
    }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return right.totalDurationMs - left.totalDurationMs;
    })
    .slice(0, limit);
}

function countAndSort(events, keyFn) {
  const counts = new Map();

  for (const event of events) {
    const key = normalizeString(keyFn(event), 'unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
  );
}

function estimateDuplicateReads(events) {
  const groups = new Map();

  for (const event of events) {
    const timestamp = new Date(event.timestamp).getTime();
    const bucket = Math.floor(timestamp / DUPLICATE_WINDOW_MS);
    const sourceSignature = event.objectTypesRead.slice().sort().join('|');
    const key = [event.requestSource, sourceSignature, bucket].join('::');
    const current = groups.get(key) ?? [];
    current.push(event);
    groups.set(key, current);
  }

  const duplicateGroups = [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      windowStart: new Date(
        Math.floor(new Date(group[0].timestamp).getTime() / DUPLICATE_WINDOW_MS) *
          DUPLICATE_WINDOW_MS
      ).toISOString(),
      requestSource: group[0].requestSource,
      objectTypesRead: group[0].objectTypesRead,
      count: group.length,
      duplicateCount: group.length - 1,
      endpoints: [...new Set(group.map((event) => event.endpoint))],
      workflows: [...new Set(group.map((event) => event.workflow))]
    }));

  return {
    estimatedDuplicateReads: sumNumbers(duplicateGroups.map((group) => group.duplicateCount)),
    duplicateWindowSeconds: Math.round(DUPLICATE_WINDOW_MS / 1000),
    groups: duplicateGroups.sort((left, right) => right.duplicateCount - left.duplicateCount)
  };
}

function buildSnapshotLayerOpportunities({ events, duplicateEstimate }) {
  const opportunities = [];
  const reportingReads = events.filter((event) => event.endpoint.startsWith('/api/reporting/'));
  const queueReads = events.filter((event) => event.endpoint.startsWith('/api/queues/'));
  const cacheMisses = events.filter((event) => event.cacheMiss).length;
  const fullReads = events.filter((event) => event.mode === 'all').length;

  if (reportingReads.length > 1) {
    opportunities.push({
      type: 'reporting_bundle_or_snapshot',
      priority: 'high',
      message:
        'Reporting page loads can request multiple full Twenty source reads. A shared reporting snapshot would let executive, queue-health, rep-performance, and cadence analytics reuse one classified read.'
    });
  }

  if (queueReads.length > 1) {
    opportunities.push({
      type: 'queue_summary_snapshot',
      priority: 'medium',
      message:
        'Queue tabs and summary badges can perform separate source reads. A queue snapshot can serve counts and the active page from one classified source read.'
    });
  }

  if (duplicateEstimate.estimatedDuplicateReads > 0) {
    opportunities.push({
      type: 'duplicate_read_reduction',
      priority: 'high',
      message: `${duplicateEstimate.estimatedDuplicateReads} likely duplicate source reads were observed within ${duplicateEstimate.duplicateWindowSeconds}-second windows.`
    });
  }

  if (events.length > 0 && cacheMisses === events.length) {
    opportunities.push({
      type: 'pre_read_cache',
      priority: 'high',
      message:
        'All observed reads were cache misses. The current cache is primarily a stale fallback after degraded reads, not a normal pre-read cache that avoids CRM calls.'
    });
  }

  if (fullReads > 0) {
    opportunities.push({
      type: 'full_read_paging_cost',
      priority: 'medium',
      message:
        'Full source reads include People, Companies, Tasks, TaskTargets, NoteTargets, TimelineActivities, and WorkspaceMembers. Snapshotting can amortize this cost.'
    });
  }

  return opportunities;
}

function buildReadObservabilityWarnings(events) {
  const warnings = [];

  if (events.length === 0) {
    warnings.push('No Twenty read events have been observed in this process yet.');
  }

  if (events.some((event) => event.readStatus === 'degraded_rate_limited')) {
    warnings.push('At least one observed read was rate-limited by Twenty.');
  }

  return warnings;
}

function summarizeReadEvent(event) {
  return {
    id: event.id,
    endpoint: event.endpoint,
    workflow: event.workflow,
    requestSource: event.requestSource,
    timestamp: event.timestamp,
    durationMs: event.durationMs,
    cacheStatus: event.cacheStatus,
    readStatus: event.readStatus,
    recordsFetched: event.recordsFetched,
    pagesFetched: event.pagesFetched,
    objectTypesRead: event.objectTypesRead,
    status: event.status,
    errorMessage: event.errorMessage
  };
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
}

function normalizeNumberMap(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, rawValue]) => [key, firstFiniteNumber(rawValue)])
      .filter(([, numericValue]) => numericValue !== null && numericValue !== undefined)
  );
}

function firstFiniteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function sumNumbers(values = []) {
  return values.reduce((total, value) => {
    const numericValue = firstFiniteNumber(value);
    return total + (numericValue ?? 0);
  }, 0);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}
