import { loadConfig } from '../src/config/env.js';
import { createCrmAdapter } from '../src/integrations/crm/crmAdapter.js';
import { inspectTaskCompletionReadinessWorkflow } from '../src/workflows/outbound/inspectTaskCompletionReadinessWorkflow.js';

async function main() {
  const config = loadConfig();
  const taskId = process.env.TASK_ID;
  const personId = process.env.PERSON_ID;

  if (!taskId || !personId) {
    console.error('TASK_ID and PERSON_ID are required.');
    process.exitCode = 1;
    return;
  }

  const result = await inspectTaskCompletionReadinessWorkflow({
    input: {
      taskId,
      personId,
      completion: {
        channel: process.env.TASK_COMPLETION_CHANNEL ?? 'LINKEDIN',
        touchStatus: process.env.TASK_COMPLETION_TOUCH_STATUS ?? 'SENT'
      }
    },
    config,
    crmAdapter: createCrmAdapter({
      provider: config.crmProvider ?? 'twenty',
      config
    }),
    correlationId: `task-completion-readiness:${taskId}:${personId}`
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'blocked') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
