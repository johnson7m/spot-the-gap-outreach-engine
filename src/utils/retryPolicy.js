export const RETRYABLE_HTTP_STATUS_CODES = new Set([429, 502, 503, 504]);

export function isRetryableTwentyError(error) {
  const status = extractHttpStatus(error);

  return hasExplicitRetryableFlag(error) || RETRYABLE_HTTP_STATUS_CODES.has(status);
}

export function extractHttpStatus(error) {
  const candidates = collectErrorCandidates(error);

  for (const candidate of candidates) {
    const status =
      candidate.status ??
      candidate.statusCode ??
      candidate.status_code ??
      candidate.httpStatus ??
      candidate.response?.status;
    const parsed = Number(status);

    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

export function extractRetryAfterMs(error) {
  const headerValue =
    error?.response?.headers?.['retry-after'] ??
    error?.response?.headers?.['Retry-After'];
  const headerMs = parseRetryAfterValue(headerValue);

  if (headerMs !== undefined) {
    return headerMs;
  }

  const candidates = collectErrorCandidates(error);

  for (const candidate of candidates) {
    const retryAfterMs = parseNumber(candidate.retryAfterMs ?? candidate.retry_after_ms);

    if (retryAfterMs !== undefined) {
      return retryAfterMs;
    }

    const retryAfterSeconds = parseRetryAfterValue(
      candidate.retryAfter ??
        candidate.retry_after ??
        candidate.retryAfterSeconds ??
        candidate.retry_after_seconds
    );

    if (retryAfterSeconds !== undefined) {
      return retryAfterSeconds;
    }
  }

  return undefined;
}

export function calculateRetryDelayMs({
  error,
  attempt,
  baseMs = 1000,
  maxMs = 30000
}) {
  const retryAfterMs = extractRetryAfterMs(error);

  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  const normalizedBase = Math.max(0, Number(baseMs) || 0);
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);

  return Math.min(normalizedBase * 2 ** (normalizedAttempt - 1), maxMs);
}

export function getRetryErrorDetails(error) {
  const retryAfterMs = extractRetryAfterMs(error);

  return {
    status: extractHttpStatus(error),
    retryable: isRetryableTwentyError(error),
    retryAfterMs,
    retry_after:
      retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000)
  };
}

function hasExplicitRetryableFlag(error) {
  return collectErrorCandidates(error).some((candidate) => candidate.retryable === true);
}

function collectErrorCandidates(error) {
  return [
    error,
    error?.error,
    error?.details,
    error?.error?.details,
    error?.response,
    error?.response?.data,
    error?.response?.data?.error,
    error?.response?.data?.details,
    error?.errorPayload,
    error?.error_payload,
    error?.errorPayload?.details,
    error?.error_payload?.details
  ].filter((candidate) => candidate && typeof candidate === 'object');
}

function parseRetryAfterValue(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const numericValue = parseNumber(value);

  if (numericValue !== undefined) {
    return Math.max(0, numericValue * 1000);
  }

  const parsedDate = Date.parse(value);

  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  return undefined;
}

function parseNumber(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}
