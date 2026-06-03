export function buildQuickCaptureCrmPayloads({
  lead,
  scores,
  cadence,
  supportedPersonFields = new Set()
}) {
  const companyPayload = createQuickCaptureCompanyPayload({ lead });
  const personPayload = createQuickCapturePersonPayload({
    lead,
    scores,
    cadence,
    supportedPersonFields
  });
  const taskDedupeKey = `quick-capture:${lead.dedupe.key}:task:${cadence.cadenceName}:${cadence.cadenceStage}`;
  const taskPayload = createQuickCaptureTaskPayload({
    lead,
    scores,
    cadence,
    dedupeKey: taskDedupeKey
  });

  return {
    company: lead.companyName
      ? {
          object: 'company',
          action: 'upsert',
          dedupeKey: lead.companyDomain
            ? `company:domain:${lead.companyDomain}`
            : `company:name:${lead.companyName}`,
          payload: companyPayload
        }
      : null,
    person: {
      object: 'person',
      action: 'upsert',
      dedupeKey: lead.dedupe.key,
      payload: personPayload
    },
    task: {
      object: 'task',
      action: 'create',
      dedupeKey: taskDedupeKey,
      payload: taskPayload
    }
  };
}

export function createQuickCapturePersonPayload({
  lead,
  scores,
  cadence,
  supportedPersonFields = new Set()
}) {
  const payload = {
    name: {
      firstName: lead.firstName ?? '',
      lastName: lead.lastName ?? ''
    },
    leadSource: lead.leadSource,
    outboundPipelineType: cadence.pipelineType,
    cadenceName: cadence.cadenceName,
    cadenceStage: cadence.cadenceStage,
    enrichmentStatus: lead.email && lead.linkedinUrl ? 'PARTIAL' : 'NOT_STARTED',
    icpFitScore: scores.icpFitScore,
    leadHealthScore: scores.leadHealthScore,
    nextOutboundTouchDate: cadence.nextOutboundTouchDate,
    outreachAngle: scores.outreachAngle,
    latestTouchChannel: cadence.firstTask.channel,
    latestTouchStatus: 'DRAFTED',
    staleRisk: scores.staleRisk,
    discoveryReadiness: scores.discoveryReadiness
  };

  if (lead.email) {
    payload.emails = {
      primaryEmail: lead.email,
      additionalEmails: []
    };
  }

  const phonePayload = createTwentyPhonePayload(lead.phone);

  if (phonePayload) {
    payload.phones = phonePayload;
  }

  if (lead.title) {
    payload.jobTitle = lead.title;
  }

  if (lead.linkedinUrl) {
    payload.linkedinLink = {
      primaryLinkUrl: lead.linkedinUrl,
      primaryLinkLabel: 'LinkedIn'
    };
  }

  if (lead.linkedinUrl && supportedPersonFields.has('quickCaptureUrl')) {
    payload.quickCaptureUrl = {
      primaryLinkUrl: lead.linkedinUrl,
      primaryLinkLabel: 'Quick Capture Source'
    };
  }

  return stripUnsupportedPersonFields(stripEmpty(payload), supportedPersonFields);
}

export function createQuickCaptureCompanyPayload({ lead }) {
  const payload = {
    name: lead.companyName
  };

  if (lead.companyWebsite || lead.companyDomain) {
    payload.domainName = {
      primaryLinkUrl: lead.companyWebsite || `https://${lead.companyDomain}`,
      primaryLinkLabel: lead.companyDomain || lead.companyWebsite
    };
  }

  return stripEmpty(payload);
}

export function createQuickCaptureTaskPayload({ lead, scores, cadence, dedupeKey }) {
  return {
    title: cadence.firstTask.title,
    status: 'TODO',
    dueAt: cadence.firstTask.dueAt,
    bodyV2: {
      markdown: buildTaskMarkdown({ lead, scores, cadence, dedupeKey })
    }
  };
}

function buildTaskMarkdown({ lead, scores, cadence, dedupeKey }) {
  return [
    `Source: Quick Capture`,
    `Dedupe strategy: ${lead.dedupe.strategy}`,
    `Lead dedupe key: ${lead.dedupe.key}`,
    `Dedupe key: ${dedupeKey}`,
    `Pipeline type: ${cadence.pipelineType}`,
    `Cadence: ${cadence.cadenceName}`,
    `Cadence stage: ${cadence.cadenceStage}`,
    `Channel: ${cadence.firstTask.channel}`,
    `ICP fit score: ${scores.icpFitScore}`,
    `Lead health score: ${scores.leadHealthScore}`,
    `Discovery readiness: ${scores.discoveryReadiness}`,
    '',
    cadence.firstTask.body,
    '',
    `Outreach angle: ${scores.outreachAngle}`,
    '',
    `Lead: ${lead.fullName}`,
    `Title: ${lead.title || 'Not provided'}`,
    `Company: ${lead.companyName || 'Not provided'}`,
    `Email: ${lead.email || 'Not provided'}`,
    `LinkedIn URL: ${lead.linkedinUrl || 'Not provided'}`,
    `Company website: ${lead.companyWebsite || 'Not provided'}`,
    '',
    `Capture notes: ${lead.notes || 'Not provided'}`,
    '',
    'Manual action required. Do not automate LinkedIn requests or messages.'
  ].join('\n');
}

function stripUnsupportedPersonFields(payload, supportedPersonFields) {
  if (!supportedPersonFields.size) {
    return payload;
  }

  return Object.fromEntries(
    Object.entries(payload).filter(([fieldName]) => supportedPersonFields.has(fieldName))
  );
}

export function createTwentyPhonePayload(phone) {
  const value = String(phone ?? '').trim();

  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, '');

  if (!value.startsWith('+1') || digits.length !== 11 || !digits.startsWith('1')) {
    return null;
  }

  return {
    primaryPhoneCountryCode: 'US',
    primaryPhoneCallingCode: '+1',
    primaryPhoneNumber: digits.slice(1),
    additionalPhones: []
  };
}

function stripEmpty(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => {
      if (fieldValue === undefined || fieldValue === null) {
        return false;
      }

      if (typeof fieldValue === 'string') {
        return fieldValue.length > 0;
      }

      return true;
    })
  );
}
