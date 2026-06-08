import { createTwentyQueueDataSource } from '../../integrations/twenty/queueDataSource.js';
import {
  createCompanyIndex,
  createWorkspaceMemberIndex,
  normalizeOwner,
  resolvePersonCompanyContext,
  resolveTaskPersonLink
} from '../../services/queueService.js';
import { mapLegacyLeadStage, normalizeLegacyLeadStage } from '../../utils/legacyLeadStageMapper.js';
import { toProjectDateOnly } from '../../utils/projectDate.js';
import { detectTestRecord } from '../../utils/testRecordDetection.js';

const OPEN_TASK_STATUSES = new Set(['TODO', 'OPEN', 'IN_PROGRESS', 'NOT_STARTED']);
const TERMINAL_LEAD_STAGES = new Set(['UNQUALIFIED_CLOSED', 'ACTIVE_CLIENT']);
const PROTECTED_ASSESSMENT_FIELDS = new Set([
  'assessmentCompleted',
  'assessmentScore',
  'lastTouchDate',
  'leadstageAuto',
  'messageAngle',
  'nextFollowUpDate'
]);

export async function planManualLeadNormalization({
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
      queueRead: config.queueRead ?? {},
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
  const plans = buildManualLeadNormalizationPlans(records, {
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
    summary: summarizeManualLeadNormalizationPlans(plans),
    plans: plans.records
  };
}

export function buildManualLeadNormalizationPlans(
  records = {},
  { includeTestRecords = false, now = new Date() } = {}
) {
  const workspaceMembersById = createWorkspaceMemberIndex(records.workspaceMembers ?? []);
  const companiesById = createCompanyIndex(records.companies ?? []);
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
    const normalized = normalizeManualLeadPerson(person, {
      companiesById,
      workspaceMembersById
    });

    if (normalized.isTestRecord && !includeTestRecords) {
      hiddenTestRecords += 1;
      continue;
    }

    const plan = buildManualLeadNormalizationPlanRecord({
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

export function buildManualLeadNormalizationPlanRecord({
  person,
  openTasks = [],
  now = new Date()
} = {}) {
  if (!person?.personId || person.assessmentCompleted === true) {
    return null;
  }

  if (TERMINAL_LEAD_STAGES.has(person.leadStage)) {
    return null;
  }

  const missingOutboundFields = getMissingOutboundFields(person);

  if (missingOutboundFields.length === 0) {
    return null;
  }

  if (!hasManualLeadSignal(person)) {
    return null;
  }

  const hasConnectionTask = openTasks.some(isConnectionTask);
  const hasFollowUpTask = openTasks.some(isPostInitialTask);
  const stageMapping = mapLegacyLeadStage(person.leadStage, {
    hasConnectionTask: hasConnectionTask || hasFollowUpTask
  });
  const inferredPipeline = inferPipelineType(person);
  const inferredCadenceName =
    inferredPipeline === 'ASSESSMENT_CAMPAIGN'
      ? 'ASSESSMENT_CAMPAIGN_V1'
      : 'RELATIONSHIP_BUILDING_V1';
  const inferredCadenceStage = inferCadenceStage({
    person,
    stageMapping,
    hasConnectionTask,
    hasFollowUpTask
  });
  const latestTouchStatus = inferLatestTouchStatus({
    person,
    stageMapping,
    hasConnectionTask,
    hasFollowUpTask
  });
  const latestTouchChannel = inferLatestTouchChannel(person);
  const recommendedUpdates = stripProtectedAssessmentFields(
    stripEmpty({
      outboundPipelineType: inferredPipeline,
      cadenceName: inferredCadenceName,
      cadenceStage: inferredCadenceStage,
      latestTouchChannel,
      latestTouchStatus,
      enrichmentStatus: person.company?.relationExists ? 'PARTIAL' : 'NEEDS_REVIEW',
      outreachAngle: buildOutreachAngle({ person, inferredPipeline }),
      leadHealthScore: stageMapping.updates.leadHealthScore ?? inferLeadHealthScore(person),
      icpFitScore: inferIcpFitScore(person),
      nextOutboundTouchDate: toProjectDateOnly(now),
      discoveryReadiness: stageMapping.updates.discoveryReadiness ?? 'NOT_READY',
      staleRisk: stageMapping.updates.staleRisk ?? 'LOW'
    })
  );
  const recommendedTaskAction = inferTaskAction({
    cadenceStage: inferredCadenceStage,
    latestTouchStatus,
    hasConnectionTask,
    hasFollowUpTask
  });
  const warnings = [
    ...stageMapping.warnings,
    ...(!person.owner?.email && !person.owner?.id
      ? ['Owner could not be resolved; assign rep before applying normalization.']
      : []),
    ...(person.company?.resolutionStatus === 'resolved_relation_id_only'
      ? ['Company relation ID exists, but Company details were not available in queue reads.']
      : []),
    ...(person.isTestRecord
      ? ['Record appears to be test/synthetic; do not normalize live unless explicitly approved.']
      : [])
  ];
  const safeToNormalize = Boolean(
    Object.keys(recommendedUpdates).length > 0 &&
      stageMapping.recognized &&
      (person.owner?.email || person.owner?.id) &&
      !person.isTestRecord
  );

  return {
    personId: person.personId,
    personName: person.name,
    owner: person.owner,
    assignedRep: person.owner?.email ?? person.owner?.name ?? null,
    companyId: person.company?.id ?? null,
    companyName: person.company?.name ?? null,
    companySegment: person.company?.segment ?? null,
    companyIndustry: person.company?.industry ?? null,
    companyResolutionStatus: person.company?.resolutionStatus ?? 'missing',
    leadStage: person.leadStage || null,
    assessmentCompleted: person.assessmentCompleted,
    missingOutboundFields,
    currentOutboundFields: {
      outboundPipelineType: person.outboundPipelineType || null,
      cadenceName: person.cadenceName || null,
      cadenceStage: person.cadenceStage || null,
      latestTouchChannel: person.latestTouchChannel || null,
      latestTouchStatus: person.latestTouchStatus || null
    },
    recommendedUpdates,
    recommendedTaskAction,
    recommendedTaskTitle: getRecommendedTaskTitle({
      pipeline: inferredPipeline,
      cadenceStage: inferredCadenceStage,
      latestTouchStatus
    }),
    openTaskIds: openTasks.map((task) => task.taskId).filter(Boolean),
    confidence: safeToNormalize ? 'high' : 'medium',
    evidence: [
      person.leadStage ? `Manual leadStage=${person.leadStage}` : null,
      person.linkedinUrl ? 'Person has LinkedIn URL.' : null,
      person.email ? 'Person has email.' : null,
      person.company?.relationExists ? `Company relation status=${person.company.resolutionStatus}.` : null,
      person.owner?.email || person.owner?.id ? 'Owner resolved.' : null,
      hasConnectionTask ? 'Existing connection/initial task evidence found.' : null,
      hasFollowUpTask ? 'Existing post-initial follow-up task evidence found.' : null
    ].filter(Boolean),
    safeToNormalize,
    isTestRecord: person.isTestRecord,
    testRecordReasons: person.testRecordReasons,
    warnings
  };
}

function normalizeManualLeadPerson(person = {}, { companiesById, workspaceMembersById }) {
  const testRecord = detectTestRecord(person);
  const company = resolvePersonCompanyContext(person, companiesById);

  return {
    raw: person,
    personId: stringify(person.id),
    name: getPersonName(person),
    email: getEmail(person),
    linkedinUrl: getLinkUrl(person.linkedinLink, person.linkedinLinkPrimaryLinkUrl, person.linkedinUrl),
    leadStage: normalizeLegacyLeadStage(person.leadStage),
    assessmentCompleted: Boolean(person.assessmentCompleted),
    owner: normalizeOwner(person, 'person', workspaceMembersById),
    company,
    leadSource: normalizeSelect(person.leadSource),
    outboundPipelineType: normalizeSelect(person.outboundPipelineType),
    cadenceName: normalizeSelect(person.cadenceName),
    cadenceStage: normalizeSelect(person.cadenceStage),
    latestTouchChannel: normalizeSelect(person.latestTouchChannel),
    latestTouchStatus: normalizeSelect(person.latestTouchStatus),
    isTestRecord: testRecord.isTestRecord,
    testRecordReasons: testRecord.reasons
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
      source: personLink.source,
      confidence: personLink.confidence
    });
    map.set(key, existing);
  }

  return map;
}

function getMissingOutboundFields(person) {
  return [
    !person.outboundPipelineType ? 'outboundPipelineType' : null,
    !person.cadenceName ? 'cadenceName' : null,
    !person.cadenceStage ? 'cadenceStage' : null,
    !person.latestTouchChannel ? 'latestTouchChannel' : null,
    !person.latestTouchStatus ? 'latestTouchStatus' : null
  ].filter(Boolean);
}

function hasManualLeadSignal(person) {
  return Boolean(
    person.owner?.id ||
      person.owner?.email ||
      person.leadStage ||
      person.linkedinUrl ||
      person.email ||
      person.company?.relationExists ||
      person.raw?.createdBy ||
      person.raw?.createdById
  );
}

function inferPipelineType(person) {
  const source = `${person.leadSource ?? ''} ${person.raw?.eventSource ?? ''}`.toUpperCase();

  return /ASSESSMENT|SPOT_THE_GAP|SPOT THE GAP/.test(source)
    ? 'ASSESSMENT_CAMPAIGN'
    : 'RELATIONSHIP_BUILDING';
}

function inferCadenceStage({ person, stageMapping, hasConnectionTask, hasFollowUpTask }) {
  if (person.leadStage === 'OUTREACH_INITIATED') {
    return hasFollowUpTask || hasConnectionTask ? 'INTRO_MESSAGE' : 'CONNECTION_REQUEST';
  }

  return stageMapping.updates.cadenceStage ?? 'NOT_STARTED';
}

function inferLatestTouchStatus({ person, stageMapping }) {
  if (person.leadStage === 'IDENTIFIED') {
    return 'DRAFTED';
  }

  return stageMapping.updates.latestTouchStatus ?? (person.leadStage ? 'SENT' : 'DRAFTED');
}

function inferLatestTouchChannel(person) {
  const source = `${person.leadSource ?? ''} ${person.raw?.eventSource ?? ''}`.toUpperCase();

  if (/EMAIL/.test(source)) return 'EMAIL';
  if (/PHONE/.test(source)) return 'PHONE';
  if (person.linkedinUrl) return 'LINKEDIN';
  return 'OTHER';
}

function inferTaskAction({ cadenceStage, latestTouchStatus, hasConnectionTask, hasFollowUpTask }) {
  if (latestTouchStatus === 'SENT' && !hasFollowUpTask) {
    return 'create_follow_up_task';
  }

  if (['NOT_STARTED', 'CONNECTION_REQUEST'].includes(cadenceStage) && !hasConnectionTask) {
    return 'create_first_task';
  }

  return 'review_existing_task_context';
}

function getRecommendedTaskTitle({ pipeline, cadenceStage, latestTouchStatus }) {
  if (latestTouchStatus === 'SENT') {
    return pipeline === 'ASSESSMENT_CAMPAIGN'
      ? 'Send assessment positioning follow-up'
      : 'Send relationship follow-up / intro message';
  }

  if (cadenceStage === 'CONNECTION_REQUEST' || cadenceStage === 'NOT_STARTED') {
    return pipeline === 'ASSESSMENT_CAMPAIGN'
      ? 'Send assessment-oriented connection request'
      : 'Send relationship-oriented connection request';
  }

  return 'Review manual lead normalization task';
}

function inferLeadHealthScore(person) {
  let score = person.company?.relationExists ? 45 : 35;
  if (person.linkedinUrl) score += 10;
  if (person.email) score += 5;
  if (person.owner?.email || person.owner?.id) score += 5;
  return Math.min(score, 75);
}

function inferIcpFitScore(person) {
  let score = person.company?.relationExists ? 55 : 40;
  if (person.company?.segment) score += 5;
  if (person.company?.industry) score += 5;
  if (person.linkedinUrl) score += 5;
  return Math.min(score, 75);
}

function buildOutreachAngle({ person, inferredPipeline }) {
  const company = person.company?.name;
  const mode =
    inferredPipeline === 'ASSESSMENT_CAMPAIGN'
      ? 'position the Spot the Gap assessment'
      : 'continue relationship-building outreach';

  return company
    ? `Use manual Twenty CRM context to ${mode} with ${person.name || 'this lead'} at ${company}.`
    : `Use manual Twenty CRM context to ${mode} with ${person.name || 'this lead'}.`;
}

function stripProtectedAssessmentFields(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload).filter(([fieldName]) => !PROTECTED_ASSESSMENT_FIELDS.has(fieldName))
  );
}

function summarizeManualLeadNormalizationPlans(planResult = {}) {
  const records = planResult.records ?? [];

  return {
    manualLeadNormalizationCount: records.length,
    safeToNormalize: records.filter((record) => record.safeToNormalize).length,
    requiresReview: records.filter((record) => !record.safeToNormalize).length,
    hiddenTestRecords: planResult.hiddenTestRecords ?? 0,
    includedTestRecords: records.filter((record) => record.isTestRecord).length,
    byLeadStage: countBy(records, (record) => record.leadStage || 'MISSING'),
    byRecommendedPipeline: countBy(records, (record) => record.recommendedUpdates.outboundPipelineType),
    byRecommendedCadenceStage: countBy(records, (record) => record.recommendedUpdates.cadenceStage),
    byRecommendedTaskAction: countBy(records, (record) => record.recommendedTaskAction),
    byConfidence: countBy(records, (record) => record.confidence)
  };
}

function isConnectionTask(task = {}) {
  return /connection request|first cadence task/i.test(`${task.title ?? ''} ${task.body ?? ''}`);
}

function isPostInitialTask(task = {}) {
  return /intro message|value touch|assessment positioning|assessment link|check in|strategic|discovery|day 2|final touch/i.test(
    `${task.title ?? ''} ${task.body ?? ''}`
  );
}

function isOpenTask(task = {}) {
  return OPEN_TASK_STATUSES.has(normalizeSelect(task.status));
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

function getEmail(record = {}) {
  return normalizeEmail(
    firstString(
      record.emails?.primaryEmail,
      record.emailsPrimaryEmail,
      record.email,
      record.primaryEmail
    )
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

function getTaskBody(task = {}) {
  if (typeof task.bodyV2 === 'string') {
    return task.bodyV2;
  }

  return task.bodyV2?.markdown ?? task.body ?? task.description ?? '';
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

function stripEmpty(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
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
