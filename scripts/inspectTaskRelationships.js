import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { createTwentyQueueDataSource } from '../src/integrations/twenty/queueDataSource.js';
import { createTwentyMetadataClient, findObject } from '../src/integrations/twenty/metadataClient.js';
import {
  createWorkspaceMemberIndex,
  normalizeOwner,
  resolveTaskPersonLink
} from '../src/services/queueService.js';

const DEFAULT_TOP_UNLINKED_LIMIT = 25;
const SUMMARY_PATH = 'data/task-relationship-summary.md';
const JSON_REPORT_PATH = 'data/task-relationship-report.json';
const CSV_REPORT_PATH = 'data/task-relationship-report.csv';
const quietLog = {
  info() {},
  warn() {},
  error() {}
};

async function main() {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const personId = args.personId ?? process.env.PERSON_ID;
  const taskId = args.taskId ?? process.env.TASK_ID;
  const limit = normalizePositiveInt(args.limit ?? process.env.LIMIT, 100);
  const filters = {
    personId: personId ?? null,
    taskId: taskId ?? null,
    limit,
    showOnlyUnlinked: toBoolean(args.showOnlyUnlinked ?? process.env.SHOW_ONLY_UNLINKED),
    showOnlySafeLinks: toBoolean(args.showOnlySafeLinks ?? process.env.SHOW_ONLY_SAFE_LINKS)
  };
  const taskRetrofitPlan = await loadTaskRetrofitPlan(
    process.env.TASK_RETROFIT_PLAN_PATH ?? config.legacyTaskRetrofit?.planPath
  );
  const source = createTwentyQueueDataSource({
    config: config.twenty,
    log: quietLog
  });
  const [records, metadata] = await Promise.all([
    source.listAllQueueRecords({
      pageSize: Math.min(Math.max(limit, 1), 100),
      maxPages: config.legacyRetrofit?.maxPages ?? 10
    }),
    inspectTaskMetadata({ config, log: quietLog })
  ]);
  const report = buildTaskRelationshipReport({
    records,
    metadata,
    taskRetrofitPlan,
    filters,
    planPath: process.env.TASK_RETROFIT_PLAN_PATH ?? config.legacyTaskRetrofit?.planPath,
    generatedAt: new Date().toISOString()
  });

  await writeGeneratedReports(report);
  printOutput(report, args);
}

export function buildTaskRelationshipReport({
  records = {},
  metadata = null,
  taskRetrofitPlan = null,
  filters = {},
  planPath = null,
  generatedAt = new Date().toISOString()
} = {}) {
  const workspaceMembersById = createWorkspaceMemberIndex(records.workspaceMembers ?? []);
  const taskTargetsByTaskId = groupBy(records.taskTargets ?? [], (target) => target.taskId);
  const taskRetrofitCandidatesByTaskId = new Map(
    (taskRetrofitPlan?.plans ?? [])
      .filter((plan) => plan.recommendedAction === 'link_task_to_person')
      .map((plan) => [String(plan.taskId), plan])
  );
  const allDiagnostics = (records.tasks ?? []).map((task) =>
    buildTaskDiagnostic({
      task,
      records,
      taskTargets: taskTargetsByTaskId.get(String(task.id ?? '')) ?? [],
      workspaceMembersById,
      retrofitCandidate: taskRetrofitCandidatesByTaskId.get(String(task.id ?? '')) ?? null
    })
  );
  const filteredDiagnostics = applyFilters(allDiagnostics, filters);
  const diagnostics = filteredDiagnostics.slice(0, filters.limit ?? 100);
  const planCandidates = Array.from(taskRetrofitCandidatesByTaskId.values());
  const candidateStatuses = planCandidates.map((candidate) =>
    buildTaskRetrofitStatus({
      retrofitCandidate: candidate,
      taskTargets: taskTargetsByTaskId.get(String(candidate.taskId ?? '')) ?? []
    })
  );
  const summary = buildSummary(filteredDiagnostics, candidateStatuses);
  const topUnlinkedTasks = filteredDiagnostics
    .filter((diagnostic) => !diagnostic.currentTargetPersonId)
    .slice(0, DEFAULT_TOP_UNLINKED_LIMIT)
    .map(toTopUnlinkedTask);
  const taskCandidatesReadyForLinking = filteredDiagnostics
    .filter(isReadyForTaskTargetLink)
    .map(toTaskCandidate);
  const selectedPeople = (records.people ?? [])
    .filter((person) => !filters.personId || String(person.id) === String(filters.personId))
    .map((person) => ({
      id: person.id,
      name: getPersonName(person),
      owner: normalizeOwner(person, 'person', workspaceMembersById)
    }));

  return {
    generatedAt,
    metadata,
    filters: {
      personId: filters.personId ?? null,
      taskId: filters.taskId ?? null,
      limit: filters.limit,
      showOnlyUnlinked: Boolean(filters.showOnlyUnlinked),
      showOnlySafeLinks: Boolean(filters.showOnlySafeLinks)
    },
    outputFiles: {
      summary: SUMMARY_PATH,
      json: JSON_REPORT_PATH,
      csv: CSV_REPORT_PATH
    },
    taskRetrofitPlan: taskRetrofitPlan
      ? {
          path: planPath,
          candidates: planCandidates.length,
          nowLinked: candidateStatuses.filter((status) => status?.status === 'linked').length,
          stillUnlinked: candidateStatuses.filter((status) => status?.status === 'still_unlinked').length
        }
      : null,
    pagination: summarizePagination(records.pagination),
    selectedPeople,
    summary,
    topUnlinkedTasks,
    taskCandidatesReadyForLinking,
    diagnostics,
    warnings: records.warnings ?? []
  };
}

function buildTaskDiagnostic({
  task = {},
  records = {},
  taskTargets = [],
  workspaceMembersById,
  retrofitCandidate = null
}) {
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
  const assignee = normalizeOwner(task, 'task', workspaceMembersById);
  const retrofitStatus = buildTaskRetrofitStatus({
    retrofitCandidate,
    taskTargets
  });
  const recommendedAction = retrofitCandidate?.recommendedAction ?? inferRecommendedAction(resolution);
  const reason = buildTaskReason({ resolution, retrofitCandidate });

  return {
    taskId: task.id,
    taskTitle: task.title ?? task.name ?? null,
    taskStatus: task.status ?? null,
    taskTargets,
    currentTargetPersonId: resolution.currentTargetPersonId ?? null,
    currentTargetCompanyId: resolution.currentTargetCompanyId ?? null,
    resolvedPerson: person
      ? {
          id: person.id,
          name: getPersonName(person),
          owner: normalizeOwner(person, 'person', workspaceMembersById)
        }
      : null,
    resolvedCompanyId: resolution.companyId,
    assignee,
    resolutionPath: resolution.path,
    resolutionSource: resolution.source,
    resolutionEvidence: resolution.evidence ?? [],
    confidence: resolution.confidence,
    recommendedAction,
    reason,
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
          inferredTargetPersonId: retrofitCandidate.inferredTargetPersonId,
          inferredTargetPersonName: retrofitCandidate.inferredTargetPersonName,
          evidence: retrofitCandidate.evidence
        }
      : null,
    taskRetrofitStatus: retrofitStatus
  };
}

function applyFilters(diagnostics, filters = {}) {
  return diagnostics.filter((diagnostic) => {
    if (filters.taskId && String(diagnostic.taskId) !== String(filters.taskId)) {
      return false;
    }

    if (
      filters.personId &&
      String(diagnostic.resolvedPerson?.id ?? diagnostic.taskRetrofitCandidate?.inferredTargetPersonId ?? '') !==
        String(filters.personId)
    ) {
      return false;
    }

    if (filters.showOnlyUnlinked && diagnostic.currentTargetPersonId) {
      return false;
    }

    if (filters.showOnlySafeLinks && diagnostic.taskRetrofitCandidate?.safeToUpdate !== true) {
      return false;
    }

    return true;
  });
}

function buildSummary(diagnostics = [], candidateStatuses = []) {
  return {
    totalTasks: diagnostics.length,
    linkedTasks: diagnostics.filter((diagnostic) => Boolean(diagnostic.currentTargetPersonId)).length,
    unlinkedTasks: diagnostics.filter((diagnostic) => !diagnostic.currentTargetPersonId).length,
    tasksLinkedThroughTaskTargets: diagnostics.filter(
      (diagnostic) => diagnostic.resolutionSource === 'task_target'
    ).length,
    tasksLinkedThroughPersonIdParsing: diagnostics.filter(
      (diagnostic) => diagnostic.resolutionSource === 'task_body_marker'
    ).length,
    tasksLinkedThroughInference: diagnostics.filter((diagnostic) =>
      ['task_person_name_match', 'task_company_match', 'task_owner_assignee_match'].includes(
        diagnostic.resolutionSource
      )
    ).length,
    tasksRequiringManualReview: diagnostics.filter(
      (diagnostic) => diagnostic.recommendedAction === 'manual_review'
    ).length,
    tasksWithOwnerResolution: diagnostics.filter(
      (diagnostic) => Boolean(diagnostic.resolvedPerson?.owner)
    ).length,
    tasksWithAssigneeResolution: diagnostics.filter((diagnostic) => Boolean(diagnostic.assignee)).length,
    safeTaskLinkCandidates: diagnostics.filter(isReadyForTaskTargetLink).length,
    remainingUnassignedTasks: diagnostics.filter(
      (diagnostic) => diagnostic.recommendedAction === 'leave_unassigned' && !diagnostic.currentTargetPersonId
    ).length,
    taskRetrofitCandidatesLinked: candidateStatuses.filter((status) => status?.status === 'linked').length,
    taskRetrofitCandidatesStillUnlinked: candidateStatuses.filter(
      (status) => status?.status === 'still_unlinked'
    ).length
  };
}

function toTopUnlinkedTask(diagnostic) {
  return {
    taskId: diagnostic.taskId,
    title: diagnostic.taskTitle,
    assignee: formatOwner(diagnostic.assignee),
    recommendedAction: diagnostic.recommendedAction,
    confidence: diagnostic.confidence,
    reason: diagnostic.reason
  };
}

function toTaskCandidate(diagnostic) {
  return {
    taskId: diagnostic.taskId,
    personId: diagnostic.taskRetrofitCandidate?.inferredTargetPersonId ?? diagnostic.resolvedPerson?.id ?? null,
    personName: diagnostic.taskRetrofitCandidate?.inferredTargetPersonName ?? diagnostic.resolvedPerson?.name ?? null,
    confidence: diagnostic.taskRetrofitCandidate?.confidence ?? diagnostic.confidence,
    evidence:
      diagnostic.taskRetrofitCandidate?.evidence?.resolutionEvidence ??
      diagnostic.resolutionEvidence ??
      []
  };
}

function isReadyForTaskTargetLink(diagnostic) {
  return (
    diagnostic.taskRetrofitCandidate?.safeToUpdate === true &&
    diagnostic.taskRetrofitStatus?.status !== 'linked' &&
    !diagnostic.currentTargetPersonId
  );
}

async function writeGeneratedReports(report) {
  await Promise.all([
    writeFile(resolve(SUMMARY_PATH), buildMarkdownSummary(report), 'utf8'),
    writeFile(resolve(JSON_REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(resolve(CSV_REPORT_PATH), buildCsvReport(report.diagnostics), 'utf8')
  ]);
}

function printOutput(report, args) {
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.csv) {
    console.log(buildCsvReport(report.diagnostics));
    return;
  }

  if (args.summary || !args.json) {
    console.log(buildTerminalSummary(report));
  }
}

function buildMarkdownSummary(report) {
  return [
    '# Task Relationship Summary',
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    '## Counts',
    '',
    summaryMarkdownTable(report.summary),
    '',
    '## Top Unlinked Tasks',
    '',
    markdownTable({
      headers: ['Task ID', 'Title', 'Assignee', 'Recommended Action', 'Confidence', 'Reason'],
      rows: report.topUnlinkedTasks.map((task) => [
        task.taskId,
        task.title,
        task.assignee,
        task.recommendedAction,
        task.confidence,
        task.reason
      ])
    }),
    '',
    '## Task Candidates Ready For Linking',
    '',
    markdownTable({
      headers: ['Task ID', 'Person ID', 'Person Name', 'Confidence', 'Evidence'],
      rows: report.taskCandidatesReadyForLinking.map((candidate) => [
        candidate.taskId,
        candidate.personId,
        candidate.personName,
        candidate.confidence,
        candidate.evidence.join('; ')
      ])
    }),
    '',
    '## Generated Files',
    '',
    `- JSON: \`${JSON_REPORT_PATH}\``,
    `- CSV: \`${CSV_REPORT_PATH}\``,
    ''
  ].join('\n');
}

function buildTerminalSummary(report) {
  return [
    'Task Relationship Summary',
    '',
    `Generated at: ${report.generatedAt}`,
    `Total Tasks: ${report.summary.totalTasks}`,
    `Linked Tasks: ${report.summary.linkedTasks}`,
    `Unlinked Tasks: ${report.summary.unlinkedTasks}`,
    `Tasks linked through taskTargets: ${report.summary.tasksLinkedThroughTaskTargets}`,
    `Tasks linked through Person ID parsing: ${report.summary.tasksLinkedThroughPersonIdParsing}`,
    `Tasks linked through inference: ${report.summary.tasksLinkedThroughInference}`,
    `Tasks requiring manual review: ${report.summary.tasksRequiringManualReview}`,
    `Tasks with owner resolution: ${report.summary.tasksWithOwnerResolution}`,
    `Tasks with assignee resolution: ${report.summary.tasksWithAssigneeResolution}`,
    `Safe task-link candidates: ${report.summary.safeTaskLinkCandidates}`,
    `Remaining unassigned tasks: ${report.summary.remainingUnassignedTasks}`,
    '',
    `Generated files:`,
    `- ${SUMMARY_PATH}`,
    `- ${JSON_REPORT_PATH}`,
    `- ${CSV_REPORT_PATH}`,
    '',
    'Top Unlinked Tasks:',
    terminalTable({
      headers: ['Task ID', 'Title', 'Assignee', 'Action', 'Confidence'],
      rows: report.topUnlinkedTasks.slice(0, DEFAULT_TOP_UNLINKED_LIMIT).map((task) => [
        task.taskId,
        truncate(task.title, 44),
        truncate(task.assignee, 24),
        task.recommendedAction,
        task.confidence
      ])
    }),
    '',
    'Task Candidates Ready For Linking:',
    terminalTable({
      headers: ['Task ID', 'Person ID', 'Person', 'Confidence'],
      rows: report.taskCandidatesReadyForLinking.map((candidate) => [
        candidate.taskId,
        candidate.personId,
        truncate(candidate.personName, 28),
        candidate.confidence
      ])
    }),
    report.warnings.length > 0 ? `\nWarnings:\n- ${report.warnings.join('\n- ')}` : ''
  ].join('\n');
}

function buildCsvReport(diagnostics = []) {
  const headers = [
    'taskId',
    'title',
    'status',
    'currentTargetPersonId',
    'resolvedPersonId',
    'resolvedPersonName',
    'assignee',
    'resolutionSource',
    'confidence',
    'recommendedAction',
    'safeToUpdate',
    'retrofitStatus',
    'reason',
    'warnings'
  ];
  const rows = diagnostics.map((diagnostic) => [
    diagnostic.taskId,
    diagnostic.taskTitle,
    diagnostic.taskStatus,
    diagnostic.currentTargetPersonId,
    diagnostic.resolvedPerson?.id,
    diagnostic.resolvedPerson?.name,
    formatOwner(diagnostic.assignee),
    diagnostic.resolutionSource,
    diagnostic.confidence,
    diagnostic.recommendedAction,
    diagnostic.taskRetrofitCandidate?.safeToUpdate,
    diagnostic.taskRetrofitStatus?.status,
    diagnostic.reason,
    diagnostic.warnings.join('; ')
  ]);

  return [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
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

function inferRecommendedAction(resolution = {}) {
  if (resolution.currentTargetPersonId) {
    return 'leave_unassigned';
  }

  if (resolution.personId && ['high', 'medium'].includes(resolution.confidence)) {
    return 'link_task_to_person';
  }

  if (resolution.personId) {
    return 'manual_review';
  }

  return 'leave_unassigned';
}

function buildTaskReason({ resolution = {}, retrofitCandidate = null }) {
  if (retrofitCandidate?.warnings?.length) {
    return retrofitCandidate.warnings.join('; ');
  }

  if (retrofitCandidate?.evidence?.resolutionEvidence?.length) {
    return retrofitCandidate.evidence.resolutionEvidence.join('; ');
  }

  if (resolution.evidence?.length) {
    return resolution.evidence.join('; ');
  }

  if (resolution.currentTargetPersonId) {
    return 'Existing taskTarget Person link found.';
  }

  if (!resolution.personId) {
    return 'No reliable Person inference found.';
  }

  return resolution.path?.join(' > ') ?? 'Relationship resolved.';
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

function parseArgs(argv = []) {
  return argv.reduce(
    (acc, arg) => {
      if (arg === '--summary') {
        acc.summary = true;
        return acc;
      }

      if (arg === '--json') {
        acc.json = true;
        return acc;
      }

      if (arg === '--csv') {
        acc.csv = true;
        return acc;
      }

      const match = arg.match(/^--([^=]+)=(.*)$/);

      if (!match) {
        return acc;
      }

      const [, key, value] = match;
      const normalizedKey = key.replace(/-([a-z])/g, (_full, letter) => letter.toUpperCase());
      acc[normalizedKey] = value;
      return acc;
    },
    {
      summary: false,
      json: false,
      csv: false
    }
  );
}

function summaryMarkdownTable(summary = {}) {
  return markdownTable({
    headers: ['Metric', 'Count'],
    rows: [
      ['Total Tasks', summary.totalTasks],
      ['Linked Tasks', summary.linkedTasks],
      ['Unlinked Tasks', summary.unlinkedTasks],
      ['Tasks linked through taskTargets', summary.tasksLinkedThroughTaskTargets],
      ['Tasks linked through Person ID parsing', summary.tasksLinkedThroughPersonIdParsing],
      ['Tasks linked through inference', summary.tasksLinkedThroughInference],
      ['Tasks requiring manual review', summary.tasksRequiringManualReview],
      ['Tasks with owner resolution', summary.tasksWithOwnerResolution],
      ['Tasks with assignee resolution', summary.tasksWithAssigneeResolution],
      ['Safe task-link candidates', summary.safeTaskLinkCandidates],
      ['Remaining unassigned tasks', summary.remainingUnassignedTasks],
      ['Task retrofit candidates already linked', summary.taskRetrofitCandidatesLinked],
      ['Task retrofit candidates still unlinked', summary.taskRetrofitCandidatesStillUnlinked]
    ]
  });
}

function markdownTable({ headers = [], rows = [] } = {}) {
  if (rows.length === 0) {
    return '_None._';
  }

  return [
    `| ${headers.map(escapeMarkdown).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdown).join(' | ')} |`)
  ].join('\n');
}

function terminalTable({ headers = [], rows = [] } = {}) {
  if (rows.length === 0) {
    return 'None.';
  }

  return [
    headers.join(' | '),
    headers.map(() => '---').join(' | '),
    ...rows.map((row) => row.map((value) => value ?? '').join(' | '))
  ].join('\n');
}

function formatOwner(owner) {
  if (!owner) {
    return null;
  }

  return owner.name && owner.email ? `${owner.name} <${owner.email}>` : owner.name ?? owner.email ?? owner.id ?? null;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function escapeCsv(value) {
  const stringValue = String(value ?? '');

  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replace(/"/g, '""')}"`;
}

function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

function truncate(value, length) {
  const stringValue = String(value ?? '');

  return stringValue.length > length ? `${stringValue.slice(0, length - 3)}...` : stringValue;
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
