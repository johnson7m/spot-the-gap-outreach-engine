export function createTaskClient({ dryRun = true, log, restClient } = {}) {
  return {
    async createTask(operation) {
      return executeOperation({ ...operation, object: 'task', dryRun, log, restClient });
    },

    async updateTaskById(operation) {
      return executeUpdateOperation({ ...operation, object: 'task', dryRun, log, restClient });
    },

    async verifyTaskCompleted(operation) {
      return executeTaskCompletionVerification({
        ...operation,
        object: 'task',
        dryRun,
        log,
        restClient
      });
    }
  };
}

async function executeOperation({ action, dedupeKey, payload, dryRun, log, restClient }) {
  if (dryRun) {
    log?.info({ object: 'task', action, dedupeKey }, 'Twenty Task dry-run operation planned');
    return {
      object: 'task',
      action,
      status: 'dry_run',
      dedupeKey,
      payload
    };
  }

  if (!restClient) {
    throw new Error('Twenty REST client is required for live Task writes.');
  }

  const existing = await restClient.findFirstRecord('tasks', (record) =>
    taskMatches(record, dedupeKey)
  );

  if (existing?.id) {
    return {
      object: 'task',
      action: 'skip_existing',
      status: 'skipped',
      dedupeKey,
      payload,
      response: existing
    };
  }

  const response = await restClient.createRecord('tasks', payload);

  return {
    object: 'task',
    action: 'create',
    status: 'succeeded',
    dedupeKey,
    payload,
    response
  };
}

async function executeUpdateOperation({ action, id, dedupeKey, payload, dryRun, log, restClient }) {
  if (dryRun) {
    log?.info({ object: 'task', action, id, dedupeKey }, 'Twenty Task dry-run update planned');
    return {
      object: 'task',
      action,
      id,
      status: 'dry_run',
      dedupeKey,
      payload
    };
  }

  if (!restClient) {
    throw new Error('Twenty REST client is required for live Task writes.');
  }

  const response = await restClient.updateRecord('tasks', id, payload);

  return {
    object: 'task',
    action,
    id,
    status: 'succeeded',
    dedupeKey,
    payload,
    response
  };
}

async function executeTaskCompletionVerification({
  action,
  id,
  dedupeKey,
  payload,
  dryRun,
  log,
  restClient
}) {
  if (dryRun) {
    log?.info({ object: 'task', action, id, dedupeKey }, 'Twenty Task completion verification skipped in dry-run');
    return {
      object: 'task',
      action,
      id,
      status: 'skipped',
      dedupeKey,
      payload,
      reason: 'Completion status verification is skipped in dry-run mode.'
    };
  }

  if (!restClient) {
    throw new Error('Twenty REST client is required for Task verification.');
  }

  const response = await restClient.getRecord('tasks', id);
  const actualStatus = normalizeStatus(response?.status);
  const completed = isCompletedTaskStatus(actualStatus);

  return {
    object: 'task',
    action,
    id,
    status: completed ? 'succeeded' : 'failed',
    dedupeKey,
    payload,
    response,
    ...(completed
      ? {}
      : {
          error: {
            message: `Completed Task verification failed; expected DONE/completed status but found ${actualStatus || 'UNKNOWN'}.`,
            actualStatus,
            expectedStatuses: ['DONE', 'COMPLETED', 'COMPLETE']
          }
        })
  };
}

function taskMatches(record, dedupeKey) {
  const body = record.bodyV2?.markdown ?? record.bodyV2 ?? '';
  return (
    String(body).includes(`Idempotency key: ${dedupeKey}`) ||
    String(body).includes(`Dedupe key: ${dedupeKey}`)
  );
}

function isCompletedTaskStatus(status) {
  return ['DONE', 'COMPLETED', 'COMPLETE'].includes(status);
}

function normalizeStatus(value) {
  return String(value ?? '').trim().toUpperCase();
}
