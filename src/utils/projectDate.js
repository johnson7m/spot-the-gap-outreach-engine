export const PROJECT_TIME_ZONE = 'America/Indiana/Indianapolis';
const DEFAULT_BUSINESS_CUTOFF_HOUR = 17;

export function toProjectDateOnly(value = new Date(), timeZone = PROJECT_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function normalizeDateOnly(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function addDaysToDateOnly(value, days) {
  const dateOnly = normalizeDateOnly(value);

  if (!dateOnly) {
    return null;
  }

  const [year, month, day] = dateOnly.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isDateOnlyBefore(dateOnly, compareDateOnly) {
  const left = normalizeDateOnly(dateOnly);
  const right = normalizeDateOnly(compareDateOnly);

  return Boolean(left && right && left < right);
}

export function nextBusinessDateOnOrAfter(value) {
  let dateOnly = normalizeDateOnly(value);

  if (!dateOnly) {
    return null;
  }

  while (isWeekendDateOnly(dateOnly)) {
    dateOnly = addDaysToDateOnly(dateOnly, 1);
  }

  return dateOnly;
}

export function getCurrentOrNextBusinessDate(now = new Date(), timeZone = PROJECT_TIME_ZONE) {
  const projectToday = toProjectDateOnly(now, timeZone);

  if (!projectToday) {
    return null;
  }

  if (!isWeekendDateOnly(projectToday) && getProjectHour(now, timeZone) < DEFAULT_BUSINESS_CUTOFF_HOUR) {
    return projectToday;
  }

  return nextBusinessDateOnOrAfter(addDaysToDateOnly(projectToday, 1));
}

export function resolveSafeMissingNextTaskDueDate({
  recommendedDueDate,
  now = new Date(),
  allowPastDue = false,
  timeZone = PROJECT_TIME_ZONE
} = {}) {
  const originalRecommendedDueDate = normalizeDateOnly(recommendedDueDate);
  const projectToday = toProjectDateOnly(now, timeZone);
  const safeDueDate = getCurrentOrNextBusinessDate(now, timeZone);

  if (!originalRecommendedDueDate) {
    return {
      recommendedDueDate: safeDueDate,
      originalRecommendedDueDate: null,
      dueDateAdjusted: true,
      dueDateAdjustmentReason: 'missing_due_date'
    };
  }

  const todayNoLongerActionable = originalRecommendedDueDate === projectToday && safeDueDate !== projectToday;

  if (!allowPastDue && (isDateOnlyBefore(originalRecommendedDueDate, projectToday) || todayNoLongerActionable)) {
    return {
      recommendedDueDate: safeDueDate,
      originalRecommendedDueDate,
      dueDateAdjusted: true,
      dueDateAdjustmentReason: todayNoLongerActionable
        ? `same_day_after_business_cutoff:${originalRecommendedDueDate}`
        : `past_due_date:${originalRecommendedDueDate}<${projectToday}`
    };
  }

  return {
    recommendedDueDate: originalRecommendedDueDate,
    originalRecommendedDueDate,
    dueDateAdjusted: false,
    dueDateAdjustmentReason: null
  };
}

function getProjectHour(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 0;
  }

  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23'
  })
    .formatToParts(date)
    .find((part) => part.type === 'hour');

  return Number(hourPart?.value ?? 0);
}

function isWeekendDateOnly(value) {
  const dateOnly = normalizeDateOnly(value);

  if (!dateOnly) {
    return false;
  }

  const [year, month, day] = dateOnly.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}
