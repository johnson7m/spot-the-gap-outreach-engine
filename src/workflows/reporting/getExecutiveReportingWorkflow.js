import { buildExecutiveReporting } from '../../services/reportingService.js';
import {
  attachReportingReadMetadata,
  buildDegradedReportingResult,
  loadReportingSourceRecords
} from './reportingWorkflowUtils.js';

export async function getExecutiveReportingWorkflow({
  query = {},
  config = {},
  log,
  workspaceUser,
  dataSource,
  correlationId,
  endpoint = '/api/reporting/executive',
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
        workflow: 'reporting:executive',
        requestSource,
        correlationId
      }
    });

  if (isCriticalDegraded) {
    return buildDegradedReportingResult({
      reportName: 'executive',
      readStatus,
      dataSource: source.provider ?? 'unknown',
      warnings,
      snapshot: snapshotMetadata
    });
  }

  const report = buildExecutiveReporting({
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
