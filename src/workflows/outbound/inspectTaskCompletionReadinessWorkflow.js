import { createCrmAdapter } from '../../integrations/crm/crmAdapter.js';
import { createTwentyMetadataClient, findField } from '../../integrations/twenty/metadataClient.js';
import { createTwentyQueueDataSource } from '../../integrations/twenty/queueDataSource.js';
import {
  buildQueue,
  getStalePriorStageTasks
} from '../../services/queueService.js';
import {
  getSupportedCadenceTransitions,
  planCadenceTransition
} from '../../utils/cadenceTransitionEngine.js';

export async function inspectTaskCompletionReadinessWorkflow({
  input = {},
  config = {},
  log,
  crmAdapter,
  dataSource,
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
  const queueInspection = await inspectQueueSelection({
    personId,
    taskId,
    person,
    task,
    dataSource,
    config,
    log,
    now,
    warnings
  });
  const taskStatusMetadata = await inspectTaskStatusMetadata({ config, log, warnings });

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
          assignee: task.assignee ?? task.owner ?? null,
          taskTargets: queueInspection.taskTargets,
          cadenceStageFromBody: readMarkdownValue(getTaskBody(task), 'Cadence stage') ?? null,
          nextCadenceStageFromBody: readMarkdownValue(getTaskBody(task), 'Next cadence stage') ?? null,
          taskTypeFromBody: readMarkdownValue(getTaskBody(task), 'Task type') ?? null,
          consideredCurrentOpenActionable: queueInspection.currentQueueTaskId === taskId,
          excludedAsStalePriorStage: queueInspection.stalePriorStageTaskIds.includes(taskId)
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
    expectedNextTask: transition?.nextTask ?? null,
    taskStatusMetadata,
    queueInspection,
    supportedTransitions: getSupportedCadenceTransitions()[cadenceName] ?? null,
    blockers,
    warnings,
    recommendedAction:
      blockers.length > 0
        ? 'Review cadence context before completing this task.'
        : 'Task completion can proceed; review the transition preview first.'
  };
}

async function inspectQueueSelection({
  personId,
  taskId,
  person,
  task,
  dataSource,
  config,
  log,
  now,
  warnings
}) {
  try {
    const source =
      dataSource ??
      createTwentyQueueDataSource({
        config: config.twenty ?? config,
        queueRead: {
          ...(config.queueRead ?? {}),
          cacheEnabled: false
        },
        log
      });
    const records =
      typeof source.listAllQueueRecords === 'function'
        ? await source.listAllQueueRecords({
            pageSize: 100,
            maxPages: config.legacyRetrofit?.maxPages ?? 10,
            query: {
              bypassCache: true
            },
            observabilityContext: {
              endpoint: 'script:tasks:inspect-completion-readiness',
              workflow: 'tasks:inspect-completion-readiness',
              requestSource: 'cli'
            }
          })
        : null;

    if (!records) {
      return emptyQueueInspection('Queue source does not support full read diagnostics.');
    }

    const relatedTaskTargets = (records.taskTargets ?? []).filter((target) =>
      String(target.taskId ?? target.task?.id ?? '') === taskId ||
      String(target.targetPersonId ?? target.personId ?? target.person?.id ?? '') === personId
    );
    const relatedTasks = (records.tasks ?? []).filter((candidate) =>
      isTaskRelatedToPersonOrTask({ task: candidate, personId, taskId, taskTargets: relatedTaskTargets })
    );
    const focusedPerson = (records.people ?? []).find((candidate) => String(candidate.id) === personId) ?? person;
    const focusedRecords = {
      people: focusedPerson ? [focusedPerson] : [],
      companies: records.companies ?? [],
      tasks: relatedTasks.length > 0 ? relatedTasks : task ? [task] : [],
      taskTargets: relatedTaskTargets,
      workspaceMembers: records.workspaceMembers ?? []
    };
    const followUps = buildQueue({
      queueSlug: 'follow-ups',
      ...focusedRecords,
      workspaceUser: { role: 'admin', email: null },
      query: {
        ownerScope: 'all',
        includeDiagnostics: true,
        includeTestRecords: true,
        dueBefore: '2099-12-31',
        limit: 100
      },
      now
    });
    const pipelineReview = buildQueue({
      queueSlug: 'pipeline-review',
      ...focusedRecords,
      workspaceUser: { role: 'admin', email: null },
      query: {
        ownerScope: 'all',
        includeDiagnostics: true,
        includeTestRecords: true,
        limit: 100
      },
      now
    });
    const normalizedPerson = followUps.items[0] ?? pipelineReview.items[0] ?? null;
    const stalePriorStageTaskIds = normalizedPerson
      ? getStalePriorStageTasks(
          {
            personId,
            cadenceName: focusedPerson?.cadenceName,
            cadenceStage: focusedPerson?.cadenceStage,
            nextOutboundTouchDate: focusedPerson?.nextOutboundTouchDate,
            latestTouchStatus: focusedPerson?.latestTouchStatus
          },
          relatedTasks.map((relatedTask) => ({
            taskId: String(relatedTask.id),
            title: relatedTask.title,
            status: relatedTask.status,
            dueDate: toDateOnlyString(relatedTask.dueAt ?? relatedTask.dueDate),
            cadenceName: readMarkdownValue(getTaskBody(relatedTask), 'Cadence'),
            cadenceStage:
              readMarkdownValue(getTaskBody(relatedTask), 'Next cadence stage') ??
              readMarkdownValue(getTaskBody(relatedTask), 'Cadence stage') ??
              readMarkdownValue(getTaskBody(relatedTask), 'Previous cadence stage'),
            taskType: readMarkdownValue(getTaskBody(relatedTask), 'Task type')
          }))
        ).map((staleTask) => staleTask.taskId)
      : [];
    const selectedFollowUp = followUps.items.find((item) => item.personId === personId) ?? null;
    const selectedPipeline = pipelineReview.items.find((item) => item.personId === personId) ?? null;
    const currentQueueItem = selectedFollowUp ?? selectedPipeline;

    return {
      source: 'twenty_queue_read',
      currentQueue: selectedFollowUp ? 'follow-ups' : selectedPipeline ? 'pipeline-review' : null,
      currentQueueTaskId: currentQueueItem?.taskId ?? null,
      currentQueueTaskTitle: currentQueueItem?.taskTitle ?? null,
      currentQueueTaskDueDate: currentQueueItem?.taskDueDate ?? null,
      currentQueueClassification: currentQueueItem?.queueClassification ?? null,
      currentQueueClassificationReasons: currentQueueItem?.queueClassificationReasons ?? [],
      inspectedTaskIds: relatedTasks.map((relatedTask) => String(relatedTask.id)),
      relatedTasks: relatedTasks.map((relatedTask) => ({
        taskId: String(relatedTask.id),
        title: relatedTask.title ?? relatedTask.name ?? null,
        status: relatedTask.status ?? null,
        dueAt: relatedTask.dueAt ?? relatedTask.dueDate ?? null,
        cadenceStage:
          readMarkdownValue(getTaskBody(relatedTask), 'Next cadence stage') ??
          readMarkdownValue(getTaskBody(relatedTask), 'Cadence stage') ??
          readMarkdownValue(getTaskBody(relatedTask), 'Previous cadence stage'),
        taskType: readMarkdownValue(getTaskBody(relatedTask), 'Task type')
      })),
      newerOpenTaskExists: relatedTasks.some(
        (relatedTask) =>
          String(relatedTask.id) !== taskId &&
          isOpenStatus(relatedTask.status) &&
          compareNullableDates(relatedTask.dueAt ?? relatedTask.dueDate, task?.dueAt ?? task?.dueDate) > 0
      ),
      stalePriorStageTaskIds,
      taskTargets: relatedTaskTargets,
      explanation:
        currentQueueItem?.taskId === taskId
          ? 'The inspected task is currently selected by queue classification.'
          : currentQueueItem?.taskId
            ? 'A different task is selected as the current queue task for this Person.'
            : 'No current actionable queue task was selected for this Person.'
    };
  } catch (error) {
    warnings.push(`Queue selection diagnostics skipped: ${error.message}`);
    return emptyQueueInspection(error.message);
  }
}

async function inspectTaskStatusMetadata({ config = {}, log, warnings }) {
  const twentyConfig = config.twenty ?? config;

  if (!twentyConfig.apiKey) {
    return {
      statusField: null,
      warning: 'Twenty API key is not configured; Task status metadata was not fetched.'
    };
  }

  try {
    const metadataClient = createTwentyMetadataClient(twentyConfig, log);
    const taskMetadata = await metadataClient.fetchObjectMetadata('task');
    const statusField = findField(taskMetadata, 'status');

    return {
      statusField: statusField
        ? {
            name: statusField.name,
            label: statusField.label,
            type: statusField.type,
            options: statusField.options ?? statusField.settings?.options ?? []
          }
        : null
    };
  } catch (error) {
    warnings.push(`Task metadata discovery skipped: ${error.message}`);
    return {
      statusField: null,
      warning: error.message
    };
  }
}

function emptyQueueInspection(reason) {
  return {
    source: 'unavailable',
    currentQueue: null,
    currentQueueTaskId: null,
    currentQueueTaskTitle: null,
    currentQueueTaskDueDate: null,
    currentQueueClassification: null,
    currentQueueClassificationReasons: [],
    inspectedTaskIds: [],
    newerOpenTaskExists: false,
    stalePriorStageTaskIds: [],
    taskTargets: [],
    explanation: reason
  };
}

function isTaskRelatedToPersonOrTask({ task = {}, personId, taskId, taskTargets = [] }) {
  const id = String(task.id ?? '');
  const body = getTaskBody(task);

  return (
    id === taskId ||
    body.includes(`Person ID: ${personId}`) ||
    taskTargets.some((target) => String(target.taskId ?? target.task?.id ?? '') === id)
  );
}

function isOpenStatus(value) {
  return ['TODO', 'OPEN', 'IN_PROGRESS', 'NOT_STARTED'].includes(normalizeSelect(value));
}

function compareNullableDates(left, right) {
  const leftDate = left ? new Date(left) : null;
  const rightDate = right ? new Date(right) : null;

  if (!leftDate || Number.isNaN(leftDate.getTime())) {
    return -1;
  }

  if (!rightDate || Number.isNaN(rightDate.getTime())) {
    return 1;
  }

  return leftDate.getTime() - rightDate.getTime();
}

function toDateOnlyString(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
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
