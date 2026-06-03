import { createCompanyClient } from './companyClient.js';
import { createTwentyMetadataClient } from './metadataClient.js';
import { createOpportunityClient } from './opportunityClient.js';
import { createPeopleClient } from './peopleClient.js';
import { buildAssessmentCrmPayloads } from './payloadBuilders.js';
import { createQuickCaptureClient } from './quickCaptureClient.js';
import { validateTwentyRelationships } from './relationshipValidator.js';
import { createTwentyRestClient } from './restClient.js';
import { validateTwentySchema } from './schemaValidator.js';
import { createTaskClient } from './taskClient.js';

export function createTwentyProvider({
  config = {},
  log,
  schemaOverride,
  restClient,
  quickCapture = {}
} = {}) {
  const dryRun = !config.syncEnabled;
  const metadataClient = createTwentyMetadataClient(config, log);
  const twentyRestClient = restClient ?? (config.apiKey ? createTwentyRestClient(config) : null);
  const peopleClient = createPeopleClient({ dryRun, log, restClient: twentyRestClient });
  const companyClient = createCompanyClient({ dryRun, log, restClient: twentyRestClient });
  const taskClient = createTaskClient({ dryRun, log, restClient: twentyRestClient });
  const opportunityClient = createOpportunityClient({ dryRun, log, restClient: twentyRestClient });
  const quickCaptureClient = createQuickCaptureClient({
    dryRun,
    log,
    restClient: twentyRestClient,
    retry: {
      maxRetries: quickCapture.maxRetries,
      baseMs: quickCapture.retryBaseMs
    }
  });

  return {
    provider: 'twenty',

    async syncAssessment({ submission, score, completedOperations = [] }) {
      const payloads = buildAssessmentCrmPayloads({ submission, score });
      const completedOperationKeys = new Set(
        completedOperations.map((operation) =>
          operationKey({
            object: operation.objectName ?? operation.object,
            dedupeKey: operation.dedupeKey
          })
        )
      );
      const schemaValidation = await discoverAndValidateSchema({
        metadataClient,
        schemaOverride,
        hasApiKey: Boolean(config.apiKey),
        log
      });
      const relationshipValidation = schemaValidation.schema
        ? validateTwentyRelationships(schemaValidation.schema)
        : {
            ok: false,
            errors: ['Twenty relationship validation skipped because schema metadata is unavailable.'],
            warnings: [],
            mappings: []
          };

      if (!dryRun && !config.apiKey) {
        return blockedResult({
          reason: 'Twenty CRM live sync is enabled, but TWENTY_API_KEY is missing.',
          schemaValidation,
          relationshipValidation,
          payloads,
          status: 'blocked_configuration'
        });
      }

      if (!dryRun && !schemaValidation.ok) {
        return blockedResult({
          reason: 'Twenty CRM live sync was blocked because schema validation failed.',
          schemaValidation,
          relationshipValidation,
          payloads,
          status: 'blocked_schema_validation'
        });
      }

      const operations = [
        await runOperation(
          () => companyClient.upsertCompany(payloads.company),
          payloads.company,
          completedOperationKeys
        ),
        await runOperation(
          () => peopleClient.upsertPerson(payloads.person),
          payloads.person,
          completedOperationKeys
        ),
        await runOperation(
          () => taskClient.createTask(payloads.task),
          payloads.task,
          completedOperationKeys
        ),
        await runOperation(
          () => opportunityClient.createOpportunity(payloads.opportunity),
          payloads.opportunity,
          completedOperationKeys
        )
      ];
      const executionStatus = getExecutionStatus({ dryRun, operations });

      return {
        provider: 'twenty',
        status: executionStatus,
        dryRun,
        reason: dryRun
          ? 'Twenty CRM execution is in dry-run mode. No records were written.'
          : 'Twenty CRM execution completed with structured per-operation results.',
        schemaValidation,
        relationshipValidation,
        operations
      };
    },

    async syncQuickCapture({ lead, payloads }) {
      if (!dryRun && !config.apiKey) {
        return {
          provider: 'twenty',
          status: 'blocked_configuration',
          dryRun: false,
          reason: 'Twenty CRM live Quick Capture sync is enabled, but TWENTY_API_KEY is missing.',
          operations: Object.values(payloads)
            .filter(Boolean)
            .map((operation) => ({
              object: operation.object,
              action: operation.action,
              status: 'planned',
              dedupeKey: operation.dedupeKey,
              payload: operation.payload
            })),
          skippedRelationships: []
        };
      }

      return quickCaptureClient.syncQuickCapture({ lead, payloads });
    },

    async syncQuickCaptureOperations({ lead, operations }) {
      if (!dryRun && !config.apiKey) {
        return {
          provider: 'twenty',
          status: 'blocked_configuration',
          dryRun: false,
          reason: 'Twenty CRM live Quick Capture sync is enabled, but TWENTY_API_KEY is missing.',
          operations: operations.map((operation) => ({
            object: operation.object,
            action: operation.action,
            status: 'planned',
            dedupeKey: operation.dedupeKey,
            payload: operation.payload
          })),
          skippedRelationships: []
        };
      }

      return quickCaptureClient.syncQuickCaptureOperations({ lead, operations });
    },

    async getPersonById(personId) {
      if (!personId) {
        return null;
      }

      if (!config.apiKey || !twentyRestClient) {
        return null;
      }

      return twentyRestClient.getRecord('people', personId);
    },

    async syncTaskCompletion({ personUpdate, nextTask }) {
      if (!dryRun && !config.apiKey) {
        return {
          provider: 'twenty',
          status: 'blocked_configuration',
          dryRun: false,
          reason: 'Twenty CRM live task completion sync is enabled, but TWENTY_API_KEY is missing.',
          operations: [personUpdate, nextTask].filter(Boolean).map((operation) => ({
            object: operation.object,
            action: operation.action,
            status: 'planned',
            dedupeKey: operation.dedupeKey,
            payload: operation.payload
          })),
          skippedRelationships: taskCompletionSkippedRelationships()
        };
      }

      const operations = [];

      operations.push(
        await runOperation(() => peopleClient.updatePersonById(personUpdate), personUpdate, new Set())
      );

      if (nextTask) {
        operations.push(
          await runOperation(() => taskClient.createTask(nextTask), nextTask, new Set())
        );
      }

      return {
        provider: 'twenty',
        status: getExecutionStatus({ dryRun, operations }),
        dryRun,
        reason: dryRun
          ? 'Twenty CRM task completion execution is in dry-run mode. No records were written.'
          : 'Twenty CRM task completion execution completed with structured operation results.',
        operations,
        skippedRelationships: taskCompletionSkippedRelationships()
      };
    }
  };
}

function taskCompletionSkippedRelationships() {
  return [
    {
      key: 'person.company',
      status: 'skipped',
      reason: 'Relationship writes remain disabled during task completion.'
    },
    {
      key: 'task.taskTargets',
      status: 'skipped',
      reason: 'Relationship writes remain disabled; next task body includes Person ID and cadence context.'
    }
  ];
}

function blockedResult({ reason, schemaValidation, relationshipValidation, payloads, status }) {
  return {
    provider: 'twenty',
    status,
    dryRun: false,
    reason,
    schemaValidation,
    relationshipValidation,
    operations: Object.values(payloads).map((operation) => ({
      object: operation.object,
      action: operation.action,
      status: 'planned',
      dedupeKey: operation.dedupeKey,
      payload: operation.payload
    }))
  };
}

async function runOperation(operation, plannedOperation, completedOperationKeys) {
  if (completedOperationKeys.has(operationKey(plannedOperation))) {
    return {
      object: plannedOperation.object,
      action: 'skip_previously_succeeded',
      status: 'skipped',
      dedupeKey: plannedOperation.dedupeKey,
      payload: plannedOperation.payload,
      reason: 'A prior attempt already logged this operation as succeeded for the same submission.'
    };
  }

  try {
    return await operation();
  } catch (error) {
    return {
      object: plannedOperation.object,
      action: plannedOperation.action,
      status: 'failed',
      dedupeKey: plannedOperation.dedupeKey,
      payload: plannedOperation.payload,
      error: {
        message: error.message,
        code: error.code,
        details: error.response?.data ?? error.details
      }
    };
  }
}

function operationKey(operation) {
  return `${operation.object}:${operation.dedupeKey}`;
}

function getExecutionStatus({ dryRun, operations }) {
  if (dryRun) {
    return 'dry_run';
  }

  const failures = operations.filter((operation) => operation.status === 'failed');
  const successes = operations.filter((operation) =>
    ['succeeded', 'skipped'].includes(operation.status)
  );

  if (failures.length === 0) {
    return 'succeeded';
  }

  if (successes.length > 0) {
    return 'partial_failure';
  }

  return 'failed';
}

async function discoverAndValidateSchema({ metadataClient, schemaOverride, hasApiKey, log }) {
  if (schemaOverride) {
    return {
      status: 'validated',
      schema: schemaOverride,
      ...validateTwentySchema(schemaOverride)
    };
  }

  if (!hasApiKey) {
    return {
      status: 'skipped',
      ok: false,
      errors: ['Twenty API key is not configured; metadata discovery was skipped.'],
      warnings: []
    };
  }

  try {
    const schema = await metadataClient.discoverSchema();
    return {
      status: 'validated',
      schema,
      ...validateTwentySchema(schema)
    };
  } catch (error) {
    log?.warn({ error }, 'Twenty schema validation failed');

    return {
      status: 'failed',
      ok: false,
      errors: [error.message],
      warnings: []
    };
  }
}
