import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { refreshWorkspaceSnapshot } from '../src/services/workspaceSnapshotService.js';

async function main() {
  const config = loadConfig();
  const result = await refreshWorkspaceSnapshot({
    query: buildQuery(),
    config,
    log: logger,
    workspaceUser: diagnosticWorkspaceUser(),
    correlationId: process.env.CORRELATION_ID
  });

  console.log(
    JSON.stringify(
      {
        snapshot: result.metadata,
        countsByObjectType: result.metadata?.countsByObjectType ?? {},
        summary: result.snapshot?.classification ?? null,
        warnings: result.snapshot?.warnings ?? []
      },
      null,
      2
    )
  );
}

function buildQuery() {
  return {
    ownerScope: process.env.SNAPSHOT_OWNER_SCOPE ?? 'all',
    assigneeScope: process.env.SNAPSHOT_ASSIGNEE_SCOPE ?? 'all',
    includeDiagnostics: process.env.SNAPSHOT_INCLUDE_DIAGNOSTICS ?? 'true',
    bypassCache: 'true'
  };
}

function diagnosticWorkspaceUser() {
  return {
    authenticated: true,
    role: process.env.SNAPSHOT_WORKSPACE_ROLE ?? 'admin',
    email: process.env.SNAPSHOT_WORKSPACE_EMAIL ?? 'diagnostics@visiblegap.com',
    roleSource: 'diagnostic_script'
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
