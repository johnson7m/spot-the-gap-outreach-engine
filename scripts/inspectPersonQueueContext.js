import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { createTwentyQueueDataSource } from '../src/integrations/twenty/queueDataSource.js';
import {
  buildQueueClassificationDiagnostics,
  createCompanyIndex,
  createWorkspaceMemberIndex,
  normalizeOwner,
  resolvePersonCompanyContext
} from '../src/services/queueService.js';
import { buildManualLeadNormalizationPlans } from '../src/workflows/outbound/manualLeadNormalizationPlanner.js';

async function main() {
  const config = loadConfig();
  const personId = process.env.PERSON_ID;

  if (!personId) {
    console.error('PERSON_ID is required. Example: PERSON_ID=<twenty-person-id> npm run queues:inspect-person');
    process.exitCode = 1;
    return;
  }

  const source = createTwentyQueueDataSource({
    config: config.twenty,
    queueRead: config.queueRead ?? {},
    log: logger
  });
  const records = await source.listAllQueueRecords({
    pageSize: Number(process.env.QUEUE_PERSON_INSPECT_PAGE_SIZE ?? 100),
    maxPages: Number(process.env.QUEUE_PERSON_INSPECT_MAX_PAGES ?? config.legacyRetrofit?.maxPages ?? 10)
  });
  const person = (records.people ?? []).find((candidate) => String(candidate.id) === String(personId));

  if (!person) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          personId,
          reason: 'person_not_found_in_queue_read',
          pagination: summarizePagination(records.pagination),
          warnings: records.warnings ?? []
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const companiesById = createCompanyIndex(records.companies ?? []);
  const workspaceMembersById = createWorkspaceMemberIndex(records.workspaceMembers ?? []);
  const companyResolution = resolvePersonCompanyContext(person, companiesById);
  const owner = normalizeOwner(person, 'person', workspaceMembersById);
  const createdBy = normalizeCreatedBy(person, workspaceMembersById);
  const taskTargetsForPerson = (records.taskTargets ?? []).filter(
    (target) => String(target.targetPersonId ?? target.personId ?? target.targetPerson?.id ?? '') === String(personId)
  );
  const tasksForPerson = (records.tasks ?? []).filter((task) =>
    taskTargetsForPerson.some((target) => String(target.taskId ?? '') === String(task.id ?? ''))
  );
  const associatedCompanyPeople = companyResolution.id
    ? (records.people ?? []).filter((candidate) =>
        hasCompanyId(candidate, companyResolution.id)
      )
    : [];
  const classification = buildQueueClassificationDiagnostics({
    people: records.people ?? [],
    companies: records.companies ?? [],
    tasks: records.tasks ?? [],
    taskTargets: records.taskTargets ?? [],
    workspaceMembers: records.workspaceMembers ?? [],
    query: {
      personId,
      limit: 10,
      includeTestRecords: true
    },
    now: new Date()
  });
  const manualNormalizationPlan = buildManualLeadNormalizationPlans(
    records,
    {
      includeTestRecords: true,
      now: new Date()
    }
  ).records.find((record) => record.personId === personId) ?? null;

  console.log(
    JSON.stringify(
      {
        ok: true,
        personId,
        rawPersonFields: pickPersonFields(person),
        companyRelation: {
          rawCompanyField: person.company ?? null,
          companyId: companyResolution.id,
          companyName: companyResolution.name,
          segment: companyResolution.segment,
          industry: companyResolution.industry,
          linkedinUrl: companyResolution.linkedinUrl,
          resolutionStatus: companyResolution.resolutionStatus,
          resolutionPath: companyResolution.resolutionPath,
          associatedPeopleCount: associatedCompanyPeople.length,
          associatedPeople: associatedCompanyPeople.map((candidate) => ({
            id: candidate.id,
            name: getPersonName(candidate)
          })),
          whyCompanyNameResolvedEmpty: companyResolution.name
            ? null
            : explainMissingCompanyName({ person, companyResolution })
        },
        leadStage: person.leadStage ?? null,
        assessmentCompleted: person.assessmentCompleted ?? null,
        owner,
        createdBy,
        associatedTaskTargets: taskTargetsForPerson.map((target) => summarizeTaskTarget(target)),
        associatedTasks: tasksForPerson.map((task) => summarizeTask(task)),
        cadenceFieldDiagnosis: {
          cadenceName: person.cadenceName ?? null,
          cadenceStage: person.cadenceStage ?? null,
          latestTouchChannel: person.latestTouchChannel ?? null,
          latestTouchStatus: person.latestTouchStatus ?? null,
          whyCadenceFieldsResolvedEmpty: explainMissingCadenceFields(person)
        },
        classification: classification.items,
        recommendedNormalization: manualNormalizationPlan,
        pagination: summarizePagination(records.pagination),
        warnings: records.warnings ?? []
      },
      null,
      2
    )
  );
}

function pickPersonFields(person = {}) {
  return {
    id: person.id,
    name: person.name,
    jobTitle: person.jobTitle,
    emails: person.emails,
    linkedinLink: person.linkedinLink,
    companyId: person.companyId ?? person.companyID ?? person.company?.id ?? null,
    companyName: person.companyName ?? person.companyNameName ?? person.company?.name ?? null,
    leadStage: person.leadStage,
    assessmentCompleted: person.assessmentCompleted,
    owner: person.owner,
    ownerId: person.ownerId,
    createdBy: person.createdBy,
    createdById: person.createdById,
    outboundPipelineType: person.outboundPipelineType,
    cadenceName: person.cadenceName,
    cadenceStage: person.cadenceStage,
    latestTouchChannel: person.latestTouchChannel,
    latestTouchStatus: person.latestTouchStatus,
    enrichmentStatus: person.enrichmentStatus
  };
}

function normalizeCreatedBy(person = {}, workspaceMembersById = new Map()) {
  const createdById = person.createdById ?? person.createdBy?.id ?? null;
  const workspaceMember = createdById ? workspaceMembersById.get(String(createdById)) : null;

  return {
    id: createdById,
    name:
      person.createdBy?.name?.fullName ??
      person.createdBy?.name ??
      person.createdByName ??
      workspaceMember?.name ??
      null,
    email:
      person.createdBy?.userEmail ??
      person.createdBy?.email ??
      person.createdBy?.user?.email ??
      workspaceMember?.email ??
      null,
    workspaceMemberId: workspaceMember?.id ?? createdById ?? null
  };
}

function explainMissingCompanyName({ person, companyResolution }) {
  if (companyResolution.id) {
    return 'Person exposes a Company relation ID, but Company name was not available from the Person relation or fetched Companies list.';
  }

  if (person.company) {
    return 'Person has a company relation object, but it did not include a readable name or ID.';
  }

  return 'Person did not expose companyId, company relation, or flattened companyName fields in queue reads.';
}

function explainMissingCadenceFields(person = {}) {
  const missing = [
    !person.outboundPipelineType ? 'outboundPipelineType' : null,
    !person.cadenceName ? 'cadenceName' : null,
    !person.cadenceStage ? 'cadenceStage' : null,
    !person.latestTouchChannel ? 'latestTouchChannel' : null,
    !person.latestTouchStatus ? 'latestTouchStatus' : null
  ].filter(Boolean);

  return missing.length > 0
    ? `Missing outbound normalization fields: ${missing.join(', ')}.`
    : null;
}

function summarizeTaskTarget(target = {}) {
  return {
    id: target.id,
    taskId: target.taskId,
    targetPersonId: target.targetPersonId ?? target.targetPerson?.id ?? null,
    targetCompanyId: target.targetCompanyId ?? target.targetCompany?.id ?? null
  };
}

function summarizeTask(task = {}) {
  return {
    id: task.id,
    title: task.title ?? task.name ?? task.subject ?? null,
    status: task.status,
    dueAt: task.dueAt ?? task.dueDate ?? null
  };
}

function hasCompanyId(person = {}, companyId) {
  return [
    person.companyId,
    person.companyID,
    person.company?.id,
    person.company?.recordId,
    person.company?.targetObjectId,
    person.companies?.[0]?.id,
    person.companies?.[0]?.recordId,
    person.companyIds?.[0]
  ].some((value) => String(value ?? '') === String(companyId));
}

function getPersonName(person = {}) {
  return [
    person.name?.fullName,
    [person.name?.firstName ?? person.nameFirstName, person.name?.lastName ?? person.nameLastName]
      .filter(Boolean)
      .join(' '),
    person.fullName,
    person.displayName
  ].find((value) => typeof value === 'string' && value.trim()) ?? null;
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
  console.error('Person queue inspection failed.');
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
