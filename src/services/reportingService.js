import {
  buildQueue,
  buildQueueCoverageAudit,
  createWorkspaceMemberIndex,
  normalizeQueueQuery
} from './queueService.js';

const QUEUE_SLUGS = [
  'fresh-leads',
  'follow-ups',
  'warm-assessments',
  'stale-recovery',
  'pipeline-review',
  'unassigned-tasks'
];

const OPEN_TASK_STATUSES = new Set(['TODO', 'OPEN', 'IN_PROGRESS', 'NOT_STARTED']);

export function buildExecutiveReporting({
  people = [],
  companies = [],
  tasks = [],
  taskTargets = [],
  workspaceMembers = [],
  workspaceUser = {},
  query = {},
  now = new Date(),
  diagnostics = {}
} = {}) {
  const snapshot = buildReportingSnapshot({
    people,
    companies,
    tasks,
    taskTargets,
    workspaceMembers,
    workspaceUser,
    query,
    now
  });
  const dispositions = snapshot.scopedSummary.countsByDisposition ?? {};

  return {
    reportName: 'executive',
    generatedAt: now.toISOString(),
    ownerScope: snapshot.normalizedQuery.ownerScope,
    assigneeScope: snapshot.normalizedQuery.assigneeScope,
    metrics: {
      totalPeople: snapshot.coverage.summary.totalPeople,
      hiddenTestRecords: snapshot.scopedSummary.hiddenTestRecords,
      expectedRealPeople: snapshot.scopedSummary.expectedRealPeople,
      activeLeads: Math.max(
        snapshot.scopedSummary.expectedRealPeople -
          (dispositions.terminal_closed ?? 0) -
          (dispositions.active_client ?? 0),
        0
      ),
      freshLeads: snapshot.queueCounts.freshLeads,
      followUps: snapshot.queueCounts.followUps,
      warmAssessments: snapshot.queueCounts.warmAssessments,
      pipelineReview: snapshot.queueCounts.pipelineReview,
      staleRecovery: snapshot.queueCounts.staleRecovery,
      activeClients: dispositions.active_client ?? 0,
      unclassifiedPeople: snapshot.scopedSummary.unclassifiedPeople,
      totalOpenTasks: countOpenTasks(snapshot.scopedTasks, snapshot.normalizedQuery, workspaceUser),
      overdueTasks: countOverdueTasks(snapshot.scopedTasks, now, snapshot.normalizedQuery, workspaceUser)
    },
    diagnostics: snapshot.normalizedQuery.includeDiagnostics
      ? {
          ...diagnostics,
          countsByDisposition: snapshot.scopedSummary.countsByDisposition,
          countsByFinalQueue: snapshot.scopedSummary.countsByFinalQueue,
          countsByExclusionReason: snapshot.scopedSummary.countsByExclusionReason,
          duplicateMultiQueueCandidateCount:
            snapshot.scopedSummary.duplicateMultiQueueCandidateCount,
          queueCounts: snapshot.queueCounts,
          overdueCountsByQueue: snapshot.overdueCountsByQueue
        }
      : undefined,
    warnings: []
  };
}

export function buildQueueHealthReporting({
  people = [],
  companies = [],
  tasks = [],
  taskTargets = [],
  workspaceMembers = [],
  workspaceUser = {},
  query = {},
  now = new Date(),
  diagnostics = {}
} = {}) {
  const snapshot = buildReportingSnapshot({
    people,
    companies,
    tasks,
    taskTargets,
    workspaceMembers,
    workspaceUser,
    query,
    now
  });
  const exclusionReasons = snapshot.scopedSummary.countsByExclusionReason ?? {};

  return {
    reportName: 'queue-health',
    generatedAt: now.toISOString(),
    ownerScope: snapshot.normalizedQuery.ownerScope,
    assigneeScope: snapshot.normalizedQuery.assigneeScope,
    metrics: {
      queueCounts: snapshot.queueCounts,
      overdueCountsByQueue: snapshot.overdueCountsByQueue,
      ownerMissing: snapshot.realCoverageRecords.filter((record) => !hasOwner(record.owner)).length,
      emailMissing: snapshot.realCoverageRecords.filter((record) => !record.email).length,
      companyMissing: snapshot.realCoverageRecords.filter(
        (record) => !record.companyName && !record.targetCompanyId
      ).length,
      linkedinMissing: snapshot.realCoverageRecords.filter((record) => !record.linkedinUrl).length,
      enrichmentPartial: exclusionReasons.enrichment_partial ?? 0,
      missingNextTask:
        (exclusionReasons.missing_next_task ?? 0) +
        (exclusionReasons.missing_follow_up_task ?? 0),
      unresolvedReviewItems: snapshot.queueCounts.pipelineReview,
      unassignedTasks: snapshot.queueCounts.unassignedTasks,
      hiddenTestRecords: snapshot.scopedSummary.hiddenTestRecords
    },
    diagnostics: snapshot.normalizedQuery.includeDiagnostics
      ? {
          ...diagnostics,
          expectedRealPeople: snapshot.scopedSummary.expectedRealPeople,
          countsByDisposition: snapshot.scopedSummary.countsByDisposition,
          countsByFinalQueue: snapshot.scopedSummary.countsByFinalQueue,
          countsByExclusionReason: exclusionReasons,
          duplicateMultiQueueCandidateCount:
            snapshot.scopedSummary.duplicateMultiQueueCandidateCount
        }
      : undefined,
    warnings: []
  };
}

export function buildRepPerformanceReporting({
  people = [],
  companies = [],
  tasks = [],
  taskTargets = [],
  workspaceMembers = [],
  outboundEvents = [],
  crmSyncLogs = [],
  assessmentSubmissions = [],
  workspaceUser = {},
  query = {},
  now = new Date(),
  diagnostics = {}
} = {}) {
  const snapshot = buildReportingSnapshot({
    people,
    companies,
    tasks,
    taskTargets,
    workspaceMembers,
    workspaceUser,
    query,
    now
  });
  const dateRange = resolveReportingDateRange(query, now);
  const buckets = new Map();
  const workspaceMembersById = createWorkspaceMemberIndex(workspaceMembers);
  const ensureBucket = (owner, fallback = {}) =>
    ensureRepBucket(buckets, owner, fallback);

  for (const record of snapshot.realCoverageRecords) {
    const bucket = ensureBucket(record.owner, {
      source: 'person_owner',
      workspaceUser
    });

    bucket.metrics.leadsOwned += 1;

    if (!['terminal_closed', 'active_client'].includes(record.disposition)) {
      bucket.metrics.activeLeadCount += 1;
    }

    if (record.disposition === 'follow_up') {
      bucket.metrics.followUpCount += 1;
    }

    if (record.disposition === 'fresh_lead') {
      bucket.metrics.freshLeadCount += 1;
    }

    if (record.disposition === 'pipeline_review') {
      bucket.metrics.pipelineReviewCount += 1;
    }
  }

  for (const task of tasks) {
    const bucket = ensureBucket(readTaskAssignee(task, workspaceMembersById), {
      source: 'task_assignee',
      workspaceUser
    });
    const dueDate = getTaskDueDate(task);

    if (isOpenTask(task)) {
      bucket.metrics.openTasksAssigned += 1;

      if (isPastDate(dueDate, now)) {
        bucket.metrics.overdueTasksAssigned += 1;
      }
    }

    if (isWithinDateRange(readTaskCreatedAt(task), dateRange)) {
      bucket.metrics.tasksCreated += 1;
    }

    if (isCompletedTask(task) && isWithinDateRange(readTaskCompletedAt(task), dateRange)) {
      bucket.metrics.tasksCompleted += 1;
    }
  }

  for (const event of outboundEvents) {
    if (!isWithinDateRange(readRecordDate(event), dateRange)) {
      continue;
    }

    const bucket = ensureBucket(readEventActor(event), {
      source: 'outbound_event_actor',
      workspaceUser
    });
    const eventType = normalizeSelect(event.event_type ?? event.eventType);
    const status = normalizeSelect(event.status);
    const payload = event.payload ?? {};
    const touchStatus = normalizeSelect(
      payload.touchStatus ??
        payload.completion?.touchStatus ??
        payload.completion?.status ??
        payload.latestTouchStatus
    );
    const cadenceStage = normalizeSelect(
      payload.cadenceStage ??
        payload.nextCadenceStage ??
        payload.recommendedNextCadenceStage ??
        payload.completion?.cadenceStage
    );

    if (isTaskCreationEvent(eventType)) {
      bucket.metrics.tasksCreated += 1;
    }

    if (eventType === 'TASK_COMPLETED') {
      bucket.metrics.tasksCompleted += 1;
    }

    if (status === 'SENT' || touchStatus === 'SENT' || eventType === 'TASK_COMPLETED') {
      bucket.metrics.touchesSent += 1;
    }

    if (touchStatus === 'RESPONDED' || eventType === 'RESPONSE_RECEIVED') {
      bucket.metrics.responses += 1;
    }

    if (touchStatus === 'NO_RESPONSE') {
      bucket.metrics.noResponses += 1;
    }

    if (cadenceStage === 'DISCOVERY_ASK' || eventType === 'DISCOVERY_REQUESTED') {
      bucket.metrics.discoveryRequests += 1;
    }

    if (
      cadenceStage === 'ASSESSMENT_POSITIONING' ||
      cadenceStage === 'ASSESSMENT_SENT' ||
      eventType === 'ASSESSMENT_REQUESTED'
    ) {
      bucket.metrics.assessmentRequests += 1;
    }
  }

  for (const submission of assessmentSubmissions) {
    if (!isWithinDateRange(readRecordDate(submission), dateRange)) {
      continue;
    }

    const bucket = ensureBucket(readAssessmentSubmissionOwner(submission), {
      source: 'assessment_submission',
      workspaceUser
    });

    bucket.metrics.assessmentCompletions += 1;
  }

  const scopedBuckets = scopeRepBuckets({
    buckets: [...buckets.values()],
    normalizedQuery: snapshot.normalizedQuery,
    workspaceUser
  });
  const reps = scopedBuckets
    .map((bucket) => ({
      repKey: bucket.repKey,
      ownerEmail: bucket.ownerEmail,
      ownerName: bucket.ownerName,
      source: bucket.source,
      metrics: bucket.metrics
    }))
    .sort(compareRepBuckets);

  return {
    reportName: 'rep-performance',
    generatedAt: now.toISOString(),
    ownerScope: snapshot.normalizedQuery.ownerScope,
    assigneeScope: snapshot.normalizedQuery.assigneeScope,
    dateRange: {
      startDate: dateRange.startDate.toISOString(),
      endDate: dateRange.endDate.toISOString()
    },
    metrics: {
      totals: sumRepMetrics(reps.map((rep) => rep.metrics)),
      reps
    },
    diagnostics: snapshot.normalizedQuery.includeDiagnostics
      ? {
          ...diagnostics,
          repCount: reps.length,
          missingOwnerBucketPresent: reps.some((rep) => rep.repKey === 'missing_owner'),
          sourceCounts: {
            people: people.length,
            tasks: tasks.length,
            outboundEvents: outboundEvents.length,
            crmSyncLogs: crmSyncLogs.length,
            assessmentSubmissions: assessmentSubmissions.length
          },
          countsByDisposition: snapshot.scopedSummary.countsByDisposition
        }
      : undefined,
    warnings: []
  };
}

function buildReportingSnapshot({
  people = [],
  companies = [],
  tasks = [],
  taskTargets = [],
  workspaceMembers = [],
  workspaceUser = {},
  query = {},
  now = new Date()
} = {}) {
  const normalizedQuery = normalizeQueueQuery(query, workspaceUser);
  const queues = Object.fromEntries(
    QUEUE_SLUGS.map((queueSlug) => [
      queueSlug,
      buildQueue({
        queueSlug,
        people,
        companies,
        tasks,
        taskTargets,
        workspaceMembers,
        workspaceUser,
        query: {
          ...normalizedQuery,
          includeDiagnostics: false,
          includeAllReviewed: false,
          limit: 1,
          offset: 0
        },
        now
      })
    ])
  );
  const coverage = buildQueueCoverageAudit({
    people,
    companies,
    tasks,
    taskTargets,
    workspaceMembers,
    query: normalizedQuery,
    now
  });
  const scopedCoverageRecords = scopeCoverageRecords({
    records: coverage.records ?? [],
    normalizedQuery,
    workspaceUser
  });
  const scopedSummary = summarizeScopedCoverage(scopedCoverageRecords);

  return {
    normalizedQuery,
    queues,
    coverage,
    scopedCoverageRecords,
    realCoverageRecords: scopedCoverageRecords.filter(
      (record) => record.disposition !== 'hidden_test_record'
    ),
    scopedSummary,
    scopedTasks: scopeTasks({
      tasks,
      normalizedQuery,
      workspaceUser
    }),
    queueCounts: buildFinalQueueCounts(scopedSummary, queues),
    overdueCountsByQueue: {
      freshLeads: queues['fresh-leads'].overdueCount,
      followUps: queues['follow-ups'].overdueCount,
      warmAssessments: queues['warm-assessments'].overdueCount,
      staleRecovery: queues['stale-recovery'].overdueCount,
      pipelineReview: queues['pipeline-review'].overdueCount,
      unassignedTasks: queues['unassigned-tasks'].overdueCount
    }
  };
}

function createEmptyRepMetrics() {
  return {
    leadsOwned: 0,
    openTasksAssigned: 0,
    overdueTasksAssigned: 0,
    tasksCreated: 0,
    tasksCompleted: 0,
    touchesSent: 0,
    responses: 0,
    noResponses: 0,
    discoveryRequests: 0,
    assessmentRequests: 0,
    assessmentCompletions: 0,
    activeLeadCount: 0,
    followUpCount: 0,
    freshLeadCount: 0,
    pipelineReviewCount: 0
  };
}

function ensureRepBucket(buckets, owner, { source = 'unknown', workspaceUser = {} } = {}) {
  const normalizedOwner = normalizeRepOwner(owner, workspaceUser);
  const existing = buckets.get(normalizedOwner.repKey);

  if (existing) {
    return existing;
  }

  const bucket = {
    ...normalizedOwner,
    source,
    metrics: createEmptyRepMetrics()
  };

  buckets.set(normalizedOwner.repKey, bucket);
  return bucket;
}

function normalizeRepOwner(owner = {}, workspaceUser = {}) {
  const emails = getOwnerEmails(owner);
  const email = emails[0] ?? '';
  const name = firstString(
    owner?.name,
    owner?.fullName,
    owner?.displayName,
    owner?.taskAssignee?.name,
    owner?.assignee?.name
  );
  const id = firstString(owner?.id, owner?.workspaceMemberId, owner?.userId);

  if (email || name || id) {
    return {
      repKey: email || id || normalizeKey(name),
      ownerEmail: email || null,
      ownerName: name || email || id || 'Unknown rep'
    };
  }

  return {
    repKey: 'missing_owner',
    ownerEmail: null,
    ownerName: 'Missing owner / assignee'
  };
}

function scopeRepBuckets({ buckets = [], normalizedQuery = {}, workspaceUser = {} } = {}) {
  if (normalizedQuery.ownerScope !== 'mine') {
    return buckets;
  }

  const workspaceEmail = normalizeEmail(workspaceUser.email);

  if (!workspaceEmail) {
    return buckets;
  }

  return buckets.filter(
    (bucket) => bucket.ownerEmail === workspaceEmail || bucket.repKey === 'missing_owner'
  );
}

function sumRepMetrics(metrics = []) {
  return metrics.reduce((acc, metric) => {
    for (const key of Object.keys(acc)) {
      acc[key] += Number(metric[key] ?? 0);
    }

    return acc;
  }, createEmptyRepMetrics());
}

function compareRepBuckets(left, right) {
  if (left.repKey === 'missing_owner') {
    return 1;
  }

  if (right.repKey === 'missing_owner') {
    return -1;
  }

  return String(left.ownerName ?? left.repKey).localeCompare(String(right.ownerName ?? right.repKey));
}

function buildFinalQueueCounts(scopedSummary = {}, queues = {}) {
  const dispositions = scopedSummary.countsByDisposition ?? {};

  return {
    freshLeads: dispositions.fresh_lead ?? 0,
    followUps: dispositions.follow_up ?? 0,
    warmAssessments: dispositions.warm_assessment ?? 0,
    staleRecovery: dispositions.stale_recovery ?? 0,
    pipelineReview: dispositions.pipeline_review ?? 0,
    unassignedTasks: queues['unassigned-tasks']?.totalCount ?? 0
  };
}

function scopeCoverageRecords({ records = [], normalizedQuery = {}, workspaceUser = {} } = {}) {
  if (normalizedQuery.ownerScope !== 'mine') {
    return records;
  }

  const workspaceEmail = normalizeEmail(workspaceUser.email);

  if (!workspaceEmail) {
    return records;
  }

  return records.filter((record) => {
    if (record.disposition === 'hidden_test_record') {
      return getOwnerEmails(record.owner).includes(workspaceEmail);
    }

    const ownerEmails = getOwnerEmails(record.owner);
    return ownerEmails.length === 0 || ownerEmails.includes(workspaceEmail);
  });
}

function scopeTasks({ tasks = [], normalizedQuery = {}, workspaceUser = {} } = {}) {
  if (normalizedQuery.assigneeScope !== 'mine' && normalizedQuery.ownerScope !== 'mine') {
    return tasks;
  }

  const workspaceEmail = normalizeEmail(workspaceUser.email);

  if (!workspaceEmail) {
    return tasks;
  }

  return tasks.filter((task) => {
    const ownerEmails = getOwnerEmails(task.assignee ?? task.owner ?? task.workspaceMember);
    return ownerEmails.length === 0 || ownerEmails.includes(workspaceEmail);
  });
}

function summarizeScopedCoverage(records = []) {
  const totalPeople = records.length;
  const hiddenTestRecords = records.filter(
    (record) => record.disposition === 'hidden_test_record'
  ).length;
  const realRecords = records.filter((record) => record.disposition !== 'hidden_test_record');
  const unclassifiedPeople = realRecords.filter(
    (record) => record.disposition === 'unclassified_needs_rule'
  ).length;

  return {
    totalPeople,
    hiddenTestRecords,
    expectedRealPeople: totalPeople - hiddenTestRecords,
    accountedForPeople: totalPeople - hiddenTestRecords - unclassifiedPeople,
    unclassifiedPeople,
    countsByFinalQueue: countBy(records, (record) => record.finalQueue ?? 'none'),
    countsByDisposition: countBy(records, (record) => record.disposition ?? 'none'),
    countsByExclusionReason: countBy(
      realRecords.flatMap((record) => record.exclusionReasons ?? []),
      (reason) => reason
    ),
    duplicateMultiQueueCandidateCount: realRecords.filter(
      (record) => (record.matchedQueueCandidates ?? []).length > 1
    ).length
  };
}

function countOpenTasks(tasks = [], normalizedQuery = {}, workspaceUser = {}) {
  return scopeTasks({ tasks, normalizedQuery, workspaceUser }).filter(isOpenTask).length;
}

function countOverdueTasks(tasks = [], now = new Date(), normalizedQuery = {}, workspaceUser = {}) {
  return scopeTasks({ tasks, normalizedQuery, workspaceUser }).filter(
    (task) => isOpenTask(task) && isPastDate(getTaskDueDate(task), now)
  ).length;
}

function resolveReportingDateRange(query = {}, now = new Date()) {
  const endDate =
    normalizeDateInput(query.endDate ?? query.to ?? query.until) ??
    new Date(now);
  const startDate =
    normalizeDateInput(query.startDate ?? query.from ?? query.since) ??
    addDays(endDate, -30);

  return {
    startDate,
    endDate
  };
}

function readTaskAssignee(task = {}, workspaceMembersById = new Map()) {
  const assigneeId = firstString(
    task.assigneeId,
    task.assignee?.id,
    task.assignee?.workspaceMemberId,
    task.ownerId,
    task.owner?.id,
    task.workspaceMemberId
  );
  const indexed = assigneeId ? workspaceMembersById.get(String(assigneeId)) : null;

  return firstObject(
    indexed,
    task.assignee,
    task.owner,
    task.workspaceMember,
    task.assigneeId || task.assigneeEmail || task.ownerEmail
      ? {
          id: task.assigneeId,
          email: task.assigneeEmail,
          userEmail: task.assigneeEmail ?? task.ownerEmail,
          name: task.assigneeName ?? task.ownerName
        }
      : null
  );
}

function readTaskCreatedAt(task = {}) {
  return normalizeDateInput(task.createdAt ?? task.created_at);
}

function readTaskCompletedAt(task = {}) {
  return normalizeDateInput(
    task.completedAt ??
      task.completed_at ??
      task.doneAt ??
      task.done_at ??
      task.updatedAt ??
      task.updated_at
  );
}

function isCompletedTask(task = {}) {
  return ['DONE', 'COMPLETED', 'COMPLETE'].includes(normalizeSelect(task.status));
}

function readRecordDate(record = {}) {
  return normalizeDateInput(
    record.created_at ??
      record.createdAt ??
      record.finished_at ??
      record.finishedAt ??
      record.processed_at ??
      record.processedAt ??
      record.scheduled_for ??
      record.scheduledFor
  );
}

function readEventActor(event = {}) {
  const payload = event.payload ?? {};
  const approval = event.approval_payload ?? event.approvalPayload ?? {};

  return firstObject(
    payload.workspaceUser,
    payload.actor,
    payload.owner,
    payload.assignee,
    approval.workspaceUser,
    approval.actor,
    event.actor,
    event.actorEmail || event.actor_email
      ? {
          email: event.actorEmail ?? event.actor_email,
          name: event.actorName ?? event.actor_name
        }
      : null
  );
}

function readCrmLogActor(log = {}) {
  const requestPayload = log.request_payload ?? log.requestPayload ?? {};
  const responsePayload = log.response_payload ?? log.responsePayload ?? {};

  return firstObject(
    requestPayload.workspaceUser,
    requestPayload.owner,
    requestPayload.assignee,
    responsePayload.workspaceUser,
    log.actor,
    log.actorEmail || log.actor_email
      ? {
          email: log.actorEmail ?? log.actor_email,
          name: log.actorName ?? log.actor_name
        }
      : null
  );
}

function readAssessmentSubmissionOwner(submission = {}) {
  const normalizedPayload = submission.normalized_payload ?? submission.normalizedPayload ?? {};
  const rawPayload = submission.raw_payload ?? submission.rawPayload ?? {};

  return firstObject(
    normalizedPayload.owner,
    normalizedPayload.workspaceUser,
    rawPayload.owner,
    rawPayload.workspaceUser,
    submission.owner,
    submission.ownerEmail || submission.owner_email
      ? {
          email: submission.ownerEmail ?? submission.owner_email,
          name: submission.ownerName ?? submission.owner_name
        }
      : null
  );
}

function isTaskCreationEvent(eventType = '') {
  return [
    'MISSING_NEXT_TASK_CREATED',
    'SENT_INITIAL_FOLLOW_UP_CREATED',
    'NEXT_TASK_CREATED',
    'TASK_CREATED'
  ].includes(eventType);
}

function isWithinDateRange(date, { startDate, endDate } = {}) {
  if (!date) {
    return false;
  }

  return date.getTime() >= startDate.getTime() && date.getTime() <= endOfDay(endDate).getTime();
}

function isOpenTask(task = {}) {
  return OPEN_TASK_STATUSES.has(normalizeSelect(task.status));
}

function getTaskDueDate(task = {}) {
  return normalizeDateInput(task.dueAt ?? task.dueDate ?? task.due_date);
}

function isPastDate(date, now = new Date()) {
  if (!date) {
    return false;
  }

  return toDateOnly(date) < toDateOnly(now);
}

function hasOwner(owner = {}) {
  return getOwnerEmails(owner).length > 0 || Boolean(owner?.id || owner?.workspaceMemberId);
}

function getOwnerEmails(owner = {}) {
  if (!owner) {
    return [];
  }

  return [
    owner.email,
    owner.userEmail,
    owner.ownerEmail,
    owner.taskAssignee?.email,
    owner.assignee?.email
  ]
    .map(normalizeEmail)
    .filter(Boolean);
}

function countBy(values = [], selector = (value) => value) {
  return values.reduce((acc, value) => {
    const key = selector(value) || 'none';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function normalizeSelect(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'object') {
    return normalizeSelect(value.value ?? value.name ?? value.label);
  }

  return String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeKey(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : '';
}

function normalizeDateInput(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateOnly(value) {
  return normalizeDateInput(value).toISOString().slice(0, 10);
}

function endOfDay(value) {
  const date = normalizeDateInput(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function addDays(value, days) {
  const source = normalizeDateInput(value) ?? new Date();
  const date = new Date(source.getTime());
  date.setDate(date.getDate() + days);
  return date;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object') ?? null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}
