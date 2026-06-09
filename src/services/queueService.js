import { detectTestRecord } from '../utils/testRecordDetection.js';
import { toProjectDateOnly } from '../utils/projectDate.js';

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
const FIRST_TOUCH_SENT_STATUSES = new Set(['SENT']);
const FRESH_EXCLUDED_TOUCH_STATUSES = new Set(['SENT', 'RESPONDED', 'COMPLETED']);
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
const EXPLICIT_STALE_FLAGS = new Set(['STALE', 'TRUE', 'YES', 'NEEDS_STALE_RECOVERY']);
const STALE_NO_RESPONSE_DAY_THRESHOLD = 30;
const INITIAL_TASK_PATTERNS = [
  /send relationship-oriented connection request/i,
  /send assessment-oriented connection request/i,
  /\bconnection request\b/i,
  /\bfirst cadence task\b/i
];
const POST_INITIAL_TASK_PATTERNS = [
  /send contextual introduction/i,
  /send assessment positioning message/i,
  /send value touch/i,
  /send spot the gap assessment link/i,
  /check in on spot the gap assessment/i,
  /send strategic check-in/i,
  /evaluate discovery ask/i
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
  companies = [],
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
  const companiesById = createCompanyIndex(companies);
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
      companiesById,
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
  const hasMore = normalizedQuery.offset + pagedItems.length < scopedItems.length;
  const diagnostics = buildQueueDiagnostics({
    queueSlug,
    people: visiblePeople,
    tasks: normalizedTasks,
    tasksByPersonId,
    hiddenTestPersonIds,
    hiddenTestRecords,
    query: normalizedQuery,
    now
  });

  return {
    queueName: definition.name,
    queueSlug: definition.slug,
    items: pagedItems,
    count: pagedItems.length,
    totalCount: scopedItems.length,
    limit: normalizedQuery.limit,
    offset: normalizedQuery.offset,
    hasMore,
    nextOffset: hasMore ? normalizedQuery.offset + pagedItems.length : null,
    overdueCount: scopedItems.filter((item) => item.isOverdueTask).length,
    ownerScope: normalizedQuery.ownerScope,
    assigneeScope: normalizedQuery.assigneeScope,
    diagnostics,
    warnings: uniqueStrings(warnings)
  };
}

export function buildQueueClassificationDiagnostics({
  people = [],
  companies = [],
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
  const companiesById = createCompanyIndex(companies);
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
      companiesById,
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
        tasks: personTasks,
        now
      });

      rows.push(toClassificationDiagnosticRow({ person, task, tasks: personTasks, diagnostic, now }));
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
        tasks: task ? [task] : [],
        now
      });

      rows.push(toClassificationDiagnosticRow({ person, task, tasks: task ? [task] : [], diagnostic, now }));
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

export function buildQueueCoverageAudit({
  people = [],
  companies = [],
  tasks = [],
  taskTargets = [],
  workspaceMembers = [],
  query = {},
  now = new Date()
} = {}) {
  const normalizedQuery = normalizeQueueQuery(
    {
      ...query,
      includeDiagnostics: true,
      includeTestRecords: true,
      ownerScope: 'all',
      assigneeScope: 'all'
    },
    { role: 'admin' }
  );
  const workspaceMembersById = createWorkspaceMemberIndex(workspaceMembers);
  const companiesById = createCompanyIndex(companies);
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
      companiesById,
      workspaceMembersById
    })
  );
  const hiddenTestPersonIds = new Set(
    normalizedPeople.filter((person) => person.isTestRecord).map((person) => person.personId)
  );
  const visiblePeople = normalizedPeople.filter((person) => !person.isTestRecord);
  const candidateMap = buildPersonQueueCandidateMap({
    people: visiblePeople,
    tasks: normalizedTasks,
    tasksByPersonId,
    hiddenTestPersonIds,
    query: normalizedQuery,
    now
  });
  const records = normalizedPeople.map((person) =>
    buildCoverageRecord({
      person,
      candidate: candidateMap.get(person.personId),
      tasks: tasksByPersonId.get(person.personId) ?? [],
      now
    })
  );
  const summary = summarizeCoverageRecords(records);

  return {
    generatedAt: now.toISOString(),
    query: {
      dueBefore: normalizedQuery.dueBefore?.toISOString?.() ?? null,
      includeTestRecords: true
    },
    summary,
    records
  };
}

function toClassificationDiagnosticRow({ person, task, tasks = [], diagnostic, now = new Date() }) {
  const taskList = tasks.length > 0 ? tasks : task ? [task] : [];
  const stale = getStaleRecoveryMatch(person, now, task);
  const due = getTaskDueInfo(task, now);

  return {
    personId: person?.personId ?? task?.personId ?? null,
    personName: person?.name ?? null,
    cadenceStage: person?.cadenceStage ?? task?.cadenceStage ?? null,
    latestTouchStatus: person?.latestTouchStatus ?? task?.latestTouchStatus ?? null,
    taskId: task?.taskId ?? null,
    taskTitle: task?.title ?? null,
    initialTaskDetected: taskList.some(isInitialOutreachTask),
    firstTouchAlreadySent: isFirstTouchAlreadySent(person),
    followUpTaskDetected: taskList.some(isPostInitialFollowUpTask),
    staleTriggerMatched: stale.matched,
    staleReason: stale.reason,
    dueStatus: due.dueStatus,
    isOverdueTask: due.isOverdueTask,
    recommendedFix: getRecommendedClassificationFix({ person, task, tasks: taskList, diagnostic }),
    matchedQueues: diagnostic.matchedQueues,
    matchedQueueCandidates: diagnostic.matchedQueues,
    finalQueue: diagnostic.finalQueue,
    queuePrecedenceApplied: diagnostic.finalQueue,
    excludedQueues: diagnostic.excludedQueues,
    excludedQueueCandidates: diagnostic.excludedQueues
      .map((excludedQueue) => excludedQueue.queueSlug ?? excludedQueue)
      .filter(Boolean),
    classificationReasons: diagnostic.classificationReasons
  };
}

function buildQueueDiagnostics({
  queueSlug,
  people = [],
  tasks = [],
  tasksByPersonId = new Map(),
  hiddenTestPersonIds = new Set(),
  hiddenTestRecords = 0,
  query = {},
  now = new Date()
} = {}) {
  const diagnostics = {
    hiddenTestRecords,
    normalizedDueBefore: query.dueBefore ? toDateOnly(query.dueBefore) : null
  };

  if (queueSlug !== 'pipeline-review') {
    return diagnostics;
  }

  const allReviewedItems = selectQueueCandidates({
    queueSlug: 'pipeline-review',
    people,
    tasks,
    tasksByPersonId,
    hiddenTestPersonIds,
    query: {
      ...query,
      includeAllReviewed: true,
      includeDiagnostics: true
    },
    warnings: [],
    now
  });

  const finalPipelineReviewItems = selectQueueCandidates({
    queueSlug: 'pipeline-review',
    people,
    tasks,
    tasksByPersonId,
    hiddenTestPersonIds,
    query: {
      ...query,
      includeAllReviewed: false,
      includeDiagnostics: false
    },
    warnings: [],
    now
  });

  diagnostics.reviewedPeopleCount = allReviewedItems.length;
  diagnostics.finalPipelineReviewCount = finalPipelineReviewItems.length;

  return diagnostics;
}

function buildPersonQueueCandidateMap({
  people = [],
  tasks = [],
  tasksByPersonId = new Map(),
  hiddenTestPersonIds = new Set(),
  query = {},
  now = new Date()
} = {}) {
  const candidateMap = new Map();

  for (const queueSlug of [
    'fresh-leads',
    'follow-ups',
    'warm-assessments',
    'stale-recovery',
    'pipeline-review'
  ]) {
    const warnings = [];
    const items = selectQueueCandidates({
      queueSlug,
      people,
      tasks,
      tasksByPersonId,
      hiddenTestPersonIds,
      query,
      warnings,
      now
    });

    for (const item of items) {
      if (!item.personId) {
        continue;
      }

      const existing = candidateMap.get(item.personId) ?? {
        matchedQueueCandidates: new Set(),
        itemsByQueue: new Map()
      };
      existing.matchedQueueCandidates.add(queueSlug);

      const queueItems = existing.itemsByQueue.get(queueSlug) ?? [];
      queueItems.push(item);
      existing.itemsByQueue.set(queueSlug, queueItems);
      candidateMap.set(item.personId, existing);
    }
  }

  return candidateMap;
}

function buildCoverageRecord({ person, candidate, tasks = [], now = new Date() }) {
  if (person.isTestRecord) {
    return {
      ...coverageBaseRecord(person),
      matchedQueueCandidates: [],
      finalQueue: 'hidden_test_record',
      disposition: 'hidden_test_record',
      exclusionReasons: person.testRecordReasons,
      recommendedFix: 'exclude_test_record_from_operational_queues'
    };
  }

  const matchedQueueCandidates = uniqueStrings([...(candidate?.matchedQueueCandidates ?? [])]);
  const terminalDisposition = getTerminalDisposition(person);
  const finalQueue = terminalDisposition ? null : pickFinalQueue(matchedQueueCandidates);
  const finalDisposition = finalQueue ? dispositionForQueue(finalQueue) : terminalDisposition;
  const pipelineItem = candidate?.itemsByQueue?.get('pipeline-review')?.[0] ?? null;
  const exclusionReasons = buildCoverageExclusionReasons({
    person,
    tasks,
    finalQueue,
    disposition: finalDisposition,
    pipelineItem
  });
  const recommendedFix = getCoverageRecommendedFix({
    person,
    tasks,
    finalQueue,
    disposition: finalDisposition,
    pipelineItem,
    now
  });

  return {
    ...coverageBaseRecord(person),
    matchedQueueCandidates,
    finalQueue: finalQueue ?? finalDisposition ?? 'unclassified_needs_rule',
    disposition: finalDisposition ?? 'unclassified_needs_rule',
    exclusionReasons,
    recommendedFix
  };
}

function coverageBaseRecord(person) {
  return {
    personId: person.personId,
    personName: person.name,
    owner: person.owner
      ? {
          id: person.owner.id ?? null,
          name: person.owner.name ?? null,
          email: person.owner.email ?? null,
          workspaceMemberId: person.owner.workspaceMemberId ?? null
        }
      : null,
    outboundPipelineType: person.outboundPipelineType || null,
    cadenceName: person.cadenceName || null,
    cadenceStage: person.cadenceStage || null,
    latestTouchStatus: person.latestTouchStatus || null,
    staleRisk: person.staleRisk || null
  };
}

function dispositionForQueue(queueSlug) {
  return {
    'fresh-leads': 'fresh_lead',
    'follow-ups': 'follow_up',
    'warm-assessments': 'warm_assessment',
    'stale-recovery': 'stale_recovery',
    'pipeline-review': 'pipeline_review'
  }[queueSlug] ?? null;
}

function getTerminalDisposition(person = {}) {
  if (person.leadStage === 'ACTIVE_CLIENT' || person.cadenceStage === 'ACTIVE_CLIENT') {
    return 'active_client';
  }

  if (
    person.leadStage === 'UNQUALIFIED_CLOSED' ||
    person.leadStage === 'DISQUALIFIED' ||
    person.cadenceStage === 'UNQUALIFIED_CLOSED' ||
    isTerminalCadenceStage(person.cadenceStage)
  ) {
    return 'terminal_closed';
  }

  return null;
}

function buildCoverageExclusionReasons({
  person,
  tasks = [],
  finalQueue,
  disposition,
  pipelineItem
} = {}) {
  if (disposition === 'hidden_test_record') {
    return person.testRecordReasons ?? ['test_record'];
  }

  if (finalQueue === 'pipeline-review') {
    const reviewReasons = pipelineItem?.reviewReasons ?? [];
    return reviewReasons.length > 0 ? uniqueStrings(reviewReasons) : ['manual_review'];
  }

  if (disposition === 'terminal_closed') {
    return ['terminal'];
  }

  if (disposition === 'active_client') {
    return ['active_client'];
  }

  if (finalQueue) {
    return [];
  }

  const review = getPipelineReview(person, firstOpenTask(tasks), tasks);
  const reasons = [...review.reasons];

  if (!person.outboundPipelineType || !person.cadenceName || !person.cadenceStage) {
    reasons.push('missing_outbound_fields');
  }

  if (person.cadenceName && !isTerminalCadenceStage(person.cadenceStage) && !firstOpenTask(tasks)) {
    reasons.push('missing_task');
  }

  if (reasons.length === 0) {
    reasons.push('no_action_rule_missing');
  }

  return uniqueStrings(reasons);
}

function getCoverageRecommendedFix({
  person,
  tasks = [],
  finalQueue,
  disposition,
  pipelineItem,
  now = new Date()
} = {}) {
  if (pipelineItem?.suggestedResolutionActions?.length > 0) {
    return pipelineItem.suggestedResolutionActions[0];
  }

  if (disposition === 'terminal_closed') {
    return 'no_active_queue_terminal_closed';
  }

  if (disposition === 'active_client') {
    return 'no_active_queue_active_client';
  }

  if (!finalQueue) {
    return 'define_queue_rule';
  }

  const task = firstOpenTask(tasks);
  const diagnostic = buildPairClassificationDiagnostic({
    person,
    task,
    tasks,
    queueSlug: finalQueue,
    now
  });

  return (
    getRecommendedClassificationFix({ person, task, tasks, diagnostic }) ??
    (finalQueue === 'pipeline-review' ? 'review_pipeline_gaps' : 'define_queue_rule')
  );
}

function summarizeCoverageRecords(records = []) {
  const totalPeople = records.length;
  const hiddenTestRecords = records.filter((record) => record.disposition === 'hidden_test_record').length;
  const expectedRealPeople = totalPeople - hiddenTestRecords;
  const realRecords = records.filter((record) => record.disposition !== 'hidden_test_record');
  const unclassifiedPeople = realRecords.filter(
    (record) => record.disposition === 'unclassified_needs_rule'
  ).length;
  const duplicateCandidatePeople = realRecords.filter(
    (record) => (record.matchedQueueCandidates ?? []).length > 1
  ).length;

  return {
    totalPeople,
    hiddenTestRecords,
    expectedRealPeople,
    accountedForPeople: expectedRealPeople - unclassifiedPeople,
    unclassifiedPeople,
    countsByFinalQueue: countBy(records, (record) => record.finalQueue ?? 'none'),
    countsByDisposition: countBy(records, (record) => record.disposition ?? 'none'),
    countsByExclusionReason: countBy(
      realRecords.flatMap((record) => record.exclusionReasons ?? []),
      (reason) => reason
    ),
    duplicateMultiQueueCandidateCount: duplicateCandidatePeople
  };
}

function countBy(values = [], selector = (value) => value) {
  return values.reduce((acc, value) => {
    const key = selector(value) || 'none';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

export function normalizeQueueQuery(query = {}, workspaceUser = {}) {
  const role = workspaceUser?.role ?? 'rep';
  const requestedLimit = Number(query.limit);
  const requestedOffset = Number(query.offset ?? query.cursor);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 50;
  const offset = Number.isFinite(requestedOffset) ? Math.max(Math.trunc(requestedOffset), 0) : 0;
  const dueBefore = normalizeDateInput(query.dueBefore ?? toProjectDateOnly(new Date())) ?? new Date();
  const includeOverdue =
    query.includeOverdue === undefined ? true : normalizeBoolean(query.includeOverdue);
  const includeUnassigned =
    query.includeUnassigned === undefined ? false : normalizeBoolean(query.includeUnassigned);
  const includeTestRecords =
    query.includeTestRecords === undefined ? false : normalizeBoolean(query.includeTestRecords);
  const includeDiagnostics =
    query.includeDiagnostics === undefined ? false : normalizeBoolean(query.includeDiagnostics);
  const includeAllReviewed =
    query.includeAllReviewed === undefined ? false : normalizeBoolean(query.includeAllReviewed);
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
  const dueStatus = normalizeSelect(query.dueStatus);
  const bypassCache =
    query.bypassCache === undefined ? false : normalizeBoolean(query.bypassCache);

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
    includeAllReviewed,
    ownerScope,
    requestedOwnerScope: requestedOwnerScope ? requestedOwnerScope.toLowerCase() : null,
    assigneeScope,
    requestedAssigneeScope: requestedAssigneeScope ? requestedAssigneeScope.toLowerCase() : null,
    status: status || null,
    dueStatus: dueStatus ? dueStatus.toLowerCase() : null,
    bypassCache
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
        .map((person) => {
          const personTasks = tasksByPersonId.get(person.personId) ?? [];
          const task = firstOpenTask(personTasks);

          return toClassifiedQueueItem({
            person,
            task,
            tasks: personTasks,
            source: 'twenty:person',
            itemWarnings: buildFreshLeadWarnings(person, personTasks),
            suggestedResolutionActions: task ? [] : ['create_next_task'],
            queueClassification: 'fresh_initial_task',
            queueClassificationReasons: buildFreshLeadClassificationReasons(person, task),
            queueSlug,
            query,
            now
          });
        });

    case 'follow-ups': {
      const taskItems = filterFollowUpTasks({
        tasks,
        query,
        hiddenTestPersonIds,
        warnings
      })
        .map((task) => {
          const person = people.find((candidate) => candidate.personId === task.personId);
          const personTasks = person ? tasksByPersonId.get(person.personId) ?? [task] : [task];
          const classification = classifyFollowUpTask({
            person: person ?? createUnknownPersonFromTask(task),
            task,
            tasks: personTasks
          });

          if (!classification.include) {
            return null;
          }

          return toClassifiedQueueItem({
            person: person ?? createUnknownPersonFromTask(task),
            task,
            tasks: personTasks,
            source: task.personId ? 'twenty:task' : 'twenty:task-unlinked',
            itemWarnings: buildTaskAssociationWarnings(task, person),
            queueClassification: classification.queueClassification,
            queueClassificationReasons: classification.reasons,
            queueSlug,
            query,
            now
          });
        })
        .filter(Boolean)
        .filter((item) => item.cadenceName && !isTerminalCadenceStage(item.cadenceStage));
      const taskItemPersonIds = new Set(taskItems.map((item) => item.personId).filter(Boolean));
      const gapItems = people
        .filter((person) => !taskItemPersonIds.has(person.personId))
        .map((person) => ({
          person,
          openTasks: tasksByPersonId.get(person.personId) ?? []
        }))
        .filter(({ person, openTasks }) => isSentInitialFollowUpGap(person, openTasks))
        .map(({ person, openTasks }) => toClassifiedQueueItem({
          person,
          task: firstOpenTask(openTasks),
          tasks: openTasks,
          source: 'twenty:person',
          itemWarnings: ['Initial touch appears sent, but no follow-up task exists.'],
          suggestedResolutionActions: ['create_follow_up_task'],
          queueClassification: 'follow_up_after_initial_sent',
          queueClassificationReasons: [
            'latest_touch_sent',
            'initial_touch_already_sent',
            'needs_next_follow_up_task'
          ],
          queueSlug,
          query,
          now
        }));

      return [...taskItems, ...gapItems];
    }

    case 'unassigned-tasks':
      return tasks
        .filter((task) => isUnassignedTask(task))
        .filter((task) => matchesTaskFilters(task, query))
        .map((task) => toUnassignedTaskQueueItem({ task, now }));

    case 'warm-assessments':
      return people
        .filter((person) => isWarmAssessment(person))
        .map((person) => {
          const personTasks = tasksByPersonId.get(person.personId) ?? [];

          return toClassifiedQueueItem({
            person,
            task: firstOpenTask(personTasks),
            tasks: personTasks,
            source: 'twenty:person',
            itemWarnings: [],
            queueClassification: 'warm_assessment_ready',
            queueClassificationReasons: buildWarmAssessmentClassificationReasons(person),
            queueSlug,
            query,
            now
          });
        });

    case 'stale-recovery':
      return people
        .map((person) => ({
          person,
          openTask: firstOpenTask(tasksByPersonId.get(person.personId)),
          personTasks: tasksByPersonId.get(person.personId) ?? []
        }))
        .filter(({ person, openTask }) => isStaleRecovery(person, now, openTask))
        .map(({ person, openTask, personTasks }) => toClassifiedQueueItem({
          person,
          task: openTask,
          tasks: personTasks,
          source: 'twenty:person',
          itemWarnings: buildStaleWarnings(person, now, openTask),
          queueClassification: 'stale_recovery_stale',
          queueClassificationReasons: buildStaleClassificationReasons(person, now, openTask),
          queueSlug,
          query,
          now
        }));

    case 'pipeline-review':
      {
        const currentFinalQueueByPersonId = buildCurrentFinalQueueByPersonId({
          people,
          tasks,
          tasksByPersonId,
          hiddenTestPersonIds,
          query,
          now
        });

        return people
          .map((person) => {
            const openTask = firstOpenTask(tasksByPersonId.get(person.personId));
            const personTasks = tasksByPersonId.get(person.personId) ?? [];
            const review = getPipelineReview(person, openTask, personTasks);

            return {
              person,
              openTask,
              personTasks,
              reviewWarnings: review.warnings,
              reviewReasons: review.reasons,
              suggestedResolutionActions: review.suggestedResolutionActions
            };
          })
          .filter(({ reviewWarnings }) => reviewWarnings.length > 0)
          .map(({ person, openTask, personTasks, reviewWarnings, reviewReasons, suggestedResolutionActions }) => ({
            person,
            item: toClassifiedQueueItem({
              person,
              task: openTask,
              tasks: personTasks,
              source: 'twenty:person',
              itemWarnings: reviewWarnings,
              reviewReasons,
              suggestedResolutionActions,
              queueClassification: getPipelineReviewClassification(reviewReasons),
              queueClassificationReasons: reviewReasons,
              queueSlug,
              query,
              now
            })
          }))
          .filter(({ person }) =>
            query.includeAllReviewed || query.includeDiagnostics
              ? true
              : currentFinalQueueByPersonId.get(person.personId) === 'pipeline-review'
          )
          .map(({ item }) => item);
      }

    default:
      return [];
  }
}

function buildCurrentFinalQueueByPersonId({
  people = [],
  tasks = [],
  tasksByPersonId = new Map(),
  hiddenTestPersonIds = new Set(),
  query = {},
  now = new Date()
} = {}) {
  const finalQueueByPersonId = new Map();

  for (const queueSlug of ['stale-recovery', 'warm-assessments', 'follow-ups', 'fresh-leads']) {
    const items = selectQueueCandidates({
      queueSlug,
      people,
      tasks,
      tasksByPersonId,
      hiddenTestPersonIds,
      query,
      warnings: [],
      now
    });

    for (const item of items) {
      if (item.personId && !finalQueueByPersonId.has(item.personId)) {
        finalQueueByPersonId.set(item.personId, queueSlug);
      }
    }
  }

  for (const person of people) {
    if (finalQueueByPersonId.has(person.personId) || getTerminalDisposition(person)) {
      continue;
    }

    const openTask = firstOpenTask(tasksByPersonId.get(person.personId));
    const personTasks = tasksByPersonId.get(person.personId) ?? [];
    const review = getPipelineReview(person, openTask, personTasks);

    if (review.warnings.length > 0) {
      finalQueueByPersonId.set(person.personId, 'pipeline-review');
    }
  }

  return finalQueueByPersonId;
}

function normalizePersonRecord({
  person = {},
  tasks = [],
  companiesById = new Map(),
  workspaceMembersById = new Map()
} = {}) {
  const owner = normalizeOwner(person, 'person', workspaceMembersById);
  const openTasks = tasks.filter(isOpenTask);
  const testRecord = detectTestRecord(person);
  const company = resolvePersonCompanyContext(person, companiesById);

  return {
    raw: person,
    personId: stringify(person.id),
    name: getPersonName(person),
    title: firstString(person.jobTitle, person.title),
    companyName: company.name,
    targetCompanyId: company.id,
    companySegment: company.segment,
    companyIndustry: company.industry,
    companyLinkedinUrl: company.linkedinUrl,
    companyResolution: company,
    linkedinUrl: getLinkUrl(person.linkedinLink, person.linkedinLinkPrimaryLinkUrl, person.linkedinUrl),
    email: getEmail(person),
    outboundPipelineType: normalizeSelect(person.outboundPipelineType),
    cadenceName: normalizeSelect(person.cadenceName),
    cadenceStage: normalizeSelect(person.cadenceStage),
    leadHealthScore: normalizeNumber(person.leadHealthScore),
    icpFitScore: normalizeNumber(person.icpFitScore),
    nextOutboundTouchDate: normalizeDateString(person.nextOutboundTouchDate),
    lastOutboundTouchDate: normalizeDateString(person.lastOutboundTouchDate),
    latestTouchChannel: normalizeSelect(person.latestTouchChannel),
    latestTouchStatus: normalizeSelect(person.latestTouchStatus),
    outreachAngle: firstString(person.outreachAngle),
    assessmentCompleted: Boolean(person.assessmentCompleted),
    leadStage: normalizeSelect(person.leadStage),
    leadstageAuto: normalizeSelect(person.leadstageAuto),
    discoveryReadiness: normalizeSelect(person.discoveryReadiness),
    enrichmentStatus: normalizeSelect(person.enrichmentStatus),
    staleRisk: normalizeSelect(person.staleRisk),
    staleRecoveryFlag: normalizeSelect(
      firstString(person.staleRecoveryFlag, person.requiresStaleRecovery, person.staleRecovery)
    ),
    staleRecoveryReason: firstString(person.staleRecoveryReason, person.staleReason, person.recoveryReason),
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

function toClassifiedQueueItem({
  person,
  task,
  tasks = [],
  queueSlug,
  query = {},
  now = new Date(),
  ...item
}) {
  const classification = buildPairClassificationDiagnostic({
    person,
    task,
    tasks,
    queueSlug,
    now
  });

  return toQueueItem({
    ...item,
    person,
    task,
    now,
    queueCandidates: classification,
    classificationDiagnostics: query.includeDiagnostics ? classification : null
  });
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
  classificationDiagnostics = null,
  queueCandidates = null,
  now = new Date()
}) {
  const owner = mergeOwnerContexts(person?.owner, task?.assignee);
  const due = getTaskDueInfo(task, now);
  const stale = getStaleRecoveryMatch(person, now, task);

  return {
    personId: person?.personId ?? task?.personId ?? null,
    taskId: task?.taskId ?? null,
    personName: person?.name ?? null,
    title: person?.title ?? null,
    companyName: person?.companyName ?? null,
    targetCompanyId: person?.targetCompanyId ?? task?.targetCompanyId ?? null,
    companySegment: person?.companySegment ?? null,
    companyIndustry: person?.companyIndustry ?? null,
    companyLinkedinUrl: person?.companyLinkedinUrl ?? null,
    companyResolution: person?.companyResolution
      ? {
          id: person.companyResolution.id,
          name: person.companyResolution.name,
          resolutionStatus: person.companyResolution.resolutionStatus,
          resolutionPath: person.companyResolution.resolutionPath
        }
      : null,
    linkedinUrl: person?.linkedinUrl ?? null,
    email: person?.email ?? null,
    leadStage: person?.leadStage ?? null,
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
    queuePrecedenceApplied: queueCandidates?.finalQueue ?? queueClassification,
    matchedQueueCandidates: queueCandidates?.matchedQueues ?? [],
    excludedQueueCandidates: (queueCandidates?.excludedQueues ?? [])
      .map((excludedQueue) => excludedQueue.queueSlug ?? excludedQueue)
      .filter(Boolean),
    ...(classificationDiagnostics ? { classificationDiagnostics } : {}),
    isOverdueTask: due.isOverdueTask,
    overdueDays: due.overdueDays,
    dueStatus: due.dueStatus,
    staleReason: stale.reason,
    isTestRecord: Boolean(person?.isTestRecord),
    testRecordReasons: person?.testRecordReasons ?? [],
    reviewReasons,
    personLinkSource: task?.personLinkSource ?? null,
    personResolutionPath: task?.personResolutionPath ?? [],
    personResolutionConfidence: task?.personResolutionConfidence ?? null,
    personResolutionEvidence: task?.personResolutionEvidence ?? [],
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

function toUnassignedTaskQueueItem({ task, now = new Date() }) {
  const due = getTaskDueInfo(task, now);

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
    queuePrecedenceApplied: 'unassigned-tasks',
    matchedQueueCandidates: ['unassigned-tasks'],
    excludedQueueCandidates: [],
    isOverdueTask: due.isOverdueTask,
    overdueDays: due.overdueDays,
    dueStatus: due.dueStatus,
    staleReason: null,
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
    person.latestTouchStatus === 'DRAFTED' &&
    !FRESH_EXCLUDED_TOUCH_STATUSES.has(person.latestTouchStatus) &&
    (isInitialOutreachTask(openTask) || !openTask)
  );
}

function isWarmAssessment(person) {
  return (
    person.assessmentCompleted === true ||
    person.leadstageAuto === 'ASSESSMENT_COMPLETED' ||
    WARM_DISCOVERY_STATUSES.has(person.discoveryReadiness)
  );
}

function getStaleRecoveryMatch(person = {}, now = new Date(), task = null) {
  if (!person) {
    return {
      matched: false,
      reason: null,
      reasons: []
    };
  }

  if (STALE_RISK_VALUES.has(person.staleRisk)) {
    return buildStaleMatch(`staleRisk=${person.staleRisk}`, [`stale_risk_${person.staleRisk.toLowerCase()}`]);
  }

  if (EXPLICIT_STALE_FLAGS.has(normalizeSelect(person.staleRecoveryFlag)) || person.staleRecoveryReason) {
    return buildStaleMatch(
      person.staleRecoveryReason || 'Explicit stale recovery flag is set.',
      ['explicit_stale_recovery_flag']
    );
  }

  const lastTouchDate = normalizeDateInput(person.lastOutboundTouchDate);
  const lastTouchAgeDays = lastTouchDate ? daysBetweenDates(lastTouchDate, now) : null;
  const lastTouchOlderThanThreshold =
    lastTouchAgeDays !== null && lastTouchAgeDays > STALE_NO_RESPONSE_DAY_THRESHOLD;
  const hasOpenActionableTask = Boolean(task && isOpenTask(task));

  if (
    person.cadenceStage === 'PAUSED' &&
    (person.latestTouchStatus === 'NO_RESPONSE' || lastTouchOlderThanThreshold)
  ) {
    return buildStaleMatch('Cadence is PAUSED after stalled/no-response outreach.', [
      'cadence_paused_stalled'
    ]);
  }

  if (person.latestTouchStatus === 'NO_RESPONSE' && lastTouchOlderThanThreshold) {
    return buildStaleMatch(
      `Latest touch is NO_RESPONSE and last outbound touch is ${lastTouchAgeDays} days old.`,
      ['latest_touch_no_response', 'last_outbound_touch_older_than_30_days']
    );
  }

  if (lastTouchOlderThanThreshold && !hasOpenActionableTask) {
    return buildStaleMatch(
      `Last outbound touch is ${lastTouchAgeDays} days old and no open actionable task exists.`,
      ['last_outbound_touch_older_than_30_days', 'no_open_actionable_task']
    );
  }

  if (isTerminalCadenceStage(person.cadenceStage) && person.latestTouchStatus === 'NO_RESPONSE' && !hasOpenActionableTask) {
    return buildStaleMatch('Cadence is terminal/expired with no response and no next path.', [
      'terminal_no_response_no_next_path'
    ]);
  }

  return {
    matched: false,
    reason: null,
    reasons: []
  };
}

function buildStaleMatch(reason, reasons = []) {
  return {
    matched: true,
    reason,
    reasons
  };
}

function isStaleRecovery(person, now, task = null) {
  return getStaleRecoveryMatch(person, now, task).matched;
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
  return ['stale_recovery_stale', ...getStaleRecoveryMatch(person, now, task).reasons];
}

function classifyFollowUpTask({ person, task, tasks = [] } = {}) {
  if (!task) {
    return {
      include: false,
      excludedReason: 'No Task available for Follow-Up classification.',
      queueClassification: null,
      reasons: []
    };
  }

  if (isFirstTouchAlreadySent(person) && isPostInitialFollowUpTask(task)) {
    return {
      include: true,
      queueClassification: 'follow_up_after_initial_sent',
      reasons: ['latest_touch_sent', 'initial_touch_already_sent', 'open_follow_up_task']
    };
  }

  if (isFirstTouchAlreadySent(person) && isInitialOutreachTask(task) && !hasPostInitialFollowUpTask(tasks)) {
    return {
      include: false,
      excludedReason: 'Initial touch is already marked SENT; create a post-initial follow-up task.',
      queueClassification: null,
      reasons: ['latest_touch_sent', 'initial_touch_already_sent', 'needs_next_follow_up_task']
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
  if (reviewReasons.includes('ready_for_normalization')) {
    return 'pipeline_review_ready_for_normalization';
  }

  if (reviewReasons.includes('needs_manual_normalization')) {
    return 'pipeline_review_needs_manual_normalization';
  }

  if (reviewReasons.includes('company_relation_unresolved')) {
    return 'pipeline_review_company_relation_unresolved';
  }

  if (reviewReasons.includes('enrichment_partial')) {
    return 'pipeline_review_missing_enrichment';
  }

  if (reviewReasons.includes('missing_next_task') || reviewReasons.includes('missing_follow_up_task')) {
    return 'pipeline_review_missing_next_task';
  }

  return 'pipeline_review_manual_review';
}

function buildPairClassificationDiagnostic({
  person,
  task,
  tasks = [],
  queueSlug = null,
  now = new Date()
} = {}) {
  const matchedQueues = [];
  const excludedQueues = [];
  const classificationReasons = [];
  const taskList = tasks.length > 0 ? tasks : task ? [task] : [];

  if (person && isStaleRecovery(person, now, task)) {
    matchedQueues.push('stale-recovery');
    classificationReasons.push(...buildStaleClassificationReasons(person, now, task));
  }

  if (person && isWarmAssessment(person)) {
    matchedQueues.push('warm-assessments');
    classificationReasons.push(...buildWarmAssessmentClassificationReasons(person));
  }

  if (person && isSentInitialFollowUpGap(person, taskList)) {
    matchedQueues.push('follow-ups');
    classificationReasons.push(
      'latest_touch_sent',
      'initial_touch_already_sent',
      'needs_next_follow_up_task'
    );
  } else if (task) {
    const followUp = classifyFollowUpTask({ person, task, tasks: taskList });

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

  if (person && isFreshLead(person, taskList)) {
    matchedQueues.push('fresh-leads');
    classificationReasons.push(...buildFreshLeadClassificationReasons(person, task));
  }

  if (person) {
    const review = getPipelineReview(person, task, taskList);

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

function isPostInitialFollowUpTask(task) {
  if (!task || !isOpenTask(task)) {
    return false;
  }

  const text = getTaskClassificationText(task);

  return (
    isPostInitialCadenceStage(task.cadenceStage) ||
    isLegacyFollowUpTask(task) ||
    POST_INITIAL_TASK_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function hasPostInitialFollowUpTask(tasks = []) {
  return (tasks ?? []).some(isPostInitialFollowUpTask);
}

function isFirstTouchAlreadySent(person = {}) {
  return (
    FRESH_CADENCE_STAGES.has(person?.cadenceStage) &&
    FIRST_TOUCH_SENT_STATUSES.has(person?.latestTouchStatus)
  );
}

function isSentInitialFollowUpGap(person = {}, tasks = []) {
  return isFirstTouchAlreadySent(person) && !hasPostInitialFollowUpTask(tasks);
}

function isSentInitialGapProtectedFromStale(person = {}, task = null) {
  return isFirstTouchAlreadySent(person) && (!task || isInitialOutreachTask(task));
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

function getPipelineReview(person, openTask, tasks = []) {
  const warnings = [];
  const reasons = [];
  const suggestedResolutionActions = [];

  if (!person.email) {
    warnings.push('Missing email.');
    reasons.push('missing_email');
  }

  if (!person.linkedinUrl) {
    warnings.push('Missing LinkedIn URL.');
    reasons.push('missing_linkedin');
  }

  if (!person.companyName && !person.targetCompanyId) {
    warnings.push('Missing company.');
    reasons.push('missing_company');
    suggestedResolutionActions.push('enrich_company');
  } else if (!person.companyName && person.targetCompanyId) {
    warnings.push('Company relation exists, but the Company name could not be resolved from queue reads.');
    reasons.push('company_relation_unresolved');
    suggestedResolutionActions.push('review_company_relation');
  }

  if (!person.cadenceName) {
    warnings.push('Missing cadence name.');
    reasons.push('missing_outbound_fields');
  }

  if (!person.cadenceStage) {
    warnings.push('Missing cadence stage.');
    reasons.push('missing_outbound_fields');
  }

  if (!person.outboundPipelineType) {
    warnings.push('Missing outbound pipeline type.');
    reasons.push('missing_outbound_fields');
  }

  if (isManualLeadNormalizationCandidate(person)) {
    warnings.push('Manual CRM lead has enough signal for outbound normalization planning.');
    reasons.push('needs_manual_normalization', 'ready_for_normalization');
    suggestedResolutionActions.push('normalize_manual_lead');
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
    suggestedResolutionActions.push('create_first_task');
  }

  if (isSentInitialFollowUpGap(person, tasks)) {
    warnings.push('Initial touch appears sent, but no follow-up task exists.');
    reasons.push('missing_follow_up_task');
    suggestedResolutionActions.push('create_follow_up_task');
  }

  if (person.isTestRecord) {
    warnings.push('Record appears to be a test or synthetic lead.');
    reasons.push('test_record');
  }

  return {
    warnings,
    reasons: uniqueStrings(reasons),
    suggestedResolutionActions: uniqueStrings(suggestedResolutionActions)
  };
}

function isManualLeadNormalizationCandidate(person = {}) {
  const missingOutboundFields = !person.outboundPipelineType || !person.cadenceName || !person.cadenceStage;
  const hasCrmSignal = Boolean(
    person.leadStage ||
      person.linkedinUrl ||
      person.email ||
      person.targetCompanyId ||
      person.companyName ||
      person.owner?.id ||
      person.owner?.email ||
      person.raw?.createdBy ||
      person.raw?.createdById
  );

  return missingOutboundFields && hasCrmSignal && person.assessmentCompleted !== true;
}

function getRecommendedClassificationFix({ person, task, tasks = [], diagnostic } = {}) {
  if (person && isSentInitialFollowUpGap(person, tasks)) {
    return 'create_follow_up_task';
  }

  if (person && isFreshLead(person, tasks) && !firstOpenTask(tasks)) {
    return 'create_first_task';
  }

  if (diagnostic?.finalQueue === 'follow-ups') {
    return task ? 'work_follow_up_task' : 'create_follow_up_task';
  }

  if (diagnostic?.finalQueue === 'stale-recovery') {
    return 'review_stale_recovery';
  }

  if (diagnostic?.finalQueue === 'pipeline-review') {
    return 'review_pipeline_gaps';
  }

  return null;
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

function getTaskDueInfo(task = null, now = new Date()) {
  const dueDate = normalizeDateInput(task?.dueDate);

  if (!task || !dueDate) {
    return {
      dueStatus: 'none',
      isOverdueTask: false,
      overdueDays: null
    };
  }

  const dueDateOnly = toDateOnly(dueDate);
  const todayDateOnly = toDateOnly(normalizeDateInput(now) ?? new Date());

  if (dueDateOnly < todayDateOnly) {
    return {
      dueStatus: 'overdue',
      isOverdueTask: true,
      overdueDays: Math.max(daysBetweenDates(dueDate, now), 1)
    };
  }

  if (dueDateOnly === todayDateOnly) {
    return {
      dueStatus: 'due_today',
      isOverdueTask: false,
      overdueDays: 0
    };
  }

  return {
    dueStatus: 'upcoming',
    isOverdueTask: false,
    overdueDays: null
  };
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

export function createCompanyIndex(companies = []) {
  return new Map(
    (companies ?? [])
      .filter((company) => getCompanyRecordId(company))
      .map((company) => [
        String(getCompanyRecordId(company)),
        normalizeCompanyRecord(company)
      ])
  );
}

export function normalizeCompanyRecord(company = {}) {
  return {
    id: getCompanyRecordId(company),
    name: getCompanyRecordName(company),
    segment: normalizeSelect(firstString(company.segment, company.segmentSelect, company.segment?.value, company.segment?.name)),
    industry: normalizeSelect(firstString(company.industry, company.industrySelect, company.industry?.value, company.industry?.name)),
    linkedinUrl: getLinkUrl(company.linkedinLink, company.linkedinLinkPrimaryLinkUrl, company.linkedinUrl),
    website: getLinkUrl(company.domainName, company.domainNamePrimaryLinkUrl, company.website, company.companyWebsite)
  };
}

export function resolvePersonCompanyContext(person = {}, companiesById = new Map()) {
  const relation = firstObject(
    person.company,
    person.primaryCompany,
    person.account,
    person.companyId && companiesById.get(String(person.companyId)),
    person.companyID && companiesById.get(String(person.companyID))
  );
  const relationId = firstString(
    person.companyId,
    person.companyID,
    person.company?.id,
    person.company?.recordId,
    person.company?.targetObjectId,
    person.company?.value,
    person.primaryCompany?.id,
    person.primaryCompany?.recordId,
    person.account?.id,
    person.companies?.[0]?.id,
    person.companies?.[0]?.recordId,
    person.companyIds?.[0]
  );
  const indexed = relationId ? companiesById.get(String(relationId)) : null;
  const source = indexed ?? normalizeCompanyRecord(relation ?? {});
  const name = firstString(
    source.name,
    getCompanyRecordName(relation),
    person.companyName,
    person.companyNameName
  );
  const id = firstString(source.id, relationId);
  const resolutionPath = [
    indexed ? 'companiesById' : null,
    relationId ? 'person.companyId/company relation id' : null,
    relation ? 'person.company expanded relation' : null,
    person.companyName || person.companyNameName ? 'person flattened company name' : null
  ].filter(Boolean);

  return {
    id: id || null,
    name: name || null,
    segment: source.segment || null,
    industry: source.industry || null,
    linkedinUrl: source.linkedinUrl || null,
    website: source.website || null,
    relationExists: Boolean(id || name),
    resolutionStatus: id && indexed
      ? 'resolved_from_company_read'
      : id
        ? 'resolved_relation_id_only'
        : name
          ? 'resolved_name_only'
          : 'missing',
    resolutionPath,
    rawRelation: relation ?? null
  };
}

function getCompanyRecordId(company = {}) {
  company = company ?? {};
  return firstString(company.id, company.recordId, company.companyId, company.companyID);
}

function getCompanyRecordName(company = {}) {
  company = company ?? {};
  return firstString(
    company.name,
    company.displayName,
    company.name?.name,
    company.name?.fullName,
    company.companyName
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

function buildStaleWarnings(person, now = new Date(), task = null) {
  const warnings = [];
  const stale = getStaleRecoveryMatch(person, now, task);

  if (STALE_RISK_VALUES.has(person.staleRisk)) {
    warnings.push(`Stale risk is ${person.staleRisk}.`);
  }

  if (stale.reason && !warnings.includes(stale.reason)) {
    warnings.push(stale.reason);
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
    lastOutboundTouchDate: null,
    latestTouchChannel: task.latestTouchChannel,
    latestTouchStatus: task.latestTouchStatus,
    outreachAngle: null,
    source: 'TWENTY_TASK',
    owner: null,
    staleRisk: null,
    staleRecoveryFlag: null,
    staleRecoveryReason: null,
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
  return stringify(resolvePersonCompanyContext(person).id);
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
  return firstString(resolvePersonCompanyContext(person).name);
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

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) ?? null;
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

function daysBetweenDates(left, right) {
  const leftDate = normalizeDateInput(left);
  const rightDate = normalizeDateInput(right) ?? new Date();

  if (!leftDate) {
    return null;
  }

  const leftStart = Date.UTC(leftDate.getUTCFullYear(), leftDate.getUTCMonth(), leftDate.getUTCDate());
  const rightStart = Date.UTC(rightDate.getUTCFullYear(), rightDate.getUTCMonth(), rightDate.getUTCDate());

  return Math.floor((rightStart - leftStart) / 86_400_000);
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.length > 0)));
}
