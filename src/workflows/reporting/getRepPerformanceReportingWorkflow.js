import { buildRepPerformanceReporting } from '../../services/reportingService.js';
import {
  attachReportingReadMetadata,
  buildDegradedReportingResult,
  loadReportingActivityRecords,
  loadReportingSourceRecords
} from './reportingWorkflowUtils.js';

export async function getRepPerformanceReportingWorkflow({
  query = {},
  config = {},
  log,
  workspaceUser,
  dataSource,
  activitySource,
  supabaseClient,
  correlationId,
  endpoint = '/api/reporting/rep-performance',
  requestSource,
  now = new Date()
} = {}) {
  const effectiveQuery = applyPerformanceBaseline({
    query,
    baselineDate: config.reporting?.performanceBaselineDate
  });
  const { records, source, readStatus, warnings, isCriticalDegraded, snapshotMetadata } =
    await loadReportingSourceRecords({
      query: effectiveQuery,
      config,
      log,
      workspaceUser,
      dataSource,
      observabilityContext: {
        endpoint,
        workflow: 'reporting:rep-performance',
        requestSource,
        correlationId
      }
    });
  const activity = await loadReportingActivityRecords({
    query: effectiveQuery,
    config,
    activitySource,
    supabaseClient
  });
  const combinedWarnings = [...warnings, ...(activity.warnings ?? [])];

  if (isCriticalDegraded) {
    return buildDegradedReportingResult({
      reportName: 'rep-performance',
      readStatus,
      dataSource: source.provider ?? 'unknown',
      warnings: combinedWarnings,
      snapshot: snapshotMetadata
    });
  }

  const report = buildRepPerformanceReporting({
    people: records.people,
    companies: records.companies,
    tasks: records.tasks,
    taskTargets: records.taskTargets,
    workspaceMembers: records.workspaceMembers,
    outboundEvents: activity.outboundEvents,
    crmSyncLogs: activity.crmSyncLogs,
    assessmentSubmissions: activity.assessmentSubmissions,
    workspaceUser,
    query: effectiveQuery,
    now
  });

  return attachReportingReadMetadata({
    report,
    source,
    readStatus,
    warnings: combinedWarnings,
    snapshot: snapshotMetadata
  });
}

function applyPerformanceBaseline({ query = {}, baselineDate } = {}) {
  if (!baselineDate || isTruthy(query.includeAllTime) || query.startDate || query.from || query.since) {
    return query;
  }

  return {
    ...query,
    startDate: baselineDate,
    performanceBaselineDate: baselineDate,
    performanceBaselineApplied: true
  };
}

function isTruthy(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}
