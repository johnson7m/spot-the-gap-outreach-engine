import { createTwentyQueueDataSource } from '../integrations/twenty/queueDataSource.js';
import {
  buildQueue,
  buildQueueCoverageAudit,
  normalizeQueueQuery
} from './queueService.js';

const DEFAULT_TTL_SECONDS = 120;
const SNAPSHOT_OBJECT_TYPES = [
  'people',
  'companies',
  'tasks',
  'taskTargets',
  'noteTargets',
  'timelineActivities',
  'workspaceMembers'
];
const QUEUE_SLUGS = [
  'fresh-leads',
  'follow-ups',
  'warm-assessments',
  'stale-recovery',
  'pipeline-review',
  'unassigned-tasks'
];

let cachedSnapshot = null;
let invalidation = null;

export function isWorkspaceSnapshotEnabled(config = {}) {
  return config.workspaceSnapshot?.enabled === true;
}

export async function getWorkspaceSnapshot({
  forceRefresh = false,
  query = {},
  config = {},
  log,
  workspaceUser,
  dataSource,
  now = new Date(),
  observabilityContext = {}
} = {}) {
  const snapshotConfig = normalizeSnapshotConfig(config);

  if (!snapshotConfig.enabled) {
    return {
      snapshot: null,
      records: null,
      metadata: buildDisabledSnapshotMetadata(snapshotConfig, forceRefresh)
    };
  }

  const current = normalizeDate(now) ?? new Date();

  if (!forceRefresh && isCachedSnapshotValid(current)) {
    return buildSnapshotReturn({
      snapshot: cachedSnapshot,
      cacheStatus: 'hit',
      forceRefresh,
      now: current
    });
  }

  const startedAt = Date.now();
  const source =
    dataSource ??
    createTwentyQueueDataSource({
      config: config.twenty ?? config,
      queueRead: config.queueRead ?? {},
      log
    });
  const sourceQuery = buildSourceReadQuery(query);
  const records =
    typeof source.listAllQueueRecords === 'function'
      ? await source.listAllQueueRecords({
          pageSize: 100,
          maxPages: config.queue?.maxPages ?? config.legacyRetrofit?.maxPages ?? 10,
          query: sourceQuery,
          observabilityContext: {
            endpoint: observabilityContext.endpoint ?? '/api/workspace/snapshot/refresh',
            workflow: observabilityContext.workflow ?? 'workspace:snapshot:build',
            requestSource: observabilityContext.requestSource ?? inferSnapshotRequestSource(workspaceUser),
            correlationId: observabilityContext.correlationId
          }
        })
      : await source.listQueueRecords({
          limit: 250,
          offset: 0,
          query: sourceQuery,
          observabilityContext: {
            endpoint: observabilityContext.endpoint ?? '/api/workspace/snapshot/refresh',
            workflow: observabilityContext.workflow ?? 'workspace:snapshot:build',
            requestSource: observabilityContext.requestSource ?? inferSnapshotRequestSource(workspaceUser),
            correlationId: observabilityContext.correlationId
          }
        });
  const generatedAt = current;
  const expiresAt = new Date(generatedAt.getTime() + snapshotConfig.ttlSeconds * 1000);
  const readDurationMs = Math.max(Date.now() - startedAt, 0);
  const readStatus = normalizeSourceReadStatus(records.readStatus);
  const snapshot = {
    records,
    sourceProvider: source.provider ?? 'unknown',
    classification: buildSnapshotClassification({
      records,
      workspaceUser,
      query,
      now: generatedAt
    }),
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttlSeconds: snapshotConfig.ttlSeconds,
    readDurationMs,
    sourceReadStatus: readStatus,
    objectsIncluded: SNAPSHOT_OBJECT_TYPES,
    countsByObjectType: countRecordsByObjectType(records),
    warnings: records.warnings ?? []
  };

  cachedSnapshot = snapshot;
  invalidation = null;

  return buildSnapshotReturn({
    snapshot,
    cacheStatus: forceRefresh ? 'refresh' : 'miss',
    forceRefresh,
    now: current
  });
}

export async function refreshWorkspaceSnapshot(options = {}) {
  return getWorkspaceSnapshot({
    ...options,
    forceRefresh: true,
    observabilityContext: {
      endpoint: '/api/workspace/snapshot/refresh',
      workflow: 'workspace:snapshot:refresh',
      requestSource: inferSnapshotRequestSource(options.workspaceUser),
      correlationId: options.correlationId,
      ...(options.observabilityContext ?? {})
    }
  });
}

export function getWorkspaceSnapshotStatus({
  config = {},
  now = new Date()
} = {}) {
  const snapshotConfig = normalizeSnapshotConfig(config);

  if (!cachedSnapshot) {
    return {
      snapshot: null,
      metadata: {
        enabled: snapshotConfig.enabled,
        cacheStatus: 'empty',
        generatedAt: null,
        expiresAt: null,
        ageSeconds: null,
        ttlSeconds: snapshotConfig.ttlSeconds,
        forceRefresh: false,
        sourceReadStatus: null,
        readDurationMs: null,
        objectsIncluded: SNAPSHOT_OBJECT_TYPES,
        countsByObjectType: {},
        invalidated: Boolean(invalidation),
        invalidationReason: invalidation?.reason ?? null,
        invalidatedAt: invalidation?.invalidatedAt ?? null
      }
    };
  }

  return buildSnapshotReturn({
    snapshot: cachedSnapshot,
    cacheStatus: isCachedSnapshotValid(normalizeDate(now) ?? new Date()) ? 'hit' : 'stale',
    forceRefresh: false,
    now
  });
}

export function invalidateWorkspaceSnapshot(reason = 'unspecified') {
  invalidation = {
    reason,
    invalidatedAt: new Date().toISOString()
  };

  return getWorkspaceSnapshotStatus();
}

export function clearWorkspaceSnapshotCache() {
  cachedSnapshot = null;
  invalidation = null;
}

function buildSnapshotReturn({
  snapshot,
  cacheStatus,
  forceRefresh,
  now = new Date()
} = {}) {
  return {
    snapshot,
    records: snapshot?.records ?? null,
    metadata: buildSnapshotMetadata({
      snapshot,
      cacheStatus,
      forceRefresh,
      now
    })
  };
}

function buildSnapshotMetadata({
  snapshot,
  cacheStatus,
  forceRefresh,
  now
} = {}) {
  const current = normalizeDate(now) ?? new Date();
  const generatedAt = snapshot?.generatedAt ? new Date(snapshot.generatedAt) : null;

  return {
    enabled: true,
    cacheStatus,
    generatedAt: snapshot?.generatedAt ?? null,
    expiresAt: snapshot?.expiresAt ?? null,
    ageSeconds: generatedAt ? Math.max(Math.floor((current - generatedAt) / 1000), 0) : null,
    ttlSeconds: snapshot?.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    forceRefresh: Boolean(forceRefresh),
    sourceReadStatus: snapshot?.sourceReadStatus ?? null,
    readDurationMs: snapshot?.readDurationMs ?? null,
    objectsIncluded: snapshot?.objectsIncluded ?? SNAPSHOT_OBJECT_TYPES,
    countsByObjectType: snapshot?.countsByObjectType ?? {},
    invalidated: Boolean(invalidation),
    invalidationReason: invalidation?.reason ?? null,
    invalidatedAt: invalidation?.invalidatedAt ?? null
  };
}

function buildDisabledSnapshotMetadata(snapshotConfig, forceRefresh) {
  return {
    enabled: false,
    cacheStatus: 'disabled',
    generatedAt: null,
    expiresAt: null,
    ageSeconds: null,
    ttlSeconds: snapshotConfig.ttlSeconds,
    forceRefresh: Boolean(forceRefresh),
    sourceReadStatus: null,
    readDurationMs: null,
    objectsIncluded: SNAPSHOT_OBJECT_TYPES,
    countsByObjectType: {}
  };
}

function isCachedSnapshotValid(now) {
  if (!cachedSnapshot || invalidation) {
    return false;
  }

  const expiresAt = new Date(cachedSnapshot.expiresAt);
  return expiresAt > now;
}

function buildSourceReadQuery(query = {}) {
  return {
    ...query,
    ownerScope: 'mine',
    assigneeScope: 'mine',
    includeDiagnostics: true
  };
}

function buildSnapshotClassification({
  records,
  workspaceUser,
  query = {},
  now
} = {}) {
  const normalizedQuery = normalizeQueueQuery(
    {
      ...query,
      ownerScope: 'all',
      assigneeScope: 'all',
      limit: 1,
      offset: 0,
      includeDiagnostics: false,
      includeAllReviewed: false
    },
    {
      ...workspaceUser,
      role: 'admin'
    }
  );
  const queues = Object.fromEntries(
    QUEUE_SLUGS.map((queueSlug) => [
      queueSlug,
      buildQueue({
        queueSlug,
        people: records.people,
        companies: records.companies,
        tasks: records.tasks,
        taskTargets: records.taskTargets,
        noteTargets: records.noteTargets,
        timelineActivities: records.timelineActivities,
        workspaceMembers: records.workspaceMembers,
        workspaceUser: {
          ...workspaceUser,
          role: 'admin'
        },
        query: normalizedQuery,
        now
      })
    ])
  );
  const coverage = buildQueueCoverageAudit({
    people: records.people,
    companies: records.companies,
    tasks: records.tasks,
    taskTargets: records.taskTargets,
    workspaceMembers: records.workspaceMembers,
    query: normalizedQuery,
    now
  });

  return {
    queueSummary: {
      counts: {
        freshLeads: queues['fresh-leads'].totalCount,
        followUps: queues['follow-ups'].totalCount,
        warmAssessments: queues['warm-assessments'].totalCount,
        staleRecovery: queues['stale-recovery'].totalCount,
        pipelineReview: queues['pipeline-review'].totalCount,
        unassignedTasks: queues['unassigned-tasks'].totalCount
      },
      overdueTasksByQueue: {
        freshLeads: queues['fresh-leads'].overdueCount,
        followUps: queues['follow-ups'].overdueCount,
        warmAssessments: queues['warm-assessments'].overdueCount,
        staleRecovery: queues['stale-recovery'].overdueCount,
        pipelineReview: queues['pipeline-review'].overdueCount,
        unassignedTasks: queues['unassigned-tasks'].overdueCount
      }
    },
    coverageSummary: coverage.summary
  };
}

function countRecordsByObjectType(records = {}) {
  return Object.fromEntries(
    SNAPSHOT_OBJECT_TYPES.map((objectType) => [
      objectType,
      Array.isArray(records[objectType]) ? records[objectType].length : 0
    ])
  );
}

function normalizeSourceReadStatus(readStatus = {}) {
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

function normalizeSnapshotConfig(config = {}) {
  return {
    enabled: config.workspaceSnapshot?.enabled === true,
    ttlSeconds: normalizePositiveInt(config.workspaceSnapshot?.ttlSeconds, DEFAULT_TTL_SECONDS)
  };
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferSnapshotRequestSource(workspaceUser = {}) {
  return workspaceUser?.roleSource === 'diagnostic_script' ? 'diagnostic_script' : 'workspace_api';
}
