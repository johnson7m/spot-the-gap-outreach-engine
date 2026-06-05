export const LEGACY_LEAD_STAGE_VALUES = [
  'IDENTIFIED',
  'OUTREACH_INITIATED',
  'ENGAGED',
  'ACTIVE_CONVERSATION',
  'DISCOVERY_READY',
  'UNQUALIFIED_CLOSED',
  'ACTIVE_CLIENT'
];

const STAGE_MAP = {
  IDENTIFIED: {
    cadenceStage: 'NOT_STARTED',
    discoveryReadiness: 'NOT_READY',
    staleRisk: 'LOW',
    leadHealthScore: 35
  },
  OUTREACH_INITIATED: {
    cadenceStage: 'CONNECTION_REQUEST',
    discoveryReadiness: 'NOT_READY',
    latestTouchStatus: 'SENT',
    leadHealthScore: 45
  },
  ENGAGED: {
    cadenceStage: 'VALUE_TOUCH',
    discoveryReadiness: 'MONITOR',
    latestTouchStatus: 'RESPONDED',
    leadHealthScore: 65
  },
  ACTIVE_CONVERSATION: {
    cadenceStage: 'STRATEGIC_CHECK_IN',
    discoveryReadiness: 'MONITOR',
    latestTouchStatus: 'RESPONDED',
    leadHealthScore: 72
  },
  DISCOVERY_READY: {
    cadenceStage: 'DISCOVERY_ASK',
    discoveryReadiness: 'READY',
    latestTouchStatus: 'RESPONDED',
    leadHealthScore: 85
  },
  UNQUALIFIED_CLOSED: {
    cadenceStage: 'PAUSED',
    discoveryReadiness: 'NOT_READY',
    staleRisk: 'STALE',
    latestTouchStatus: 'DECLINED',
    leadHealthScore: 10
  },
  ACTIVE_CLIENT: {
    cadenceStage: 'COMPLETED',
    discoveryReadiness: 'BOOKED',
    staleRisk: 'LOW',
    latestTouchStatus: 'COMPLETED',
    leadHealthScore: 100
  }
};

export function mapLegacyLeadStage(leadStage, { hasConnectionTask = false } = {}) {
  const normalized = normalizeLegacyLeadStage(leadStage);
  const mapped = STAGE_MAP[normalized];

  if (!mapped) {
    return {
      legacyLeadStage: normalized,
      recognized: false,
      updates: {},
      warnings: normalized ? [`Unrecognized legacy leadStage: ${normalized}`] : []
    };
  }

  const updates = { ...mapped };

  if (normalized === 'OUTREACH_INITIATED' && hasConnectionTask) {
    updates.cadenceStage = 'INTRO_MESSAGE';
  }

  if (
    normalized === 'ACTIVE_CONVERSATION' &&
    Number(updates.leadHealthScore ?? 0) >= 75
  ) {
    updates.discoveryReadiness = 'READY';
  }

  return {
    legacyLeadStage: normalized,
    recognized: true,
    updates,
    warnings: []
  };
}

export function normalizeLegacyLeadStage(value) {
  return String(value ?? '').trim().toUpperCase();
}
