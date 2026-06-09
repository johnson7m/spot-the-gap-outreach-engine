import { buildOperationsReporting } from '../../services/reportingService.js';
import { loadReportingActivityRecords } from './reportingWorkflowUtils.js';

export async function getOperationsReportingWorkflow({
  query = {},
  config = {},
  activitySource,
  supabaseClient,
  now = new Date()
} = {}) {
  const activity = await loadReportingActivityRecords({
    query,
    config,
    activitySource,
    supabaseClient
  });
  const report = buildOperationsReporting({
    outboundEvents: activity.outboundEvents,
    crmSyncLogs: activity.crmSyncLogs,
    assessmentSubmissions: activity.assessmentSubmissions,
    query,
    now,
    diagnostics: {
      activityDataSource: activity.dataSource ?? 'unknown'
    }
  });
  const isPartial = (activity.warnings ?? []).length > 0;

  return {
    ...report,
    dataSource: activity.dataSource ?? 'supabase',
    status: isPartial ? 'partial' : 'ok',
    isPartial,
    partialReason: isPartial ? 'activity_reporting_read_warning' : null,
    retryAfterSeconds: null,
    warnings: [...(report.warnings ?? []), ...(activity.warnings ?? [])]
  };
}
