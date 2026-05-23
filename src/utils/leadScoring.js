export const assessmentOptions = [
  { label: 'Not true today', value: 1 },
  { label: 'Inconsistent', value: 2 },
  { label: 'Partially true', value: 3 },
  { label: 'Mostly true', value: 4 },
  { label: 'Consistently true', value: 5 }
];

export const assessmentDimensions = {
  reporting: {
    label: 'Reporting reliability',
    recommendation:
      'Define source-of-truth metrics, reporting ownership, and the cadence leaders use to make decisions.'
  },
  ownership: {
    label: 'Workflow ownership',
    recommendation:
      'Clarify who owns each stage, what triggers escalation, and what must be true before work moves forward.'
  },
  systems: {
    label: 'Systems fragmentation',
    recommendation:
      'Map where ATS, VMS, CRM, spreadsheets, and internal tools disagree or duplicate work.'
  },
  handoffs: {
    label: 'Handoffs and onboarding',
    recommendation:
      'Document onboarding, delivery, and handoff checkpoints so work does not depend on individual memory.'
  },
  scale: {
    label: 'Scaling readiness',
    recommendation:
      'Prioritize the process and reporting constraints most likely to break as volume, headcount, or account load increases.'
  }
};

export const assessmentQuestions = [
  {
    id: 'reporting-trust',
    dimension: 'reporting',
    prompt:
      'Leadership can trust operational reporting without manual explanation, cleanup, or side-channel updates.'
  },
  {
    id: 'metric-ownership',
    dimension: 'reporting',
    prompt:
      'Core metrics like pipeline, account health, starts, stuck work, and follow-up have clear definitions and owners.'
  },
  {
    id: 'stage-ownership',
    dimension: 'ownership',
    prompt:
      'Each major workflow stage has a clear owner, expected next action, and escalation path.'
  },
  {
    id: 'accountability-rhythm',
    dimension: 'ownership',
    prompt:
      'Managers can quickly tell who owns a delayed item and what is needed to move it forward.'
  },
  {
    id: 'system-agreement',
    dimension: 'systems',
    prompt:
      'Your ATS, VMS, CRM, spreadsheets, and operating tools generally agree on status, ownership, and priority.'
  },
  {
    id: 'duplicate-admin',
    dimension: 'systems',
    prompt:
      'Recruiters, admins, or operators are not regularly duplicating updates across multiple tools.'
  },
  {
    id: 'handoff-control',
    dimension: 'handoffs',
    prompt:
      'Onboarding, delivery, compliance, and client update handoffs are documented enough that delays are visible early.'
  },
  {
    id: 'scaling-control',
    dimension: 'scale',
    prompt:
      'The current operating structure could handle materially more accounts, starts, clients, or team members without adding chaos.'
  }
];

export function scoreAssessment(answers = {}) {
  return calculateAssessmentResults(answers);
}

export function calculateAssessmentResults(answers = {}) {
  const normalizedAnswers = normalizeAssessmentAnswers(answers);
  const answered = assessmentQuestions.filter((question) =>
    Number.isFinite(normalizedAnswers[question.id])
  );
  const total = answered.reduce((sum, question) => sum + normalizedAnswers[question.id], 0);
  const score = Math.round((total / (assessmentQuestions.length * 5)) * 100);
  const dimensionScores = Object.entries(assessmentDimensions).map(([id, dimension]) => {
    const dimensionQuestions = assessmentQuestions.filter(
      (question) => question.dimension === id
    );
    const dimensionTotal = dimensionQuestions.reduce(
      (sum, question) => sum + (normalizedAnswers[question.id] || 0),
      0
    );
    const percent = Math.round((dimensionTotal / (dimensionQuestions.length * 5)) * 100);

    return {
      id,
      label: dimension.label,
      recommendation: dimension.recommendation,
      score: percent
    };
  });

  const weakAreas = [...dimensionScores].sort((a, b) => a.score - b.score).slice(0, 2);
  const grade = getGrade(score);
  const priority = getPriorityFromGrade(grade.grade);

  return {
    score,
    grade: grade.grade,
    band: grade.label,
    label: grade.label,
    tone: grade.tone,
    prompt: grade.prompt,
    priority,
    signalCount: answered.length,
    answeredCount: answered.length,
    questionCount: assessmentQuestions.length,
    dimensionScores,
    weakAreas,
    recommendedNextAction: getRecommendedNextAction({ score, grade, weakAreas })
  };
}

export function normalizeAssessmentAnswers(answers = {}) {
  if (!answers || typeof answers !== 'object') {
    return {};
  }

  return Object.fromEntries(
    assessmentQuestions
      .map((question) => [question.id, toAssessmentOptionValue(answers[question.id])])
      .filter(([, value]) => Number.isFinite(value))
  );
}

export function parseAnswerSummary(answerSummary = '') {
  if (typeof answerSummary !== 'string' || answerSummary.trim().length === 0) {
    return {};
  }

  return Object.fromEntries(
    answerSummary
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [id, rawValue] = entry.split(':').map((part) => part.trim());
        return [id, toAssessmentOptionValue(rawValue)];
      })
      .filter(([id, value]) => id && Number.isFinite(value))
  );
}

export function getGrade(score) {
  if (score >= 86) {
    return {
      grade: 'A',
      label: 'Operationally healthy',
      tone: 'Strong',
      prompt:
        'Your current structure appears comparatively mature. The priority is preserving reporting reliability and ownership discipline as volume increases.'
    };
  }

  if (score >= 72) {
    return {
      grade: 'B',
      label: 'Controlled with constraint risk',
      tone: 'Watch',
      prompt:
        'Core practices exist, but some areas may still depend on manual interpretation, individual memory, or uneven reporting discipline.'
    };
  }

  if (score >= 58) {
    return {
      grade: 'C',
      label: 'Operational drag is likely present',
      tone: 'Review',
      prompt:
        'Your answers suggest bottlenecks are likely costing time, slowing handoffs, or weakening leadership confidence in operating data.'
    };
  }

  return {
    grade: 'D',
    label: 'Scaling risk',
    tone: 'Urgent',
    prompt:
      'Your operating structure is likely relying too heavily on manual reconciliation, informal ownership, and reactive escalation.'
  };
}

function toAssessmentOptionValue(value) {
  const number = Number(value);

  if (Number.isFinite(number)) {
    return Math.max(1, Math.min(5, number));
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const cleaned = value.trim().toLowerCase();
  const matchedOption = assessmentOptions.find((option) =>
    option.label.toLowerCase() === cleaned
  );

  return matchedOption?.value;
}

function getPriorityFromGrade(grade) {
  if (grade === 'D') {
    return 'high';
  }

  if (grade === 'C') {
    return 'medium';
  }

  return 'low';
}

function getRecommendedNextAction({ score, grade, weakAreas }) {
  const weakAreaSummary = weakAreas.map((area) => area.label).join(', ');

  if (grade.grade === 'D') {
    return `Prioritize diagnostic follow-up. The assessment scored ${score}/100 (${grade.label}), with priority gaps in ${weakAreaSummary}.`;
  }

  if (grade.grade === 'C') {
    return `Review for fit and send a focused follow-up. The assessment scored ${score}/100 (${grade.label}), with likely drag in ${weakAreaSummary}.`;
  }

  return `Add to light-touch follow-up or nurture. The assessment scored ${score}/100 (${grade.label}), with weakest areas in ${weakAreaSummary}.`;
}
