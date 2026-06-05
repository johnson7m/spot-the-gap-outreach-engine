import { createTwentyQueueDataSource } from '../../integrations/twenty/queueDataSource.js';
import {
  createWorkspaceMemberIndex,
  normalizeOwner,
  resolveTaskPersonLink
} from '../../services/queueService.js';

export async function planLegacyTaskRetrofit({
  config = {},
  dataSource,
  log,
  pageSize = 100,
  maxPages = 10,
  limit,
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
          limit: limit ?? pageSize
        });
  const plans = buildLegacyTaskRetrofitPlans(records);

  return {
    status: 'dry_run',
    dryRun: true,
    generatedAt: now.toISOString(),
    pagination: records.pagination ?? null,
    warnings: records.warnings ?? [],
    summary: summarizeTaskPlans(plans),
    plans
  };
}

export function buildLegacyTaskRetrofitPlans(records = {}) {
  const taskTargetsByTaskId = groupTaskTargetsByTaskId(records.taskTargets ?? []);
  const workspaceMembersById = createWorkspaceMemberIndex(records.workspaceMembers ?? []);
  const peopleById = new Map((records.people ?? []).filter((person) => person?.id).map((person) => [String(person.id), person]));

  return (records.tasks ?? []).map((task) => {
    const taskTargets = taskTargetsByTaskId.get(String(task.id ?? '')) ?? [];
    const body = getTaskBody(task);
    const personLink = resolveTaskPersonLink({
      task,
      body,
      taskTargets,
      people: records.people ?? [],
      workspaceMembersById
    });
    const inferredPerson = personLink.personId ? peopleById.get(String(personLink.personId)) : null;
    const assignee = normalizeOwner(task, 'task', workspaceMembersById);
    const confidence = personLink.confidence ?? 'unknown';
    const recommendedAction = chooseRecommendedAction({
      currentTargetPersonId: personLink.currentTargetPersonId,
      currentTargetCompanyId: personLink.currentTargetCompanyId,
      inferredTargetPersonId: personLink.personId,
      inferredTargetCompanyId: personLink.companyId,
      confidence
    });
    const warnings = buildTaskRetrofitWarnings({
      personLink,
      inferredPerson,
      recommendedAction
    });

    return {
      taskId: task.id ?? null,
      taskTitle: task.title ?? task.name ?? task.subject ?? null,
      taskStatus: normalizeSelect(task.status),
      currentTargetPersonId: personLink.currentTargetPersonId ?? null,
      currentTargetCompanyId: personLink.currentTargetCompanyId ?? null,
      inferredTargetPersonId: personLink.currentTargetPersonId ? null : personLink.personId ?? null,
      inferredTargetCompanyId: personLink.currentTargetCompanyId ? null : personLink.companyId ?? null,
      inferredTargetPersonName: inferredPerson ? getPersonName(inferredPerson) : null,
      confidence,
      evidence: {
        resolutionPath: personLink.path ?? ['fallback_unknown'],
        resolutionSource: personLink.source ?? null,
        resolutionEvidence: personLink.evidence ?? [],
        assignee,
        bodyPersonId: parseBodyPersonId(body),
        taskTargetIds: taskTargets.map((target) => target.id).filter(Boolean)
      },
      recommendedAction,
      safeToUpdate: recommendedAction === 'link_task_to_person' && ['high', 'medium'].includes(confidence),
      warnings
    };
  });
}

function chooseRecommendedAction({
  currentTargetPersonId,
  currentTargetCompanyId,
  inferredTargetPersonId,
  inferredTargetCompanyId,
  confidence
}) {
  if (currentTargetPersonId) {
    return 'leave_unassigned';
  }

  if (inferredTargetPersonId && ['high', 'medium'].includes(confidence)) {
    return 'link_task_to_person';
  }

  if (!inferredTargetPersonId && currentTargetCompanyId) {
    return 'leave_unassigned';
  }

  if (!inferredTargetPersonId && inferredTargetCompanyId && confidence !== 'unknown') {
    return confidence === 'low' ? 'manual_review' : 'link_task_to_company';
  }

  if (inferredTargetPersonId) {
    return 'manual_review';
  }

  return 'leave_unassigned';
}

function buildTaskRetrofitWarnings({ personLink, inferredPerson, recommendedAction }) {
  const warnings = [...(personLink.warnings ?? [])];

  if (personLink.personId && !inferredPerson) {
    warnings.push('Inferred Person ID was not present in the fetched People set.');
  }

  if (recommendedAction === 'manual_review') {
    warnings.push('Task target inference requires manual review before any relationship write.');
  }

  if (recommendedAction === 'leave_unassigned' && !personLink.currentTargetPersonId && !personLink.personId) {
    warnings.push('No reliable Person inference found; leave unassigned until reviewed.');
  }

  return uniqueStrings(warnings);
}

function summarizeTaskPlans(plans = []) {
  return {
    totalTasks: plans.length,
    currentPersonTargets: plans.filter((plan) => plan.currentTargetPersonId).length,
    inferredPersonTargets: plans.filter((plan) => plan.inferredTargetPersonId).length,
    safeToUpdate: plans.filter((plan) => plan.safeToUpdate).length,
    manualReview: plans.filter((plan) => plan.recommendedAction === 'manual_review').length,
    unassignedTasks: plans.filter((plan) => plan.recommendedAction === 'leave_unassigned' && !plan.currentTargetPersonId).length,
    byRecommendedAction: countByValue(plans, (plan) => plan.recommendedAction),
    byConfidence: countByValue(plans, (plan) => plan.confidence)
  };
}

function groupTaskTargetsByTaskId(taskTargets = []) {
  const map = new Map();

  for (const taskTarget of taskTargets) {
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

function getTaskBody(task) {
  if (typeof task?.bodyV2 === 'string') {
    return task.bodyV2;
  }

  return task?.bodyV2?.markdown ?? task?.body ?? task?.description ?? '';
}

function parseBodyPersonId(body) {
  return body?.match(/(?:Person ID|personId):\s*([a-zA-Z0-9-]+)/i)?.[1] ?? null;
}

function getPersonName(person = {}) {
  return (
    person.name?.fullName ??
    [person.name?.firstName ?? person.nameFirstName, person.name?.lastName ?? person.nameLastName]
      .filter(Boolean)
      .join(' ') ??
    person.fullName ??
    null
  );
}

function normalizeSelect(value) {
  return String(value ?? '').trim().toUpperCase();
}

function countByValue(records, getValue) {
  return records.reduce((acc, record) => {
    const key = getValue(record) ?? 'UNKNOWN';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.length > 0)));
}
