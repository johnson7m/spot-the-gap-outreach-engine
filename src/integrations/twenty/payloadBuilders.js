const SOURCE = 'Spot the Gap Assessment';

export function buildAssessmentCrmPayloads({ submission, score, now = new Date() }) {
  const companyPayload = createCompanyPayload({ submission, score });
  const personPayload = createPersonPayload({ submission, score, now });
  const taskDedupeKey = `submission:${submission.submissionId}:task:assessment-review`;
  const taskPayload = createTaskPayload({ submission, score, now, dedupeKey: taskDedupeKey });
  const opportunityPayload = createOpportunityPayload({ submission, score });

  return {
    person: {
      object: 'person',
      action: 'upsert',
      dedupeKey: submission.person.email
        ? `person:email:${submission.person.email}`
        : `person:submission:${submission.submissionId}`,
      payload: personPayload
    },
    company: {
      object: 'company',
      action: 'upsert',
      dedupeKey: submission.company.domain
        ? `company:domain:${submission.company.domain}`
        : `company:name:${submission.company.name ?? 'unknown'}`,
      payload: companyPayload
    },
    task: {
      object: 'task',
      action: 'create_or_skip_by_submission',
      dedupeKey: taskDedupeKey,
      payload: taskPayload
    },
    opportunity: {
      object: 'opportunity',
      action: shouldCreateOpportunity(score) ? 'create_or_update' : 'skip',
      dedupeKey: `submission:${submission.submissionId}:opportunity:assessment`,
      payload: opportunityPayload
    }
  };
}

export function createPersonPayload({ submission, score, now = new Date() }) {
  const fullName = {
    firstName: submission.person.firstName ?? '',
    lastName: submission.person.lastName ?? ''
  };
  const payload = {
    name: fullName,
    assessmentCompleted: true,
    assessmentScore: score.score,
    leadstageAuto: 'ASSESSMENT_COMPLETED',
    messageAngle: buildMessageAngle(submission, score),
    lastTouchDate: toDateOnly(submission.submittedAt ?? now),
    nextFollowUpDate: toDateOnly(addDays(now, followUpDays(score.priority))),
    leadSource: SOURCE
  };

  if (submission.person.email) {
    payload.emails = {
      primaryEmail: submission.person.email,
      additionalEmails: []
    };
  }

  if (submission.person.phone) {
    payload.phones = {
      primaryPhoneNumber: submission.person.phone,
      additionalPhones: []
    };
  }

  if (submission.person.role) {
    payload.jobTitle = submission.person.role;
  }

  if (submission.person.linkedinUrl) {
    payload.linkedinLink = {
      primaryLinkUrl: submission.person.linkedinUrl,
      primaryLinkLabel: 'LinkedIn'
    };
  }

  return stripUndefined(payload);
}

export function updatePersonPayload(args) {
  return createPersonPayload(args);
}

export function createCompanyPayload({ submission, score }) {
  const payload = {
    name: submission.company.name,
    operationalMaturityScore: scoreToRating(score.score)
  };

  if (submission.company.website || submission.company.domain) {
    payload.domainName = {
      primaryLinkUrl: submission.company.website ?? `https://${submission.company.domain}`,
      primaryLinkLabel: submission.company.domain ?? submission.company.website
    };
  }

  return stripUndefined(payload);
}

export function updateCompanyPayload(args) {
  return createCompanyPayload(args);
}

export function createTaskPayload({ submission, score, now = new Date(), dedupeKey }) {
  const dueAt = addDays(now, followUpDays(score.priority));

  return {
    title: `Review Spot the Gap assessment: ${submission.company.name ?? submission.person.email ?? 'new submission'}`,
    status: 'TODO',
    dueAt: dueAt.toISOString(),
    bodyV2: {
      markdown: buildAssessmentReviewMarkdown(submission, score, dedupeKey)
    }
  };
}

export function createOpportunityPayload({ submission, score }) {
  return {
    name: `${submission.company.name ?? 'Unknown company'} - Spot the Gap diagnostic`,
    stage: 'TARGET_IDENTIFIED',
    dealValue: null,
    hiring: false
  };
}

export function shouldCreateOpportunity(score) {
  return ['C', 'D'].includes(score.grade);
}

function buildMessageAngle(submission, score) {
  const weakAreas = score.weakAreas.map((area) => area.label).join(' and ');
  const businessType = submission.assessment.profile.businessType;
  const context = businessType ? `${businessType}; ` : '';

  return `${context}${score.label}. Focus first conversation on ${weakAreas || 'the lowest-scoring operating areas'}.`;
}

function buildAssessmentReviewMarkdown(submission, score, dedupeKey) {
  return [
    `Source: ${SOURCE}`,
    `Idempotency key: ${dedupeKey}`,
    `Submitted: ${submission.submittedAt}`,
    `Score: ${score.score}/100`,
    `Grade: ${score.grade} - ${score.label}`,
    `Priority: ${score.priority}`,
    `Top weaknesses: ${score.weakAreas.map((area) => `${area.label} (${area.score})`).join(', ')}`,
    `Business type: ${submission.assessment.profile.businessType ?? 'Not provided'}`,
    `Team size: ${submission.assessment.profile.teamSize ?? 'Not provided'}`,
    `Current tools: ${submission.assessment.profile.currentTools ?? 'Not provided'}`,
    '',
    score.recommendedNextAction,
    '',
    'TODO: add idempotency key, audit record link, and approved outreach recommendation once those systems exist.'
  ].join('\n');
}

function followUpDays(priority) {
  if (priority === 'high') {
    return 1;
  }

  if (priority === 'medium') {
    return 3;
  }

  return 14;
}

function scoreToRating(score) {
  if (score >= 86) {
    return 'RATING_5';
  }

  if (score >= 72) {
    return 'RATING_4';
  }

  if (score >= 58) {
    return 'RATING_3';
  }

  if (score >= 40) {
    return 'RATING_2';
  }

  return 'RATING_1';
}

function toDateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function stripUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined)
  );
}
