import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { createTwentyQueueDataSource } from '../src/integrations/twenty/queueDataSource.js';
import { buildQueueCoverageAudit } from '../src/services/queueService.js';
import {
  getOutboundQueueSummaryWorkflow,
  getOutboundQueueWorkflow
} from '../src/workflows/outbound/getQueueWorkflow.js';

async function main() {
  const config = loadConfig();
  const query = {
    ownerScope: 'all',
    assigneeScope: 'all',
    bypassCache: process.env.BYPASS_QUEUE_CACHE === 'true' ? 'true' : undefined
  };
  const source = createTwentyQueueDataSource({
    config: config.twenty,
    queueRead: config.queueRead ?? {},
    log: logger
  });
  const records = await source.listAllQueueRecords({
    pageSize: Number(process.env.PIPELINE_REVIEW_COMPARE_PAGE_SIZE ?? process.env.LEGACY_RETROFIT_PAGE_SIZE ?? 100),
    maxPages: Number(process.env.PIPELINE_REVIEW_COMPARE_MAX_PAGES ?? process.env.LEGACY_RETROFIT_MAX_PAGES ?? 10),
    query
  });
  const snapshotDataSource = createSnapshotDataSource(records);
  const now = new Date();
  const coverage = buildQueueCoverageAudit({
    people: records.people,
    companies: records.companies,
    tasks: records.tasks,
    taskTargets: records.taskTargets,
    workspaceMembers: records.workspaceMembers,
    query,
    now
  });
  const summary = await getOutboundQueueSummaryWorkflow({
    query,
    config,
    workspaceUser: adminWorkspaceUser(),
    dataSource: snapshotDataSource,
    now
  });
  const endpoint = await getOutboundQueueWorkflow({
    queueSlug: 'pipeline-review',
    query,
    config,
    workspaceUser: adminWorkspaceUser(),
    dataSource: snapshotDataSource,
    now
  });
  const endpointAllItems = await getAllEndpointItems({
    query,
    config,
    dataSource: snapshotDataSource,
    now,
    limit: 100
  });
  const auditPipelineIds = new Set(
    coverage.records
      .filter((record) => record.disposition === 'pipeline_review')
      .map((record) => record.personId)
  );
  const endpointPipelineIds = new Set(endpointAllItems.map((item) => item.personId).filter(Boolean));
  const endpointPageIds = new Set(endpoint.items.map((item) => item.personId).filter(Boolean));
  const output = {
    generatedAt: now.toISOString(),
    coverageAuditPipelineReviewCount: auditPipelineIds.size,
    summaryPipelineReviewCount: summary.counts?.pipelineReview ?? null,
    endpointPipelineReviewTotalCount: endpoint.totalCount,
    endpointReturnedCount: endpoint.count,
    endpointLimit: endpoint.limit,
    endpointOffset: endpoint.offset,
    endpointHasMore: endpoint.hasMore,
    endpointNextOffset: endpoint.nextOffset,
    endpointAllPagesReturnedCount: endpointAllItems.length,
    hiddenTestRecords: coverage.summary.hiddenTestRecords,
    reviewedPeopleCount: endpoint.diagnostics?.reviewedPeopleCount ?? summary.diagnostics?.reviewedPeopleCount ?? null,
    finalPipelineReviewCount:
      endpoint.diagnostics?.finalPipelineReviewCount ??
      summary.diagnostics?.finalPipelineReviewCount ??
      null,
    includeDiagnostics: Boolean(query.includeDiagnostics),
    includeAllReviewed: Boolean(query.includeAllReviewed),
    dueStatus: query.dueStatus ?? null,
    ownerScope: endpoint.ownerScope,
    assigneeScope: endpoint.assigneeScope,
    filtersApplied: {
      ownerScope: query.ownerScope,
      assigneeScope: query.assigneeScope,
      dueBefore: endpoint.diagnostics?.normalizedDueBefore ?? null,
      dueStatus: query.dueStatus ?? null,
      includeDiagnostics: Boolean(query.includeDiagnostics),
      includeAllReviewed: Boolean(query.includeAllReviewed),
      includeTestRecords: Boolean(query.includeTestRecords),
      bypassCache: query.bypassCache === 'true'
    },
    cache: summarizeCache(records.readStatus?.cache),
    readStatus: summarizeReadStatus(records.readStatus),
    pagination: summarizePagination(records.pagination),
    sampleIdsPresentInAuditButMissingFromEndpoint: sampleDifference(auditPipelineIds, endpointPipelineIds),
    sampleIdsPresentInEndpointButMissingFromAudit: sampleDifference(endpointPipelineIds, auditPipelineIds),
    sampleIdsPresentInAuditButMissingFromEndpointPage: sampleDifference(auditPipelineIds, endpointPageIds),
    warnings: records.warnings ?? []
  };

  console.log(JSON.stringify(output, null, 2));
}

async function getAllEndpointItems({ query, config, dataSource, now, limit }) {
  const items = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query: {
        ...query,
        limit,
        offset
      },
      config,
      workspaceUser: adminWorkspaceUser(),
      dataSource,
      now
    });
    items.push(...page.items);
    hasMore = Boolean(page.hasMore);
    offset = page.nextOffset ?? offset + limit;
  }

  return items;
}

function createSnapshotDataSource(records) {
  return {
    provider: 'snapshot',
    async listAllQueueRecords() {
      return records;
    }
  };
}

function adminWorkspaceUser() {
  return {
    authenticated: true,
    role: 'admin',
    email: 'diagnostics@visiblegap.com',
    roleSource: 'diagnostic_script'
  };
}

function sampleDifference(leftSet, rightSet, limit = 20) {
  return [...leftSet].filter((id) => !rightSet.has(id)).slice(0, limit);
}

function summarizeReadStatus(readStatus = {}) {
  return {
    status: readStatus.status ?? null,
    isPartial: Boolean(readStatus.isPartial),
    partialReason: readStatus.partialReason ?? null,
    retryAfterSeconds: readStatus.retryAfterSeconds ?? null,
    criticalFailures: readStatus.criticalFailures ?? [],
    nonCriticalFailures: readStatus.nonCriticalFailures ?? []
  };
}

function summarizeCache(cache = {}) {
  return {
    cacheStatus: cache.status ?? null,
    cacheKey: cache.cacheKey ?? null,
    cacheGeneratedAt: cache.cacheGeneratedAt ?? cache.cachedAt ?? null,
    cachedAt: cache.cachedAt ?? null,
    cacheTtlSeconds: cache.ttlSeconds ?? null,
    ageSeconds: cache.ageSeconds ?? null,
    bypass: Boolean(cache.bypass)
  };
}

function summarizePagination(pagination) {
  if (!pagination?.objects) {
    return pagination ?? null;
  }

  return Object.fromEntries(
    Object.entries(pagination.objects).map(([objectName, value]) => [
      objectName,
      {
        pagesFetched: value.pagesFetched,
        totalFetched: value.totalFetched,
        totalCount: value.totalCount,
        hasMore: value.hasMore
      }
    ])
  );
}

main().catch((error) => {
  console.error('Pipeline Review count comparison failed.');
  console.error(
    JSON.stringify(
      {
        message: error.message,
        code: error.code,
        httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
