const CADENCE_TRANSITIONS = {
  ASSESSMENT_CAMPAIGN_V1: {
    NOT_STARTED: {
      nextStage: 'ASSESSMENT_POSITIONING',
      nextTask: {
        taskType: 'ASSESSMENT_POSITIONING_MESSAGE',
        title: 'Send assessment positioning follow-up',
        dueInDays: 2
      }
    },
    CONNECTION_REQUEST: {
      nextStage: 'INTRO_MESSAGE',
      nextTask: {
        taskType: 'ASSESSMENT_POSITIONING_MESSAGE',
        title: 'Send assessment positioning message',
        dueInDays: 2
      }
    },
    INTRO_MESSAGE: {
      nextStage: 'ASSESSMENT_POSITIONING',
      nextTask: {
        taskType: 'ASSESSMENT_POSITIONING_MESSAGE',
        title: 'Send assessment positioning message',
        dueInDays: 1
      }
    },
    ASSESSMENT_POSITIONING: {
      nextStage: 'ASSESSMENT_SENT',
      nextTask: {
        taskType: 'ASSESSMENT_LINK_SEND',
        title: 'Send Spot the Gap assessment link',
        dueInDays: 1
      }
    },
    ASSESSMENT_SENT: {
      nextStage: 'ASSESSMENT_CHECK_IN',
      nextTask: {
        taskType: 'ASSESSMENT_CHECK_IN',
        title: 'Check in on Spot the Gap assessment',
        dueInDays: 3
      }
    },
    ASSESSMENT_CHECK_IN: {
      terminal: true
    }
  },
  RELATIONSHIP_BUILDING_V1: {
    NOT_STARTED: {
      nextStage: 'INTRO_MESSAGE',
      nextTask: {
        taskType: 'CONTEXTUAL_INTRODUCTION',
        title: 'Send contextual introduction',
        dueInDays: 2
      }
    },
    CONNECTION_REQUEST: {
      nextStage: 'INTRO_MESSAGE',
      nextTask: {
        taskType: 'CONTEXTUAL_INTRODUCTION',
        title: 'Send contextual introduction',
        dueInDays: 2
      }
    },
    INTRO_MESSAGE: {
      nextStage: 'VALUE_TOUCH',
      nextTask: {
        taskType: 'VALUE_TOUCH',
        title: 'Send value touch',
        dueInDays: 14
      }
    },
    VALUE_TOUCH: {
      nextStage: 'STRATEGIC_CHECK_IN',
      nextTask: {
        taskType: 'STRATEGIC_CHECK_IN',
        title: 'Send strategic check-in',
        dueInDays: 30
      }
    },
    STRATEGIC_CHECK_IN: {
      nextStage: 'DISCOVERY_ASK',
      nextTask: {
        taskType: 'DISCOVERY_ASK',
        title: 'Evaluate discovery ask',
        dueInDays: 60
      }
    },
    DISCOVERY_ASK: {
      terminal: true
    }
  }
};

const COMPLETION_TERMINAL_TOUCH_STATUSES = new Set(['RESPONDED', 'COMPLETED']);

export function planCadenceTransition({
  cadenceName,
  currentCadenceStage,
  completion = {},
  now = new Date()
} = {}) {
  const normalizedCadenceName = normalizeSelect(cadenceName);
  const oldCadenceStage = normalizeSelect(currentCadenceStage);
  const touchStatus = normalizeSelect(completion.touchStatus || 'SENT');
  const channel = normalizeSelect(completion.channel || 'LINKEDIN');
  const completedAt = normalizeDate(completion.completedAt, now);
  const rule = CADENCE_TRANSITIONS[normalizedCadenceName]?.[oldCadenceStage];

  if (!rule) {
    const error = new Error(
      `No cadence transition is configured for ${normalizedCadenceName || 'UNKNOWN'}:${oldCadenceStage || 'UNKNOWN'}.`
    );
    error.code = 'CADENCE_TRANSITION_NOT_FOUND';
    error.statusCode = 422;
    error.details = {
      cadenceName: normalizedCadenceName || null,
      currentCadenceStage: oldCadenceStage || null,
      supportedStages: Object.keys(CADENCE_TRANSITIONS[normalizedCadenceName] ?? {})
    };
    throw error;
  }

  const newCadenceStage = rule.terminal
    ? getTerminalCadenceStage(touchStatus)
    : rule.nextStage;
  const nextTask = rule.nextTask
    ? buildNextTaskPlan({
        rule,
        cadenceName: normalizedCadenceName,
        oldCadenceStage,
        newCadenceStage,
        completedAt
      })
    : null;

  return {
    cadenceName: normalizedCadenceName,
    oldCadenceStage,
    newCadenceStage,
    channel,
    touchStatus,
    completedAt: completedAt.toISOString(),
    lastOutboundTouchDate: toDateOnly(completedAt),
    nextOutboundTouchDate: nextTask ? toDateOnly(new Date(nextTask.dueAt)) : null,
    terminal: Boolean(rule.terminal),
    nextTask
  };
}

export function getSupportedCadenceTransitions() {
  return structuredClone(CADENCE_TRANSITIONS);
}

function buildNextTaskPlan({
  rule,
  cadenceName,
  oldCadenceStage,
  newCadenceStage,
  completedAt
}) {
  const dueAt = addDays(completedAt, rule.nextTask.dueInDays);

  return {
    taskType: rule.nextTask.taskType,
    title: rule.nextTask.title,
    dueInDays: rule.nextTask.dueInDays,
    dueAt: dueAt.toISOString(),
    cadenceName,
    oldCadenceStage,
    nextCadenceStage: newCadenceStage
  };
}

function getTerminalCadenceStage(touchStatus) {
  return COMPLETION_TERMINAL_TOUCH_STATUSES.has(touchStatus) ? 'COMPLETED' : 'PAUSED';
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function normalizeDate(value, fallback) {
  const date = value ? new Date(value) : new Date(fallback);

  if (Number.isNaN(date.getTime())) {
    const error = new Error('completion.completedAt must be a valid ISO date when provided.');
    error.code = 'TASK_COMPLETION_INVALID_DATE';
    error.statusCode = 400;
    throw error;
  }

  return date;
}

function normalizeSelect(value) {
  return String(value ?? '').trim().toUpperCase();
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}
