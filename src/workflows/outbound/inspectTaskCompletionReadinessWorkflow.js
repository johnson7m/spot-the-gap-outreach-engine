import { createCrmAdapter } from '../../integrations/crm/crmAdapter.js';
import {
  getSupportedCadenceTransitions,
  planCadenceTransition
} from '../../utils/cadenceTransitionEngine.js';

export async function inspectTaskCompletionReadinessWorkflow({
  input = {},
  config = {},
  log,
  crmAdapter,
  now = new Date(),
  correlationId
} = {}) {
  const taskId = normalizeRequiredString(input.taskId, 'taskId');
  const personId = normalizeRequiredString(input.personId, 'personId');
  const adapter =
    crmAdapter ??
    createCrmAdapter({
      provider: config.crmProvider ?? 'twenty',
      config,
      log
    });
  const [person, task] = await Promise.all([
    adapter.getPersonById(personId),
    adapter.getTaskById ? adapter.getTaskById(taskId) : null
  ]);
  const cadenceName = normalizeSelect(input.cadenceName ?? person?.cadenceName);
  const currentCadenceStage = normalizeSelect(
    input.currentCadenceStage ?? person?.cadenceStage ?? readMarkdownValue(getTaskBody(task), 'Cadence stage')
  );
  const completion = {
    channel: normalizeSelect(input.completion?.channel ?? 'LINKEDIN'),
    touchStatus: normalizeSelect(input.completion?.touchStatus ?? 'SENT'),
    completedAt: input.completion?.completedAt ?? now.toISOString()
  };
  const blockers = [];
  const warnings = [];
  let transition = null;

  if (!person) {
    blockers.push('Person could not be read from Twenty.');
  }

  if (!task) {
    warnings.push('Task could not be read from Twenty; readiness is based on Person cadence only.');
  }

  if (!cadenceName) {
    blockers.push('Person cadenceName is missing.');
  }

  if (!currentCadenceStage) {
    blockers.push('Person cadenceStage is missing.');
  }

  if (blockers.length === 0) {
    try {
      transition = planCadenceTransition({
        cadenceName,
        currentCadenceStage,
        completion,
        now
      });
    } catch (error) {
      blockers.push(error.message);
      if (error.details?.supportedStages?.length > 0) {
        warnings.push(
          `Supported stages for ${cadenceName}: ${error.details.supportedStages.join(', ')}.`
        );
      }
    }
  }

  return {
    status: blockers.length > 0 ? 'blocked' : 'ready',
    correlationId,
    taskId,
    personId,
    task: task
      ? {
          id: task.id,
          title: task.title ?? task.name ?? null,
          status: task.status ?? null,
          dueAt: task.dueAt ?? task.dueDate ?? null,
          cadenceStageFromBody: readMarkdownValue(getTaskBody(task), 'Cadence stage') ?? null,
          nextCadenceStageFromBody: readMarkdownValue(getTaskBody(task), 'Next cadence stage') ?? null,
          taskTypeFromBody: readMarkdownValue(getTaskBody(task), 'Task type') ?? null
        }
      : null,
    person: person
      ? {
          id: person.id,
          name: person.name?.fullName ?? person.name ?? null,
          cadenceName: person.cadenceName ?? null,
          cadenceStage: person.cadenceStage ?? null,
          latestTouchStatus: person.latestTouchStatus ?? null,
          nextOutboundTouchDate: person.nextOutboundTouchDate ?? null
        }
      : null,
    completionPreview: completion,
    transition,
    supportedTransitions: getSupportedCadenceTransitions()[cadenceName] ?? null,
    blockers,
    warnings,
    recommendedAction:
      blockers.length > 0
        ? 'Review cadence context before completing this task.'
        : 'Task completion can proceed; review the transition preview first.'
  };
}

function getTaskBody(task = {}) {
  const body = task?.bodyV2?.markdown ?? task?.bodyV2 ?? task?.body ?? task?.description ?? '';
  return typeof body === 'string' ? body : JSON.stringify(body ?? '');
}

function readMarkdownValue(body, label) {
  if (!body) {
    return null;
  }

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`^${escapedLabel}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() ?? null;
}

function normalizeRequiredString(value, fieldName) {
  const normalized = String(value ?? '').trim();

  if (!normalized) {
    const error = new Error(`${fieldName} is required.`);
    error.code = 'TASK_COMPLETION_READINESS_INPUT_INVALID';
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeSelect(value) {
  return String(value ?? '').trim().toUpperCase();
}
