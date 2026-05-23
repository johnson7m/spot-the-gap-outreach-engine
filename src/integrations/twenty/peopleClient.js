export function createPeopleClient({ dryRun = true, log, restClient } = {}) {
  return {
    async upsertPerson(operation) {
      return executeOperation({ ...operation, object: 'person', dryRun, log, restClient });
    }
  };
}

async function executeOperation({ action, dedupeKey, payload, dryRun, log, restClient }) {
  if (dryRun) {
    log?.info({ object: 'person', action, dedupeKey }, 'Twenty People dry-run operation planned');
    return {
      object: 'person',
      action,
      status: 'dry_run',
      dedupeKey,
      payload
    };
  }

  if (!restClient) {
    throw new Error('Twenty REST client is required for live People writes.');
  }

  const existing = payload.emails?.primaryEmail
    ? await restClient.findFirstRecord('people', (record) =>
        emailMatches(record, payload.emails.primaryEmail)
      )
    : null;

  if (existing?.id) {
    const response = await restClient.updateRecord('people', existing.id, payload);

    return {
      object: 'person',
      action: 'update',
      status: 'succeeded',
      dedupeKey,
      payload,
      response
    };
  }

  const response = await restClient.createRecord('people', payload);

  return {
    object: 'person',
    action: 'create',
    status: 'succeeded',
    dedupeKey,
    payload,
    response
  };
}

function emailMatches(record, email) {
  const normalizedEmail = email.toLowerCase();
  return (
    record.emails?.primaryEmail?.toLowerCase() === normalizedEmail ||
    record.emailsPrimaryEmail?.toLowerCase() === normalizedEmail
  );
}
