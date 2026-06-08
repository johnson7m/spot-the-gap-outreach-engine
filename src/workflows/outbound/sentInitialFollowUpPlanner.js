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
const INITIAL_CADENCE_STAGES = new Set(['NOT_STARTED', 'CONNECTION_REQUEST']);
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
const POST_INITIAL_CADENCE_STAGES = new Set([
  'INTRO_MESSAGE',
  'VALUE_TOUCH',
  'ASSESSMENT_POSITIONING',
  'ASSESSMENT_SENT',
  'ASSESSMENT_CHECK_IN',
  'STRATEGIC_CHECK_IN',
  'DISCOVERY_ASK'
]);
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
  /evaluate discovery ask/i,
  /\bli\s*-\s*day\s*2\b/i,
  /\bli\s*-\s*f\/?u\b/i,
  /\bfinal touch\b/i
];

const FOLLOW_UP_RULES = {
  ASSESSMENT_CAMPAIGN_V1: {
    nextCadenceStage: 'ASSESSMENT_POSITIONING',
    taskTitle: 'Send assessment positioning message',
    taskType: 'assessment_positioning',
    dueInDays: 1
  },
  RELATIONSHIP_BUILDING_V1: {
    nextCadenceStage: 'INTRO_MESSAGE',
    taskTitle: 'Send contextual introduction',
    taskType: 'introduction',
    dueInDays: 2
  }
};

export async function planSentInitialFollowUps({
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
  const plans = buildSentInitialFollowUpPlans(records, {
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
    summary: summarizeSentInitialFollowUpPlans(plans),
    plans: plans.records
  };
}

export function buildSentInitialFollowUpPlans(
  records = {},
  { includeTestRecords = false, now = new Date() } = {}
) {
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
    const normalized = normalizePersonForSentFollowUpPlan(person, workspaceMembersById);

    if (normalized.isTestRecord && !includeTestRecords) {
      hiddenTestRecords += 1;
      continue;
    }

    const plan = buildSentInitialFollowUpPlanRecord({
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

export function buildSentInitialFollowUpPlanRecord({
  person,
  openTasks = [],
  now = new Date()
} = {}) {
  if (!person?.personId || isExcludedPersonState(person)) {
    return null;
  }

  if (person.latestTouchStatus !== 'SENT' || !INITIAL_CADENCE_STAGES.has(person.cadenceStage)) {
    return null;
  }

  if (openTasks.some(isPostInitialFollowUpTask)) {
    return null;
  }

  const rule = getFollowUpRule(person);

  if (!rule) {
    return null;
  }

  const currentInitialTask = openTasks.find(isInitialOutreachTask) ?? null;
  const warnings = [];
  const evidence = [
    `cadenceName=${person.cadenceName}`,
    `cadenceStage=${person.cadenceStage}`,
    'latestTouchStatus=SENT',
    'No open post-initial follow-up task resolved through taskTargets or Person markers.'
  ];
  const rawRecommendedDueDate =
    person.nextOutboundTouchDate || addDaysToDateOnly(toProjectDateOnly(now), rule.dueInDays);
  const dueDate = resolveSafeMissingNextTaskDueDate({
    recommendedDueDate: rawRecommendedDueDate,
    now
  });

  if (currentInitialTask) {
    evidence.push(`currentInitialTaskId=${currentInitialTask.taskId}`);
  }

  if (!person.owner?.email && !person.owner?.id) {
    warnings.push('Owner could not be resolved; task assignment may need manual review.');
  }

  if (person.isTestRecord) {
    warnings.push('Record appears to be test/synthetic; do not create live tasks unless explicitly approved.');
  }

  if (dueDate.dueDateAdjusted) {
    evidence.push(`recommendedDueDate adjusted from ${rawRecommendedDueDate ?? 'missing'} to ${dueDate.recommendedDueDate}`);
  }

  const safeToCreate = Boolean(rule && !person.isTestRecord && (person.owner?.email || person.owner?.id));

  return {
    personId: person.personId,
    personName: person.name,
    owner: person.owner,
    cadenceName: person.cadenceName,
    cadenceStage: person.cadenceStage,
    latestTouchStatus: person.latestTouchStatus,
    latestTouchChannel: person.latestTouchChannel,
    currentInitialTaskId: currentInitialTask?.taskId ?? null,
    recommendedNextCadenceStage: rule.nextCadenceStage,
    recommendedTaskTitle: rule.taskTitle,
    recommendedDueDate: dueDate.recommendedDueDate,
    originalRecommendedDueDate: dueDate.originalRecommendedDueDate,
    dueDateAdjusted: dueDate.dueDateAdjusted,
    dueDateAdjustmentReason: dueDate.dueDateAdjustmentReason,
    recommendedTaskType: rule.taskType,
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
      taskId: stringify(task.id),
      title: firstString(task.title, task.name, task.subject),
      status: normalizeSelect(task.status),
      body,
      cadenceStage: normalizeSelect(
        readMarkdownValue(body, 'Next cadence stage') ??
          readMarkdownValue(body, 'Cadence stage') ??
          readMarkdownValue(body, 'Previous cadence stage')
      ),
      taskType: normalizeSelect(readMarkdownValue(body, 'Task type')),
      latestTouchStatus: normalizeSelect(readMarkdownValue(body, 'Latest touch status')),
      source: personLink.source,
      confidence: personLink.confidence
    });
    map.set(key, existing);
  }

  return map;
}

function normalizePersonForSentFollowUpPlan(person = {}, workspaceMembersById) {
  const testRecord = detectTestRecord(person);

  return {
    raw: person,
    personId: stringify(person.id),
    name: getPersonName(person),
    owner: normalizeOwner(person, 'person', workspaceMembersById),
    outboundPipelineType: normalizeSelect(person.outboundPipelineType),
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

function summarizeSentInitialFollowUpPlans(planResult = {}) {
  const records = planResult.records ?? [];

  return {
    sentInitialFollowUpCount: records.length,
    safeToCreate: records.filter((record) => record.safeToCreate).length,
    requiresReview: records.filter((record) => !record.safeToCreate).length,
    hiddenTestRecords: planResult.hiddenTestRecords ?? 0,
    includedTestRecords: records.filter((record) => record.isTestRecord).length,
    dueDatesAdjusted: records.filter((record) => record.dueDateAdjusted).length,
    byCadenceName: countBy(records, (record) => record.cadenceName),
    byCadenceStage: countBy(records, (record) => record.cadenceStage),
    byRecommendedNextCadenceStage: countBy(records, (record) => record.recommendedNextCadenceStage),
    byConfidence: countBy(records, (record) => record.confidence)
  };
}

function getFollowUpRule(person) {
  if (person.cadenceName === 'ASSESSMENT_CAMPAIGN_V1' || person.outboundPipelineType === 'ASSESSMENT_CAMPAIGN') {
    return FOLLOW_UP_RULES.ASSESSMENT_CAMPAIGN_V1;
  }

  if (person.cadenceName === 'RELATIONSHIP_BUILDING_V1' || person.outboundPipelineType === 'RELATIONSHIP_BUILDING') {
    return FOLLOW_UP_RULES.RELATIONSHIP_BUILDING_V1;
  }

  return null;
}

function isExcludedPersonState(person) {
  return [
    person.cadenceStage,
    person.latestTouchStatus,
    person.leadstageAuto,
    person.discoveryReadiness
  ].some((value) => TERMINAL_OR_EXCLUDED_STATES.has(normalizeSelect(value)));
}

function isOpenTask(task = {}) {
  return OPEN_TASK_STATUSES.has(normalizeSelect(task.status));
}

function isInitialOutreachTask(task = {}) {
  const text = getTaskClassificationText(task);

  return (
    task.taskType === 'CONNECTION_REQUEST' ||
    INITIAL_TASK_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function isPostInitialFollowUpTask(task = {}) {
  const text = getTaskClassificationText(task);

  return (
    POST_INITIAL_CADENCE_STAGES.has(normalizeSelect(task.cadenceStage)) ||
    POST_INITIAL_TASK_PATTERNS.some((pattern) => pattern.test(text))
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

function readMarkdownValue(body, label) {
  if (!body) {
    return null;
  }

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`^${escapedLabel}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() ?? null;
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
