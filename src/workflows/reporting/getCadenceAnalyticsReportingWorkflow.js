import { buildCadenceAnalyticsReporting } from '../../services/reportingService.js';
import {
  attachReportingReadMetadata,
  buildDegradedReportingResult,
  loadReportingActivityRecords,
  loadReportingSourceRecords
} from './reportingWorkflowUtils.js';

export async function getCadenceAnalyticsReportingWorkflow({
  query = {},
  config = {},
  log,
  workspaceUser,
  dataSource,
  activitySource,
  supabaseClient,
  now = new Date()
} = {}) {
  const { records, source, readStatus, warnings, isCriticalDegraded } =
    await loadReportingSourceRecords({
      query,
      config,
      log,
      workspaceUser,
      dataSource
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
      reportName: 'cadence-analytics',
      readStatus,
      dataSource: source.provider ?? 'unknown',
      warnings: combinedWarnings
    });
  }

  const report = buildCadenceAnalyticsReporting({
    people: records.people,
    companies: records.companies,
    tasks: records.tasks,
    taskTargets: records.taskTargets,
    workspaceMembers: records.workspaceMembers,
    outboundEvents: activity.outboundEvents,
    assessmentSubmissions: activity.assessmentSubmissions,
    workspaceUser,
    query,
    now,
    diagnostics: {
      activityDataSource: activity.dataSource ?? 'unknown'
    }
  });

  return attachReportingReadMetadata({
    report,
    source,
    readStatus,
    warnings: combinedWarnings
  });
}
