import {
  buildQueue,
  buildQueueCoverageAudit,
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
