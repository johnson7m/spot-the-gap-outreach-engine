import { sha256, stableStringify } from '../../utils/idempotency.js';

export function normalizeQuickCaptureLead(input = {}) {
  const fullName = normalizeWhitespace(input.fullName);
  const firstName = normalizeWhitespace(input.firstName);
  const lastName = normalizeWhitespace(input.lastName);
  const parsedName = splitName(fullName);
  const normalized = {
    firstName: firstName || parsedName.firstName,
    lastName: lastName || parsedName.lastName,
    fullName:
      fullName ||
      [firstName || parsedName.firstName, lastName || parsedName.lastName]
        .filter(Boolean)
        .join(' '),
    title: normalizeWhitespace(input.title),
    companyName: normalizeWhitespace(input.companyName),
    companyWebsite: normalizeUrl(input.companyWebsite),
    companyDomain: extractDomain(input.companyWebsite),
    linkedinUrl: normalizeUrl(input.linkedinUrl),
    email: normalizeEmail(input.email),
    phone: normalizeWhitespace(input.phone),
    phoneCountryCode: normalizeSelect(input.phoneCountryCode),
    phoneCallingCode: normalizeCallingCode(input.phoneCallingCode),
    leadSource: normalizeWhitespace(input.leadSource),
    outboundPipelineType: normalizeSelect(input.outboundPipelineType),
    notes: normalizeWhitespace(input.notes),
    assignedRep: normalizeWhitespace(input.assignedRep),
    companySegment: normalizeSelect(input.companySegment ?? input.segment),
    companyIndustry: normalizeSelect(firstValue(input.companyIndustry ?? input.industry))
  };

  validateQuickCaptureLead(normalized);

  return {
    ...normalized,
    dedupe: buildQuickCaptureDedupe(normalized)
  };
}

export function validateQuickCaptureLead(lead) {
  const errors = [];

  if (!lead.fullName) {
    errors.push('fullName or firstName/lastName is required.');
  }

  if (!lead.companyName) {
    errors.push('companyName is required.');
  }

  if (!lead.leadSource) {
    errors.push('leadSource is required.');
  }

  if (!lead.linkedinUrl && !lead.email && !lead.phone && !lead.notes) {
    errors.push('At least one of linkedinUrl, email, phone, or notes is required for capture context.');
  }

  if (errors.length > 0) {
    const error = new Error(`Invalid quick capture lead: ${errors.join(' ')}`);
    error.details = errors;
    throw error;
  }
}

export function assertFakeQuickCaptureLead(lead) {
  const errors = [];
  const email = lead.email ?? '';
  const companyName = lead.companyName ?? '';
  const linkedinUrl = lead.linkedinUrl ?? '';

  if (!email.endsWith('@example.com') && !email.includes('test')) {
    errors.push('Quick Capture live test email must be obviously fake/test.');
  }

  if (!/test/i.test(companyName)) {
    errors.push('Quick Capture live test companyName must include "test".');
  }

  if (linkedinUrl && !/test/i.test(linkedinUrl)) {
    errors.push('Quick Capture live test LinkedIn URL must include "test".');
  }

  if (errors.length > 0) {
    const error = new Error(`Unsafe Quick Capture live test lead: ${errors.join(' ')}`);
    error.details = errors;
    throw error;
  }
}

export function buildQuickCaptureDedupe(lead) {
  if (lead.email) {
    return {
      strategy: 'email',
      key: `person:email:${lead.email}`
    };
  }

  if (lead.linkedinUrl) {
    return {
      strategy: 'linkedin',
      key: `person:linkedin:${lead.linkedinUrl}`
    };
  }

  const fallback = {
    name: lead.fullName,
    company: lead.companyName
  };

  return {
    strategy: 'name_company',
    key: `person:name-company:${sha256(stableStringify(fallback)).slice(0, 24)}`
  };
}

function splitName(value) {
  const parts = normalizeWhitespace(value).split(' ').filter(Boolean);

  if (parts.length === 0) {
    return {
      firstName: '',
      lastName: ''
    };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ')
  };
}

function normalizeWhitespace(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeEmail(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeSelect(value) {
  return normalizeWhitespace(value).toUpperCase();
}

function normalizeCallingCode(value) {
  const normalized = normalizeWhitespace(value);

  if (!normalized) {
    return '';
  }

  return normalized.startsWith('+') ? normalized : `+${normalized}`;
}

function normalizeUrl(value) {
  const normalized = normalizeWhitespace(value);

  if (!normalized) {
    return '';
  }

  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  return `https://${normalized}`;
}

function extractDomain(value) {
  const normalized = normalizeUrl(value);

  if (!normalized) {
    return '';
  }

  try {
    return new URL(normalized).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}
