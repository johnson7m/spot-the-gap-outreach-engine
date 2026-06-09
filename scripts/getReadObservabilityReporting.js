import { getReadObservabilityReportingWorkflow } from '../src/workflows/reporting/getReadObservabilityReportingWorkflow.js';

async function main() {
  const result = await getReadObservabilityReportingWorkflow({
    query: buildQuery(),
    now: new Date()
  });

  console.log(JSON.stringify(result, null, 2));
}

function buildQuery() {
  return {
    since: process.env.READ_OBSERVABILITY_SINCE,
    limit: process.env.READ_OBSERVABILITY_LIMIT,
    topLimit: process.env.READ_OBSERVABILITY_TOP_LIMIT
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
