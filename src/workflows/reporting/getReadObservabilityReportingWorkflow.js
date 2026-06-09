import {
  buildReadObservabilityReport,
  getTwentyReadEvents
} from '../../services/readObservabilityService.js';

export async function getReadObservabilityReportingWorkflow({
  query = {},
  now = new Date()
} = {}) {
  const events = getTwentyReadEvents({
    since: query.since ?? query.startDate,
    limit: query.limit
  });
  const report = buildReadObservabilityReport({
    events,
    now,
    topLimit: Number(query.topLimit) || 10
  });

  return {
    ...report,
    warnings: report.warnings ?? []
  };
}
