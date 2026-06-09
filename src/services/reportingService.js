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

export function buildOperationsReporting({
  outboundEvents = [],
  crmSyncLogs = [],
  assessmentSubmissions = [],
  query = {},
  now = new Date(),
  diagnostics = {}
} = {}) {
  const dateRange = resolveReportingDateRange(query, now);
  const eventsInRange = outboundEvents.filter((event) =>
    isWithinDateRange(readRecordDate(event), dateRange)
  );
  const logsInRange = crmSyncLogs.filter((log) => isWithinDateRange(readRecordDate(log), dateRange));
  const submissionsInRange = assessmentSubmissions.filter((submission) =>
    isWithinDateRange(readRecordDate(submission), dateRange)
  );
  const outboundTaskCreationEvents = eventsInRange.filter(isTaskCreationOutboundEvent).length;
  const crmTaskCreationEvents = logsInRange.filter(isTaskCreateCrmLog).length;
  const failures = buildRecentOperationFailures({
    outboundEvents: eventsInRange,
    crmSyncLogs: logsInRange,
    assessmentSubmissions: submissionsInRange
  });

  return {
    reportName: 'operations',
    generatedAt: now.toISOString(),
    dateRange: {
      startDate: dateRange.startDate.toISOString(),
      endDate: endOfDay(dateRange.endDate).toISOString()
    },
    metrics: {
      totalOutboundEvents: eventsInRange.length,
      totalCrmSyncLogs: logsInRange.length,
      successfulSyncs: logsInRange.filter(isSuccessfulCrmSync).length,
      failedSyncs: logsInRange.filter(isFailedCrmSync).length,
      partialSuccessSyncs: logsInRange.filter(isPartialSuccessCrmSync).length,
      recoveryEvents: countMatchingOperations({
        outboundEvents: eventsInRange,
        crmSyncLogs: logsInRange,
        predicate: isRecoveryOperation
      }),
      duplicatePreventionEvents: countMatchingOperations({
        outboundEvents: eventsInRange,
        crmSyncLogs: logsInRange,
        predicate: isDuplicatePreventionOperation
      }),
      manualReviewEvents: countMatchingOperations({
        outboundEvents: eventsInRange,
        crmSyncLogs: logsInRange,
        predicate: isManualReviewOperation
      }),
      queueClassificationEvents: countMatchingOperations({
        outboundEvents: eventsInRange,
        crmSyncLogs: logsInRange,
        predicate: isQueueClassificationOperation
      }),
      taskCreationEvents:
        outboundTaskCreationEvents > 0 ? outboundTaskCreationEvents : crmTaskCreationEvents,
      taskCompletionEvents: eventsInRange.filter((event) => readEventType(event) === 'TASK_COMPLETED')
        .length,
      quickCaptureCommitEvents: eventsInRange.filter(isQuickCaptureOperation).length,
      assessmentWebhookEvents: submissionsInRange.length
    },
    breakdowns: {
      byEventType: countBy(eventsInRange, (event) => readEventType(event).toLowerCase() || 'unknown'),
      byStatus: {
        outboundEvents: countBy(eventsInRange, (event) => normalizeStatus(event.status)),
        crmSyncLogs: countBy(logsInRange, (log) => normalizeStatus(log.status)),
        assessmentSubmissions: countBy(submissionsInRange, (submission) =>
          normalizeStatus(submission.sync_status ?? submission.syncStatus)
        )
      },
      bySourceWorkflow: buildWorkflowBreakdown({
        outboundEvents: eventsInRange,
        crmSyncLogs: logsInRange,
        assessmentSubmissions: submissionsInRange
      }),
      byDay: buildOperationsDailyBreakdown({
        dateRange,
        outboundEvents: eventsInRange,
        crmSyncLogs: logsInRange,
        assessmentSubmissions: submissionsInRange
      })
    },
    recentFailures: failures.slice(0, 10),
    diagnostics: truthyString(query.includeDiagnostics) === 'true'
      ? {
          ...diagnostics,
          sourceCounts: {
            outboundEvents: outboundEvents.length,
            crmSyncLogs: crmSyncLogs.length,
            assessmentSubmissions: assessmentSubmissions.length
          },
          inRangeCounts: {
            outboundEvents: eventsInRange.length,
            crmSyncLogs: logsInRange.length,
            assessmentSubmissions: submissionsInRange.length
          },
          failureCount: failures.length
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

function isTaskCreationOutboundEvent(event = {}) {
  return isTaskCreationEvent(readEventType(event));
}

function isTaskCreateCrmLog(log = {}) {
  return (
    normalizeSelect(log.object_name ?? log.objectName) === 'TASK' &&
    ['CREATE', 'UPSERT'].includes(normalizeSelect(log.action)) &&
    normalizeStatus(log.status) === 'succeeded'
  );
}

function isSuccessfulCrmSync(log = {}) {
  return normalizeStatus(log.status) === 'succeeded';
}

function isFailedCrmSync(log = {}) {
  return normalizeStatus(log.status) === 'failed';
}

function isPartialSuccessCrmSync(log = {}) {
  const statuses = [
    normalizeStatus(log.status),
    normalizeStatus(log.response_payload?.status ?? log.responsePayload?.status),
    normalizeStatus(log.error_payload?.status ?? log.errorPayload?.status)
  ];

  return statuses.some((status) => ['partial_success', 'partial_failure'].includes(status));
}

function countMatchingOperations({ outboundEvents = [], crmSyncLogs = [], predicate }) {
  return (
    outboundEvents.filter((event) => predicate({ kind: 'outbound_event', record: event })).length +
    crmSyncLogs.filter((log) => predicate({ kind: 'crm_sync_log', record: log })).length
  );
}

function isRecoveryOperation({ kind, record = {} } = {}) {
  return operationSearchText(kind, record).includes('recovery') ||
    operationSearchText(kind, record).includes('recover');
}

function isDuplicatePreventionOperation({ kind, record = {} } = {}) {
  const payloads = operationPayloads(kind, record);
  const text = operationSearchText(kind, record);

  return (
    text.includes('duplicate') ||
    payloads.some((payload) =>
      Boolean(
        payload?.duplicateAvoided ??
          payload?.duplicateTaskSkipped ??
          payload?.duplicateSkipped ??
          payload?.duplicate ??
          payload?.dedupeSkipped
      )
    ) ||
    (kind === 'crm_sync_log' &&
      normalizeStatus(record.status) === 'skipped' &&
      Boolean(record.dedupe_key ?? record.dedupeKey))
  );
}

function isManualReviewOperation({ kind, record = {} } = {}) {
  const text = operationSearchText(kind, record);
  return text.includes('manual_review') || text.includes('requires_review') || text.includes('review_required');
}

function isQueueClassificationOperation({ kind, record = {} } = {}) {
  const text = operationSearchText(kind, record);
  return text.includes('queue_classification') || text.includes('coverage_audit') || text.includes('classification');
}

function isQuickCaptureOperation(event = {}) {
  const eventType = readEventType(event);
  return eventType.includes('QUICK_CAPTURE');
}

function buildWorkflowBreakdown({
  outboundEvents = [],
  crmSyncLogs = [],
  assessmentSubmissions = []
} = {}) {
  const workflows = new Map();
  const ensureWorkflow = (workflow) => {
    const key = workflow || 'unknown';
    const existing = workflows.get(key);

    if (existing) {
      return existing;
    }

    const row = {
      workflow: key,
      total: 0,
      outboundEvents: 0,
      crmSyncLogs: 0,
      assessmentSubmissions: 0,
      failed: 0
    };

    workflows.set(key, row);
    return row;
  };

  for (const event of outboundEvents) {
    const row = ensureWorkflow(inferWorkflow('outbound_event', event));
    row.total += 1;
    row.outboundEvents += 1;

    if (normalizeStatus(event.status) === 'failed') {
      row.failed += 1;
    }
  }

  for (const log of crmSyncLogs) {
    const row = ensureWorkflow(inferWorkflow('crm_sync_log', log));
    row.total += 1;
    row.crmSyncLogs += 1;

    if (isFailedCrmSync(log)) {
      row.failed += 1;
    }
  }

  for (const submission of assessmentSubmissions) {
    const row = ensureWorkflow('assessment_webhook');
    row.total += 1;
    row.assessmentSubmissions += 1;

    if (normalizeStatus(submission.sync_status ?? submission.syncStatus) === 'failed') {
      row.failed += 1;
    }
  }

  return [...workflows.values()].sort((left, right) =>
    left.workflow.localeCompare(right.workflow)
  );
}

function buildOperationsDailyBreakdown({
  dateRange,
  outboundEvents = [],
  crmSyncLogs = [],
  assessmentSubmissions = []
} = {}) {
  const days = new Map();
  const rangeDays = enumerateDays(dateRange);
  const ensureDay = (date) => {
    const key = date;
    const existing = days.get(key);

    if (existing) {
      return existing;
    }

    const row = {
      date: key,
      totalOutboundEvents: 0,
      totalCrmSyncLogs: 0,
      assessmentWebhookEvents: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      taskCreationEvents: 0,
      taskCompletionEvents: 0,
      recoveryEvents: 0
    };

    days.set(key, row);
    return row;
  };

  for (const day of rangeDays) {
    ensureDay(day);
  }

  for (const event of outboundEvents) {
    const row = ensureDay(toDayKey(readRecordDate(event)));
    row.totalOutboundEvents += 1;

    if (isTaskCreationOutboundEvent(event)) {
      row.taskCreationEvents += 1;
    }

    if (readEventType(event) === 'TASK_COMPLETED') {
      row.taskCompletionEvents += 1;
    }

    if (isRecoveryOperation({ kind: 'outbound_event', record: event })) {
      row.recoveryEvents += 1;
    }
  }

  for (const log of crmSyncLogs) {
    const row = ensureDay(toDayKey(readRecordDate(log)));
    row.totalCrmSyncLogs += 1;

    if (isSuccessfulCrmSync(log)) {
      row.successfulSyncs += 1;
    }

    if (isFailedCrmSync(log)) {
      row.failedSyncs += 1;
    }

    if (isTaskCreateCrmLog(log)) {
      row.taskCreationEvents += 1;
    }

    if (isRecoveryOperation({ kind: 'crm_sync_log', record: log })) {
      row.recoveryEvents += 1;
    }
  }

  for (const submission of assessmentSubmissions) {
    const row = ensureDay(toDayKey(readRecordDate(submission)));
    row.assessmentWebhookEvents += 1;
  }

  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function buildRecentOperationFailures({
  outboundEvents = [],
  crmSyncLogs = [],
  assessmentSubmissions = []
} = {}) {
  return [
    ...outboundEvents
      .filter((event) => normalizeStatus(event.status) === 'failed' || event.error_payload)
      .map((event) => ({
        source: 'outbound_events',
        id: event.id ?? null,
        occurredAt: readRecordDate(event)?.toISOString() ?? null,
        correlationId: event.correlation_id ?? event.correlationId ?? null,
        eventType: event.event_type ?? event.eventType ?? null,
        status: normalizeStatus(event.status),
        workflow: inferWorkflow('outbound_event', event),
        message: extractErrorMessage(event.error_payload ?? event.errorPayload),
        details: sanitizeErrorDetails(event.error_payload ?? event.errorPayload)
      })),
    ...crmSyncLogs
      .filter((log) => isFailedCrmSync(log) || log.error_payload || log.errorPayload)
      .map((log) => ({
        source: 'crm_sync_logs',
        id: log.id ?? null,
        occurredAt: readRecordDate(log)?.toISOString() ?? null,
        correlationId: log.correlation_id ?? log.correlationId ?? null,
        provider: log.provider ?? null,
        objectName: log.object_name ?? log.objectName ?? null,
        action: log.action ?? null,
        status: normalizeStatus(log.status),
        workflow: inferWorkflow('crm_sync_log', log),
        message: extractErrorMessage(log.error_payload ?? log.errorPayload ?? log.response_payload),
        details: sanitizeErrorDetails(log.error_payload ?? log.errorPayload ?? log.response_payload)
      })),
    ...assessmentSubmissions
      .filter((submission) =>
        ['failed', 'partial_failure'].includes(
          normalizeStatus(submission.sync_status ?? submission.syncStatus)
        )
      )
      .map((submission) => ({
        source: 'assessment_submissions',
        id: submission.id ?? null,
        occurredAt: readRecordDate(submission)?.toISOString() ?? null,
        correlationId: submission.correlation_id ?? submission.correlationId ?? null,
        status: normalizeStatus(submission.sync_status ?? submission.syncStatus),
        workflow: 'assessment_webhook',
        message: extractErrorMessage(submission.error_payload ?? submission.errorPayload),
        details: sanitizeErrorDetails(submission.error_payload ?? submission.errorPayload)
      }))
  ].sort((left, right) => String(right.occurredAt ?? '').localeCompare(String(left.occurredAt ?? '')));
}

function inferWorkflow(kind, record = {}) {
  if (kind === 'assessment_webhook') {
    return 'assessment_webhook';
  }

  const payloads = operationPayloads(kind, record);
  const explicit = firstString(
    record.workflow,
    record.workflow_name,
    record.workflowName,
    ...payloads.flatMap((payload) => [
      payload?.workflow,
      payload?.workflowName,
      payload?.sourceWorkflow,
      payload?.source,
      payload?.operation
    ])
  );

  if (explicit) {
    return normalizeKey(explicit) || 'unknown';
  }

  const eventType = kind === 'outbound_event' ? readEventType(record) : '';
  const action = normalizeSelect(record.action);
  const objectName = normalizeSelect(record.object_name ?? record.objectName);
  const text = operationSearchText(kind, record);

  if (eventType.includes('QUICK_CAPTURE') || text.includes('quick_capture')) {
    return 'quick_capture';
  }

  if (eventType === 'TASK_COMPLETED' || eventType === 'NEXT_TASK_CREATED') {
    return 'task_completion';
  }

  if (eventType.includes('MISSING_NEXT_TASK')) {
    return 'missing_next_task_apply';
  }

  if (eventType.includes('SENT_INITIAL_FOLLOW_UP')) {
    return 'sent_initial_follow_up_apply';
  }

  if (eventType.includes('MANUAL_LEAD_NORMALIZED')) {
    return 'manual_lead_normalization';
  }

  if (eventType.includes('LEGACY_OWNER')) {
    return 'legacy_owner_cleanup';
  }

  if (eventType.includes('LEGACY_TASK')) {
    return 'legacy_task_retrofit';
  }

  if (eventType.includes('LEGACY')) {
    return 'legacy_retrofit';
  }

  if (text.includes('recovery') || text.includes('recover')) {
    return 'recovery';
  }

  if (objectName || action) {
    return normalizeKey([objectName.toLowerCase(), action.toLowerCase()].filter(Boolean).join('_'));
  }

  return 'unknown';
}

function operationSearchText(kind, record = {}) {
  return [
    kind,
    record.event_type,
    record.eventType,
    record.status,
    record.action,
    record.object_name,
    record.objectName,
    record.correlation_id,
    record.correlationId,
    ...operationPayloads(kind, record).map((payload) => JSON.stringify(payload ?? {}))
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function operationPayloads(kind, record = {}) {
  if (kind === 'outbound_event') {
    return [record.payload, record.approval_payload, record.error_payload, record.errorPayload];
  }

  return [
    record.request_payload,
    record.requestPayload,
    record.response_payload,
    record.responsePayload,
    record.error_payload,
    record.errorPayload
  ];
}

function readEventType(event = {}) {
  return normalizeSelect(event.event_type ?? event.eventType);
}

function normalizeStatus(value) {
  return normalizeKey(value || 'unknown') || 'unknown';
}

function enumerateDays({ startDate, endDate } = {}) {
  const days = [];
  const cursor = new Date(startDate);
  const stop = endOfDay(endDate);
  let guard = 0;

  cursor.setHours(0, 0, 0, 0);

  while (cursor.getTime() <= stop.getTime() && guard < 370) {
    days.push(toDayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }

  return days;
}

function toDayKey(value) {
  const date = normalizeDateInput(value);
  return date ? date.toISOString().slice(0, 10) : 'unknown';
}

function extractErrorMessage(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return truncateString(redactSensitiveText(value), 300);
  }

  if (typeof value !== 'object') {
    return truncateString(String(value), 300);
  }

  return truncateString(
    redactSensitiveText(
      firstString(
        value.message,
        value.error,
        value.errorMessage,
        value.reason,
        value.statusText,
        value.detail,
        value.details
      ) || JSON.stringify(sanitizeErrorDetails(value))
    ),
    300
  );
}

function sanitizeErrorDetails(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth > 4) {
    return '[Truncated]';
  }

  if (typeof value === 'string') {
    return truncateString(redactSensitiveText(value), 500);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeErrorDetails(item, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveKey(key))
      .slice(0, 25)
      .map(([key, child]) => [key, sanitizeErrorDetails(child, depth + 1)])
  );
}

function isSensitiveKey(key = '') {
  return /token|secret|password|authorization|api[-_]?key|bearer|jwt/i.test(key);
}

function redactSensitiveText(value = '') {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

function truncateString(value = '', maxLength = 500) {
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function truthyString(value) {
  return String(value ?? '').toLowerCase();
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
  const source = normalizeDateInput(value) ?? new Date();
  const date = new Date(source.getTime());
  date.setUTCHours(23, 59, 59, 999);
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
