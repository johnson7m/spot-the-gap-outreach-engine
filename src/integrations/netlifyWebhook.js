import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  assessmentQuestions,
  normalizeAssessmentAnswers,
  parseAnswerSummary
} from '../utils/leadScoring.js';
import { sha256, stableStringify } from '../utils/idempotency.js';

const knownFormFields = new Set([
  'name',
  'fullName',
  'full_name',
  'firstName',
  'first_name',
  'lastName',
  'last_name',
  'email',
  'workEmail',
  'work_email',
  'phone',
  'company',
  'companyName',
  'company_name',
  'website',
  'companyWebsite',
  'company_website',
  'role',
  'title',
  'jobTitle',
  'job_title',
  'industry',
  'companySize',
  'company_size',
  'businessType',
  'teamSize',
  'currentTools',
  'score',
  'grade',
  'gradeLabel',
  'topWeaknesses',
  'answerSummary',
  'form-name',
  'bot-field'
]);

const normalizedSubmissionSchema = z.object({
  submissionId: z.string().min(1),
  formName: z.string().min(1),
  submittedAt: z.string().min(1),
  person: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    role: z.string().optional(),
    linkedinUrl: z.string().optional()
  }),
  company: z.object({
    name: z.string().optional(),
    website: z.string().optional(),
    domain: z.string().optional(),
    industry: z.string().optional(),
    size: z.string().optional()
  }),
  assessment: z.object({
    source: z.literal('spot-the-gap-assessment'),
    formScore: z.number().optional(),
    formGrade: z.string().optional(),
    formGradeLabel: z.string().optional(),
    topWeaknesses: z.array(z.string()),
    rawAnswerSummary: z.string().optional(),
    answers: z.record(z.string(), z.number()),
    profile: z.object({
      businessType: z.string().optional(),
      teamSize: z.string().optional(),
      currentTools: z.string().optional()
    })
  }),
  metadata: z.object({
    raw: z.unknown(),
    sourceForm: z.literal('netlify'),
    receivedPayloadShape: z.string(),
    hasExternalSubmissionId: z.boolean()
  })
});

export function assertWebhookSecret(
  headers,
  expectedSecret,
  { environment = 'development', log, correlationId } = {}
) {
  if (!expectedSecret && environment === 'development') {
    log?.warn?.(
      { correlationId },
      'Webhook secret validation bypassed because NODE_ENV=development and no secret is configured'
    );
    return;
  }

  if (!expectedSecret) {
    log?.error?.(
      { correlationId, environment },
      'Webhook rejected because no webhook secret is configured'
    );
    throwHttpError(503, 'Webhook secret is not configured');
  }

  const receivedSecret = getReceivedWebhookSecret(headers);

  if (!receivedSecret) {
    log?.warn?.(
      { correlationId, environment, headerPresent: false },
      'Webhook rejected because secret header is missing'
    );
    throwHttpError(401, 'Missing webhook secret');
  }

  if (!secretsMatch(receivedSecret, expectedSecret)) {
    log?.warn?.(
      { correlationId, environment, headerPresent: true },
      'Webhook rejected because secret header is invalid'
    );
    throwHttpError(401, 'Invalid webhook secret');
  }
}

export function normalizeNetlifySubmission(body) {
  const payload = parsePayload(body);
  const data = payload.data ?? payload;
  const externalSubmissionId =
    payload.id ??
    payload.submissionId ??
    payload.submission_id ??
    data.submissionId ??
    data.submission_id;
  const fullName = pick(data, ['fullName', 'full_name', 'name']);
  const nameParts = splitName(fullName);
  const website = cleanString(
    pick(data, ['companyWebsite', 'company_website', 'website'])
  );
  const rawAnswerSummary = cleanString(data.answerSummary);
  const answers = normalizeAssessmentAnswers({
    ...extractAnswerFields(data),
    ...parseAnswerSummary(rawAnswerSummary)
  });

  const normalized = {
    submissionId: String(externalSubmissionId ?? `payload:${sha256(stableStringify(payload))}`),
    formName: String(
      payload.form_name ??
        payload.formName ??
        data['form-name'] ??
        data.formName ??
        'assessment'
    ),
    submittedAt: String(
      payload.created_at ??
        payload.createdAt ??
        data.submittedAt ??
        new Date().toISOString()
    ),
    person: {
      firstName: cleanString(pick(data, ['firstName', 'first_name'])) ?? nameParts.firstName,
      lastName: cleanString(pick(data, ['lastName', 'last_name'])) ?? nameParts.lastName,
      email: cleanString(pick(data, ['email', 'workEmail', 'work_email']))?.toLowerCase(),
      phone: cleanString(pick(data, ['phone'])),
      role: cleanString(pick(data, ['role', 'title', 'jobTitle', 'job_title'])),
      linkedinUrl: cleanString(pick(data, ['linkedinUrl', 'linkedin_url', 'linkedin']))
    },
    company: {
      name: cleanString(pick(data, ['company', 'companyName', 'company_name'])),
      website,
      domain: normalizeDomain(website),
      industry: cleanString(pick(data, ['industry'])),
      size: cleanString(pick(data, ['companySize', 'company_size', 'teamSize']))
    },
    assessment: {
      source: 'spot-the-gap-assessment',
      formScore: parseOptionalNumber(data.score),
      formGrade: cleanString(data.grade),
      formGradeLabel: cleanString(data.gradeLabel),
      topWeaknesses: splitList(data.topWeaknesses),
      rawAnswerSummary,
      answers,
      profile: {
        businessType: cleanString(data.businessType),
        teamSize: cleanString(data.teamSize),
        currentTools: cleanString(data.currentTools)
      }
    },
    metadata: {
      raw: payload,
      sourceForm: 'netlify',
      receivedPayloadShape: describePayloadShape(body),
      hasExternalSubmissionId: Boolean(externalSubmissionId)
    }
  };

  const parsed = normalizedSubmissionSchema.safeParse(normalized);

  if (!parsed.success) {
    throwHttpError(400, 'Invalid Netlify assessment payload', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
  }

  return parsed.data;
}

export function validateNetlifyAssessmentSubmission(submission, score) {
  const errors = [];
  const validQuestionIds = new Set(assessmentQuestions.map((question) => question.id));

  if (submission.formName !== 'assessment') {
    errors.push(`Expected formName "assessment", received "${submission.formName}".`);
  }

  if (!submission.person.email) {
    errors.push('Missing required contact field: email.');
  }

  if (!submission.person.firstName) {
    errors.push('Missing required contact field: name.');
  }

  if (submission.assessment.formScore === undefined) {
    errors.push('Missing required assessment field: score.');
  }

  if (!submission.assessment.formGrade) {
    errors.push('Missing required assessment field: grade.');
  }

  if (!submission.assessment.formGradeLabel) {
    errors.push('Missing required assessment field: gradeLabel.');
  }

  if (!submission.assessment.rawAnswerSummary) {
    errors.push('Missing required assessment field: answerSummary.');
  }

  for (const question of assessmentQuestions) {
    const answer = submission.assessment.answers[question.id];

    if (!Number.isInteger(answer) || answer < 1 || answer > 5) {
      errors.push(`Missing or invalid answer for question "${question.id}".`);
    }
  }

  for (const answerId of Object.keys(submission.assessment.answers)) {
    if (!validQuestionIds.has(answerId)) {
      errors.push(`Unexpected assessment answer id "${answerId}".`);
    }
  }

  if (score && submission.assessment.formScore !== undefined && submission.assessment.formScore !== score.score) {
    errors.push(
      `Submitted score ${submission.assessment.formScore} does not match calculated score ${score.score}.`
    );
  }

  if (score && submission.assessment.formGrade && submission.assessment.formGrade !== score.grade) {
    errors.push(
      `Submitted grade ${submission.assessment.formGrade} does not match calculated grade ${score.grade}.`
    );
  }

  if (errors.length > 0) {
    throwHttpError(400, 'Invalid assessment submission', { errors });
  }

  return {
    ok: true
  };
}

function parsePayload(body) {
  try {
    if (typeof body?.payload === 'string') {
      return JSON.parse(body.payload);
    }

    if (body?.payload && typeof body.payload === 'object') {
      return body.payload;
    }

    return body ?? {};
  } catch {
    throwHttpError(400, 'Malformed Netlify payload');
  }
}

function extractAnswerFields(data) {
  const explicitAnswers =
    data.answers ?? data.assessmentAnswers ?? data.assessment_answers ?? data.responses;

  if (explicitAnswers && typeof explicitAnswers === 'object' && !Array.isArray(explicitAnswers)) {
    return explicitAnswers;
  }

  const validQuestionIds = new Set(assessmentQuestions.map((question) => question.id));

  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => validQuestionIds.has(key) || !knownFormFields.has(key))
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

function pick(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source[key] !== null && source[key] !== '') {
      return source[key];
    }
  }

  return undefined;
}

function cleanString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const cleaned = String(value).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function splitName(fullName) {
  const cleaned = cleanString(fullName);

  if (!cleaned) {
    return {};
  }

  const parts = cleaned.split(/\s+/);

  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : undefined
  };
}

function normalizeDomain(website) {
  if (!website) {
    return undefined;
  }

  try {
    const withProtocol = website.startsWith('http') ? website : `https://${website}`;
    return new URL(withProtocol).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function splitList(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map(cleanString).filter(Boolean);
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function describePayloadShape(body) {
  if (typeof body?.payload === 'string') {
    return 'netlify-urlencoded-payload-json';
  }

  if (body?.payload && typeof body.payload === 'object') {
    return 'netlify-payload-object';
  }

  if (body?.data && typeof body.data === 'object') {
    return 'netlify-data-object';
  }

  return 'form-body';
}

function getReceivedWebhookSecret(headers) {
  return (
    headers['x-visible-gap-secret'] ??
    headers['x-webhook-secret'] ??
    headers['x-netlify-secret']
  );
}

function secretsMatch(receivedSecret, expectedSecret) {
  const received = Buffer.from(String(receivedSecret));
  const expected = Buffer.from(String(expectedSecret));

  if (received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(received, expected);
}

function throwHttpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  throw error;
}
