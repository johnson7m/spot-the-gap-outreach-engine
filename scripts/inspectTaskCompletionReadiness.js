import { loadConfig } from '../src/config/env.js';
import { createCrmAdapter } from '../src/integrations/crm/crmAdapter.js';
import { inspectTaskCompletionReadinessWorkflow } from '../src/workflows/outbound/inspectTaskCompletionReadinessWorkflow.js';

async function main() {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const taskId = args.taskId ?? process.env.TASK_ID;
  const personId = args.personId ?? process.env.PERSON_ID;

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

function parseArgs(args = []) {
  return args.reduce((acc, arg, index) => {
    if (arg.startsWith('--task-id=')) {
      acc.taskId = arg.slice('--task-id='.length);
    } else if (arg === '--task-id') {
      acc.taskId = args[index + 1];
    } else if (arg.startsWith('--person-id=')) {
      acc.personId = arg.slice('--person-id='.length);
    } else if (arg === '--person-id') {
      acc.personId = args[index + 1];
    }

    return acc;
  }, {});
}

main().catch((error) => {
  console.error(JSON.stringify({
    message: error.message,
    code: error.code,
    status: error.response?.status,
    responseBody: error.response?.data
  }, null, 2));
  process.exitCode = 1;
});
