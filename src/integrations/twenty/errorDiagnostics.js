const SECRET_KEY_PATTERN = /authorization|bearer|token|secret|api[_-]?key|password/i;

export function enrichTwentyRestError(error, context = {}) {
  const httpStatus = error.response?.status;
  const responseBody = sanitizePayloadForDiagnostics(error.response?.data);

  error.twentyDiagnostics = {
    objectPlural: context.objectPlural,
    action: context.action,
    httpStatus,
    responseBody,
    validationMessages: extractTwentyValidationMessages(error.response?.data),
    sanitizedRequestPayload: sanitizePayloadForDiagnostics(context.payload),
    fieldNames: Object.keys(context.payload ?? {})
  };

  return error;
}

export function sanitizePayloadForDiagnostics(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePayloadForDiagnostics(entry));
  }

  if (!value || typeof value !== 'object') {
    return sanitizeScalar(value);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[redacted]' : sanitizePayloadForDiagnostics(entryValue)
    ])
  );
}

export function extractTwentyValidationMessages(body) {
  const messages = new Set();

  collectMessages(body, messages);
  return [...messages];
}

function collectMessages(value, messages) {
  if (!value) {
    return;
  }

  if (typeof value === 'string') {
    messages.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectMessages(entry, messages);
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (/message|error|detail|reason|validation/i.test(key)) {
      collectMessages(entryValue, messages);
      continue;
    }

    if (Array.isArray(entryValue) || typeof entryValue === 'object') {
      collectMessages(entryValue, messages);
    }
  }
}

function sanitizeScalar(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}
