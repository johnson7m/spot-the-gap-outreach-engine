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
  const { records, source, readStatus, warnings, isCriticalDegraded } =
    await loadReportingSourceRecords({
      query,
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
    query,
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
      warnings: combinedWarnings
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
    query,
    now
  });

  return attachReportingReadMetadata({
    report,
    source,
    readStatus,
    warnings: combinedWarnings
  });
}
