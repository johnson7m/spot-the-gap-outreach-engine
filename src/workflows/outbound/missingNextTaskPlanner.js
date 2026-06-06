import { createTwentyQueueDataSource } from '../../integrations/twenty/queueDataSource.js';
import {
  createWorkspaceMemberIndex,
  normalizeOwner,
  resolveTaskPersonLink
} from '../../services/queueService.js';
import {
  addDaysToDateOnly,
  normalizeDateOnly,
  resolveSafeMissingNextTaskDueDate,
  toProjectDateOnly
} from '../../utils/projectDate.js';
import { detectTestRecord } from '../../utils/testRecordDetection.js';

const OPEN_TASK_STATUSES = new Set(['TODO', 'OPEN', 'IN_PROGRESS', 'NOT_STARTED']);
const TERMINAL_OR_EXCLUDED_STATES = new Set([
  'PAUSED',
  'COMPLETED',
  'COMPLETE',
  'DONE',
  'ACTIVE_CLIENT',
  'UNQUALIFIED_CLOSED',
  'DECLINED',
  'DISQUALIFIED',
  'DISQUALIFIED_NURTURE'
]);
const ACTIVE_TOUCH_STATUSES = new Set([
  'DRAFTED',
  'SENT',
  'NO_RESPONSE',
  'RESPONDED',
  'FOLLOW_UP_NEEDED'
]);

const TASK_RULES = {
  ASSESSMENT_CAMPAIGN_V1: {
    NOT_STARTED: taskRule('Send assessment-oriented connection request', 'connection_request', 1),
    CONNECTION_REQUEST: taskRule('Send assessment-oriented connection request', 'connection_request', 1),
    INTRO_MESSAGE: taskRule('Send assessment positioning message', 'assessment_positioning', 1),
    ASSESSMENT_POSITIONING: taskRule('Send assessment positioning message', 'assessment_positioning', 1),
    ASSESSMENT_SENT: taskRule('Send Spot the Gap assessment link', 'assessment_link', 1),
    ASSESSMENT_CHECK_IN: taskRule('Check in on Spot the Gap assessment', 'assessment_check_in', 3)
  },
  RELATIONSHIP_BUILDING_V1: {
    NOT_STARTED: taskRule('Send relationship-oriented connection request', 'connection_request', 1),
    CONNECTION_REQUEST: taskRule('Send relationship-oriented connection request', 'connection_request', 1),
    INTRO_MESSAGE: taskRule('Send contextual introduction', 'introduction', 2),
    VALUE_TOUCH: taskRule('Send value touch', 'value_touch', 14),
    STRATEGIC_CHECK_IN: taskRule('Send strategic check-in', 'strategic_check_in', 30),
    DISCOVERY_ASK: taskRule('Evaluate discovery ask', 'discovery_ask', 60)
  }
};

export async function planMissingNextTasks({
  config = {},
  dataSource,
  log,
  includeTestRecords = false,
  pageSize = 100,
  maxPages = 10,
  now = new Date()
} = {}) {
  const source =
    dataSource ??
    createTwentyQueueDataSource({
      config: config.twenty ?? config,
      log
    });
  const records =
    typeof source.listAllQueueRecords === 'function'
      ? await source.listAllQueueRecords({
          pageSize,
          maxPages
        })
      : await source.listQueueRecords({
          limit: pageSize
        });
  const plans = buildMissingNextTaskPlans(records, {
    includeTestRecords,
    now
  });

  return {
    status: 'dry_run',
    dryRun: true,
    generatedAt: now.toISOString(),
    includeTestRecords,
    pagination: records.pagination ?? null,
    warnings: records.warnings ?? [],
    summary: summarizeMissingNextTaskPlans(plans),
    plans: plans.records
  };
}

export function buildMissingNextTaskPlans(records = {}, { includeTestRecords = false, now = new Date() } = {}) {
  const workspaceMembersById = createWorkspaceMemberIndex(records.workspaceMembers ?? []);
  const taskTargetsByTaskId = groupBy(records.taskTargets ?? [], (target) => target.taskId);
  const openTasksByPersonId = buildOpenTasksByPersonId({
    tasks: records.tasks ?? [],
    taskTargetsByTaskId,
    people: records.people ?? [],
    workspaceMembersById
  });
  const output = [];
  let hiddenTestRecords = 0;

  for (const person of records.people ?? []) {
    const normalized = normalizePersonForTaskPlan(person, workspaceMembersById);

    if (normalized.isTestRecord && !includeTestRecords) {
      hiddenTestRecords += 1;
      continue;
    }

    const plan = buildMissingNextTaskPlanRecord({
      person: normalized,
      openTasks: openTasksByPersonId.get(normalized.personId) ?? [],
      now
    });

    if (plan) {
      output.push(plan);
    }
  }

  return {
    records: output,
    hiddenTestRecords
  };
}

export function buildMissingNextTaskPlanRecord({ person, openTasks = [], now = new Date() } = {}) {
  if (!person?.personId || !person.cadenceName || isTerminalOrExcluded(person.cadenceStage)) {
    return null;
  }

  if (isExcludedPersonState(person)) {
    return null;
  }

  if (!ACTIVE_TOUCH_STATUSES.has(person.latestTouchStatus)) {
    return null;
  }

  if (openTasks.length > 0) {
    return null;
  }

  const taskRuleForStage = getTaskRule(person);

  if (!taskRuleForStage) {
    return null;
  }

  const warnings = [];
  const evidence = [
    `cadenceName=${person.cadenceName}`,
    `cadenceStage=${person.cadenceStage}`,
    `latestTouchStatus=${person.latestTouchStatus}`,
    'No open task resolved through taskTargets or Person markers.'
  ];
  const originalNextOutboundTouchDate = person.nextOutboundTouchDate ?? null;
  const rawRecommendedDueDate =
    originalNextOutboundTouchDate ||
    addDaysToDateOnly(toProjectDateOnly(now), taskRuleForStage.dueInDays);
  const dueDate = resolveSafeMissingNextTaskDueDate({
    recommendedDueDate: rawRecommendedDueDate,
    now
  });

  if (!person.owner?.email && !person.owner?.id) {
    warnings.push('Owner could not be resolved; task assignment may need manual review.');
  }

  if (person.isTestRecord) {
    warnings.push('Record appears to be test/synthetic; do not create live tasks unless explicitly approved.');
  }

  if (dueDate.dueDateAdjusted) {
    evidence.push(`recommendedDueDate adjusted from ${rawRecommendedDueDate ?? 'missing'} to ${dueDate.recommendedDueDate}`);
  }

  const safeToCreate = Boolean(taskRuleForStage && !person.isTestRecord && (person.owner?.email || person.owner?.id));

  return {
    personId: person.personId,
    personName: person.name,
    companyId: person.companyId,
    owner: person.owner,
    cadenceName: person.cadenceName,
    cadenceStage: person.cadenceStage,
    latestTouchChannel: person.latestTouchChannel,
    latestTouchStatus: person.latestTouchStatus,
    nextOutboundTouchDate: person.nextOutboundTouchDate,
    originalNextOutboundTouchDate,
    recommendedTaskTitle: taskRuleForStage.title,
    recommendedDueDate: dueDate.recommendedDueDate,
    originalRecommendedDueDate: dueDate.originalRecommendedDueDate,
    dueDateAdjusted: dueDate.dueDateAdjusted,
    dueDateAdjustmentReason: dueDate.dueDateAdjustmentReason,
    recommendedTaskType: taskRuleForStage.taskType,
    confidence: safeToCreate ? 'high' : 'medium',
    evidence,
    safeToCreate,
    isTestRecord: person.isTestRecord,
    testRecordReasons: person.testRecordReasons,
    warnings
  };
}

function buildOpenTasksByPersonId({ tasks = [], taskTargetsByTaskId, people = [], workspaceMembersById }) {
  const map = new Map();

  for (const task of tasks) {
    if (!isOpenTask(task)) {
      continue;
    }

    const body = getTaskBody(task);
    const personLink = resolveTaskPersonLink({
      task,
      body,
      taskTargets: taskTargetsByTaskId.get(String(task.id ?? '')) ?? [],
      people,
      workspaceMembersById
    });

    if (!personLink.personId) {
      continue;
    }

    const key = String(personLink.personId);
    const existing = map.get(key) ?? [];
    existing.push({
      taskId: task.id,
      title: task.title ?? task.name ?? task.subject ?? null,
      source: personLink.source,
      confidence: personLink.confidence
    });
    map.set(key, existing);
  }

  return map;
}

function normalizePersonForTaskPlan(person = {}, workspaceMembersById) {
  const testRecord = detectTestRecord(person);

  return {
    raw: person,
    personId: stringify(person.id),
    name: getPersonName(person),
    companyId: firstString(person.companyId, person.company?.id, person.companyID),
    owner: normalizeOwner(person, 'person', workspaceMembersById),
    cadenceName: normalizeSelect(person.cadenceName),
    cadenceStage: normalizeSelect(person.cadenceStage),
    latestTouchChannel: normalizeSelect(person.latestTouchChannel),
    latestTouchStatus: normalizeSelect(person.latestTouchStatus),
    nextOutboundTouchDate: normalizeDateString(person.nextOutboundTouchDate),
    leadstageAuto: normalizeSelect(person.leadstageAuto),
    discoveryReadiness: normalizeSelect(person.discoveryReadiness),
    isTestRecord: testRecord.isTestRecord,
    testRecordReasons: testRecord.reasons
  };
}

function summarizeMissingNextTaskPlans(planResult = {}) {
  const records = planResult.records ?? [];

  return {
    missingNextTaskCount: records.length,
    safeToCreate: records.filter((record) => record.safeToCreate).length,
    requiresReview: records.filter((record) => !record.safeToCreate).length,
    hiddenTestRecords: planResult.hiddenTestRecords ?? 0,
    includedTestRecords: records.filter((record) => record.isTestRecord).length,
    dueDatesAdjusted: records.filter((record) => record.dueDateAdjusted).length,
    byDueDateAdjustmentReason: countBy(
      records.filter((record) => record.dueDateAdjusted),
      (record) => record.dueDateAdjustmentReason
    ),
    byCadenceName: countBy(records, (record) => record.cadenceName),
    byCadenceStage: countBy(records, (record) => record.cadenceStage),
    byConfidence: countBy(records, (record) => record.confidence)
  };
}

function getTaskRule(person) {
  return TASK_RULES[person.cadenceName]?.[person.cadenceStage] ?? null;
}

function isExcludedPersonState(person) {
  return [
    person.cadenceStage,
    person.latestTouchStatus,
    person.leadstageAuto,
    person.discoveryReadiness
  ].some((value) => TERMINAL_OR_EXCLUDED_STATES.has(normalizeSelect(value)));
}

function isTerminalOrExcluded(value) {
  return TERMINAL_OR_EXCLUDED_STATES.has(normalizeSelect(value));
}

function taskRule(title, taskType, dueInDays) {
  return {
    title,
    taskType,
    dueInDays
  };
}

function isOpenTask(task = {}) {
  return OPEN_TASK_STATUSES.has(normalizeSelect(task.status));
}

function getTaskBody(task = {}) {
  if (typeof task.bodyV2 === 'string') {
    return task.bodyV2;
  }

  return task.bodyV2?.markdown ?? task.body ?? task.description ?? '';
}

function getPersonName(person = {}) {
  return firstString(
    person.name?.fullName,
    [person.name?.firstName ?? person.nameFirstName, person.name?.lastName ?? person.nameLastName]
      .filter(Boolean)
      .join(' '),
    person.fullName,
    person.displayName
  );
}

function groupBy(records = [], getKey) {
  const map = new Map();

  for (const record of records) {
    const key = getKey(record);

    if (!key) {
      continue;
    }

    const existing = map.get(String(key)) ?? [];
    existing.push(record);
    map.set(String(key), existing);
  }

  return map;
}

function countBy(records = [], getValue) {
  return records.reduce((acc, record) => {
    const value = getValue(record) ?? 'UNKNOWN';
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function normalizeSelect(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeDateString(value) {
  return normalizeDateOnly(value);
}

function stringify(value) {
  return value === undefined || value === null ? null : String(value);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}
