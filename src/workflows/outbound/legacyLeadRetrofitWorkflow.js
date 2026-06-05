import { createTwentyMetadataClient, findObject } from '../../integrations/twenty/metadataClient.js';
import { createTwentyQueueDataSource } from '../../integrations/twenty/queueDataSource.js';
import {
  buildLegacyRetrofitRecommendation,
  LEGACY_OUTBOUND_FIELDS
} from '../../utils/legacyLeadClassifier.js';
import { resolveLegacyOwner } from '../../utils/legacyOwnerResolver.js';

const METADATA_OBJECTS = [
  'person',
  'task',
  'taskTarget',
  'noteTarget',
  'timelineActivity',
  'workspaceMember'
];

export async function planLegacyLeadRetrofit({
  config = {},
  dataSource,
  metadataClient,
  log,
  limit = 100,
  all = false,
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
  const [metadata, records] = await Promise.all([
    discoverLegacyMetadata({ config, metadataClient, log }),
    fetchLegacyRecords({
      source,
      all,
      limit,
      pageSize,
      maxPages
    })
  ]);
  const people = records.people ?? [];
  const evidenceByPersonId = buildEvidenceByPersonId(records);
  const workspaceMembers = records.workspaceMembers ?? [];
  const plans = people.map((person) =>
    buildLegacyRetrofitRecommendation({
      person,
      evidence: evidenceByPersonId.get(String(person.id)) ?? emptyEvidence(),
      ownerResolution: resolveLegacyOwner({
        person,
        workspaceMembers
      }),
      now
    })
  );
  const summary = summarizePlans(plans);
  const pagination = buildPaginationSummary({
    records,
    all,
    limit,
    pageSize,
    maxPages,
    finalPlanCount: plans.length
  });
  const warnings = [
    ...(records.warnings ?? []),
    ...buildPaginationWarnings({
      all,
      peopleCount: people.length,
      pageSize,
      pagination
    })
  ];

  return {
    status: 'dry_run',
    dryRun: true,
    generatedAt: now.toISOString(),
    metadata,
    pagination,
    warnings,
    summary,
    plans
  };
}

async function fetchLegacyRecords({ source, all, limit, pageSize, maxPages }) {
  if (all && typeof source.listAllQueueRecords === 'function') {
    return source.listAllQueueRecords({
      pageSize,
      maxPages
    });
  }

  const records = await source.listQueueRecords({ limit });

  if (all) {
    return {
      ...records,
      warnings: [
        ...(records.warnings ?? []),
        'LEGACY_RETROFIT_ALL=true requested, but the configured data source does not support cursor pagination; fetched one page only.'
      ],
      pagination: {
        requestedMode: 'all',
        pageSize,
        maxPages,
        objects: {
          people: {
            objectPlural: 'people',
            mechanism: 'single_page_fallback',
            pageSize,
            maxPages,
            pagesFetched: 1,
            totalFetched: records.people?.length ?? 0,
            totalCount: null,
            hasMore: (records.people?.length ?? 0) >= pageSize,
            nextCursor: null
          }
        }
      }
    };
  }

  return {
    ...records,
    pagination: {
      requestedMode: 'limited',
      limit,
      objects: {
        people: {
          objectPlural: 'people',
          mechanism: 'single_page',
          pageSize: limit,
          maxPages: 1,
          pagesFetched: 1,
          totalFetched: records.people?.length ?? 0,
          totalCount: null,
          hasMore: false,
          nextCursor: null
        }
      }
    }
  };
}

function buildEvidenceByPersonId(records = {}) {
  const map = new Map();

  for (const person of records.people ?? []) {
    if (!person?.id) {
      continue;
    }

    map.set(String(person.id), {
      ...emptyEvidence(),
      personId: String(person.id)
    });
  }

  for (const taskTarget of records.taskTargets ?? []) {
    const personId = taskTarget.targetPersonId;

    if (!personId) {
      continue;
    }

    const evidence = ensureEvidence(map, personId);
    evidence.taskCount += 1;
    evidence.taskTargetIds.push(taskTarget.id);
    evidence.taskIds.push(taskTarget.taskId);
  }

  for (const noteTarget of records.noteTargets ?? []) {
    const personId = noteTarget.targetPersonId;

    if (!personId) {
      continue;
    }

    const evidence = ensureEvidence(map, personId);
    evidence.noteCount += 1;
    evidence.noteTargetIds.push(noteTarget.id);
    evidence.noteIds.push(noteTarget.noteId);
  }

  for (const activity of records.timelineActivities ?? []) {
    const personId = activity.targetPersonId;

    if (!personId) {
      continue;
    }

    const evidence = ensureEvidence(map, personId);
    evidence.timelineCount += 1;
    evidence.timelineActivityIds.push(activity.id);
  }

  for (const task of records.tasks ?? []) {
    const body = getTaskBody(task);
    const bodyPersonId = body?.match(/(?:Person ID|personId):\s*([a-zA-Z0-9-]+)/i)?.[1];
    const targetPersonId = findTaskTargetPersonId(records.taskTargets, task.id);
    const personId = bodyPersonId ?? targetPersonId;

    if (personId) {
      const evidence = ensureEvidence(map, personId);
      evidence.taskCount += 1;
      addUnique(evidence.taskIds, task.id);

      if (bodyPersonId && !targetPersonId) {
        evidence.fallbackTaskBodyMatches += 1;
      }

      addTaskHistoryEvidence(evidence, task, body);
    }

    if (/connection request|connect/i.test(`${task.title ?? ''} ${body ?? ''}`)) {
      const target = personId;

      if (target) {
        ensureEvidence(map, target).hasConnectionTask = true;
      }
    }
  }

  return map;
}

function summarizePlans(plans = []) {
  const needingUpdate = plans.filter((plan) => Object.keys(plan.recommendedUpdates).length > 0);
  const safeToUpdate = needingUpdate.filter((plan) => plan.safeToUpdate);
  const manualReview = plans.filter((plan) => !plan.safeToUpdate && Object.keys(plan.recommendedUpdates).length > 0);
  const alreadyRetrofitted = plans.filter((plan) => Object.keys(plan.recommendedUpdates).length === 0);

  return {
    totalRecords: plans.length,
    alreadyRetrofitted: alreadyRetrofitted.length,
    needingUpdate: needingUpdate.length,
    safeToUpdate: safeToUpdate.length,
    requiresManualReview: manualReview.length,
    byPipelineType: countBy(plans, 'inferredPipelineType'),
    byCadenceStage: countBy(plans, 'inferredCadenceStage'),
    recordsByOwner: countByValue(plans, (plan) => plan.ownerName ?? plan.ownerId ?? 'Missing owner'),
    recordsByCreatedBy: countByValue(plans, (plan) => plan.createdByName ?? plan.createdById ?? 'Missing Created By'),
    recordsWithMissingOwner: countByOwnerStatus(plans, 'missing'),
    recordsWithResolvedOwner: countByOwnerStatus(plans, 'resolved'),
    recordsWithUnresolvedOwner: countByOwnerStatus(plans, 'unresolved'),
    recordsInferredFromCreatedBy: countByOwnerStatus(plans, 'inferred_from_created_by'),
    recordsStillMissingOwner: plans.filter((plan) =>
      ['missing', 'unresolved'].includes(plan.ownerResolutionStatus)
    ).length,
    recordsOwnedByVisibleGap: countByOwnerStatus(plans, 'legacy_visible_gap'),
    recordsByRecommendedWorkspaceEmail: countByValue(
      plans.filter((plan) => plan.recommendedWorkspaceEmail),
      (plan) => plan.recommendedWorkspaceEmail
    ),
    ownerRecommendationsByPerson: Object.fromEntries(
      plans
        .filter((plan) => plan.ownerRecommendation)
        .map((plan) => [
          plan.personId,
          {
            name: plan.name,
            createdByName: plan.createdByName,
            createdByEmail: plan.createdByEmail,
            recommendedOwnerName: plan.ownerRecommendation.recommendedOwnerName,
            recommendedOwnerEmail: plan.ownerRecommendation.recommendedOwnerEmail,
            recommendedOwnerWorkspaceMemberId:
              plan.ownerRecommendation.recommendedOwnerWorkspaceMemberId,
            source: plan.ownerRecommendation.source
          }
        ])
    )
  };
}

function buildPaginationSummary({ records, all, limit, pageSize, maxPages, finalPlanCount }) {
  const sourcePagination = records.pagination ?? {};
  const people = sourcePagination.objects?.people ?? {
    objectPlural: 'people',
    mechanism: all ? 'unknown' : 'single_page',
    pageSize: all ? pageSize : limit,
    maxPages: all ? maxPages : 1,
    pagesFetched: 1,
    totalFetched: records.people?.length ?? 0,
    totalCount: null,
    hasMore: false,
    nextCursor: null
  };

  return {
    requestedMode: all ? 'all' : 'limited',
    limit: all ? null : limit,
    pageSize: all ? pageSize : people.pageSize,
    maxPages: all ? maxPages : people.maxPages,
    pagesFetched: people.pagesFetched ?? 0,
    totalFetched: people.totalFetched ?? records.people?.length ?? 0,
    totalCount: people.totalCount ?? null,
    hasMore: Boolean(people.hasMore),
    nextCursor: people.nextCursor ?? null,
    finalPlanCount,
    objects: sourcePagination.objects ?? {
      people
    }
  };
}

function buildPaginationWarnings({ all, peopleCount, pageSize, pagination }) {
  const warnings = [];
  const likelyMoreFromTotal =
    Number.isFinite(Number(pagination.totalCount)) && Number(pagination.totalCount) > peopleCount;

  if (all && peopleCount === pageSize && (pagination.hasMore || likelyMoreFromTotal)) {
    warnings.push(
      'LEGACY_RETROFIT_ALL=true fetched exactly one page while Twenty reports more records; check cursor pagination before applying.'
    );
  }

  if (all && pagination.hasMore) {
    warnings.push(
      `LEGACY_RETROFIT_ALL=true stopped before all People were fetched. Fetched ${peopleCount} of ${pagination.totalCount ?? 'unknown'} records. Increase LEGACY_RETROFIT_MAX_PAGES or inspect pagination.`
    );
  }

  return warnings;
}

async function discoverLegacyMetadata({ config = {}, metadataClient, log }) {
  const twentyConfig = config.twenty ?? config;

  if (!twentyConfig.apiKey && !metadataClient) {
    return {
      status: 'skipped',
      fields: {},
      warnings: ['Twenty metadata discovery skipped because TWENTY_API_KEY is not configured.']
    };
  }

  try {
    const client = metadataClient ?? createTwentyMetadataClient(twentyConfig, log);
    const schema = await client.discoverSchema(METADATA_OBJECTS);
    const person = findObject(schema, 'person');

    return {
      status: 'discovered',
      fields: {
        eventBoolean: summarizeField(person?.fieldsByName?.eventCustom),
        manualLeadStage: summarizeField(person?.fieldsByName?.leadStage),
        owner: summarizeField(person?.fieldsByName?.owner),
        createdBy: summarizeField(person?.fieldsByName?.createdBy),
        company: summarizeField(person?.fieldsByName?.company),
        taskTargets: summarizeField(person?.fieldsByName?.taskTargets),
        noteTargets: summarizeField(person?.fieldsByName?.noteTargets),
        timelineActivities: summarizeField(person?.fieldsByName?.timelineActivities),
        outboundFields: Object.fromEntries(
          LEGACY_OUTBOUND_FIELDS.map((fieldName) => [
            fieldName,
            summarizeField(person?.fieldsByName?.[fieldName])
          ])
        )
      },
      warnings: []
    };
  } catch (error) {
    return {
      status: 'failed',
      fields: {},
      warnings: [`Twenty legacy metadata discovery failed: ${error.message}`]
    };
  }
}

function summarizeField(field) {
  if (!field) {
    return {
      exists: false
    };
  }

  return {
    exists: true,
    name: field.name,
    label: field.label,
    type: field.type,
    options: (field.options ?? []).map((option) =>
      typeof option === 'string' ? option : option.value
    ),
    relationType: field.settings?.relationType ?? null,
    joinColumnName: field.settings?.joinColumnName ?? null
  };
}

function ensureEvidence(map, personId) {
  const key = String(personId);
  const existing = map.get(key) ?? { ...emptyEvidence(), personId: key };
  map.set(key, existing);
  return existing;
}

function emptyEvidence() {
  return {
    personId: null,
    taskCount: 0,
    noteCount: 0,
    timelineCount: 0,
    hasConnectionTask: false,
    fallbackTaskBodyMatches: 0,
    completedTaskCount: 0,
    historicalTaskStage: null,
    historicalTaskReasons: [],
    historicalTaskIds: [],
    taskIds: [],
    taskTargetIds: [],
    noteIds: [],
    noteTargetIds: [],
    timelineActivityIds: []
  };
}

function addTaskHistoryEvidence(evidence, task = {}, body = '') {
  const text = `${task.title ?? ''} ${body ?? ''}`;
  const status = normalizeTaskStatus(task.status);
  const completed = isCompletedTaskStatus(status);
  const stage = inferHistoricalCadenceStageFromTaskText(text);

  if (!stage) {
    return;
  }

  if (completed) {
    evidence.completedTaskCount += 1;
  }

  const existingRank = cadenceStageRank(evidence.historicalTaskStage);
  const nextRank = cadenceStageRank(stage);

  if (nextRank > existingRank) {
    evidence.historicalTaskStage = stage;
  }

  addUnique(evidence.historicalTaskIds, task.id);
  addUnique(
    evidence.historicalTaskReasons,
    `${completed ? 'Completed' : 'Historical'} task "${task.title ?? task.id}" maps to ${stage}.`
  );
}

function inferHistoricalCadenceStageFromTaskText(value) {
  const text = String(value ?? '').toLowerCase();

  if (/discovery/.test(text)) {
    return 'DISCOVERY_ASK';
  }

  if (/assessment.*(follow|check)|check.*assessment/.test(text)) {
    return 'ASSESSMENT_CHECK_IN';
  }

  if (/assessment.*(sent|send|link|cta)|day\s*3/.test(text) && /assessment|spot the gap/.test(text)) {
    return 'ASSESSMENT_SENT';
  }

  if (/day\s*3|strategic|month\s*1|check[\s-]?in/.test(text)) {
    return 'STRATEGIC_CHECK_IN';
  }

  if (/day\s*2|value touch|follow[\s-]?up/.test(text)) {
    return /assessment|spot the gap/.test(text) ? 'ASSESSMENT_POSITIONING' : 'VALUE_TOUCH';
  }

  if (/day\s*1|connection|connect|intro|introduction/.test(text)) {
    return 'INTRO_MESSAGE';
  }

  return null;
}

function cadenceStageRank(stage) {
  return {
    NOT_STARTED: 0,
    CONNECTION_REQUEST: 1,
    INTRO_MESSAGE: 2,
    ASSESSMENT_POSITIONING: 3,
    VALUE_TOUCH: 3,
    ASSESSMENT_SENT: 4,
    STRATEGIC_CHECK_IN: 4,
    ASSESSMENT_CHECK_IN: 5,
    DISCOVERY_ASK: 6,
    COMPLETED: 7,
    PAUSED: 7
  }[String(stage ?? '').toUpperCase()] ?? -1;
}

function normalizeTaskStatus(status) {
  return String(status ?? '').trim().toUpperCase();
}

function isCompletedTaskStatus(status) {
  return ['DONE', 'COMPLETED', 'COMPLETE', 'CLOSED'].includes(status);
}

function addUnique(values, value) {
  if (value && !values.includes(value)) {
    values.push(value);
  }
}

function findTaskTargetPersonId(taskTargets = [], taskId) {
  return taskTargets.find((target) => String(target.taskId ?? '') === String(taskId))?.targetPersonId ?? null;
}

function getTaskBody(task) {
  if (typeof task?.bodyV2 === 'string') {
    return task.bodyV2;
  }

  return task?.bodyV2?.markdown ?? task?.body ?? '';
}

function countBy(plans, fieldName) {
  return plans.reduce((acc, plan) => {
    const key = plan[fieldName] ?? 'UNKNOWN';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function countByOwnerStatus(plans, status) {
  return plans.filter((plan) => plan.ownerResolutionStatus === status).length;
}

function countByValue(plans, getValue) {
  return plans.reduce((acc, plan) => {
    const key = getValue(plan);

    if (!key) {
      return acc;
    }

    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}
