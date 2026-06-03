import { findObject } from './metadataClient.js';
import { sanitizePayloadForDiagnostics } from './errorDiagnostics.js';

export const QUICK_CAPTURE_PERSON_FIELDS = Object.freeze([
  'name',
  'emails',
  'phones',
  'linkedinLink',
  'jobTitle',
  'company',
  'owner',
  'leadSource',
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
]);

const FIELD_EXPECTATIONS = {
  name: { type: 'FULL_NAME' },
  emails: { type: 'EMAILS' },
  phones: { type: 'PHONES' },
  linkedinLink: { type: 'LINKS' },
  jobTitle: { type: 'TEXT' },
  company: { type: 'RELATION' },
  owner: { type: 'RELATION' },
  leadSource: { type: 'TEXT' },
  outboundPipelineType: {
    type: 'SELECT',
    options: ['ASSESSMENT_CAMPAIGN', 'RELATIONSHIP_BUILDING', 'GENERAL_PROSPECT']
  },
  cadenceName: {
    type: 'SELECT',
    options: ['ASSESSMENT_CAMPAIGN_V1', 'RELATIONSHIP_BUILDING_V1', 'NONE']
  },
  cadenceStage: {
    type: 'SELECT',
    options: [
      'NOT_STARTED',
      'CONNECTION_REQUEST',
      'INTRO_MESSAGE',
      'ASSESSMENT_POSITIONING',
      'ASSESSMENT_SENT',
      'ASSESSMENT_CHECK_IN',
      'VALUE_TOUCH',
      'STRATEGIC_CHECK_IN',
      'DISCOVERY_ASK',
      'PAUSED',
      'COMPLETED'
    ]
  },
  enrichmentStatus: {
    type: 'SELECT',
    options: ['NOT_STARTED', 'PARTIAL', 'ENRICHED', 'NEEDS_REVIEW', 'FAILED']
  },
  icpFitScore: { type: 'NUMBER' },
  leadHealthScore: { type: 'NUMBER' },
  lastOutboundTouchDate: { type: 'DATE' },
  nextOutboundTouchDate: { type: 'DATE' },
  outreachAngle: { type: 'TEXT' },
  latestTouchChannel: {
    type: 'SELECT',
    options: ['LINKEDIN', 'EMAIL', 'PHONE', 'TEXT', 'IN_PERSON', 'OTHER']
  },
  latestTouchStatus: {
    type: 'SELECT',
    options: ['DRAFTED', 'SENT', 'RESPONDED', 'NO_RESPONSE', 'BOUNCED', 'DECLINED', 'COMPLETED']
  },
  quickCaptureUrl: { type: 'LINKS' },
  staleRisk: { type: 'SELECT', options: ['LOW', 'MEDIUM', 'HIGH', 'STALE'] },
  discoveryReadiness: {
    type: 'SELECT',
    options: ['NOT_READY', 'MONITOR', 'READY', 'REQUESTED', 'BOOKED']
  }
};

const REST_RELATION_ID_FIELDS = {
  ownerId: {
    metadataField: 'owner'
  }
};

export function validateQuickCapturePersonPayload({ payload = {}, lead = {}, schema } = {}) {
  const person = schema ? findObject(schema, 'person') : null;
  const errors = [];
  const warnings = [];
  const fieldReport = [];
  const includedFieldNames = Object.keys(payload ?? {});

  if (!person) {
    return {
      ok: false,
      errors: [
        {
          code: 'PERSON_METADATA_MISSING',
          message: 'Twenty Person metadata is required before live Quick Capture Person writes.'
        }
      ],
      warnings,
      fieldReport,
      includedFieldNames,
      dedupeStrategy: lead.dedupe?.strategy ?? null,
      sanitizedRequestPayload: sanitizePayloadForDiagnostics(payload)
    };
  }

  for (const fieldName of QUICK_CAPTURE_PERSON_FIELDS) {
    const field = person.fieldsByName?.[fieldName];
    const expectation = FIELD_EXPECTATIONS[fieldName];
    const value = payload?.[fieldName];
    const included = Object.hasOwn(payload ?? {}, fieldName);
    const fieldErrors = [];
    const fieldWarnings = [];
    const expectedOptions = expectation?.options ?? [];
    const actualOptions = optionValues(field);

    if (!field) {
      if (included) {
        fieldErrors.push(`Field "${fieldName}" is included in the payload but does not exist on Twenty Person.`);
      }

      fieldReport.push({
        fieldName,
        included,
        exists: false,
        expectedType: expectation?.type ?? null,
        actualType: null,
        status: included ? 'field_missing' : 'omitted',
        messages: [...fieldErrors]
      });
      pushFieldErrors(errors, fieldName, fieldErrors);
      continue;
    }

    if (expectation?.type && field.type !== expectation.type) {
      fieldErrors.push(
        `Field "${fieldName}" expected Twenty type ${expectation.type}, received ${field.type}.`
      );
    }

    if (included) {
      fieldErrors.push(...validateValueShape({ fieldName, field, value }));
    }

    if (field.type === 'SELECT' && expectedOptions.length > 0) {
      const missingOptions = expectedOptions.filter((option) => !actualOptions.includes(option));

      for (const option of missingOptions) {
        fieldWarnings.push(`Field "${fieldName}" metadata is missing expected option "${option}".`);
      }
    }

    fieldReport.push({
      fieldName,
      included,
      exists: true,
      expectedType: expectation?.type ?? null,
      actualType: field.type,
      expectedOptions,
      actualOptions,
      status: getFieldStatus({ included, fieldErrors, fieldWarnings }),
      messages: [...fieldErrors, ...fieldWarnings]
    });

    pushFieldErrors(errors, fieldName, fieldErrors);
    pushFieldWarnings(warnings, fieldName, fieldWarnings);
  }

  for (const fieldName of includedFieldNames) {
    if (QUICK_CAPTURE_PERSON_FIELDS.includes(fieldName)) {
      continue;
    }

    const relationIdValidation = validateRestRelationIdField({
      fieldName,
      value: payload[fieldName],
      person
    });

    if (relationIdValidation.allowed) {
      fieldReport.push(relationIdValidation.report);
      pushFieldErrors(errors, fieldName, relationIdValidation.errors);
      continue;
    }

    if (!relationIdValidation.known) {
      const message = `Payload includes unapproved Quick Capture Person field "${fieldName}".`;

      errors.push({
        code: 'PERSON_FIELD_UNAPPROVED',
        fieldName,
        message
      });

      continue;
    }

    fieldReport.push(relationIdValidation.report);
    pushFieldErrors(errors, fieldName, relationIdValidation.errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    fieldReport,
    includedFieldNames,
    dedupeStrategy: lead.dedupe?.strategy ?? null,
    sanitizedRequestPayload: sanitizePayloadForDiagnostics(payload)
  };
}

function validateRestRelationIdField({ fieldName, value, person }) {
  const expectation = REST_RELATION_ID_FIELDS[fieldName];

  if (!expectation) {
    return {
      known: false,
      allowed: false,
      errors: []
    };
  }

  const field = person.fieldsByName?.[expectation.metadataField];
  const errors = [];

  if (!field) {
    errors.push(
      `Payload includes REST relation id "${fieldName}", but field "${expectation.metadataField}" does not exist on Twenty Person.`
    );
  } else if (field.type !== 'RELATION') {
    errors.push(
      `Payload includes REST relation id "${fieldName}", but field "${expectation.metadataField}" is type ${field.type}, not RELATION.`
    );
  }

  if (!isUuid(value)) {
    errors.push(`Field "${fieldName}" must be a valid UUID relation id.`);
  }

  return {
    known: true,
    allowed: true,
    errors,
    report: {
      fieldName,
      included: true,
      exists: Boolean(field),
      expectedType: 'RELATION_ID',
      actualType: field?.type ?? null,
      status: errors.length > 0 ? 'shape_mismatch' : 'included_valid',
      messages: errors
    }
  };
}

export function buildPersonMetadataComparison({ schema } = {}) {
  const person = schema ? findObject(schema, 'person') : null;

  return QUICK_CAPTURE_PERSON_FIELDS.map((fieldName) => {
    const field = person?.fieldsByName?.[fieldName];
    const expectation = FIELD_EXPECTATIONS[fieldName];
    const expectedOptions = expectation?.options ?? [];
    const actualOptions = optionValues(field);
    const messages = [];

    if (!field) {
      messages.push(`Field "${fieldName}" is missing from Twenty Person metadata.`);
    } else if (expectation?.type && field.type !== expectation.type) {
      messages.push(
        `Field "${fieldName}" expected type ${expectation.type}, received ${field.type}.`
      );
    }

    if (field?.type === 'SELECT') {
      for (const option of expectedOptions) {
        if (!actualOptions.includes(option)) {
          messages.push(`Field "${fieldName}" is missing select value "${option}".`);
        }
      }
    }

    return {
      fieldName,
      exists: Boolean(field),
      expectedType: expectation?.type ?? null,
      actualType: field?.type ?? null,
      expectedOptions,
      actualOptions,
      status: messages.length === 0 ? 'ok' : 'mismatch',
      messages
    };
  });
}

function validateValueShape({ fieldName, field, value }) {
  if (value === undefined || value === null) {
    return [`Field "${fieldName}" is included with an empty value.`];
  }

  if (field.type === 'FULL_NAME') {
    return validateObjectShape(fieldName, value, ['firstName', 'lastName']);
  }

  if (field.type === 'EMAILS') {
    const errors = validateObjectShape(fieldName, value, ['primaryEmail', 'additionalEmails']);

    if (value.primaryEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value.primaryEmail))) {
      errors.push(`Field "${fieldName}.primaryEmail" is not a valid email address.`);
    }

    if (!Array.isArray(value.additionalEmails)) {
      errors.push(`Field "${fieldName}.additionalEmails" must be an array.`);
    }

    return errors;
  }

  if (field.type === 'PHONES') {
    const errors = validateObjectShape(fieldName, value, [
      'primaryPhoneNumber',
      'primaryPhoneCountryCode',
      'primaryPhoneCallingCode',
      'additionalPhones'
    ]);

    if (!Array.isArray(value.additionalPhones)) {
      errors.push(`Field "${fieldName}.additionalPhones" must be an array.`);
    }

    return errors;
  }

  if (field.type === 'LINKS') {
    const errors = validateObjectShape(fieldName, value, ['primaryLinkUrl', 'primaryLinkLabel']);

    if (value.primaryLinkUrl && !isSafeUrl(value.primaryLinkUrl)) {
      errors.push(`Field "${fieldName}.primaryLinkUrl" must be an http(s) URL.`);
    }

    if (value.secondaryLinks !== undefined && !Array.isArray(value.secondaryLinks)) {
      errors.push(`Field "${fieldName}.secondaryLinks" must be an array when provided.`);
    }

    return errors;
  }

  if (field.type === 'SELECT') {
    const options = optionValues(field);

    return options.includes(value)
      ? []
      : [`Field "${fieldName}" value "${value}" is not in Twenty select options.`];
  }

  if (field.type === 'NUMBER') {
    return Number.isFinite(value) ? [] : [`Field "${fieldName}" must be a finite number.`];
  }

  if (field.type === 'DATE') {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value))
      ? []
      : [`Field "${fieldName}" must be a YYYY-MM-DD date string.`];
  }

  if (field.type === 'TEXT') {
    return typeof value === 'string' ? [] : [`Field "${fieldName}" must be a string.`];
  }

  if (field.type === 'RELATION') {
    return [`Field "${fieldName}" is a relation field; Quick Capture relationship writes are disabled.`];
  }

  return [];
}

function validateObjectShape(fieldName, value, requiredKeys) {
  const errors = [];

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`Field "${fieldName}" must be an object.`];
  }

  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      errors.push(`Field "${fieldName}.${key}" is required for Twenty ${fieldName} shape.`);
    }
  }

  return errors;
}

function getFieldStatus({ included, fieldErrors, fieldWarnings }) {
  if (fieldErrors.length > 0) {
    return 'shape_mismatch';
  }

  if (fieldWarnings.length > 0) {
    return 'metadata_warning';
  }

  return included ? 'included_valid' : 'omitted';
}

function pushFieldErrors(errors, fieldName, messages) {
  for (const message of messages) {
    errors.push({
      code: 'PERSON_PAYLOAD_FIELD_INVALID',
      fieldName,
      message
    });
  }
}

function pushFieldWarnings(warnings, fieldName, messages) {
  for (const message of messages) {
    warnings.push({
      code: 'PERSON_METADATA_WARNING',
      fieldName,
      message
    });
  }
}

function optionValues(field) {
  return (field?.options ?? []).map((option) =>
    typeof option === 'string' ? option : option.value
  );
}

function isSafeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value ?? '')
  );
}
