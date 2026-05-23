export function createOpportunityClient({ dryRun = true, log, restClient } = {}) {
  return {
    async createOpportunity(operation) {
      if (operation.action === 'skip') {
        return {
          object: 'opportunity',
          action: 'skip',
          status: 'skipped',
          dedupeKey: operation.dedupeKey,
          reason: 'Assessment score does not meet the current opportunity creation threshold.',
          payload: operation.payload
        };
      }

      return executeOperation({ ...operation, object: 'opportunity', dryRun, log, restClient });
    }
  };
}

async function executeOperation({ action, dedupeKey, payload, dryRun, log, restClient }) {
  if (dryRun) {
    log?.info(
      { object: 'opportunity', action, dedupeKey },
      'Twenty Opportunity dry-run operation planned'
    );
    return {
      object: 'opportunity',
      action,
      status: 'dry_run',
      dedupeKey,
      payload
    };
  }

  if (!restClient) {
    throw new Error('Twenty REST client is required for live Opportunity writes.');
  }

  const existing = await restClient.findFirstRecord('opportunities', (record) =>
    opportunityMatches(record, payload)
  );

  if (existing?.id) {
    const response = await restClient.updateRecord('opportunities', existing.id, payload);

    return {
      object: 'opportunity',
      action: 'update',
      status: 'succeeded',
      dedupeKey,
      payload,
      response
    };
  }

  const response = await restClient.createRecord('opportunities', payload);

  return {
    object: 'opportunity',
    action: 'create',
    status: 'succeeded',
    dedupeKey,
    payload,
    response
  };
}

function opportunityMatches(record, payload) {
  return Boolean(
    payload.name &&
      record.name &&
      String(record.name).trim().toLowerCase() === String(payload.name).trim().toLowerCase()
  );
}
