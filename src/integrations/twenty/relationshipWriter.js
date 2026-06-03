import { findField, findObject } from './metadataClient.js';
import { sanitizePayloadForDiagnostics } from './errorDiagnostics.js';

const RELATIONSHIP_SCHEMA_OBJECTS = ['person', 'company', 'task', 'taskTarget', 'noteTarget'];

export function createTwentyRelationshipWriter({
  config = {},
  dryRun = true,
  restClient,
  metadataClient,
  schemaOverride,
  log
} = {}) {
  let schemaPromise = null;

  async function getSchema() {
    if (schemaOverride) {
      return schemaOverride;
    }

    if (!metadataClient || !config.apiKey) {
      return null;
    }

    schemaPromise ??= metadataClient.discoverSchema(RELATIONSHIP_SCHEMA_OBJECTS);
    return schemaPromise;
  }

  return {
    async inspectRelationshipMetadata() {
      const schema = await getSchema();

      return inspectTwentyRelationshipMetadata(schema);
    },

    async linkPersonToCompany({ personId, companyId, context = {} } = {}) {
      const operation = createPersonCompanyOperation({ personId, companyId, context });

      return runRelationshipOperation({
        operation,
        config,
        dryRun,
        restClient,
        log,
        metadataValidator: async () => validatePersonCompanyMetadata(await getSchema()),
        execute: async () => {
          const existingPerson = await restClient.getRecord('people', personId);

          if (String(existingPerson?.companyId ?? '') === String(companyId)) {
            return {
              action: 'skip_existing',
              response: existingPerson,
              reason: 'Person is already linked to this Company.'
            };
          }

          const response = await restClient.updateRecord('people', personId, operation.payload);

          return {
            action: 'update',
            response
          };
        }
      });
    },

    async linkTaskToPerson({ taskId, personId, context = {} } = {}) {
      const operation = createTaskTargetOperation({
        taskId,
        targetId: personId,
        targetType: 'person',
        context
      });

      return runRelationshipOperation({
        operation,
        config,
        dryRun,
        restClient,
        log,
        metadataValidator: async () => validateTaskTargetMetadata(await getSchema(), 'person'),
        execute: async () => createOrSkipTaskTarget({ restClient, operation })
      });
    },

    async linkTaskToCompany({ taskId, companyId, context = {} } = {}) {
      const operation = createTaskTargetOperation({
        taskId,
        targetId: companyId,
        targetType: 'company',
        context
      });

      return runRelationshipOperation({
        operation,
        config,
        dryRun,
        restClient,
        log,
        metadataValidator: async () => validateTaskTargetMetadata(await getSchema(), 'company'),
        execute: async () => createOrSkipTaskTarget({ restClient, operation })
      });
    }
  };
}

export function inspectTwentyRelationshipMetadata(schema) {
  if (!schema) {
    return {
      ok: false,
      warnings: ['Twenty relationship metadata is unavailable.'],
      relationships: {}
    };
  }

  return {
    ok: true,
    warnings: [],
    relationships: {
      personCompany: validatePersonCompanyMetadata(schema),
      taskTargetPerson: validateTaskTargetMetadata(schema, 'person'),
      taskTargetCompany: validateTaskTargetMetadata(schema, 'company'),
      taskAssignee: inspectJoinColumnRelationship({
        schema,
        objectName: 'task',
        fieldName: 'assignee',
        expectedJoinColumnName: 'assigneeId'
      }),
      companyPeople: inspectOneToManyRelationship({
        schema,
        objectName: 'company',
        fieldName: 'people'
      }),
      noteTarget: inspectNoteTargetMetadata(schema)
    }
  };
}

export function createPersonCompanyOperation({ personId, companyId, context = {} } = {}) {
  return {
    key: 'person.company',
    object: 'person',
    action: 'link_company',
    dedupeKey: `relationship:person:${personId}:company:${companyId}`,
    payload: {
      companyId
    },
    personId,
    companyId,
    context,
    requiredFlag: 'personCompanyLinkEnabled'
  };
}

export function createTaskTargetOperation({
  taskId,
  targetId,
  targetType,
  context = {}
} = {}) {
  const targetField = targetType === 'company' ? 'targetCompanyId' : 'targetPersonId';

  return {
    key: targetType === 'company' ? 'task.taskTargets.company' : 'task.taskTargets.person',
    object: 'taskTarget',
    action: targetType === 'company' ? 'link_task_to_company' : 'link_task_to_person',
    dedupeKey: `relationship:task:${taskId}:${targetType}:${targetId}`,
    payload: {
      taskId,
      [targetField]: targetId
    },
    taskId,
    targetId,
    targetType,
    context,
    requiredFlag: 'taskTargetLinkEnabled'
  };
}

async function runRelationshipOperation({
  operation,
  config,
  dryRun,
  restClient,
  log,
  metadataValidator,
  execute
}) {
  if (!hasRequiredIds(operation)) {
    return skippedOperation(operation, 'Required relationship IDs are missing.');
  }

  if (!config.relationshipWritesEnabled) {
    return skippedOperation(operation, 'TWENTY_RELATIONSHIP_WRITES_ENABLED=false.');
  }

  if (!config[operation.requiredFlag]) {
    return skippedOperation(operation, `Twenty relationship flag ${operation.requiredFlag} is disabled.`);
  }

  const metadataValidation = await metadataValidator();

  if (!metadataValidation.ok) {
    return failedOperation(operation, {
      message: 'Twenty relationship metadata validation failed.',
      code: 'TWENTY_RELATIONSHIP_METADATA_INVALID',
      details: metadataValidation
    });
  }

  if (dryRun) {
    return {
      ...baseOperationResult(operation),
      status: 'dry_run',
      metadataValidation,
      reason: 'Relationship write is in dry-run mode.'
    };
  }

  if (!restClient) {
    return failedOperation(operation, {
      message: 'Twenty REST client is required for live relationship writes.',
      code: 'TWENTY_REST_CLIENT_MISSING',
      details: metadataValidation
    });
  }

  try {
    const execution = await execute();

    log?.info?.(
      {
        key: operation.key,
        action: execution.action,
        dedupeKey: operation.dedupeKey
      },
      'Twenty relationship write completed.'
    );

    return {
      ...baseOperationResult(operation),
      action: execution.action ?? operation.action,
      status: execution.action === 'skip_existing' ? 'skipped' : 'succeeded',
      response: execution.response,
      metadataValidation,
      reason: execution.reason
    };
  } catch (error) {
    log?.warn?.(
      {
        key: operation.key,
        dedupeKey: operation.dedupeKey,
        error: error.message,
        status: error.twentyDiagnostics?.httpStatus ?? error.response?.status,
        payload: sanitizePayloadForDiagnostics(operation.payload)
      },
      'Twenty relationship write failed.'
    );

    return failedOperation(operation, error, metadataValidation);
  }
}

async function createOrSkipTaskTarget({ restClient, operation }) {
  const existing = await restClient.findFirstRecord('taskTargets', (record) =>
    String(record.taskId ?? '') === String(operation.payload.taskId) &&
    String(record[operation.targetType === 'company' ? 'targetCompanyId' : 'targetPersonId'] ?? '') ===
      String(operation.targetId)
  );

  if (existing?.id) {
    return {
      action: 'skip_existing',
      response: existing,
      reason: 'Task target already exists.'
    };
  }

  const response = await restClient.createRecord('taskTargets', operation.payload);

  return {
    action: 'create',
    response
  };
}

function validatePersonCompanyMetadata(schema) {
  const fieldValidation = inspectJoinColumnRelationship({
    schema,
    objectName: 'person',
    fieldName: 'company',
    expectedJoinColumnName: 'companyId'
  });

  return {
    ...fieldValidation,
    payloadShape: {
      objectPlural: 'people',
      method: 'PATCH',
      fields: ['companyId']
    }
  };
}

function validateTaskTargetMetadata(schema, targetType) {
  if (!schema) {
    return invalidMetadata('Twenty relationship metadata is unavailable.');
  }

  const taskTarget = findObject(schema, 'taskTarget');
  const taskField = findField(taskTarget, 'task');
  const targetFieldName = targetType === 'company' ? 'targetCompany' : 'targetPerson';
  const targetJoinColumnName = targetType === 'company' ? 'targetCompanyId' : 'targetPersonId';
  const targetField = findField(taskTarget, targetFieldName);
  const errors = [];

  if (!taskTarget) {
    errors.push('Missing taskTarget object metadata.');
  }

  if (!isRelationWithJoinColumn(taskField, 'taskId')) {
    errors.push('taskTarget.task must be a RELATION with joinColumnName taskId.');
  }

  if (!isRelationWithJoinColumn(targetField, targetJoinColumnName, ['MORPH_RELATION'])) {
    errors.push(
      `taskTarget.${targetFieldName} must be a MORPH_RELATION with joinColumnName ${targetJoinColumnName}.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    objectName: 'taskTarget',
    relationType: 'taskTargets',
    payloadShape: {
      objectPlural: 'taskTargets',
      method: 'POST',
      fields: ['taskId', targetJoinColumnName]
    },
    fields: {
      task: summarizeField(taskField),
      [targetFieldName]: summarizeField(targetField)
    }
  };
}

function inspectJoinColumnRelationship({
  schema,
  objectName,
  fieldName,
  expectedJoinColumnName
}) {
  if (!schema) {
    return invalidMetadata('Twenty relationship metadata is unavailable.');
  }

  const objectMetadata = findObject(schema, objectName);
  const field = findField(objectMetadata, fieldName);
  const errors = [];

  if (!objectMetadata) {
    errors.push(`Missing ${objectName} object metadata.`);
  }

  if (!isRelationWithJoinColumn(field, expectedJoinColumnName)) {
    errors.push(
      `${objectName}.${fieldName} must be a RELATION with joinColumnName ${expectedJoinColumnName}.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    objectName,
    fieldName,
    relationType: field?.settings?.relationType ?? null,
    joinColumnName: field?.settings?.joinColumnName ?? field?.joinColumnName ?? null,
    field: summarizeField(field)
  };
}

function inspectOneToManyRelationship({ schema, objectName, fieldName }) {
  if (!schema) {
    return invalidMetadata('Twenty relationship metadata is unavailable.');
  }

  const objectMetadata = findObject(schema, objectName);
  const field = findField(objectMetadata, fieldName);
  const errors = [];

  if (!field || field.type !== 'RELATION' || field.settings?.relationType !== 'ONE_TO_MANY') {
    errors.push(`${objectName}.${fieldName} must be a ONE_TO_MANY RELATION.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    objectName,
    fieldName,
    relationType: field?.settings?.relationType ?? null,
    field: summarizeField(field)
  };
}

function inspectNoteTargetMetadata(schema) {
  if (!schema) {
    return invalidMetadata('Twenty relationship metadata is unavailable.');
  }

  const noteTarget = findObject(schema, 'noteTarget');
  const noteField = findField(noteTarget, 'note');
  const personField = findField(noteTarget, 'targetPerson');
  const companyField = findField(noteTarget, 'targetCompany');
  const errors = [];

  if (!noteTarget) {
    errors.push('Missing noteTarget object metadata.');
  }

  if (!isRelationWithJoinColumn(noteField, 'noteId')) {
    errors.push('noteTarget.note must be a RELATION with joinColumnName noteId.');
  }

  if (!isRelationWithJoinColumn(personField, 'targetPersonId', ['MORPH_RELATION'])) {
    errors.push('noteTarget.targetPerson must be a MORPH_RELATION with joinColumnName targetPersonId.');
  }

  if (!isRelationWithJoinColumn(companyField, 'targetCompanyId', ['MORPH_RELATION'])) {
    errors.push('noteTarget.targetCompany must be a MORPH_RELATION with joinColumnName targetCompanyId.');
  }

  return {
    ok: errors.length === 0,
    errors,
    objectName: 'noteTarget',
    payloadShape: {
      objectPlural: 'noteTargets',
      method: 'POST',
      fields: ['noteId', 'targetPersonId', 'targetCompanyId']
    },
    fields: {
      note: summarizeField(noteField),
      targetPerson: summarizeField(personField),
      targetCompany: summarizeField(companyField)
    }
  };
}

function isRelationWithJoinColumn(field, expectedJoinColumnName, extraAllowedTypes = []) {
  const allowedTypes = new Set(['RELATION', ...extraAllowedTypes]);
  return (
    Boolean(field) &&
    allowedTypes.has(field.type) &&
    (field.settings?.joinColumnName ?? field.joinColumnName) === expectedJoinColumnName
  );
}

function hasRequiredIds(operation) {
  if (operation.key === 'person.company') {
    return Boolean(operation.personId && operation.companyId);
  }

  return Boolean(operation.taskId && operation.targetId);
}

function skippedOperation(operation, reason) {
  return {
    ...baseOperationResult(operation),
    status: 'skipped',
    reason
  };
}

function failedOperation(operation, error, metadataValidation) {
  const diagnostics = error.twentyDiagnostics ?? {};

  return {
    ...baseOperationResult(operation),
    status: 'failed',
    metadataValidation,
    error: {
      message: error.message,
      code: error.code,
      httpStatus: diagnostics.httpStatus ?? error.response?.status,
      responseBody: diagnostics.responseBody ?? error.response?.data ?? error.details,
      sanitizedRequestPayload:
        diagnostics.sanitizedRequestPayload ?? sanitizePayloadForDiagnostics(operation.payload)
    }
  };
}

function baseOperationResult(operation) {
  return {
    key: operation.key,
    object: operation.object,
    action: operation.action,
    dedupeKey: operation.dedupeKey,
    payload: operation.payload,
    context: operation.context
  };
}

function invalidMetadata(message) {
  return {
    ok: false,
    errors: [message]
  };
}

function summarizeField(field) {
  if (!field) {
    return null;
  }

  return {
    name: field.name,
    label: field.label,
    type: field.type,
    isCustom: field.isCustom,
    relationType: field.settings?.relationType ?? null,
    joinColumnName: field.settings?.joinColumnName ?? field.joinColumnName ?? null
  };
}
