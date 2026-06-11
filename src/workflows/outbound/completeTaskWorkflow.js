import { createCrmAdapter } from '../../integrations/crm/crmAdapter.js';
import {
  buildNextTaskDedupeKey,
  createCompletedTaskUpdatePayload,
  createNextCadenceTaskPayload,
  createNextTaskCreatedOutboundEvent,
  createPersonCadenceUpdatePayload,
  createTaskCompletedOutboundEvent
} from '../../integrations/twenty/taskCompletionPayloadBuilders.js';
import { createOperationalStore } from '../../persistence/operationalStore.js';
import { planCadenceTransition } from '../../utils/cadenceTransitionEngine.js';
import { sanitizeWorkspaceUser } from '../../utils/outboundActorMapper.js';

const CHANNELS = new Set(['LINKEDIN', 'EMAIL', 'PHONE', 'TEXT', 'IN_PERSON', 'OTHER']);
const TOUCH_STATUSES = new Set([
  'DRAFTED',
  'SENT',
  'RESPONDED',
  'NO_RESPONSE',
  'BOUNCED',
  'DECLINED',
  'COMPLETED'
]);

export async function completeOutboundTaskWorkflow({
  input,
  config = {},
  log,
  workspaceUser,
  crmAdapter,
  operationalStore,
  now = new Date(),
  correlationId
} = {}) {
  const normalized = normalizeTaskCompletionInput(input);
  const adapter =
    crmAdapter ??
    createCrmAdapter({
      provider: config.crmProvider ?? 'twenty',
      config,
      log
    });
  const person = await resolvePersonContext({
    adapter,
    input: normalized
  });
  const cadenceName = normalized.cadenceName || person.cadenceName;
  const currentCadenceStage = normalized.currentCadenceStage || person.cadenceStage;

  if (!cadenceName || !currentCadenceStage) {
    const error = new Error(
      'Person cadenceName and cadenceStage are required to complete an outbound task.'
    );
    error.code = 'TASK_COMPLETION_CADENCE_CONTEXT_MISSING';
    error.statusCode = 422;
    throw error;
  }

  const transition = planCadenceTransition({
    cadenceName,
    currentCadenceStage,
    completion: normalized.completion,
    now
  });
  const personUpdate = buildPersonUpdateOperation({
    personId: normalized.personId,
    taskId: normalized.taskId,
    transition
  });
  const completedTask = buildCompletedTaskOperation({
    taskId: normalized.taskId,
    transition
  });
  const nextTask = buildNextTaskOperation({
    person,
    personId: normalized.personId,
    taskId: normalized.taskId,
    transition,
    completion: normalized.completion
  });
  const workflowCorrelationId =
    correlationId ?? `task-completion:${normalized.taskId}:${transition.cadenceName}:${transition.newCadenceStage}`;
  const store =
    config.supabase?.enabled && (operationalStore ?? createOperationalStore({ config, log }));
  const completedEvent = createTaskCompletedOutboundEvent({
    personId: normalized.personId,
    taskId: normalized.taskId,
    transition,
    completion: normalized.completion,
    workspaceUser,
    correlationId: workflowCorrelationId
  });
  const persistedEvents = [];

  if (store) {
    persistedEvents.push(await store.appendOutboundEvent(completedEvent));
  }

  const crmSync = await adapter.syncTaskCompletion({
    completedTask,
    personUpdate,
    nextTask
  });
  const nextTaskEvent = createNextTaskEventFromCrmResult({
    personId: normalized.personId,
    taskId: normalized.taskId,
    nextTask,
    transition,
    workspaceUser,
    correlationId: workflowCorrelationId,
    crmSync
  });

  if (store && nextTaskEvent) {
    persistedEvents.push(await store.appendOutboundEvent(nextTaskEvent));
  }

  const auditLogs = store
    ? await appendTaskCompletionCrmAuditLogs({
        store,
        correlationId: workflowCorrelationId,
        personId: normalized.personId,
        taskId: normalized.taskId,
        workspaceUser,
        transition,
        crmSync
      })
    : [];

  return {
    status: crmSync.status,
    correlationId: workflowCorrelationId,
    personId: normalized.personId,
    taskId: normalized.taskId,
    transition,
    completedTask,
    personUpdate,
    nextTask,
    crmSync,
    outboundEvents: {
      planned: [completedEvent, nextTaskEvent].filter(Boolean),
      persisted: persistedEvents
    },
    auditLogs,
    workspaceUser: sanitizeWorkspaceUser(workspaceUser),
    skippedRelationships: crmSync.skippedRelationships ?? []
  };
}

export function normalizeTaskCompletionInput(input = {}) {
  const completion = input.completion ?? {};
  const normalized = {
    personId: normalizeRequiredString(input.personId, 'personId'),
    taskId: normalizeRequiredString(input.taskId, 'taskId'),
    personSnapshot: input.personSnapshot ?? input.person ?? null,
    cadenceName: normalizeSelect(input.cadenceName),
    currentCadenceStage: normalizeSelect(input.currentCadenceStage),
    completion: {
      channel: normalizeSelect(completion.channel || 'LINKEDIN'),
      touchStatus: normalizeSelect(completion.touchStatus || 'SENT'),
      messageBody: normalizeWhitespace(completion.messageBody),
      notes: normalizeWhitespace(completion.notes),
      completedAt: normalizeWhitespace(completion.completedAt)
    }
  };

  if (!CHANNELS.has(normalized.completion.channel)) {
    throwValidationError(
      `completion.channel must be one of ${Array.from(CHANNELS).join(', ')}.`
    );
  }

  if (!TOUCH_STATUSES.has(normalized.completion.touchStatus)) {
    throwValidationError(
      `completion.touchStatus must be one of ${Array.from(TOUCH_STATUSES).join(', ')}.`
    );
  }

  return normalized;
}

function buildPersonUpdateOperation({ personId, taskId, transition }) {
  return {
    object: 'person',
    action: 'update',
    id: personId,
    dedupeKey: `task-completion:person:${personId}:task:${taskId}:stage:${transition.newCadenceStage}`,
    payload: createPersonCadenceUpdatePayload({ transition })
  };
}

function buildCompletedTaskOperation({ taskId, transition }) {
  return {
    object: 'task',
    action: 'update',
    id: taskId,
    dedupeKey: `task-completion:completed-task:${taskId}:stage:${transition.newCadenceStage}`,
    payload: createCompletedTaskUpdatePayload({ transition })
  };
}

function buildNextTaskOperation({ person, personId, taskId, transition, completion }) {
  if (!transition.nextTask) {
    return null;
  }

  const dedupeKey = buildNextTaskDedupeKey({
    personId,
    cadenceName: transition.cadenceName,
    nextCadenceStage: transition.nextTask.nextCadenceStage,
    taskType: transition.nextTask.taskType
  });

  return {
    object: 'task',
    action: 'create',
    dedupeKey,
    payload: createNextCadenceTaskPayload({
      person,
      personId,
      taskId,
      transition,
      completion,
      dedupeKey
    })
  };
}

async function resolvePersonContext({ adapter, input }) {
  if (input.personSnapshot) {
    return input.personSnapshot;
  }

  const person = await adapter.getPersonById(input.personId);

  if (!person) {
    const error = new Error(
      'Unable to resolve Person cadence context from Twenty. Provide a valid personId or personSnapshot.'
    );
    error.code = 'TASK_COMPLETION_PERSON_CONTEXT_MISSING';
    error.statusCode = 422;
    throw error;
  }

  return person;
}

function createNextTaskEventFromCrmResult({
  personId,
  taskId,
  nextTask,
  transition,
  workspaceUser,
  correlationId,
  crmSync
}) {
  if (!nextTask || !transition.nextTask) {
    return null;
  }

  const taskOperation = crmSync.operations.find(
    (operation) => operation.object === 'task' && operation.dedupeKey === nextTask.dedupeKey
  );
  const event = createNextTaskCreatedOutboundEvent({
    personId,
    taskId,
    nextTaskOperation: nextTask,
    transition,
    workspaceUser,
    correlationId
  });

  return {
    ...event,
    status: taskOperation?.status === 'failed' ? 'failed' : event.status,
    payload: {
      ...event.payload,
      crmTaskOperationStatus: taskOperation?.status ?? null,
      crmTaskId: taskOperation?.response?.id ?? taskOperation?.id ?? null
    },
    errorPayload: taskOperation?.status === 'failed' ? taskOperation.error ?? null : null
  };
}

async function appendTaskCompletionCrmAuditLogs({
  store,
  correlationId,
  personId,
  taskId,
  workspaceUser,
  transition,
  crmSync
}) {
  const logs = [];
  const startedAt = new Date().toISOString();
  const finishedAt = startedAt;

  for (const operation of [
    ...crmSync.operations,
    ...(crmSync.relationshipResults ?? [])
  ]) {
    logs.push(
      await store.appendCrmSyncLog({
        assessmentSubmissionId: null,
        workflowJobId: null,
        correlationId,
        provider: crmSync.provider,
        objectName: operation.object,
        action: operation.action,
        dedupeKey: operation.dedupeKey,
        status: normalizeAuditStatus(operation.status),
        attempt: operation.attempts ?? 1,
        requestPayload: {
          payload: operation.payload,
          personId,
          completedTaskId: taskId,
          workspaceUser: sanitizeWorkspaceUser(workspaceUser),
          transition
        },
        responsePayload: operation.response,
        errorPayload: operation.error,
        startedAt,
        finishedAt
      })
    );
  }

  return logs;
}

function normalizeAuditStatus(status) {
  if (['dry_run', 'skipped', 'failed'].includes(status)) {
    return status;
  }

  return 'succeeded';
}

function normalizeRequiredString(value, fieldName) {
  const normalized = normalizeWhitespace(value);

  if (!normalized) {
    throwValidationError(`${fieldName} is required.`);
  }

  return normalized;
}

function throwValidationError(message) {
  const error = new Error(`Invalid task completion payload: ${message}`);
  error.code = 'TASK_COMPLETION_VALIDATION_FAILED';
  error.statusCode = 400;
  throw error;
}

function normalizeWhitespace(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeSelect(value) {
  return normalizeWhitespace(value).toUpperCase();
}
