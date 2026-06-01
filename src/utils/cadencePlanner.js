export const OUTBOUND_PIPELINE_TYPES = {
  ASSESSMENT_CAMPAIGN: 'ASSESSMENT_CAMPAIGN',
  RELATIONSHIP_BUILDING: 'RELATIONSHIP_BUILDING',
  GENERAL_PROSPECT: 'GENERAL_PROSPECT'
};

export const CADENCE_NAMES = {
  ASSESSMENT_CAMPAIGN_V1: 'ASSESSMENT_CAMPAIGN_V1',
  RELATIONSHIP_BUILDING_V1: 'RELATIONSHIP_BUILDING_V1',
  NONE: 'NONE'
};

export const CADENCE_STAGES = {
  NOT_STARTED: 'NOT_STARTED',
  CONNECTION_REQUEST: 'CONNECTION_REQUEST'
};

export function planInitialCadence({
  outboundPipelineType,
  availablePipelineTypes = [],
  availableCadenceNames = [],
  availableCadenceStages = [],
  now = new Date()
} = {}) {
  const pipelineType = resolvePipelineType(outboundPipelineType, availablePipelineTypes);
  const cadenceName = resolveCadenceName(pipelineType, availableCadenceNames);
  const cadenceStage = resolveCadenceStage(pipelineType, cadenceName, availableCadenceStages);
  const dueAt = nextBusinessDay(now);

  return {
    pipelineType,
    cadenceName,
    cadenceStage,
    nextOutboundTouchDate: toDateOnly(dueAt),
    firstTask: buildFirstTaskPlan({ pipelineType, cadenceName, cadenceStage, dueAt })
  };
}

function resolvePipelineType(value, availablePipelineTypes) {
  if (value && availablePipelineTypes.includes(value)) {
    return value;
  }

  if (value && Object.values(OUTBOUND_PIPELINE_TYPES).includes(value)) {
    return value;
  }

  if (availablePipelineTypes.includes(OUTBOUND_PIPELINE_TYPES.GENERAL_PROSPECT)) {
    return OUTBOUND_PIPELINE_TYPES.GENERAL_PROSPECT;
  }

  return OUTBOUND_PIPELINE_TYPES.RELATIONSHIP_BUILDING;
}

function resolveCadenceName(pipelineType, availableCadenceNames) {
  const desired =
    pipelineType === OUTBOUND_PIPELINE_TYPES.ASSESSMENT_CAMPAIGN
      ? CADENCE_NAMES.ASSESSMENT_CAMPAIGN_V1
      : pipelineType === OUTBOUND_PIPELINE_TYPES.RELATIONSHIP_BUILDING
        ? CADENCE_NAMES.RELATIONSHIP_BUILDING_V1
        : CADENCE_NAMES.NONE;

  if (availableCadenceNames.length === 0 || availableCadenceNames.includes(desired)) {
    return desired;
  }

  if (availableCadenceNames.includes(CADENCE_NAMES.NONE)) {
    return CADENCE_NAMES.NONE;
  }

  return availableCadenceNames[0];
}

function resolveCadenceStage(pipelineType, cadenceName, availableCadenceStages) {
  const desired =
    pipelineType === OUTBOUND_PIPELINE_TYPES.GENERAL_PROSPECT ||
    cadenceName === CADENCE_NAMES.NONE
      ? CADENCE_STAGES.NOT_STARTED
      : CADENCE_STAGES.CONNECTION_REQUEST;

  if (availableCadenceStages.length === 0 || availableCadenceStages.includes(desired)) {
    return desired;
  }

  if (availableCadenceStages.includes(CADENCE_STAGES.CONNECTION_REQUEST)) {
    return CADENCE_STAGES.CONNECTION_REQUEST;
  }

  return availableCadenceStages[0];
}

function buildFirstTaskPlan({ pipelineType, cadenceName, cadenceStage, dueAt }) {
  if (pipelineType === OUTBOUND_PIPELINE_TYPES.ASSESSMENT_CAMPAIGN) {
    return {
      channel: 'LINKEDIN',
      title: 'Send assessment-oriented connection request',
      body: 'Send a manual connection request that opens the door to the Spot the Gap assessment. Do not automate LinkedIn actions.',
      dueAt: dueAt.toISOString(),
      cadenceName,
      cadenceStage
    };
  }

  if (pipelineType === OUTBOUND_PIPELINE_TYPES.RELATIONSHIP_BUILDING) {
    return {
      channel: 'LINKEDIN',
      title: 'Send relationship-oriented connection request',
      body: 'Send a manual connection request focused on relevance and relationship-building. Do not automate LinkedIn actions.',
      dueAt: dueAt.toISOString(),
      cadenceName,
      cadenceStage
    };
  }

  return {
    channel: 'OTHER',
    title: 'Review general prospect and choose outbound path',
    body: 'Review the captured lead, confirm fit, and choose assessment campaign or relationship-building cadence before outreach.',
    dueAt: dueAt.toISOString(),
    cadenceName,
    cadenceStage
  };
}

function nextBusinessDay(value) {
  const date = new Date(value);
  const day = date.getUTCDay();

  if (day === 5) {
    date.setUTCDate(date.getUTCDate() + 3);
  } else if (day === 6) {
    date.setUTCDate(date.getUTCDate() + 2);
  } else {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  return date;
}

function toDateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}
