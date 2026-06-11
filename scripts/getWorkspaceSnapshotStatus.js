import { loadConfig } from '../src/config/env.js';
import { getWorkspaceSnapshotStatus } from '../src/services/workspaceSnapshotService.js';

async function main() {
  const config = loadConfig();
  const result = getWorkspaceSnapshotStatus({ config });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
