export function createCompanyClient({ dryRun = true, log, restClient } = {}) {
  return {
    async upsertCompany(operation) {
      return executeOperation({ ...operation, object: 'company', dryRun, log, restClient });
    }
  };
}

async function executeOperation({ action, dedupeKey, payload, dryRun, log, restClient }) {
  if (dryRun) {
    log?.info({ object: 'company', action, dedupeKey }, 'Twenty Company dry-run operation planned');
    return {
      object: 'company',
      action,
      status: 'dry_run',
      dedupeKey,
      payload
    };
  }

  if (!restClient) {
    throw new Error('Twenty REST client is required for live Company writes.');
  }

  const existing = await restClient.findFirstRecord('companies', (record) =>
    companyMatches(record, payload)
  );

  if (existing?.id) {
    const response = await restClient.updateRecord('companies', existing.id, payload);

    return {
      object: 'company',
      action: 'update',
      status: 'succeeded',
      dedupeKey,
      payload,
      response
    };
  }

  const response = await restClient.createRecord('companies', payload);

  return {
    object: 'company',
    action: 'create',
    status: 'succeeded',
    dedupeKey,
    payload,
    response
  };
}

function companyMatches(record, payload) {
  const targetDomain = payload.domainName?.primaryLinkUrl?.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase();
  const recordDomain = (
    record.domainName?.primaryLinkUrl ??
    record.domainNamePrimaryLinkUrl ??
    ''
  )
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .toLowerCase();

  if (targetDomain && recordDomain === targetDomain) {
    return true;
  }

  return Boolean(
    payload.name &&
      record.name &&
      String(record.name).trim().toLowerCase() === String(payload.name).trim().toLowerCase()
  );
}
