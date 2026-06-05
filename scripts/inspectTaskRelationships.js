import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { createTwentyQueueDataSource } from '../src/integrations/twenty/queueDataSource.js';
import { createTwentyMetadataClient, findObject } from '../src/integrations/twenty/metadataClient.js';
import {
  createWorkspaceMemberIndex,
  normalizeOwner,
  resolveTaskPersonLink
} from '../src/services/queueService.js';

async function main() {
  const config = loadConfig();
  const personId = process.env.PERSON_ID;
  const taskId = process.env.TASK_ID;
  const limit = Number(process.env.LIMIT ?? 100);
  const taskRetrofitPlan = await loadTaskRetrofitPlan(
    process.env.TASK_RETROFIT_PLAN_PATH ?? config.legacyTaskRetrofit?.planPath
  );
  const taskRetrofitCandidatesByTaskId = new Map(
    (taskRetrofitPlan?.plans ?? [])
      .filter((plan) => plan.recommendedAction === 'link_task_to_person')
      .map((plan) => [String(plan.taskId), plan])
  );
  const source = createTwentyQueueDataSource({
    config: config.twenty,
    log: logger
  });
  const [records, metadata] = await Promise.all([
    source.listAllQueueRecords({
      pageSize: Math.min(Math.max(limit, 1), 100),
      maxPages: config.legacyRetrofit?.maxPages ?? 10
    }),
    inspectTaskMetadata({ config, log: logger })
  ]);
  const workspaceMembersById = createWorkspaceMemberIndex(records.workspaceMembers ?? []);
  const selectedTasks = (records.tasks ?? []).filter((task) => !taskId || String(task.id) === String(taskId));
  const selectedPeople = (records.people ?? []).filter((person) => !personId || String(person.id) === String(personId));
  const taskTargetsByTaskId = groupBy(records.taskTargets ?? [], (target) => target.taskId);
  const diagnostics = selectedTasks.slice(0, limit).map((task) => {
    const taskTargets = taskTargetsByTaskId.get(String(task.id ?? '')) ?? [];
    const body = getTaskBody(task);
    const resolution = resolveTaskPersonLink({
      task,
      body,
      taskTargets,
      people: records.people ?? [],
      workspaceMembersById
    });
    const person = resolution.personId
      ? (records.people ?? []).find((candidate) => String(candidate.id) === String(resolution.personId))
      : null;
    const retrofitCandidate = taskRetrofitCandidatesByTaskId.get(String(task.id ?? '')) ?? null;
    const retrofitStatus = buildTaskRetrofitStatus({
      retrofitCandidate,
      taskTargets
    });

    return {
      taskId: task.id,
      taskTitle: task.title ?? task.name ?? null,
      taskStatus: task.status ?? null,
      taskTargets,
      resolvedPerson: person
        ? {
            id: person.id,
            name: getPersonName(person),
            owner: normalizeOwner(person, 'person', workspaceMembersById)
          }
        : null,
      resolvedCompanyId: resolution.companyId,
      assignee: normalizeOwner(task, 'task', workspaceMembersById),
      resolutionPath: resolution.path,
      resolutionSource: resolution.source,
      confidence: resolution.confidence,
      queueBucket: resolution.personId ? null : 'unassigned_tasks',
      warnings: [
        ...(resolution.warnings ?? []),
        ...(!resolution.personId
          ? ['Task does not expose a reliable Person relationship through taskTargets, task fields, body markers, or inference.']
          : [])
      ],
      relationshipGaps: {
        missingTaskTargetPerson: !resolution.currentTargetPersonId,
        missingTaskTargetCompany: !resolution.currentTargetCompanyId,
        inferredPersonWithoutTaskTarget: Boolean(resolution.personId && !resolution.currentTargetPersonId)
      },
      taskRetrofitCandidate: retrofitCandidate
        ? {
            recommendedAction: retrofitCandidate.recommendedAction,
            safeToUpdate: retrofitCandidate.safeToUpdate,
            confidence: retrofitCandidate.confidence,
            inferredTargetPersonId: retrofitCandidate.inferredTargetPersonId
          }
        : null,
      taskRetrofitStatus: retrofitStatus
    };
  });
  const planCandidates = Array.from(taskRetrofitCandidatesByTaskId.values());
  const candidateStatuses = planCandidates.map((candidate) =>
    buildTaskRetrofitStatus({
      retrofitCandidate: candidate,
      taskTargets: taskTargetsByTaskId.get(String(candidate.taskId ?? '')) ?? []
    })
  );

  console.log(
    JSON.stringify(
      {
        metadata,
        filters: {
          PERSON_ID: personId ?? null,
          TASK_ID: taskId ?? null,
          LIMIT: limit
        },
        taskRetrofitPlan: taskRetrofitPlan
          ? {
              path: process.env.TASK_RETROFIT_PLAN_PATH ?? config.legacyTaskRetrofit?.planPath,
              candidates: planCandidates.length,
              nowLinked: candidateStatuses.filter((status) => status?.status === 'linked').length,
              stillUnlinked: candidateStatuses.filter((status) => status?.status === 'still_unlinked').length
            }
          : null,
        pagination: summarizePagination(records.pagination),
        selectedPeople: selectedPeople.map((person) => ({
          id: person.id,
          name: getPersonName(person),
          owner: normalizeOwner(person, 'person', workspaceMembersById)
        })),
        diagnostics,
        warnings: records.warnings ?? []
      },
      null,
      2
    )
  );
}

async function loadTaskRetrofitPlan(planPath) {
  if (!planPath) {
    return null;
  }

  try {
    return JSON.parse(await readFile(planPath, 'utf8'));
  } catch {
    return null;
  }
}

function buildTaskRetrofitStatus({ retrofitCandidate, taskTargets = [] }) {
  if (!retrofitCandidate) {
    return null;
  }

  const linked = taskTargets.some(
    (target) =>
      String(target.targetPersonId ?? '') ===
      String(retrofitCandidate.inferredTargetPersonId ?? '')
  );

  return {
    taskId: retrofitCandidate.taskId,
    expectedTargetPersonId: retrofitCandidate.inferredTargetPersonId,
    status: linked ? 'linked' : 'still_unlinked'
  };
}

async function inspectTaskMetadata({ config, log }) {
  try {
    const client = createTwentyMetadataClient(config.twenty, log);
    const schema = await client.discoverSchema(['task', 'taskTarget', 'workspaceMember']);
    const task = findObject(schema, 'task');
    const taskTarget = findObject(schema, 'taskTarget');

    return {
      task: summarizeFields(task, ['taskTargets', 'assignee', 'status', 'dueAt']),
      taskTarget: summarizeFields(taskTarget, ['task', 'targetPerson', 'targetCompany', 'targetPersonId', 'targetCompanyId', 'taskId'])
    };
  } catch (error) {
    return {
      error: error.message
    };
  }
}

function summarizeFields(object, fieldNames) {
  return Object.fromEntries(
    fieldNames.map((fieldName) => {
      const field = object?.fieldsByName?.[fieldName];
      return [
        fieldName,
        field
          ? {
              exists: true,
              name: field.name,
              label: field.label,
              type: field.type,
              relationType: field.settings?.relationType ?? null,
              joinColumnName: field.settings?.joinColumnName ?? null
            }
          : {
              exists: false
            }
      ];
    })
  );
}

function groupBy(records, getKey) {
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

function getTaskBody(task) {
  if (typeof task?.bodyV2 === 'string') {
    return task.bodyV2;
  }

  return task?.bodyV2?.markdown ?? task?.body ?? task?.description ?? '';
}

function getPersonName(person = {}) {
  return (
    person.name?.fullName ??
    [person.name?.firstName ?? person.nameFirstName, person.name?.lastName ?? person.nameLastName]
      .filter(Boolean)
      .join(' ') ??
    null
  );
}

function summarizePagination(pagination) {
  if (!pagination?.objects) {
    return pagination ?? null;
  }

  return Object.fromEntries(
    Object.entries(pagination.objects).map(([objectName, value]) => [
      objectName,
      {
        pagesFetched: value.pagesFetched,
        totalFetched: value.totalFetched,
        totalCount: value.totalCount,
        hasMore: value.hasMore
      }
    ])
  );
}

main().catch((error) => {
  console.error('Task relationship inspection failed.');
  console.error(
    JSON.stringify(
      {
        message: error.message,
        code: error.code,
        httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
