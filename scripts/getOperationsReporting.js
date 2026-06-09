import { loadConfig } from '../src/config/env.js';
import { getOperationsReportingWorkflow } from '../src/workflows/reporting/getOperationsReportingWorkflow.js';

async function main() {
  const config = loadConfig();
  const result = await getOperationsReportingWorkflow({
    query: buildQuery(),
    config,
    workspaceUser: diagnosticWorkspaceUser(),
    now: new Date()
  });

  console.log(JSON.stringify(result, null, 2));
}

function buildQuery() {
  return {
    includeDiagnostics: process.env.REPORTING_INCLUDE_DIAGNOSTICS ?? 'true',
    startDate: process.env.REPORTING_START_DATE,
    endDate: process.env.REPORTING_END_DATE
  };
}

function diagnosticWorkspaceUser() {
  return {
    authenticated: true,
    role: process.env.REPORTING_WORKSPACE_ROLE ?? 'admin',
    email: process.env.REPORTING_WORKSPACE_EMAIL ?? 'diagnostics@visiblegap.com',
    roleSource: 'diagnostic_script'
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
