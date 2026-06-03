import {
  calculateRetryDelayMs,
  getRetryErrorDetails,
  isRetryableTwentyError
} from '../../utils/retryPolicy.js';
import {
  extractTwentyValidationMessages,
  sanitizePayloadForDiagnostics
} from './errorDiagnostics.js';

export const PROTECTED_ASSESSMENT_FIELDS = [
  'assessmentCompleted',
  'assessmentScore',
  'lastTouchDate',
  'leadstageAuto',
  'messageAngle',
  'nextFollowUpDate'
];

export function createQuickCaptureClient({
  dryRun = true,
  log,
  restClient,
  retry = {}
} = {}) {
  const retryPolicy = normalizeRetryPolicy(retry);

  return {
    async syncQuickCapture({ lead, payloads }) {
      return executeQuickCaptureOperations({
        lead,
        operations: buildOperationsFromPayloads(payloads),
        dryRun,
        restClient,
        log,
        retryPolicy
      });
    },

    async syncQuickCaptureOperations({ lead = {}, operations = [] }) {
      return executeQuickCaptureOperations({
        lead,
        operations: operations.filter(Boolean),
        dryRun,
        restClient,
        log,
        retryPolicy
      });
    }
  };
}

async function executeQuickCaptureOperations({
  lead,
  operations,
  dryRun,
  restClient,
  log,
  retryPolicy
}) {
  const operationResults = [];
  const skippedRelationships = [
    {
      key: 'person.company',
      status: 'skipped',
      reason: 'Relationship writes remain disabled until Twenty relation payload shape is confirmed.'
    },
    {
      key: 'task.taskTargets',
      status: 'skipped',
      reason: 'Relationship writes remain disabled until Twenty relation payload shape is confirmed.'
    }
  ];

  for (const operation of operations) {
    operationResults.push(
      await runOperationWithRetry({
        operation,
        lead,
        dryRun,
        log,
        retryPolicy,
        execute: () =>
          executeQuickCaptureOperation({
            operation,
            lead,
            dryRun,
            restClient,
            log
          })
      })
    );
  }

  return {
    provider: 'twenty',
    status: getExecutionStatus({ dryRun, operations: operationResults }),
    dryRun,
    reason: dryRun
      ? 'Quick Capture execution is in dry-run mode. No records were written.'
      : 'Quick Capture CRM execution completed with structured operation results.',
    operations: operationResults,
    skippedRelationships
  };
}

function buildOperationsFromPayloads(payloads = {}) {
  return [payloads.company, payloads.person, payloads.task].filter(Boolean);
}

async function runOperationWithRetry({ operation, lead, execute, dryRun, log, retryPolicy }) {
  let attempt = 0;
  const maxAttempts = dryRun ? 1 : retryPolicy.maxRetries + 1;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      const result = await execute();

      return {
        ...result,
        attempts: attempt,
        retryCount: attempt - 1
      };
    } catch (error) {
      const retryable = isRetryableTwentyError(error);
      const canRetry = retryable && attempt < maxAttempts;

      if (!canRetry) {
        return toFailedOperation(
          operation,
          error,
          {
            attempts: attempt,
            retryCount: attempt - 1,
            maxRetries: retryPolicy.maxRetries
          },
          { lead }
        );
      }

      const delayMs = calculateRetryDelayMs({
        error,
        attempt,
        baseMs: retryPolicy.baseMs,
        maxMs: retryPolicy.maxDelayMs
      });

      log?.warn?.(
        {
          object: operation.object,
          dedupeKey: operation.dedupeKey,
          attempt,
          nextAttempt: attempt + 1,
          delayMs
        },
        'Retryable Quick Capture CRM operation failed; retrying operation.'
      );

      await retryPolicy.sleep(delayMs);
    }
  }

  throw new Error('Quick Capture retry loop exited unexpectedly.');
}

function executeQuickCaptureOperation({ operation, lead, dryRun, restClient, log }) {
  if (operation.object === 'company') {
    return executeCompanyOperation({
      operation,
      dryRun,
      restClient,
      log
    });
  }

  if (operation.object === 'person') {
    return executePersonOperation({
      operation,
      lead,
      dryRun,
      restClient,
      log
    });
  }

  if (operation.object === 'task') {
    return executeTaskOperation({
      operation,
      dryRun,
      restClient,
      log
    });
  }

  throw new Error(`Unsupported Quick Capture CRM operation object "${operation.object}".`);
}

export function assertNoProtectedAssessmentFields(payload) {
  const present = PROTECTED_ASSESSMENT_FIELDS.filter((fieldName) =>
    Object.hasOwn(payload, fieldName)
  );

  if (present.length > 0) {
    throw new Error(
      `Quick Capture Person payload includes protected assessment fields: ${present.join(', ')}`
    );
  }
}

async function executeCompanyOperation({ operation, dryRun, restClient, log }) {
  if (dryRun) {
    log?.info?.({ object: 'company', dedupeKey: operation.dedupeKey }, 'Quick Capture Company dry-run');
    return toDryRunOperation(operation);
  }

  ensureRestClient(restClient, 'Company');
  const existing = await restClient.findFirstRecord('companies', (record) =>
    companyMatches(record, operation.payload)
  );

  if (existing?.id) {
    const response = await restClient.updateRecord('companies', existing.id, operation.payload);

    return toSucceededOperation(operation, 'update', response, {
      duplicateAvoided: true,
      matchedBy: 'company_domain_or_name'
    });
  }

  const response = await restClient.createRecord('companies', operation.payload);
  return toSucceededOperation(operation, 'create', response, {
    duplicateAvoided: false
  });
}

async function executePersonOperation({ operation, lead, dryRun, restClient, log }) {
  assertNoProtectedAssessmentFields(operation.payload);
  assertValidPersonPayload(operation);

  if (dryRun) {
    log?.info?.({ object: 'person', dedupeKey: operation.dedupeKey }, 'Quick Capture Person dry-run');
    return toDryRunOperation(operation);
  }

  ensureRestClient(restClient, 'Person');
  const existingMatch = await findExistingPerson(restClient, lead, operation.payload);

  if (existingMatch.record?.id) {
    const response = await restClient.updateRecord('people', existingMatch.record.id, operation.payload);

    return toSucceededOperation(operation, 'update', response, {
      duplicateAvoided: true,
      matchedBy: existingMatch.matchedBy
    });
  }

  const response = await restClient.createRecord('people', operation.payload);
  return toSucceededOperation(operation, 'create', response, {
    duplicateAvoided: false,
    matchedBy: null
  });
}

function assertValidPersonPayload(operation) {
  if (operation.payloadValidation?.ok === false) {
    const error = new Error('Quick Capture Person payload failed metadata validation.');

    error.code = 'PERSON_PAYLOAD_VALIDATION_FAILED';
    error.details = operation.payloadValidation;
    throw error;
  }
}

async function executeTaskOperation({ operation, dryRun, restClient, log }) {
  if (dryRun) {
    log?.info?.({ object: 'task', dedupeKey: operation.dedupeKey }, 'Quick Capture Task dry-run');
    return toDryRunOperation(operation);
  }

  ensureRestClient(restClient, 'Task');
  const existing = await restClient.findFirstRecord('tasks', (record) =>
    taskMatches(record, operation.dedupeKey)
  );

  if (existing?.id) {
    return {
      object: operation.object,
      action: 'skip_existing',
      status: 'skipped',
      dedupeKey: operation.dedupeKey,
      payload: operation.payload,
      response: existing,
      duplicateAvoided: true,
      matchedBy: 'task_dedupe_key'
    };
  }

  const response = await restClient.createRecord('tasks', operation.payload);
  return toSucceededOperation(operation, 'create', response, {
    duplicateAvoided: false
  });
}

async function findExistingPerson(restClient, lead, payload) {
  if (lead.email || payload.emails?.primaryEmail) {
    const targetEmail = lead.email ?? payload.emails.primaryEmail;
    const record = await restClient.findFirstRecord('people', (candidate) =>
      emailMatches(candidate, targetEmail)
    );

    if (record) {
      return { record, matchedBy: 'email' };
    }
  }

  if (lead.linkedinUrl || payload.linkedinLink?.primaryLinkUrl) {
    const targetUrl = normalizeUrl(lead.linkedinUrl ?? payload.linkedinLink.primaryLinkUrl);
    const record = await restClient.findFirstRecord('people', (candidate) =>
      normalizeUrl(candidate.linkedinLink?.primaryLinkUrl ?? candidate.linkedinLinkPrimaryLinkUrl) ===
      targetUrl
    );

    if (record) {
      return { record, matchedBy: 'linkedin' };
    }
  }

  const record = await restClient.findFirstRecord('people', (candidate) =>
    personNameMatches(candidate, payload) && companyNameMatches(candidate, lead.companyName)
  );

  return record ? { record, matchedBy: 'name_company' } : { record: null, matchedBy: null };
}

function emailMatches(record, email) {
  const target = String(email ?? '').toLowerCase();

  return (
    record.emails?.primaryEmail?.toLowerCase() === target ||
    record.emailsPrimaryEmail?.toLowerCase() === target
  );
}

function personNameMatches(record, payload) {
  const targetFirst = normalizeText(payload.name?.firstName);
  const targetLast = normalizeText(payload.name?.lastName);
  const recordFirst = normalizeText(record.name?.firstName ?? record.nameFirstName);
  const recordLast = normalizeText(record.name?.lastName ?? record.nameLastName);

  return Boolean(targetFirst && targetFirst === recordFirst && targetLast === recordLast);
}

function companyNameMatches(record, companyName) {
  const target = normalizeText(companyName);
  const recordCompany = normalizeText(
    record.company?.name ?? record.companyName ?? record.company?.displayName
  );

  return !target || !recordCompany || target === recordCompany;
}

function companyMatches(record, payload) {
  const targetDomain = normalizeDomain(payload.domainName?.primaryLinkUrl);
  const recordDomain = normalizeDomain(
    record.domainName?.primaryLinkUrl ?? record.domainNamePrimaryLinkUrl
  );

  if (targetDomain && recordDomain === targetDomain) {
    return true;
  }

  return Boolean(payload.name && normalizeText(record.name) === normalizeText(payload.name));
}

function taskMatches(record, dedupeKey) {
  const body = record.bodyV2?.markdown ?? record.bodyV2 ?? '';
  return String(body).includes(`Dedupe key: ${dedupeKey}`);
}

function toDryRunOperation(operation) {
  return {
    object: operation.object,
    action: operation.action,
    status: 'dry_run',
    dedupeKey: operation.dedupeKey,
    payload: operation.payload,
    payloadValidation: operation.payloadValidation
  };
}

function toSucceededOperation(operation, action, response, extras = {}) {
  return {
    object: operation.object,
    action,
    status: 'succeeded',
    dedupeKey: operation.dedupeKey,
    payload: operation.payload,
    payloadValidation: operation.payloadValidation,
    response,
    ...extras
  };
}

function toFailedOperation(operation, error, retryMeta, { lead } = {}) {
  const retryDetails = getRetryErrorDetails(error);
  const twentyDiagnostics = error.twentyDiagnostics ?? {};
  const httpStatus = twentyDiagnostics.httpStatus ?? error.response?.status;
  const responseBody = twentyDiagnostics.responseBody ?? sanitizePayloadForDiagnostics(error.response?.data ?? error.details);
  const validationMessages =
    twentyDiagnostics.validationMessages?.length > 0
      ? twentyDiagnostics.validationMessages
      : extractTwentyValidationMessages(error.response?.data ?? error.details);
  const diagnostics = {
    failingOperation: {
      object: operation.object,
      action: operation.action,
      dedupeKey: operation.dedupeKey
    },
    fieldNames: Object.keys(operation.payload ?? {}),
    dedupeStrategy: lead?.dedupe?.strategy ?? null,
    sanitizedRequestPayload:
      twentyDiagnostics.sanitizedRequestPayload ??
      sanitizePayloadForDiagnostics(operation.payload),
    payloadValidation: operation.payloadValidation ?? null
  };

  return {
    object: operation.object,
    action: operation.action,
    status: 'failed',
    dedupeKey: operation.dedupeKey,
    payload: operation.payload,
    payloadValidation: operation.payloadValidation,
    attempts: retryMeta.attempts,
    retryCount: retryMeta.retryCount,
    maxRetries: retryMeta.maxRetries,
    error: {
      message: error.message,
      code: error.code,
      httpStatus,
      responseBody,
      validationMessages,
      details: responseBody,
      diagnostics,
      ...stripUndefined(retryDetails)
    }
  };
}

function getExecutionStatus({ dryRun, operations }) {
  if (dryRun) {
    return 'dry_run';
  }

  const failed = operations.some((operation) => operation.status === 'failed');

  if (failed) {
    return operations.some((operation) => operation.status === 'succeeded')
      ? 'partial_failure'
      : 'failed';
  }

  return 'succeeded';
}

function ensureRestClient(restClient, objectName) {
  if (!restClient) {
    throw new Error(`Twenty REST client is required for live Quick Capture ${objectName} writes.`);
  }
}

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeUrl(value) {
  return String(value ?? '').trim().replace(/\/$/, '').toLowerCase();
}

function normalizeDomain(value) {
  return normalizeUrl(value).replace(/^https?:\/\//, '').replace(/^www\./, '');
}

function normalizeRetryPolicy(retry) {
  return {
    maxRetries: Math.max(0, Number(retry.maxRetries ?? 0)),
    baseMs: Math.max(0, Number(retry.baseMs ?? 1000)),
    maxDelayMs: Math.max(0, Number(retry.maxDelayMs ?? 30000)),
    sleep: retry.sleep ?? sleep
  };
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function stripUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}
