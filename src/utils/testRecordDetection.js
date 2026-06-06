const TEST_EMAIL_PATTERNS = [
  'example.com',
  'webhooktest.com',
  'sync-test',
  'cadence-test',
  'quick-capture-test'
];

const TEST_NAME_PATTERNS = [
  /\btest\b/i,
  /webhook\s*test/i,
  /cadencetest/i,
  /write\s*test/i,
  /writetest/i,
  /scooby\s+doo/i
];

const TEST_COMPANY_PATTERNS = [
  /\btest\b/i,
  /webhook\s*test/i,
  /sync\s*test/i,
  /sync-test/i,
  /quick\s*capture\s*test/i,
  /quick-capture-test/i,
  /cadence\s*test/i,
  /cadencetest/i
];

export function detectTestRecord(record = {}) {
  const email = getEmail(record);
  const name = getPersonName(record);
  const companyName = getCompanyName(record);
  const reasons = [];

  if (email && TEST_EMAIL_PATTERNS.some((pattern) => email.toLowerCase().includes(pattern))) {
    reasons.push(`Email looks synthetic: ${email}`);
  }

  if (name && TEST_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    reasons.push(`Name looks synthetic: ${name}`);
  }

  if (companyName && TEST_COMPANY_PATTERNS.some((pattern) => pattern.test(companyName))) {
    reasons.push(`Company looks synthetic: ${companyName}`);
  }

  return {
    isTestRecord: reasons.length > 0,
    reasons
  };
}

function getEmail(record = {}) {
  return firstString(
    record.email,
    record.primaryEmail,
    record.emails?.primaryEmail,
    record.emailsPrimaryEmail,
    record.normalizedLead?.email
  );
}

function getPersonName(record = {}) {
  return firstString(
    record.fullName,
    record.displayName,
    record.name?.fullName,
    [record.name?.firstName ?? record.nameFirstName, record.name?.lastName ?? record.nameLastName]
      .filter(Boolean)
      .join(' '),
    [record.firstName, record.lastName].filter(Boolean).join(' ')
  );
}

function getCompanyName(record = {}) {
  return firstString(
    record.companyName,
    record.companyNameName,
    record.company?.name,
    record.company?.displayName,
    record.company?.nameName
  );
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}
