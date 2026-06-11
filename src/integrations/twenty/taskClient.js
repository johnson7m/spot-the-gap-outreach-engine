export function createTaskClient({ dryRun = true, log, restClient } = {}) {
  return {
    async createTask(operation) {
      return executeOperation({ ...operation, object: 'task', dryRun, log, restClient });
    },

    async updateTaskById(operation) {
      return executeUpdateOperation({ ...operation, object: 'task', dryRun, log, restClient });
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

function taskMatches(record, dedupeKey) {
  const body = record.bodyV2?.markdown ?? record.bodyV2 ?? '';
  return (
    String(body).includes(`Idempotency key: ${dedupeKey}`) ||
    String(body).includes(`Dedupe key: ${dedupeKey}`)
  );
}
