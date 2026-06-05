const QUEUE_DEFINITIONS = {
  'fresh-leads': {
    slug: 'fresh-leads',
    name: 'Fresh Lead Queue'
  },
  'follow-ups': {
    slug: 'follow-ups',
    name: 'Follow-Up Queue'
  },
  'warm-assessments': {
    slug: 'warm-assessments',
    name: 'Warm Assessment Queue'
  },
  'stale-recovery': {
    slug: 'stale-recovery',
    name: 'Stale Recovery Queue'
  },
  'pipeline-review': {
    slug: 'pipeline-review',
    name: 'Pipeline Review Queue'
  }
};

const OPEN_TASK_STATUSES = new Set(['TODO', 'OPEN', 'IN_PROGRESS', 'NOT_STARTED']);
const TERMINAL_CADENCE_STAGES = new Set([
  'PAUSED',
  'COMPLETED',
  'COMPLETE',
  'DISQUALIFIED',
  'DISQUALIFIED_NURTURE',
  'DONE'
]);
const WARM_DISCOVERY_STATUSES = new Set(['READY', 'REQUESTED', 'BOOKED']);
const REVIEW_ENRICHMENT_STATUSES = new Set(['NEEDS_REVIEW', 'PARTIAL']);
const FRESH_CADENCE_STAGES = new Set(['CONNECTION_REQUEST', 'NOT_STARTED']);
const STALE_RISK_VALUES = new Set(['STALE', 'HIGH']);
const UNASSIGNED_TASK_ACTIONS = [
  'associate_person',
  'associate_company',
  'accept_and_link',
  'dismiss_from_my_view'
];

export function getQueueDefinition(queueSlug) {
  return QUEUE_DEFINITIONS[queueSlug] ?? null;
}

export function buildQueue({
  queueSlug,
  people = [],
  tasks = [],
  taskTargets = [],
  workspaceMembers = [],
  workspaceUser = {},
  query = {},
  now = new Date()
} = {}) {
  const definition = getQueueDefinition(queueSlug);

  if (!definition) {
    const error = new Error(`Unsupported queue "${queueSlug}".`);
    error.code = 'QUEUE_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  const normalizedQuery = normalizeQueueQuery(query, workspaceUser);
  const workspaceMembersById = createWorkspaceMemberIndex(workspaceMembers);
  const taskTargetsByTaskId = groupTaskTargetsByTaskId(taskTargets);
  const normalizedTasks = tasks.map((task) =>
    normalizeTaskRecord({
      task,
      taskTargets: taskTargetsByTaskId.get(String(task.id ?? '')) ?? [],
      people,
      workspaceMembersById
    })
  );
  const tasksByPersonId = groupTasksByPersonId(normalizedTasks);
  const normalizedPeople = people.map((person) =>
    normalizePersonRecord({
      person,
      tasks: tasksByPersonId.get(String(person.id ?? '')) ?? [],
      workspaceMembersById
    })
  );
  const warnings = [];
  const candidates = selectQueueCandidates({
    queueSlug,
    people: normalizedPeople,
    tasks: normalizedTasks,
    tasksByPersonId,
    query: normalizedQuery,
    now
  });
  const scopedItems = applyRoleScope({
    items: candidates,
    workspaceUser,
    query: normalizedQuery,
    warnings
  });
  const pagedItems = scopedItems.slice(
    normalizedQuery.offset,
    normalizedQuery.offset + normalizedQuery.limit
  );

  return {
    queueName: definition.name,
    queueSlug: definition.slug,
    items: pagedItems,
    count: scopedItems.length,
    limit: normalizedQuery.limit,
    offset: normalizedQuery.offset,
    ownerScope: normalizedQuery.ownerScope,
    warnings: uniqueStrings(warnings)
  };
}

export function normalizeQueueQuery(query = {}, workspaceUser = {}) {
  const role = workspaceUser?.role ?? 'rep';
  const requestedLimit = Number(query.limit);
  const requestedOffset = Number(query.offset ?? query.cursor);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 50;
  const offset = Number.isFinite(requestedOffset) ? Math.max(Math.trunc(requestedOffset), 0) : 0;
  const dueBefore = normalizeDateInput(query.dueBefore) ?? new Date();
  const includeOverdue =
    query.includeOverdue === undefined ? true : normalizeBoolean(query.includeOverdue);
  const requestedOwnerScope = normalizeSelect(query.requestedOwnerScope ?? query.ownerScope);
  const ownerScope =
    role === 'rep'
      ? 'mine'
      : requestedOwnerScope === 'MINE'
        ? 'mine'
        : 'all';

  return {
    limit,
    offset,
    dueBefore,
    includeOverdue,
    ownerScope,
    requestedOwnerScope: requestedOwnerScope ? requestedOwnerScope.toLowerCase() : null
  };
}

function selectQueueCandidates({ queueSlug, people, tasks, tasksByPersonId, query, now }) {
  switch (queueSlug) {
    case 'fresh-leads':
      return people
        .filter((person) => isFreshLead(person))
        .map((person) => toQueueItem({
          person,
          task: firstOpenTask(tasksByPersonId.get(person.personId)),
          source: 'twenty:person',
          itemWarnings: buildFreshLeadWarnings(person, tasksByPersonId.get(person.personId))
        }));

    case 'follow-ups':
      return tasks
        .filter((task) => isDueOpenTask(task, query))
        .map((task) => {
          const person = people.find((candidate) => candidate.personId === task.personId);
          return toQueueItem({
            person: person ?? createUnknownPersonFromTask(task),
            task,
            source: task.personId ? 'twenty:task' : 'twenty:task-unlinked',
            itemWarnings: buildTaskAssociationWarnings(task, person)
          });
        })
        .filter((item) => item.cadenceName && !isTerminalCadenceStage(item.cadenceStage));

    case 'warm-assessments':
      return people
        .filter((person) => isWarmAssessment(person))
        .map((person) => toQueueItem({
          person,
          task: firstOpenTask(tasksByPersonId.get(person.personId)),
          source: 'twenty:person',
          itemWarnings: []
        }));

    case 'stale-recovery':
      return people
        .filter((person) => isStaleRecovery(person, now))
        .map((person) => toQueueItem({
          person,
          task: firstOpenTask(tasksByPersonId.get(person.personId)),
          source: 'twenty:person',
          itemWarnings: buildStaleWarnings(person)
        }));

    case 'pipeline-review':
      return people
        .map((person) => {
          const openTask = firstOpenTask(tasksByPersonId.get(person.personId));
          const reviewWarnings = getPipelineReviewWarnings(person, openTask);

          return {
            person,
            openTask,
            reviewWarnings
          };
        })
        .filter(({ reviewWarnings }) => reviewWarnings.length > 0)
        .map(({ person, openTask, reviewWarnings }) => toQueueItem({
          person,
          task: openTask,
          source: 'twenty:person',
          itemWarnings: reviewWarnings
        }));

    default:
      return [];
  }
}

function normalizePersonRecord({ person = {}, tasks = [], workspaceMembersById = new Map() } = {}) {
  const owner = normalizeOwner(person, 'person', workspaceMembersById);
  const openTasks = tasks.filter(isOpenTask);

  return {
    raw: person,
    personId: stringify(person.id),
    name: getPersonName(person),
    title: firstString(person.jobTitle, person.title),
    companyName: getCompanyName(person),
    linkedinUrl: getLinkUrl(person.linkedinLink, person.linkedinLinkPrimaryLinkUrl, person.linkedinUrl),
    email: getEmail(person),
    outboundPipelineType: normalizeSelect(person.outboundPipelineType),
    cadenceName: normalizeSelect(person.cadenceName),
    cadenceStage: normalizeSelect(person.cadenceStage),
    leadHealthScore: normalizeNumber(person.leadHealthScore),
    icpFitScore: normalizeNumber(person.icpFitScore),
    nextOutboundTouchDate: normalizeDateString(person.nextOutboundTouchDate),
    latestTouchChannel: normalizeSelect(person.latestTouchChannel),
    latestTouchStatus: normalizeSelect(person.latestTouchStatus),
    outreachAngle: firstString(person.outreachAngle),
    assessmentCompleted: Boolean(person.assessmentCompleted),
    leadstageAuto: normalizeSelect(person.leadstageAuto),
    discoveryReadiness: normalizeSelect(person.discoveryReadiness),
    enrichmentStatus: normalizeSelect(person.enrichmentStatus),
    staleRisk: normalizeSelect(person.staleRisk),
    leadSource: normalizeSelect(person.leadSource),
    source: normalizeSelect(person.leadSource) || 'TWENTY_PERSON',
    owner,
    openTaskCount: openTasks.length,
    taskWarnings: tasks.flatMap((task) => task.warnings ?? [])
  };
}

function normalizeTaskRecord({
  task = {},
  taskTargets = [],
  people = [],
  workspaceMembersById = new Map()
} = {}) {
  const body = getTaskBody(task);
  const personLink = resolveTaskPersonLink({
    task,
    body,
    taskTargets,
    people,
    workspaceMembersById
  });
  const assignee = normalizeOwner(task, 'task', workspaceMembersById);

  return {
    raw: task,
    taskId: stringify(task.id),
    personId: personLink.personId,
    currentTargetPersonId: personLink.currentTargetPersonId,
    currentTargetCompanyId: personLink.currentTargetCompanyId,
    personLinkSource: personLink.source,
    personResolutionPath: personLink.path,
    personResolutionConfidence: personLink.confidence,
    personResolutionEvidence: personLink.evidence,
    title: firstString(task.title, task.name, task.subject),
    dueDate: normalizeDateString(task.dueAt ?? task.dueDate ?? task.due_date),
    status: normalizeSelect(task.status),
    body,
    cadenceName: normalizeSelect(readMarkdownValue(body, 'Cadence')),
    cadenceStage: normalizeSelect(
      readMarkdownValue(body, 'Next cadence stage') ??
        readMarkdownValue(body, 'Cadence stage') ??
        readMarkdownValue(body, 'Previous cadence stage')
    ),
    latestTouchChannel: normalizeSelect(readMarkdownValue(body, 'Channel')),
    latestTouchStatus: normalizeSelect(readMarkdownValue(body, 'Latest touch status')),
    assignee,
    targetCompanyId: personLink.companyId,
    warnings: buildTaskLinkWarnings(personLink)
  };
}

function toQueueItem({ person, task, source, itemWarnings = [] }) {
  const owner = mergeOwnerContexts(person?.owner, task?.assignee);

  return {
    personId: person?.personId ?? task?.personId ?? null,
    taskId: task?.taskId ?? null,
    personName: person?.name ?? null,
    title: person?.title ?? null,
    companyName: person?.companyName ?? null,
    linkedinUrl: person?.linkedinUrl ?? null,
    email: person?.email ?? null,
    outboundPipelineType: person?.outboundPipelineType ?? null,
    cadenceName: person?.cadenceName ?? task?.cadenceName ?? null,
    cadenceStage: person?.cadenceStage ?? task?.cadenceStage ?? null,
    leadHealthScore: person?.leadHealthScore ?? null,
    icpFitScore: person?.icpFitScore ?? null,
    nextOutboundTouchDate: person?.nextOutboundTouchDate ?? null,
    latestTouchChannel: person?.latestTouchChannel ?? task?.latestTouchChannel ?? null,
    latestTouchStatus: person?.latestTouchStatus ?? task?.latestTouchStatus ?? null,
    outreachAngle: person?.outreachAngle ?? null,
    taskTitle: task?.title ?? null,
    taskDueDate: task?.dueDate ?? null,
    taskStatus: task?.status ?? null,
    owner,
    assignedRep: owner?.email ?? owner?.name ?? null,
    assignedRepDetails: owner?.taskAssignee ?? task?.assignee ?? null,
    source,
    personLinkSource: task?.personLinkSource ?? null,
    personResolutionPath: task?.personResolutionPath ?? [],
    personResolutionConfidence: task?.personResolutionConfidence ?? null,
    personResolutionEvidence: task?.personResolutionEvidence ?? [],
    targetCompanyId: task?.targetCompanyId ?? null,
    queueBucket: task && !task.personId ? 'unassigned_tasks' : null,
    suggestedResolutionActions: task && !task.personId ? UNASSIGNED_TASK_ACTIONS : [],
    warnings: uniqueStrings([
      ...(person?.taskWarnings ?? []),
      ...(task?.warnings ?? []),
      ...itemWarnings
    ])
  };
}

function applyRoleScope({ items, workspaceUser = {}, query, warnings }) {
  const role = workspaceUser.role ?? 'rep';
  const email = normalizeEmail(workspaceUser.email);

  if (role !== 'rep' && query.ownerScope !== 'mine') {
    return items;
  }

  if (role === 'rep' && query.requestedOwnerScope === 'all') {
    warnings.push('Rep requests for ownerScope=all are treated as ownerScope=mine.');
  }

  if (!email) {
    warnings.push('Workspace user email is unavailable; owner filtering could not be enforced.');
    return items;
  }

  return items.filter((item) => {
    const ownerEmails = getOwnerEmails(item.owner);

    if (ownerEmails.length === 0) {
      item.warnings = uniqueStrings([
        ...(item.warnings ?? []),
        'Ownership unavailable; rep scope could not be confidently enforced for this item.'
      ]);
      warnings.push('Some queue items do not expose owner or assignee email data from Twenty.');
      return true;
    }

    return ownerEmails.includes(email);
  });
}

function isFreshLead(person) {
  return (
    Boolean(person.outboundPipelineType) &&
    FRESH_CADENCE_STAGES.has(person.cadenceStage) &&
    person.latestTouchStatus === 'DRAFTED'
  );
}

function isWarmAssessment(person) {
  return (
    person.assessmentCompleted === true ||
    person.leadstageAuto === 'ASSESSMENT_COMPLETED' ||
    WARM_DISCOVERY_STATUSES.has(person.discoveryReadiness)
  );
}

function isStaleRecovery(person, now) {
  if (STALE_RISK_VALUES.has(person.staleRisk)) {
    return true;
  }

  const nextTouchDate = normalizeDateInput(person.nextOutboundTouchDate);

  if (nextTouchDate && isBeforeStartOfDay(nextTouchDate, now)) {
    return true;
  }

  return person.latestTouchStatus === 'NO_RESPONSE' && Boolean(person.cadenceStage);
}

function getPipelineReviewWarnings(person, openTask) {
  const warnings = [];

  for (const [fieldName, value] of [
    ['email', person.email],
    ['LinkedIn URL', person.linkedinUrl],
    ['company', person.companyName],
    ['cadence name', person.cadenceName],
    ['cadence stage', person.cadenceStage]
  ]) {
    if (!value) {
      warnings.push(`Missing ${fieldName}.`);
    }
  }

  if (REVIEW_ENRICHMENT_STATUSES.has(person.enrichmentStatus)) {
    warnings.push(`Enrichment status requires review: ${person.enrichmentStatus}.`);
  }

  if (person.raw?.duplicateWarning || person.raw?.duplicateWarnings?.length) {
    warnings.push('Duplicate warning present; merge review may be needed.');
  }

  if (person.cadenceName && !isTerminalCadenceStage(person.cadenceStage) && !openTask) {
    warnings.push('No open next task found despite non-terminal cadence.');
  }

  return warnings;
}

function isDueOpenTask(task, query) {
  if (!isOpenTask(task)) {
    return false;
  }

  const dueDate = normalizeDateInput(task.dueDate);

  if (!dueDate) {
    return false;
  }

  if (query.includeOverdue) {
    return dueDate.getTime() <= endOfDay(query.dueBefore).getTime();
  }

  return toDateOnly(dueDate) === toDateOnly(query.dueBefore);
}

function firstOpenTask(tasks = []) {
  return (tasks ?? []).filter(isOpenTask).sort(compareTasksByDueDate)[0] ?? null;
}

function isOpenTask(task) {
  return OPEN_TASK_STATUSES.has(normalizeSelect(task?.status));
}

function isTerminalCadenceStage(cadenceStage) {
  return TERMINAL_CADENCE_STAGES.has(normalizeSelect(cadenceStage));
}

function groupTasksByPersonId(tasks) {
  const map = new Map();

  for (const task of tasks) {
    if (!task.personId) {
      continue;
    }

    const key = String(task.personId);
    const existing = map.get(key) ?? [];
    existing.push(task);
    map.set(key, existing);
  }

  return map;
}

function groupTaskTargetsByTaskId(taskTargets = []) {
  const map = new Map();

  for (const taskTarget of taskTargets ?? []) {
    if (!taskTarget?.taskId) {
      continue;
    }

    const key = String(taskTarget.taskId);
    const existing = map.get(key) ?? [];
    existing.push(taskTarget);
    map.set(key, existing);
  }

  return map;
}

export function createWorkspaceMemberIndex(workspaceMembers = []) {
  return new Map(
    (workspaceMembers ?? [])
      .filter((member) => member?.id)
      .map((member) => [
        String(member.id),
        {
          id: String(member.id),
          email: normalizeEmail(member.userEmail ?? member.email ?? member.user?.email),
          name: getWorkspaceMemberName(member),
          userId: stringify(member.userId)
        }
      ])
  );
}

function buildFreshLeadWarnings(person, tasks) {
  if (firstOpenTask(tasks)) {
    return [];
  }

  return ['No open task found for this fresh lead; task relationship may be unavailable.'];
}

function buildTaskAssociationWarnings(task, person) {
  const warnings = [];

  if (!task.personId) {
    warnings.push('Task does not expose a Person ID or parsable Person ID marker.');
  }

  if (task.personLinkSource === 'task_body_marker') {
    warnings.push(
      'Task relationship fallback used: Person ID was parsed from task body while relationship writes remain disabled.'
    );
  }

  if (!person && task.personId) {
    warnings.push('Task references a Person ID that was not present in the fetched People page.');
  }

  return warnings;
}

function buildStaleWarnings(person) {
  const warnings = [];

  if (STALE_RISK_VALUES.has(person.staleRisk)) {
    warnings.push(`Stale risk is ${person.staleRisk}.`);
  }

  if (person.latestTouchStatus === 'NO_RESPONSE') {
    warnings.push('Latest touch status is NO_RESPONSE.');
  }

  if (person.nextOutboundTouchDate) {
    warnings.push(`Next outbound touch date is ${person.nextOutboundTouchDate}.`);
  }

  return warnings;
}

function createUnknownPersonFromTask(task) {
  return {
    personId: task.personId ?? null,
    name: null,
    title: null,
    companyName: null,
    linkedinUrl: null,
    email: null,
    outboundPipelineType: null,
    cadenceName: task.cadenceName,
    cadenceStage: task.cadenceStage,
    leadHealthScore: null,
    icpFitScore: null,
    nextOutboundTouchDate: null,
    latestTouchChannel: task.latestTouchChannel,
    latestTouchStatus: task.latestTouchStatus,
    outreachAngle: null,
    source: 'TWENTY_TASK',
    owner: null,
    taskWarnings: []
  };
}

export function resolveTaskPersonLink({
  task = {},
  body = '',
  taskTargets = [],
  people = [],
  workspaceMembersById = new Map()
} = {}) {
  const embeddedTaskTargets = Array.isArray(task.taskTargets) ? task.taskTargets : [];
  const text = normalizeSearchText(`${firstString(task.title, task.name, task.subject)} ${body}`);
  const targetPersonId = firstString(
    ...taskTargets.map((target) => getTaskTargetPersonId(target))
  );
  const targetCompanyId = firstString(
    ...taskTargets.map((target) => getTaskTargetCompanyId(target))
  );
  const embeddedTargetPersonId = firstString(
    ...embeddedTaskTargets.map((target) => getTaskTargetPersonId(target))
  );
  const embeddedTargetCompanyId = firstString(
    ...embeddedTaskTargets.map((target) => getTaskTargetCompanyId(target))
  );

  if (targetPersonId) {
    return {
      personId: targetPersonId,
      companyId: targetCompanyId || null,
      currentTargetPersonId: targetPersonId,
      currentTargetCompanyId: targetCompanyId || null,
      source: 'task_target',
      path: ['taskTarget.targetPersonId'],
      confidence: 'high',
      evidence: [`taskTarget.targetPersonId=${targetPersonId}`],
      warnings: []
    };
  }

  if (embeddedTargetPersonId) {
    return {
      personId: embeddedTargetPersonId,
      companyId: embeddedTargetCompanyId || targetCompanyId || null,
      currentTargetPersonId: embeddedTargetPersonId,
      currentTargetCompanyId: embeddedTargetCompanyId || targetCompanyId || null,
      source: 'task_expanded_relation',
      path: ['task.taskTargets expanded relation'],
      confidence: 'high',
      evidence: [`task.taskTargets target person=${embeddedTargetPersonId}`],
      warnings: []
    };
  }

  const explicitId = firstString(
    task.personId,
    task.person?.id,
    task.people?.[0]?.id,
    task.targetPersonId
  );

  if (explicitId) {
    return {
      personId: explicitId,
      companyId: targetCompanyId || embeddedTargetCompanyId || null,
      currentTargetPersonId: null,
      currentTargetCompanyId: targetCompanyId || embeddedTargetCompanyId || null,
      source: 'task_field',
      path: ['task.personId'],
      confidence: 'high',
      evidence: [`task person field=${explicitId}`],
      warnings: []
    };
  }

  const bodyPersonId = body?.match(/(?:Person ID|personId):\s*([a-zA-Z0-9-]+)/i)?.[1];

  if (bodyPersonId) {
    return {
      personId: bodyPersonId,
      companyId: targetCompanyId || embeddedTargetCompanyId || null,
      currentTargetPersonId: null,
      currentTargetCompanyId: targetCompanyId || embeddedTargetCompanyId || null,
      source: 'task_body_marker',
      path: ['task body Person ID marker'],
      confidence: 'medium',
      evidence: [`body Person ID marker=${bodyPersonId}`],
      warnings: [
        'Task relationship fallback used: Person ID was parsed from task body because no taskTarget Person link was found.'
      ]
    };
  }

  const personNameMatch = findUniquePersonMatchByName(people, text);

  if (personNameMatch) {
    return {
      personId: String(personNameMatch.id),
      companyId: getCompanyId(personNameMatch) || targetCompanyId || embeddedTargetCompanyId || null,
      currentTargetPersonId: null,
      currentTargetCompanyId: targetCompanyId || embeddedTargetCompanyId || null,
      source: 'task_person_name_match',
      path: ['task title/body person-name matching'],
      confidence: 'medium',
      evidence: [`Task text matched Person name: ${getPersonName(personNameMatch)}`],
      warnings: [
        'Task relationship inference used Person name matching; review before writing taskTarget relationships.'
      ]
    };
  }

  const companyMatch = findUniquePersonMatchByCompany(
    people,
    text,
    targetCompanyId || embeddedTargetCompanyId
  );

  if (companyMatch) {
    return {
      personId: String(companyMatch.id),
      companyId: getCompanyId(companyMatch) || targetCompanyId || embeddedTargetCompanyId || null,
      currentTargetPersonId: null,
      currentTargetCompanyId: targetCompanyId || embeddedTargetCompanyId || null,
      source: 'task_company_match',
      path: ['task title/body company matching'],
      confidence: 'low',
      evidence: [`Task text or target matched Company: ${getCompanyName(companyMatch)}`],
      warnings: [
        'Task relationship inference used Company matching only; manual review recommended before linking.'
      ]
    };
  }

  const ownerAssigneeMatch = findUniquePersonMatchByOwnerOrAssignee({
    task,
    people,
    workspaceMembersById
  });

  if (ownerAssigneeMatch) {
    return {
      personId: String(ownerAssigneeMatch.id),
      companyId: getCompanyId(ownerAssigneeMatch) || targetCompanyId || embeddedTargetCompanyId || null,
      currentTargetPersonId: null,
      currentTargetCompanyId: targetCompanyId || embeddedTargetCompanyId || null,
      source: 'task_owner_assignee_match',
      path: ['owner/assignee matching'],
      confidence: 'low',
      evidence: ['Task assignee/owner matched a unique Person owner.'],
      warnings: [
        'Task relationship inference used owner/assignee matching only; manual review recommended before linking.'
      ]
    };
  }

  return {
    personId: null,
    companyId: targetCompanyId || embeddedTargetCompanyId || null,
    currentTargetPersonId: null,
    currentTargetCompanyId: targetCompanyId || embeddedTargetCompanyId || null,
    source: null,
    path: ['fallback_unknown'],
    confidence: 'unknown',
    evidence: [],
    warnings: []
  };
}

function buildTaskLinkWarnings(personLink) {
  if (personLink.warnings?.length) {
    return personLink.warnings;
  }

  if (personLink.source === 'task_target') {
    return [];
  }

  if (personLink.companyId && !personLink.personId) {
    return ['Task target exposes Company but no Person; Person context is unavailable.'];
  }

  return [];
}

function getTaskTargetPersonId(target = {}) {
  return firstString(
    target.targetPersonId,
    target.personId,
    target.person?.id,
    target.targetPerson?.id,
    target.people?.[0]?.id,
    target.targetObjectNameSingular === 'person' ? target.targetObjectId : null
  );
}

function getTaskTargetCompanyId(target = {}) {
  return firstString(
    target.targetCompanyId,
    target.companyId,
    target.company?.id,
    target.targetCompany?.id,
    target.companies?.[0]?.id,
    target.targetObjectNameSingular === 'company' ? target.targetObjectId : null
  );
}

function findUniquePersonMatchByName(people = [], text = '') {
  if (!text) {
    return null;
  }

  const matches = people.filter((person) => {
    const name = normalizeSearchText(getPersonName(person));
    return name.length >= 5 && text.includes(name);
  });

  return matches.length === 1 ? matches[0] : null;
}

function findUniquePersonMatchByCompany(people = [], text = '', companyId) {
  if (companyId) {
    const matches = people.filter((person) => getCompanyId(person) === companyId);
    return matches.length === 1 ? matches[0] : null;
  }

  if (!text) {
    return null;
  }

  const matches = people.filter((person) => {
    const companyName = normalizeSearchText(getCompanyName(person));
    return companyName.length >= 4 && text.includes(companyName);
  });

  return matches.length === 1 ? matches[0] : null;
}

function findUniquePersonMatchByOwnerOrAssignee({ task = {}, people = [], workspaceMembersById } = {}) {
  const taskOwner = normalizeOwner(task, 'task', workspaceMembersById);

  if (!taskOwner?.id && !taskOwner?.email) {
    return null;
  }

  const matches = people.filter((person) => {
    const personOwner = normalizeOwner(person, 'person', workspaceMembersById);
    return (
      (taskOwner.id && taskOwner.id === personOwner?.id) ||
      (taskOwner.email && taskOwner.email === personOwner?.email)
    );
  });

  return matches.length === 1 ? matches[0] : null;
}

function getCompanyId(person = {}) {
  return stringify(person.companyId ?? person.company?.id ?? person.companyID);
}

function getPersonName(person) {
  return firstString(
    person.name?.fullName,
    [person.name?.firstName ?? person.nameFirstName, person.name?.lastName ?? person.nameLastName]
      .filter(Boolean)
      .join(' '),
    person.fullName,
    person.displayName
  );
}

function getCompanyName(person) {
  return firstString(
    person.company?.name,
    person.company?.displayName,
    person.companyName,
    person.companyNameName
  );
}

function getEmail(record) {
  return normalizeEmail(
    firstString(
      record.emails?.primaryEmail,
      record.emailsPrimaryEmail,
      record.email,
      record.primaryEmail
    )
  );
}

function getTaskBody(task) {
  const bodyV2 = task.bodyV2;

  if (typeof bodyV2 === 'string') {
    return bodyV2;
  }

  return firstString(
    bodyV2?.markdown,
    bodyV2?.blocknote,
    task.body,
    task.description,
    task.note
  );
}

function getLinkUrl(fieldValue, flattenedValue, fallbackValue) {
  return firstString(
    fieldValue?.primaryLinkUrl,
    fieldValue?.url,
    fieldValue,
    flattenedValue,
    fallbackValue
  );
}

export function normalizeOwner(record, recordType, workspaceMembersById = new Map()) {
  const candidates =
    recordType === 'task'
      ? [record.assignee, record.owner, record.workspaceMember]
      : [record.owner, record.accountOwner, record.assignee, record.workspaceMember];

  const source = candidates.find(Boolean) ?? {};
  const candidateId = firstString(
    source.id,
    source.workspaceMemberId,
    source.context?.workspaceMemberId,
    record.ownerId,
    record.assigneeId,
    record.accountOwnerId
  );
  const workspaceMember = candidateId ? workspaceMembersById.get(candidateId) : null;
  const email = normalizeEmail(
    firstString(
      source.userEmail,
      source.email,
      source.user?.email,
      source.primaryEmail,
      workspaceMember?.email,
      record.ownerEmail,
      record.assigneeEmail,
      record.accountOwnerEmail
    )
  );
  const name = firstString(
    getOwnerSourceName(source),
    source.fullName,
    source.displayName,
    workspaceMember?.name,
    record.ownerName
  );
  const id = candidateId;

  if (!email && !name && !id) {
    return null;
  }

  return {
    id: id || null,
    email: email || null,
    name: name || null,
    workspaceMemberId: workspaceMember?.id ?? id ?? null,
    source: workspaceMember
      ? recordType === 'task'
        ? 'task_assignee_workspace_member'
        : 'person_owner_workspace_member'
      : recordType === 'task'
        ? 'task_assignee'
        : 'person_owner'
  };
}

function getWorkspaceMemberName(member) {
  if (!member) {
    return '';
  }

  if (typeof member.name === 'string') {
    return member.name;
  }

  return firstString(
    member.name?.fullName,
    [member.name?.firstName, member.name?.lastName].filter(Boolean).join(' '),
    member.displayName
  );
}

function getOwnerSourceName(source = {}) {
  if (typeof source.name === 'string') {
    return source.name;
  }

  return firstString(
    source.name?.fullName,
    [source.name?.firstName, source.name?.lastName].filter(Boolean).join(' '),
    source.fullName,
    source.displayName
  );
}

function mergeOwnerContexts(personOwner, taskAssignee) {
  if (personOwner && taskAssignee) {
    return {
      ...personOwner,
      taskAssignee,
      source: 'person_owner_and_task_assignee'
    };
  }

  return personOwner ?? taskAssignee ?? null;
}

function getOwnerEmails(owner) {
  if (!owner) {
    return [];
  }

  return uniqueStrings([
    normalizeEmail(owner.email),
    normalizeEmail(owner.taskAssignee?.email)
  ]).filter(Boolean);
}

function readMarkdownValue(body, label) {
  if (!body) {
    return null;
  }

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`^${escapedLabel}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() ?? null;
}

function compareTasksByDueDate(left, right) {
  const leftTime = normalizeDateInput(left.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightTime = normalizeDateInput(right.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;

  return leftTime - rightTime;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number') {
      return String(value);
    }
  }

  return '';
}

function stringify(value) {
  return value === undefined || value === null ? null : String(value);
}

function normalizeSelect(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function normalizeDateInput(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDateString(value) {
  const date = normalizeDateInput(value);
  return date ? toDateOnly(date) : null;
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function endOfDay(date) {
  const normalizedDate = normalizeDateInput(date) ?? new Date();
  return new Date(
    Date.UTC(
      normalizedDate.getUTCFullYear(),
      normalizedDate.getUTCMonth(),
      normalizedDate.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );
}

function isBeforeStartOfDay(value, comparison) {
  const date = normalizeDateInput(value);
  const comparisonDate = normalizeDateInput(comparison) ?? new Date();

  if (!date) {
    return false;
  }

  return toDateOnly(date) < toDateOnly(comparisonDate);
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.length > 0)));
}
