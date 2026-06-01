const STAFFING_TERMS = [
  'staffing',
  'recruiting',
  'workforce',
  'talent',
  'ats',
  'vms',
  'operations',
  'delivery'
];

export function scoreOutboundLead(lead) {
  const icpFitScore = calculateIcpFitScore(lead);
  const leadHealthScore = calculateLeadHealthScore(lead, icpFitScore);

  return {
    icpFitScore,
    leadHealthScore,
    staleRisk: leadHealthScore >= 75 ? 'LOW' : leadHealthScore >= 55 ? 'MEDIUM' : 'HIGH',
    discoveryReadiness:
      icpFitScore >= 75 && leadHealthScore >= 70
        ? 'MONITOR'
        : 'NOT_READY'
  };
}

export function calculateIcpFitScore(lead) {
  let score = 35;
  const searchText = [
    lead.title,
    lead.companyName,
    lead.notes,
    lead.companyWebsite
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (lead.companyName) {
    score += 15;
  }

  if (lead.title) {
    score += 10;
  }

  if (lead.companyWebsite) {
    score += 10;
  }

  if (STAFFING_TERMS.some((term) => searchText.includes(term))) {
    score += 20;
  }

  if (lead.outboundPipelineType === 'ASSESSMENT_CAMPAIGN') {
    score += 10;
  }

  return clampScore(score);
}

export function calculateLeadHealthScore(lead, icpFitScore = calculateIcpFitScore(lead)) {
  let score = Math.round(icpFitScore * 0.55);

  if (lead.email) {
    score += 15;
  }

  if (lead.linkedinUrl) {
    score += 15;
  }

  if (lead.phone) {
    score += 5;
  }

  if (lead.notes) {
    score += 10;
  }

  return clampScore(score);
}

export function buildOutboundOutreachAngle(lead, scores) {
  const companyContext = lead.companyName ? ` at ${lead.companyName}` : '';
  const sourceContext = lead.leadSource ? ` via ${lead.leadSource}` : '';

  if (lead.outboundPipelineType === 'ASSESSMENT_CAMPAIGN') {
    return `Invite ${lead.fullName}${companyContext} to compare current operating gaps against the Spot the Gap assessment${sourceContext}.`;
  }

  if (scores.icpFitScore >= 75) {
    return `Start a relationship-led conversation with ${lead.fullName}${companyContext} around operational visibility and execution constraints${sourceContext}.`;
  }

  return `Open a light relationship-building touch with ${lead.fullName}${companyContext} and validate fit before introducing a stronger CTA.`;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
