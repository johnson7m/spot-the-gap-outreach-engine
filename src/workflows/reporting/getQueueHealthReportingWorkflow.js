import { buildQueueHealthReporting } from '../../services/reportingService.js';
import {
  attachReportingReadMetadata,
  buildDegradedReportingResult,
  loadReportingSourceRecords
} from './reportingWorkflowUtils.js';

export async function getQueueHealthReportingWorkflow({
  query = {},
  config = {},
  log,
  workspaceUser,
  dataSource,
  correlationId,
  endpoint = '/api/reporting/queue-health',
  requestSource,
  now = new Date()
} = {}) {
  const { records, source, readStatus, warnings, isCriticalDegraded, snapshotMetadata } =
    await loadReportingSourceRecords({
      query,
      config,
      log,
      workspaceUser,
      dataSource,
      observabilityContext: {
        endpoint,
        workflow: 'reporting:queue-health',
        requestSource,
        correlationId
      }
    });

  if (isCriticalDegraded) {
    return buildDegradedReportingResult({
      reportName: 'queue-health',
      readStatus,
      dataSource: source.provider ?? 'unknown',
      warnings,
      snapshot: snapshotMetadata
    });
  }

  const report = buildQueueHealthReporting({
    people: records.people,
    companies: records.companies,
    tasks: records.tasks,
    taskTargets: records.taskTargets,
    workspaceMembers: records.workspaceMembers,
    workspaceUser,
    query,
    now
  });

  return attachReportingReadMetadata({
    report,
    source,
    readStatus,
    warnings,
    snapshot: snapshotMetadata
  });
}
