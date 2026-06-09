import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { getQueueHealthReportingWorkflow } from '../src/workflows/reporting/getQueueHealthReportingWorkflow.js';

async function main() {
  const config = loadConfig();
  const result = await getQueueHealthReportingWorkflow({
    query: buildQuery(),
    config,
    log: logger,
    workspaceUser: diagnosticWorkspaceUser(),
    now: new Date()
  });

  console.log(JSON.stringify(result, null, 2));
}

function buildQuery() {
  return {
    ownerScope: process.env.REPORTING_OWNER_SCOPE ?? 'all',
    assigneeScope: process.env.REPORTING_ASSIGNEE_SCOPE ?? 'all',
    includeDiagnostics: process.env.REPORTING_INCLUDE_DIAGNOSTICS ?? 'true',
    bypassCache: process.env.BYPASS_QUEUE_CACHE === 'true' ? 'true' : undefined
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
