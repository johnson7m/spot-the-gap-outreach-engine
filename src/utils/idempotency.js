import { createHash, randomUUID } from 'node:crypto';

export function createCorrelationId(headers = {}) {
  return String(
    headers['x-correlation-id'] ??
      headers['x-request-id'] ??
      headers['x-nf-request-id'] ??
      randomUUID()
  );
}

export function createAssessmentIdempotency({ submission, score }) {
  const hashInput = {
    source: submission.assessment.source,
    externalSubmissionId: submission.submissionId,
    formName: submission.formName,
    submittedAt: submission.submittedAt,
    email: submission.person.email,
    company: submission.company.name,
    score: score.score,
    grade: score.grade,
    answers: submission.assessment.answers
  };
  const payloadHash = sha256(stableStringify(hashInput));
  const idempotencyKey = submission.metadata?.hasExternalSubmissionId
    ? `netlify:${submission.submissionId}`
    : `assessment:${payloadHash}`;

  return {
    idempotencyKey,
    payloadHash
  };
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)])
    );
  }

  return value;
}
