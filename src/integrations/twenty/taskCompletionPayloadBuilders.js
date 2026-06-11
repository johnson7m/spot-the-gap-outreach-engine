export function createPersonCadenceUpdatePayload({ transition }) {
  const payload = {
    cadenceName: transition.cadenceName,
    cadenceStage: transition.newCadenceStage,
    latestTouchChannel: transition.channel,
    latestTouchStatus: transition.touchStatus,
    lastOutboundTouchDate: transition.lastOutboundTouchDate
  };

  if (transition.nextOutboundTouchDate) {
    payload.nextOutboundTouchDate = transition.nextOutboundTouchDate;
  }

  return payload;
}

export function createCompletedTaskUpdatePayload({ transition }) {
  return {
    status: 'DONE'
  };
}

export function createNextCadenceTaskPayload({
  person,
  personId,
  taskId,
  transition,
  completion,
  dedupeKey
}) {
  if (!transition.nextTask) {
    return null;
  }

  return {
    title: transition.nextTask.title,
    status: 'TODO',
    dueAt: transition.nextTask.dueAt,
    bodyV2: {
      markdown: buildNextTaskMarkdown({
        person,
        personId,
        taskId,
        transition,
        completion,
        dedupeKey
      })
    }
  };
}

export function buildNextTaskDedupeKey({ personId, cadenceName, nextCadenceStage, taskType }) {
  return [
    'outbound-cadence',
    `person:${personId}`,
    `cadence:${cadenceName}`,
    `stage:${nextCadenceStage}`,
    `task:${taskType}`
  ].join(':');
}

export function createTaskCompletedOutboundEvent({
  personId,
  taskId,
  transition,
  completion,
  workspaceUser,
  correlationId
}) {
  return {
    assessmentSubmissionId: null,
    correlationId,
    eventType: 'task_completed',
    channel: transition.channel.toLowerCase(),
    status: toOutboundEventStatus(transition.touchStatus),
    actorType: 'human',
    requiresApproval: false,
    payload: {
      workspaceUser: sanitizeWorkspaceUser(workspaceUser),
      personId,
      taskId,
      cadenceName: transition.cadenceName,
      oldCadenceStage: transition.oldCadenceStage,
      newCadenceStage: transition.newCadenceStage,
      channel: transition.channel,
      touchStatus: transition.touchStatus,
      messageBody: completion.messageBody || null,
      notes: completion.notes || null,
      completedAt: transition.completedAt
    },
    scheduledFor: null
  };
}

export function createNextTaskCreatedOutboundEvent({
  personId,
  taskId,
  nextTaskOperation,
  transition,
  workspaceUser,
  correlationId
}) {
  if (!transition.nextTask || !nextTaskOperation) {
    return null;
  }

  return {
    assessmentSubmissionId: null,
    correlationId,
    eventType: 'next_task_created',
    channel: 'task',
    status: 'planned',
    actorType: 'human',
    requiresApproval: false,
    payload: {
      workspaceUser: sanitizeWorkspaceUser(workspaceUser),
      personId,
      completedTaskId: taskId,
      cadenceName: transition.cadenceName,
      oldCadenceStage: transition.oldCadenceStage,
      newCadenceStage: transition.newCadenceStage,
      nextTask: transition.nextTask,
      nextTaskDedupeKey: nextTaskOperation.dedupeKey
    },
    scheduledFor: transition.nextTask.dueAt
  };
}

function buildNextTaskMarkdown({
  person,
  personId,
  taskId,
  transition,
  completion,
  dedupeKey
}) {
  return [
    `Source: Outbound cadence task completion`,
    `Person ID: ${personId}`,
    `Completed Task ID: ${taskId}`,
    `Dedupe key: ${dedupeKey}`,
    `Idempotency key: ${dedupeKey}`,
    `Cadence: ${transition.cadenceName}`,
    `Previous cadence stage: ${transition.oldCadenceStage}`,
    `Next cadence stage: ${transition.newCadenceStage}`,
    `Task type: ${transition.nextTask.taskType}`,
    `Channel: ${transition.channel}`,
    `Latest touch status: ${transition.touchStatus}`,
    '',
    `Person: ${getPersonName(person) || 'Unknown person'}`,
    `Company: ${getCompanyName(person) || 'Not provided'}`,
    '',
    completion.messageBody ? `Completed message:\n${completion.messageBody}` : 'Completed message: Not provided',
    '',
    completion.notes ? `Completion notes:\n${completion.notes}` : 'Completion notes: Not provided',
    '',
    'Relationship writes are intentionally disabled. Use the Person ID above to verify context.',
    'Manual action required. Do not automate LinkedIn requests or messages.'
  ].join('\n');
}

function getPersonName(person = {}) {
  return (
    person.name?.fullName ??
    [person.name?.firstName ?? person.nameFirstName, person.name?.lastName ?? person.nameLastName]
      .filter(Boolean)
      .join(' ')
  );
}

function getCompanyName(person = {}) {
  return person.company?.name ?? person.companyName ?? person.company?.displayName ?? '';
}

function toOutboundEventStatus(touchStatus) {
  if (['SENT', 'RESPONDED', 'COMPLETED'].includes(touchStatus)) {
    return 'sent';
  }

  if (['BOUNCED', 'DECLINED'].includes(touchStatus)) {
    return 'failed';
  }

  return 'planned';
}

function sanitizeWorkspaceUser(workspaceUser) {
  if (!workspaceUser) {
    return null;
  }

  return {
    authenticated: Boolean(workspaceUser.authenticated),
    userId: workspaceUser.userId ?? null,
    email: workspaceUser.email ?? null,
    fullName: workspaceUser.fullName ?? null,
    role: workspaceUser.role ?? null,
    roleSource: workspaceUser.roleSource ?? null,
    profileId: workspaceUser.profileId ?? null
  };
}
