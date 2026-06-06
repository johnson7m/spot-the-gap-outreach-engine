import { detectTestRecord } from '../utils/testRecordDetection.js';

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
  },
  'unassigned-tasks': {
    slug: 'unassigned-tasks',
    name: 'Unassigned Tasks Queue'
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
const POST_INITIAL_CADENCE_STAGES = new Set([
  'INTRO_MESSAGE',
  'VALUE_TOUCH',
  'ASSESSMENT_POSITIONING',
  'ASSESSMENT_SENT',
  'ASSESSMENT_CHECK_IN',
  'STRATEGIC_CHECK_IN',
  'DISCOVERY_ASK'
]);
const STALE_RISK_VALUES = new Set(['STALE', 'HIGH']);
const INITIAL_TASK_PATTERNS = [
  /send relationship-oriented connection request/i,
  /send assessment-oriented connection request/i,
  /\bconnection request\b/i,
  /\bfirst cadence task\b/i
];
const LEGACY_FOLLOW_UP_TASK_PATTERNS = [
  /\bli\s*-\s*day\s*2\b/i,
  /\bli\s*-\s*f\/?u\b/i,
  /\bf\/?u accepted connect\b/i,
  /\bfinal touch\b/i,
  /\bday\s*2\b/i,
  /\bvalue touch\b/i,
  /\bstrategic check-in\b/i,
  /\bassessment check-in\b/i,
  /\bassessment positioning\b/i,
  /\bdiscovery ask\b/i
];
const UNASSIGNED_TASK_ACTIONS = [
  'associate_person',
  'associate_company',
  'dismiss_from_my_view',
  'leave_unassigned'
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
  const visiblePeople = normalizedQuery.includeTestRecords
    ? normalizedPeople
    : normalizedPeople.filter((person) => !person.isTestRecord);
  const hiddenTestRecords = normalizedQuery.includeTestRecords
    ? 0
    : normalizedPeople.filter((person) => person.isTestRecord).length;
  const hiddenTestPersonIds = new Set(
    normalizedQuery.includeTestRecords
      ? []
      : normalizedPeople.filter((person) => person.isTestRecord).map((person) => person.personId)
  );
  const warnings = [];
  const candidates = selectQueueCandidates({
    queueSlug,
    people: visiblePeople,
    tasks: normalizedTasks,
    tasksByPersonId,
    hiddenTestPersonIds,
    query: normalizedQuery,
    warnings,
    now
  });
  const scopedItems = applyRoleScope({
    queueSlug,
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
    assigneeScope: normalizedQuery.assigneeScope,
    diagnostics: {
      hiddenTestRecords
    },
    warnings: uniqueStrings(warnings)
  };
}

export function buildQueueClassificationDiagnostics({
  people = [],
  tasks = [],
  taskTargets = [],
  workspaceMembers = [],
  query = {},
  now = new Date()
} = {}) {
  const normalizedQuery = normalizeQueueQuery(
    {
      ...query,
      includeDiagnostics: true
    },
    { role: 'admin' }
  );
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
  const personIdFilter = query.personId ? String(query.personId) : null;
  const taskIdFilter = query.taskId ? String(query.taskId) : null;
  const visiblePeople = normalizedQuery.includeTestRecords
    ? normalizedPeople
    : normalizedPeople.filter((person) => !person.isTestRecord);
  const rows = [];

  for (const person of visiblePeople) {
    if (personIdFilter && person.personId !== personIdFilter) {
      continue;
    }

    const personTasks = tasksByPersonId.get(person.personId) ?? [];
    const candidateTasks = taskIdFilter
      ? personTasks.filter((task) => task.taskId === taskIdFilter)
      : personTasks.filter(isOpenTask);
    const taskRows = candidateTasks.length > 0 ? candidateTasks : [null];

    for (const task of taskRows) {
      const diagnostic = buildPairClassificationDiagnostic({
        person,
        task,
        now
      });

      rows.push(toClassificationDiagnosticRow({ person, task, diagnostic }));
    }
  }

  if (taskIdFilter && rows.length === 0) {
    const task = normalizedTasks.find((candidate) => candidate.taskId === taskIdFilter);

    if (task) {
      const person = task.personId
        ? normalizedPeople.find((candidate) => candidate.personId === task.personId)
        : createUnknownPersonFromTask(task);
      const diagnostic = buildPairClassificationDiagnostic({
        person,
        task,
        now
      });

      rows.push(toClassificationDiagnosticRow({ person, task, diagnostic }));
    }
  }

  return {
    generatedAt: now.toISOString(),
    count: rows.length,
    limit: normalizedQuery.limit,
    offset: normalizedQuery.offset,
    items: rows.slice(normalizedQuery.offset, normalizedQuery.offset + normalizedQuery.limit)
  };
}

function toClassificationDiagnosticRow({ person, task, diagnostic }) {
  return {
    personId: person?.personId ?? task?.personId ?? null,
    personName: person?.name ?? null,
    cadenceStage: person?.cadenceStage ?? task?.cadenceStage ?? null,
    latestTouchStatus: person?.latestTouchStatus ?? task?.latestTouchStatus ?? null,
    taskId: task?.taskId ?? null,
    taskTitle: task?.title ?? null,
    matchedQueues: diagnostic.matchedQueues,
    finalQueue: diagnostic.finalQueue,
    excludedQueues: diagnostic.excludedQueues,
    classificationReasons: diagnostic.classificationReasons
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
  const includeUnassigned =
    query.includeUnassigned === undefined ? false : normalizeBoolean(query.includeUnassigned);
  const includeTestRecords =
    query.includeTestRecords === undefined ? false : normalizeBoolean(query.includeTestRecords);
  const includeDiagnostics =
    query.includeDiagnostics === undefined ? false : normalizeBoolean(query.includeDiagnostics);
  const requestedOwnerScope = normalizeSelect(query.requestedOwnerScope ?? query.ownerScope);
  const requestedAssigneeScope = normalizeSelect(query.requestedAssigneeScope ?? query.assigneeScope);
  const ownerScope =
    role === 'rep'
      ? 'mine'
      : requestedOwnerScope === 'MINE'
        ? 'mine'
        : 'all';
  const assigneeScope =
    role === 'rep'
      ? 'mine'
      : requestedAssigneeScope === 'MINE'
        ? 'mine'
        : 'all';
  const status = normalizeSelect(query.status);

  return {
    limit,
    offset,
    dueBefore,
    dueBeforeProvided:
      typeof query.dueBeforeProvided === 'boolean' ? query.dueBeforeProvided : Boolean(query.dueBefore),
    includeOverdue,
    includeUnassigned,
    includeTestRecords,
    includeDiagnostics,
    ownerScope,
    requestedOwnerScope: requestedOwnerScope ? requestedOwnerScope.toLowerCase() : null,
    assigneeScope,
    requestedAssigneeScope: requestedAssigneeScope ? requestedAssigneeScope.toLowerCase() : null,
    status: status || null
  };
}

function selectQueueCandidates({
  queueSlug,
  people,
  tasks,
  tasksByPersonId,
  hiddenTestPersonIds,
  query,
  warnings,
  now
}) {
  switch (queueSlug) {
    case 'fresh-leads':
      return people
        .filter((person) => isFreshLead(person, tasksByPersonId.get(person.personId)))
        .map((person) => toQueueItem({
          person,
          task: firstOpenTask(tasksByPersonId.get(person.personId)),
          source: 'twenty:person',
          itemWarnings: buildFreshLeadWarnings(person, tasksByPersonId.get(person.personId)),
          suggestedResolutionActions: firstOpenTask(tasksByPersonId.get(person.personId))
            ? []
            : ['create_next_task'],
          queueClassification: 'fresh_initial_task',
          queueClassificationReasons: buildFreshLeadClassificationReasons(
            person,
            firstOpenTask(tasksByPersonId.get(person.personId))
          ),
          classificationDiagnostics: query.includeDiagnostics
            ? buildPairClassificationDiagnostic({
                person,
                task: firstOpenTask(tasksByPersonId.get(person.personId)),
                queueSlug,
                now
              })
            : null
        }));

    case 'follow-ups':
      return filterFollowUpTasks({
        tasks,
        query,
        hiddenTestPersonIds,
        warnings
      })
        .map((task) => {
          const person = people.find((candidate) => candidate.personId === task.personId);
          const classification = classifyFollowUpTask({
            person: person ?? createUnknownPersonFromTask(task),
            task
          });

          if (!classification.include) {
            return null;
          }

          return toQueueItem({
            person: person ?? createUnknownPersonFromTask(task),
            task,
            source: task.personId ? 'twenty:task' : 'twenty:task-unlinked',
            itemWarnings: buildTaskAssociationWarnings(task, person),
            queueClassification: classification.queueClassification,
            queueClassificationReasons: classification.reasons,
            classificationDiagnostics: query.includeDiagnostics
              ? buildPairClassificationDiagnostic({
                  person: person ?? createUnknownPersonFromTask(task),
                  task,
                  queueSlug,
                  now
                })
              : null
          });
        })
        .filter(Boolean)
        .filter((item) => item.cadenceName && !isTerminalCadenceStage(item.cadenceStage));

    case 'unassigned-tasks':
      return tasks
        .filter((task) => isUnassignedTask(task))
        .filter((task) => matchesTaskFilters(task, query))
        .map((task) => toUnassignedTaskQueueItem({ task }));

    case 'warm-assessments':
      return people
        .filter((person) => isWarmAssessment(person))
        .map((person) => toQueueItem({
          person,
          task: firstOpenTask(tasksByPersonId.get(person.personId)),
          source: 'twenty:person',
          itemWarnings: [],
          queueClassification: 'warm_assessment_ready',
          queueClassificationReasons: buildWarmAssessmentClassificationReasons(person),
          classificationDiagnostics: query.includeDiagnostics
            ? buildPairClassificationDiagnostic({
                person,
                task: firstOpenTask(tasksByPersonId.get(person.personId)),
                queueSlug,
                now
              })
            : null
        }));

    case 'stale-recovery':
      return people
        .map((person) => ({
          person,
          openTask: firstOpenTask(tasksByPersonId.get(person.personId))
        }))
        .filter(({ person, openTask }) => isStaleRecovery(person, now, openTask))
        .map(({ person, openTask }) => toQueueItem({
          person,
          task: openTask,
          source: 'twenty:person',
          itemWarnings: buildStaleWarnings(person, openTask),
          queueClassification: 'stale_recovery_stale',
          queueClassificationReasons: buildStaleClassificationReasons(person, now, openTask),
          classificationDiagnostics: query.includeDiagnostics
            ? buildPairClassificationDiagnostic({
                person,
                task: openTask,
                queueSlug,
                now
              })
            : null
        }));

    case 'pipeline-review':
      return people
        .map((person) => {
          const openTask = firstOpenTask(tasksByPersonId.get(person.personId));
          const review = getPipelineReview(person, openTask);

          return {
            person,
            openTask,
            reviewWarnings: review.warnings,
            reviewReasons: review.reasons
          };
        })
        .filter(({ reviewWarnings }) => reviewWarnings.length > 0)
        .map(({ person, openTask, reviewWarnings, reviewReasons }) => toQueueItem({
          person,
          task: openTask,
          source: 'twenty:person',
          itemWarnings: reviewWarnings,
          reviewReasons,
          queueClassification: getPipelineReviewClassification(reviewReasons),
          queueClassificationReasons: reviewReasons,
          classificationDiagnostics: query.includeDiagnostics
            ? buildPairClassificationDiagnostic({
                person,
                task: openTask,
                queueSlug,
                now
              })
            : null
        }));

    default:
      return [];
  }
}

function normalizePersonRecord({ person = {}, tasks = [], workspaceMembersById = new Map() } = {}) {
  const owner = normalizeOwner(person, 'person', workspaceMembersById);
  const openTasks = tasks.filter(isOpenTask);
  const testRecord = detectTestRecord(person);

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
    isTestRecord: testRecord.isTestRecord,
    testRecordReasons: testRecord.reasons,
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
    existingTaskTargets: taskTargets,
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
    taskType: normalizeSelect(readMarkdownValue(body, 'Task type')),
    assignee,
    targetCompanyId: personLink.companyId,
    warnings: buildTaskLinkWarnings(personLink)
  };
}

function toQueueItem({
  person,
  task,
  source,
  itemWarnings = [],
  suggestedResolutionActions = [],
  reviewReasons = [],
  queueClassification = null,
  queueClassificationReasons = [],
  classificationDiagnostics = null
}) {
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
    queueClassification,
    queueClassificationReasons: uniqueStrings(queueClassificationReasons),
    ...(classificationDiagnostics ? { classificationDiagnostics } : {}),
    isTestRecord: Boolean(person?.isTestRecord),
    testRecordReasons: person?.testRecordReasons ?? [],
    reviewReasons,
    personLinkSource: task?.personLinkSource ?? null,
    personResolutionPath: task?.personResolutionPath ?? [],
    personResolutionConfidence: task?.personResolutionConfidence ?? null,
    personResolutionEvidence: task?.personResolutionEvidence ?? [],
    targetCompanyId: task?.targetCompanyId ?? null,
    queueBucket: task && !task.personId ? 'unassigned_tasks' : null,
    suggestedResolutionActions:
      suggestedResolutionActions.length > 0
        ? suggestedResolutionActions
        : task && !task.personId
          ? UNASSIGNED_TASK_ACTIONS
          : [],
    warnings: uniqueStrings([
      ...(person?.taskWarnings ?? []),
      ...(task?.warnings ?? []),
      ...itemWarnings
    ])
  };
}

function toUnassignedTaskQueueItem({ task }) {
  return {
    personId: null,
    taskId: task.taskId,
    title: null,
    taskTitle: task.title,
    taskStatus: task.status,
    taskDueDate: task.dueDate,
    assignee: task.assignee,
    owner: task.assignee,
    assignedRep: task.assignee?.email ?? task.assignee?.name ?? null,
    assignedRepDetails: task.assignee ?? null,
    memberResolution: task.assignee,
    taskBodyExcerpt: excerpt(task.body),
    existingTaskTargets: task.existingTaskTargets ?? [],
    currentTargetPersonId: task.currentTargetPersonId ?? null,
    currentTargetCompanyId: task.currentTargetCompanyId ?? null,
    targetCompanyId: task.targetCompanyId ?? null,
    personLinkSource: task.personLinkSource ?? null,
    personResolutionPath: task.personResolutionPath ?? [],
    personResolutionConfidence: task.personResolutionConfidence ?? null,
    personResolutionEvidence: task.personResolutionEvidence ?? [],
    queueClassification: 'unassigned_task_review',
    queueClassificationReasons: ['unassigned_task_no_person_link'],
    queueBucket: 'unassigned_tasks',
    suggestedResolutionActions: UNASSIGNED_TASK_ACTIONS,
    source: 'twenty:task-unassigned',
    warnings: uniqueStrings([
      ...(task.warnings ?? []),
      'Task has no taskTarget Person link and no confident inferred Person.'
    ])
  };
}

function applyRoleScope({ queueSlug, items, workspaceUser = {}, query, warnings }) {
  const role = workspaceUser.role ?? 'rep';
  const email = normalizeEmail(workspaceUser.email);
  const scope = queueSlug === 'unassigned-tasks' ? query.assigneeScope : query.ownerScope;
  const requestedScope =
    queueSlug === 'unassigned-tasks' ? query.requestedAssigneeScope : query.requestedOwnerScope;
  const scopeLabel = queueSlug === 'unassigned-tasks' ? 'assigneeScope' : 'ownerScope';

  if (role !== 'rep' && scope !== 'mine') {
    return items;
  }

  if (role === 'rep' && requestedScope === 'all') {
    warnings.push(`Rep requests for ${scopeLabel}=all are treated as ${scopeLabel}=mine.`);
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

function isFreshLead(person, tasks = []) {
  const openTask = firstOpenTask(tasks);

  return (
    Boolean(person.outboundPipelineType) &&
    FRESH_CADENCE_STAGES.has(person.cadenceStage) &&
    (person.latestTouchStatus === 'DRAFTED' || isInitialOutreachTask(openTask) || !openTask)
  );
}

function isWarmAssessment(person) {
  return (
    person.assessmentCompleted === true ||
    person.leadstageAuto === 'ASSESSMENT_COMPLETED' ||
    WARM_DISCOVERY_STATUSES.has(person.discoveryReadiness)
  );
}

function isStaleRecovery(person, now, task = null) {
  if (STALE_RISK_VALUES.has(person.staleRisk)) {
    return true;
  }

  const nextTouchDate = normalizeDateInput(person.nextOutboundTouchDate);

  if (nextTouchDate && isBeforeStartOfDay(nextTouchDate, now)) {
    return !isFreshInitialGeneratedTaskProtectedFromStale(person, task);
  }

  return person.latestTouchStatus === 'NO_RESPONSE' && Boolean(person.cadenceStage);
}

function buildFreshLeadClassificationReasons(person, task) {
  const reasons = ['fresh_initial_task'];

  if (person.cadenceStage === 'NOT_STARTED') {
    reasons.push('cadence_not_started');
  }

  if (person.cadenceStage === 'CONNECTION_REQUEST') {
    reasons.push('cadence_connection_request');
  }

  if (isInitialOutreachTask(task)) {
    reasons.push('initial_outreach_task_open');
  }

  if (!task) {
    reasons.push('no_open_task_create_first_task');
  }

  return reasons;
}

function buildWarmAssessmentClassificationReasons(person) {
  const reasons = ['warm_assessment_ready'];

  if (person.assessmentCompleted) {
    reasons.push('assessment_completed');
  }

  if (person.leadstageAuto === 'ASSESSMENT_COMPLETED') {
    reasons.push('leadstage_assessment_completed');
  }

  if (WARM_DISCOVERY_STATUSES.has(person.discoveryReadiness)) {
    reasons.push('discovery_readiness_warm');
  }

  return reasons;
}

function buildStaleClassificationReasons(person, now, task = null) {
  const reasons = ['stale_recovery_stale'];

  if (STALE_RISK_VALUES.has(person.staleRisk)) {
    reasons.push(`stale_risk_${person.staleRisk.toLowerCase()}`);
  }

  const nextTouchDate = normalizeDateInput(person.nextOutboundTouchDate);

  if (
    nextTouchDate &&
    isBeforeStartOfDay(nextTouchDate, now) &&
    !isFreshInitialGeneratedTaskProtectedFromStale(person, task)
  ) {
    reasons.push('next_touch_overdue');
  }

  if (person.latestTouchStatus === 'NO_RESPONSE') {
    reasons.push('latest_touch_no_response');
  }

  return reasons;
}

function classifyFollowUpTask({ person, task } = {}) {
  if (!task) {
    return {
      include: false,
      excludedReason: 'No Task available for Follow-Up classification.',
      queueClassification: null,
      reasons: []
    };
  }

  if (isPostInitialCadenceStage(person?.cadenceStage) || isPostInitialCadenceStage(task.cadenceStage)) {
    return {
      include: true,
      queueClassification: 'follow_up_post_initial_touch',
      reasons: ['follow_up_post_initial_touch', 'post_initial_cadence_stage']
    };
  }

  if (isLegacyFollowUpTask(task)) {
    return {
      include: true,
      queueClassification: 'follow_up_legacy_task_history',
      reasons: ['follow_up_legacy_task_history']
    };
  }

  if (
    person?.cadenceStage === 'NOT_STARTED' &&
    isInitialOutreachTask(task) &&
    person?.latestTouchStatus === 'DRAFTED' &&
    !hasPriorOutreachEvidence(person, task)
  ) {
    return {
      include: false,
      excludedReason: 'Initial NOT_STARTED outreach task belongs in Fresh Leads.',
      queueClassification: null,
      reasons: ['excluded_initial_outreach_fresh_lead']
    };
  }

  if (FRESH_CADENCE_STAGES.has(person?.cadenceStage) && isInitialOutreachTask(task)) {
    return {
      include: false,
      excludedReason: 'Initial connection/request Task belongs in Fresh Leads.',
      queueClassification: null,
      reasons: ['excluded_initial_outreach_fresh_lead']
    };
  }

  if (hasPriorOutreachEvidence(person, task) && !isInitialOutreachTask(task)) {
    return {
      include: true,
      queueClassification: 'follow_up_post_initial_touch',
      reasons: ['follow_up_post_initial_touch', 'prior_outreach_evidence']
    };
  }

  return {
    include: false,
    excludedReason: 'Task does not show post-initial outreach evidence.',
    queueClassification: null,
    reasons: ['excluded_not_post_initial_touch']
  };
}

function getPipelineReviewClassification(reviewReasons = []) {
  if (reviewReasons.includes('enrichment_partial')) {
    return 'pipeline_review_missing_enrichment';
  }

  if (reviewReasons.includes('missing_next_task')) {
    return 'pipeline_review_missing_next_task';
  }

  return 'pipeline_review_manual_review';
}

function buildPairClassificationDiagnostic({ person, task, queueSlug = null, now = new Date() } = {}) {
  const matchedQueues = [];
  const excludedQueues = [];
  const classificationReasons = [];

  if (person && isStaleRecovery(person, now, task)) {
    matchedQueues.push('stale-recovery');
    classificationReasons.push(...buildStaleClassificationReasons(person, now, task));
  }

  if (person && isWarmAssessment(person)) {
    matchedQueues.push('warm-assessments');
    classificationReasons.push(...buildWarmAssessmentClassificationReasons(person));
  }

  if (task) {
    const followUp = classifyFollowUpTask({ person, task });

    if (followUp.include) {
      matchedQueues.push('follow-ups');
      classificationReasons.push(...followUp.reasons);
    } else {
      excludedQueues.push({
        queueSlug: 'follow-ups',
        reason: followUp.excludedReason,
        classificationReasons: followUp.reasons
      });
    }
  }

  if (person && isFreshLead(person, task ? [task] : [])) {
    matchedQueues.push('fresh-leads');
    classificationReasons.push(...buildFreshLeadClassificationReasons(person, task));
  }

  if (person) {
    const review = getPipelineReview(person, task);

    if (review.reasons.length > 0) {
      matchedQueues.push('pipeline-review');
      classificationReasons.push(...review.reasons);
    }
  }

  const finalQueue = pickFinalQueue(matchedQueues);
  const precedenceExcludedQueues = matchedQueues
    .filter((matchedQueue) => matchedQueue !== finalQueue)
    .map((matchedQueue) => ({
      queueSlug: matchedQueue,
      reason: `Excluded by precedence in favor of ${finalQueue}.`,
      classificationReasons: []
    }));

  return {
    currentQueue: queueSlug,
    matchedQueues: uniqueStrings(matchedQueues),
    finalQueue,
    excludedQueues: [...precedenceExcludedQueues, ...excludedQueues],
    classificationReasons: uniqueStrings(classificationReasons)
  };
}

function pickFinalQueue(matchedQueues = []) {
  for (const queueSlug of [
    'stale-recovery',
    'warm-assessments',
    'follow-ups',
    'fresh-leads',
    'pipeline-review'
  ]) {
    if (matchedQueues.includes(queueSlug)) {
      return queueSlug;
    }
  }

  return null;
}

function isInitialOutreachTask(task) {
  if (!task) {
    return false;
  }

  const text = getTaskClassificationText(task);

  return (
    task.taskType === 'CONNECTION_REQUEST' ||
    INITIAL_TASK_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function isFreshInitialGeneratedTaskProtectedFromStale(person = {}, task = null) {
  return (
    Boolean(task) &&
    isOpenTask(task) &&
    FRESH_CADENCE_STAGES.has(person.cadenceStage) &&
    isInitialOutreachTask(task) &&
    isMissingNextTaskPlannerTask(task)
  );
}

function isMissingNextTaskPlannerTask(task = {}) {
  return /source:\s*missing next-task planner/i.test(getTaskClassificationText(task));
}

function isLegacyFollowUpTask(task) {
  const text = getTaskClassificationText(task);

  return LEGACY_FOLLOW_UP_TASK_PATTERNS.some((pattern) => pattern.test(text));
}

function isPostInitialCadenceStage(value) {
  return POST_INITIAL_CADENCE_STAGES.has(normalizeSelect(value));
}

function hasPriorOutreachEvidence(person = {}, task = {}) {
  return (
    ['SENT', 'RESPONDED', 'NO_RESPONSE', 'COMPLETED'].includes(normalizeSelect(person.latestTouchStatus)) ||
    ['SENT', 'RESPONDED', 'NO_RESPONSE', 'COMPLETED'].includes(normalizeSelect(task.latestTouchStatus)) ||
    isPostInitialCadenceStage(person.cadenceStage) ||
    isPostInitialCadenceStage(task.cadenceStage) ||
    isLegacyFollowUpTask(task)
  );
}

function getTaskClassificationText(task = {}) {
  return [
    task.title,
    task.taskType,
    task.cadenceStage,
    task.latestTouchStatus,
    task.body
  ]
    .filter(Boolean)
    .join(' ');
}

function getPipelineReview(person, openTask) {
  const warnings = [];
  const reasons = [];

  if (!person.email) {
    warnings.push('Missing email.');
    reasons.push('missing_email');
  }

  if (!person.linkedinUrl) {
    warnings.push('Missing LinkedIn URL.');
    reasons.push('missing_linkedin');
  }

  if (!person.companyName) {
    warnings.push('Missing company.');
    reasons.push('missing_company');
  }

  if (!person.cadenceName) {
    warnings.push('Missing cadence name.');
    reasons.push('manual_review');
  }

  if (!person.cadenceStage) {
    warnings.push('Missing cadence stage.');
    reasons.push('manual_review');
  }

  if (REVIEW_ENRICHMENT_STATUSES.has(person.enrichmentStatus)) {
    warnings.push(`Enrichment status requires review: ${person.enrichmentStatus}.`);
    reasons.push('enrichment_partial');
  }

  if (person.raw?.duplicateWarning || person.raw?.duplicateWarnings?.length) {
    warnings.push('Duplicate warning present; merge review may be needed.');
    reasons.push('manual_review');
  }

  if (person.cadenceName && !isTerminalCadenceStage(person.cadenceStage) && !openTask) {
    warnings.push('No open next task found despite non-terminal cadence.');
    reasons.push('missing_next_task');
  }

  if (person.isTestRecord) {
    warnings.push('Record appears to be a test or synthetic lead.');
    reasons.push('test_record');
  }

  return {
    warnings,
    reasons: uniqueStrings(reasons)
  };
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

function filterFollowUpTasks({
  tasks = [],
  query = {},
  hiddenTestPersonIds = new Set(),
  warnings = []
} = {}) {
  const unassignedCount = tasks.filter(isUnassignedTask).length;

  if (!query.includeUnassigned && unassignedCount > 0) {
    warnings.push(`${unassignedCount} unassigned tasks hidden. Review Unassigned Tasks queue.`);
  }

  return tasks
    .filter((task) => !hiddenTestPersonIds.has(task.personId))
    .filter((task) => query.includeUnassigned || !isUnassignedTask(task))
    .filter((task) => isDueOpenTask(task, query));
}

function isUnassignedTask(task) {
  return !task.currentTargetPersonId && !hasConfidentPersonResolution(task);
}

function hasConfidentPersonResolution(task) {
  return Boolean(
    task.personId &&
      ['high', 'medium'].includes(normalizeSelect(task.personResolutionConfidence).toLowerCase())
  );
}

function matchesTaskFilters(task, query = {}) {
  if (query.status && normalizeSelect(task.status) !== query.status) {
    return false;
  }

  if (query.dueBeforeProvided) {
    const dueDate = normalizeDateInput(task.dueDate);

    if (!dueDate || dueDate.getTime() > endOfDay(query.dueBefore).getTime()) {
      return false;
    }
  }

  return true;
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

  return ['No open task exists yet; create the first cadence task.'];
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

function buildStaleWarnings(person, task = null) {
  const warnings = [];

  if (STALE_RISK_VALUES.has(person.staleRisk)) {
    warnings.push(`Stale risk is ${person.staleRisk}.`);
  }

  if (person.latestTouchStatus === 'NO_RESPONSE') {
    warnings.push('Latest touch status is NO_RESPONSE.');
  }

  if (person.nextOutboundTouchDate && !isFreshInitialGeneratedTaskProtectedFromStale(person, task)) {
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

function excerpt(value, maxLength = 280) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
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
