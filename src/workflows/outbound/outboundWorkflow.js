export const OUTBOUND_EVENT_TYPES = {
  LEAD_RESEARCH_REQUESTED: 'lead_research_requested',
  MESSAGE_ANGLE_PROPOSED: 'message_angle_proposed',
  OUTREACH_DRAFT_REQUESTED: 'outreach_draft_requested',
  HUMAN_APPROVAL_REQUIRED: 'human_approval_required'
};

export async function planOutboundEvent({
  operationalStore,
  assessmentSubmissionId,
  correlationId,
  eventType,
  payload,
  channel = 'linkedin',
  scheduledFor = null
}) {
  if (!operationalStore) {
    throw new Error('An operational store is required to plan outbound events.');
  }

  return operationalStore.appendOutboundEvent({
    assessmentSubmissionId,
    correlationId,
    eventType,
    channel,
    status: 'planned',
    actorType: 'system',
    requiresApproval: true,
    payload,
    scheduledFor
  });
}

export function createOutboundWorkflowPlaceholder() {
  return {
    status: 'not_implemented',
    reason:
      'Outbound orchestration is intentionally limited to event planning until approval queues and execution controls exist.'
  };
}
