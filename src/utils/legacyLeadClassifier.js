import { PROTECTED_ASSESSMENT_FIELDS } from '../integrations/twenty/quickCaptureClient.js';
import { mapLegacyLeadStage, normalizeLegacyLeadStage } from './legacyLeadStageMapper.js';

export const LEGACY_OUTBOUND_FIELDS = [
  'outboundPipelineType',
  'cadenceName',
  'cadenceStage',
  'enrichmentStatus',
  'icpFitScore',
  'leadHealthScore',
  'lastOutboundTouchDate',
  'nextOutboundTouchDate',
  'outreachAngle',
  'latestTouchChannel',
  'latestTouchStatus',
  'quickCaptureUrl',
  'staleRisk',
  'discoveryReadiness'
];

export function classifyLegacyLead({ person = {}, evidence = {} } = {}) {
  const taskCount = evidence.taskCount ?? 0;
  const noteCount = evidence.noteCount ?? 0;
  const timelineCount = evidence.timelineCount ?? 0;
  const hasTaskHistory = taskCount > 0;
  const hasNoteHistory = noteCount > 0;
  const hasTimelineHistory = timelineCount > 0;
  const eventTrue = Boolean(person.eventCustom);
  const legacyLeadStage = normalizeLegacyLeadStage(person.leadStage);
  const hasAdvancedLegacyStage = Boolean(legacyLeadStage && legacyLeadStage !== 'IDENTIFIED');
  const stageMapping = mapLegacyLeadStage(legacyLeadStage, {
    hasConnectionTask: evidence.hasConnectionTask
  });
  const inferredPipelineType =
    eventTrue || hasTaskHistory || hasNoteHistory || hasTimelineHistory || hasAdvancedLegacyStage
      ? 'RELATIONSHIP_BUILDING'
      : 'ASSESSMENT_CAMPAIGN';
  const inferredCadenceName =
    inferredPipelineType === 'RELATIONSHIP_BUILDING'
      ? 'RELATIONSHIP_BUILDING_V1'
      : 'ASSESSMENT_CAMPAIGN_V1';
  const inferredFromStage = stageMapping.updates;
  const historicalCadenceStage = normalizeCadenceStage(evidence.historicalTaskStage);
  const mappedCadenceStage =
    inferredFromStage.cadenceStage ??
    (inferredPipelineType === 'RELATIONSHIP_BUILDING' ? 'CONNECTION_REQUEST' : 'NOT_STARTED');
  const inferredCadenceStage = chooseMoreAdvancedCadenceStage(
    mappedCadenceStage,
    historicalCadenceStage
  );
  const inferredDiscoveryReadiness =
    inferredFromStage.discoveryReadiness ??
    (hasAdvancedLegacyStage ? 'MONITOR' : 'NOT_READY');
  const inferredLeadHealthScore =
    inferredFromStage.leadHealthScore ??
    inferLeadHealthScore({
      eventTrue,
      hasTaskHistory,
      hasNoteHistory,
      hasTimelineHistory,
      hasAdvancedLegacyStage,
      pipelineType: inferredPipelineType
    });
  const inferredStaleRisk =
    inferredFromStage.staleRisk ??
    (legacyLeadStage === 'UNQUALIFIED_CLOSED' ? 'STALE' : 'MEDIUM');
  const warnings = [...stageMapping.warnings];

  if (!legacyLeadStage && (hasTaskHistory || hasNoteHistory || eventTrue)) {
    warnings.push('Legacy history found without manual leadStage; mapped conservatively.');
  }

  const inferred = {
    outboundPipelineType: inferredPipelineType,
    cadenceName: inferredCadenceName,
    cadenceStage: inferredCadenceStage,
    discoveryReadiness: inferredDiscoveryReadiness,
    leadHealthScore: inferredLeadHealthScore,
    staleRisk: inferredStaleRisk,
    enrichmentStatus: warnings.length > 0 ? 'NEEDS_REVIEW' : 'PARTIAL',
    latestTouchChannel: inferLatestTouchChannel({ eventTrue, person }),
    latestTouchStatus:
      inferredFromStage.latestTouchStatus ??
      (evidence.completedTaskCount > 0
        ? 'SENT'
        : hasTaskHistory || hasNoteHistory || hasTimelineHistory
          ? 'SENT'
          : 'DRAFTED'),
    icpFitScore: inferIcpFitScore(person),
    outreachAngle: buildLegacyOutreachAngle({ person, inferredPipelineType })
  };

  return {
    inferred,
    evidence: {
      eventTrue,
      legacyLeadStage,
      hasTaskHistory,
      hasNoteHistory,
      hasTimelineHistory,
      taskCount,
      noteCount,
      timelineCount,
      hasAdvancedLegacyStage,
      taskIds: evidence.taskIds ?? [],
      taskTargetIds: evidence.taskTargetIds ?? [],
      completedTaskCount: evidence.completedTaskCount ?? 0,
      historicalTaskStage: evidence.historicalTaskStage ?? null,
      historicalTaskIds: evidence.historicalTaskIds ?? [],
      historicalTaskReasons: evidence.historicalTaskReasons ?? [],
      noteIds: evidence.noteIds ?? [],
      noteTargetIds: evidence.noteTargetIds ?? [],
      timelineActivityIds: evidence.timelineActivityIds ?? [],
      fallbackTaskBodyMatches: evidence.fallbackTaskBodyMatches ?? 0,
      classificationReasons: buildClassificationReasons({
        eventTrue,
        hasTaskHistory,
        hasNoteHistory,
        hasTimelineHistory,
        legacyLeadStage,
        inferredPipelineType,
        historicalCadenceStage: evidence.historicalTaskStage
      })
    },
    warnings: [
      ...warnings,
      ...(evidence.historicalTaskStage
        ? [`Historical task evidence advanced cadence inference to ${evidence.historicalTaskStage}.`]
        : [])
    ]
  };
}

export function buildLegacyRetrofitRecommendation({
  person,
  evidence,
  ownerResolution,
  now = new Date()
} = {}) {
  const classification = classifyLegacyLead({ person, evidence });
  const currentFields = getCurrentOutboundFields(person);
  const missingFields = LEGACY_OUTBOUND_FIELDS.filter((fieldName) => isMissingValue(person[fieldName]));
  const recommendedUpdates = {};

  for (const [fieldName, value] of Object.entries(classification.inferred)) {
    if (PROTECTED_ASSESSMENT_FIELDS.includes(fieldName)) {
      continue;
    }

    if (isMissingValue(person[fieldName]) && !isMissingValue(value)) {
      recommendedUpdates[fieldName] = value;
    }
  }

  if (isMissingValue(person.nextOutboundTouchDate) && !isTerminalCadence(recommendedUpdates.cadenceStage ?? person.cadenceStage)) {
    recommendedUpdates.nextOutboundTouchDate = toDateOnly(now);
  }

  const warnings = [
    ...classification.warnings,
    ...(ownerResolution?.warnings ?? []),
    ...buildRecommendationWarnings({ person, recommendedUpdates, missingFields })
  ];
  const safeToUpdate =
    Object.keys(recommendedUpdates).length > 0 &&
    warnings.every((warning) => !/Unrecognized|manual review/i.test(warning)) &&
    !includesProtectedFields(recommendedUpdates);

  return {
    personId: person.id ?? null,
    name: getPersonName(person),
    company: getCompanyName(person),
    ownerId: ownerResolution?.ownerId ?? null,
    ownerName: ownerResolution?.ownerName ?? null,
    ownerEmail: ownerResolution?.ownerEmail ?? null,
    ownerWorkspaceMemberId: ownerResolution?.ownerWorkspaceMemberId ?? null,
    createdById: ownerResolution?.createdById ?? null,
    createdByName: ownerResolution?.createdByName ?? null,
    createdByEmail: ownerResolution?.createdByEmail ?? null,
    inferredOwnerName: ownerResolution?.inferredOwnerName ?? null,
    inferredOwnerEmail: ownerResolution?.inferredOwnerEmail ?? null,
    inferredOwnerWorkspaceMemberId: ownerResolution?.inferredOwnerWorkspaceMemberId ?? null,
    ownerResolutionStatus: ownerResolution?.ownerResolutionStatus ?? 'missing',
    ownerRecommendation: ownerResolution?.ownerRecommendation ?? null,
    recommendedWorkspaceEmail: ownerResolution?.recommendedWorkspaceEmail ?? null,
    currentFields,
    inferredPipelineType: classification.inferred.outboundPipelineType,
    inferredCadenceName: classification.inferred.cadenceName,
    inferredCadenceStage: classification.inferred.cadenceStage,
    inferredDiscoveryReadiness: classification.inferred.discoveryReadiness,
    inferredLeadHealthScore: classification.inferred.leadHealthScore,
    inferredStaleRisk: classification.inferred.staleRisk,
    missingFields,
    recommendedUpdates,
    evidence: classification.evidence,
    warnings,
    safeToUpdate
  };
}

function inferLeadHealthScore({
  eventTrue,
  hasTaskHistory,
  hasNoteHistory,
  hasTimelineHistory,
  hasAdvancedLegacyStage,
  pipelineType
}) {
  let score = pipelineType === 'RELATIONSHIP_BUILDING' ? 50 : 35;

  if (eventTrue) score += 8;
  if (hasTaskHistory) score += 10;
  if (hasNoteHistory) score += 8;
  if (hasTimelineHistory) score += 4;
  if (hasAdvancedLegacyStage) score += 8;

  return Math.min(score, 85);
}

function inferIcpFitScore(person) {
  if (person.icpFitScore) {
    return Number(person.icpFitScore);
  }

  return person.companyId || person.company?.id || getCompanyName(person) ? 55 : 40;
}

function inferLatestTouchChannel({ eventTrue, person }) {
  const source = String(person.leadSource ?? person.eventSource ?? '').toUpperCase();

  if (eventTrue || /EVENT|IN_PERSON|IN PERSON/.test(source)) {
    return 'IN_PERSON';
  }

  if (/EMAIL/.test(source)) {
    return 'EMAIL';
  }

  if (/PHONE/.test(source)) {
    return 'PHONE';
  }

  return 'LINKEDIN';
}

function buildLegacyOutreachAngle({ person, inferredPipelineType }) {
  const name = getPersonName(person) || 'this lead';
  const company = getCompanyName(person);
  const mode =
    inferredPipelineType === 'RELATIONSHIP_BUILDING'
      ? 'continue relationship-building outreach'
      : 'introduce the Spot the Gap assessment';

  return company
    ? `Use existing Visible Gap CRM context to ${mode} with ${name} at ${company}.`
    : `Use existing Visible Gap CRM context to ${mode} with ${name}.`;
}

function buildClassificationReasons({
  eventTrue,
  hasTaskHistory,
  hasNoteHistory,
  hasTimelineHistory,
  legacyLeadStage,
  inferredPipelineType,
  historicalCadenceStage
}) {
  return [
    eventTrue ? 'Event boolean is true.' : null,
    hasTaskHistory ? 'Task history exists.' : null,
    hasNoteHistory ? 'Note history exists.' : null,
    hasTimelineHistory ? 'Timeline history exists.' : null,
    legacyLeadStage ? `Manual leadStage is ${legacyLeadStage}.` : null,
    historicalCadenceStage ? `Historical task stage evidence: ${historicalCadenceStage}.` : null,
    `Inferred pipeline type: ${inferredPipelineType}.`
  ].filter(Boolean);
}

function chooseMoreAdvancedCadenceStage(left, right) {
  if (!right) {
    return left;
  }

  if (!left) {
    return right;
  }

  return cadenceStageRank(right) > cadenceStageRank(left) ? right : left;
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
    PAUSED: 7,
    COMPLETED: 7
  }[normalizeCadenceStage(stage)] ?? -1;
}

function normalizeCadenceStage(value) {
  return String(value ?? '').trim().toUpperCase();
}

function buildRecommendationWarnings({ person, recommendedUpdates, missingFields }) {
  const warnings = [];

  if (!person.email && !person.emails?.primaryEmail && !person.linkedinLink?.primaryLinkUrl) {
    warnings.push('Missing strong contact identifiers; manual review recommended.');
  }

  if (missingFields.length === 0 && Object.keys(recommendedUpdates).length === 0) {
    warnings.push('No missing outbound fields detected.');
  }

  if (includesProtectedFields(recommendedUpdates)) {
    warnings.push('Protected assessment fields were detected in recommended updates and must be removed.');
  }

  return warnings;
}

function getCurrentOutboundFields(person = {}) {
  return Object.fromEntries(LEGACY_OUTBOUND_FIELDS.map((fieldName) => [fieldName, person[fieldName] ?? null]));
}

function includesProtectedFields(payload = {}) {
  return Object.keys(payload).some((fieldName) => PROTECTED_ASSESSMENT_FIELDS.includes(fieldName));
}

function isMissingValue(value) {
  return value === undefined || value === null || value === '';
}

function isTerminalCadence(stage) {
  return ['PAUSED', 'COMPLETED'].includes(String(stage ?? '').toUpperCase());
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function getPersonName(person = {}) {
  return (
    person.name?.fullName ??
    [person.name?.firstName ?? person.nameFirstName, person.name?.lastName ?? person.nameLastName]
      .filter(Boolean)
      .join(' ')
  );
}

function getCompanyName(person = {}) {
  return person.company?.name ?? person.companyName ?? person.company?.displayName ?? '';
}
