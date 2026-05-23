import { describe, expect, it } from 'vitest';
import sampleSubmission from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import {
  assertWebhookSecret,
  normalizeNetlifySubmission,
  validateNetlifyAssessmentSubmission
} from '../src/integrations/netlifyWebhook.js';
import { createCrmAdapter } from '../src/integrations/crm/crmAdapter.js';
import { createFixedWindowRateLimiter } from '../src/middleware/rateLimit.js';
import { buildSchemaSnapshot } from '../src/integrations/twenty/metadataClient.js';
import {
  buildAssessmentCrmPayloads,
  createOpportunityPayload,
  createPersonPayload,
  shouldCreateOpportunity
} from '../src/integrations/twenty/payloadBuilders.js';
import { createMemoryOperationalStore } from '../src/persistence/memoryOperationalStore.js';
import { validateTwentyRelationships } from '../src/integrations/twenty/relationshipValidator.js';
import { validateTwentySchema } from '../src/integrations/twenty/schemaValidator.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import { calculateAssessmentResults, getGrade, parseAnswerSummary } from '../src/utils/leadScoring.js';
import { evaluateSyncTestMode } from '../src/utils/syncTestGuards.js';

const testConfig = {
  crmProvider: 'twenty',
  webhookSharedSecret: undefined,
  twenty: {
    syncEnabled: false,
    apiBaseUrl: 'https://api.twenty.com',
    apiKey: undefined,
    workspaceId: undefined
  },
  workflowMaxAttempts: 3
};

const liveTestConfig = {
  ...testConfig,
  twenty: {
    syncEnabled: true,
    apiBaseUrl: 'https://api.twenty.com',
    apiKey: 'test-key',
    workspaceId: undefined
  }
};

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

const mockTwentyObjects = [
  {
    nameSingular: 'person',
    namePlural: 'people',
    duplicateCriteria: [['nameFirstName', 'nameLastName'], ['linkedinLinkPrimaryLinkUrl'], ['emailsPrimaryEmail']],
    fields: [
      field('name', 'FULL_NAME'),
      field('emails', 'EMAILS'),
      field('linkedinLink', 'LINKS'),
      field('company', 'RELATION'),
      field('jobTitle', 'TEXT'),
      field('assessmentCompleted', 'BOOLEAN', { isCustom: true }),
      field('assessmentScore', 'NUMBER', { isCustom: true }),
      field('lastTouchDate', 'DATE', { isCustom: true }),
      field('leadstageAuto', 'SELECT', {
        isCustom: true,
        options: [
          'NEW_LEAD',
          'RESEARCHED',
          'CONNECTION_REQUESTED',
          'CONNECTED',
          'MESSAGE_SENT',
          'FOLLOW_UP_NEEDED',
          'ASSESSMENT_SENT',
          'ASSESSMENT_COMPLETED',
          'DISCOVERY_REQUESTED',
          'DISQUALIFIED_NURTURE'
        ]
      }),
      field('messageAngle', 'TEXT', { isCustom: true }),
      field('nextFollowUpDate', 'DATE', { isCustom: true })
    ]
  },
  {
    nameSingular: 'company',
    namePlural: 'companies',
    duplicateCriteria: [['name'], ['domainNamePrimaryLinkUrl']],
    fields: [
      field('name', 'TEXT'),
      field('domainName', 'LINKS'),
      field('people', 'RELATION'),
      field('operationalMaturityScore', 'RATING', {
        isCustom: true,
        options: ['RATING_1', 'RATING_2', 'RATING_3', 'RATING_4', 'RATING_5']
      })
    ]
  },
  {
    nameSingular: 'task',
    namePlural: 'tasks',
    fields: [
      field('title', 'TEXT'),
      field('bodyV2', 'RICH_TEXT'),
      field('dueAt', 'DATE_TIME'),
      field('status', 'SELECT', { options: ['TODO', 'IN_PROGRESS', 'DONE'] }),
      field('taskTargets', 'RELATION')
    ]
  },
  {
    nameSingular: 'opportunity',
    namePlural: 'opportunities',
    fields: [
      field('name', 'TEXT'),
      field('stage', 'SELECT', {
        options: [
          'TARGET_IDENTIFIED',
          'CONNECTION_SENT',
          'CONNECTED',
          'CONVERSATION_STARTED',
          'QUALIFIED',
          'CALL_SCHEDULED',
          'OPPORTUNITY',
          'DISCOVERY_SCHEDULED',
          'DISCOVERY_COMPLETED',
          'SOLUTION_ALIGNMENT',
          'PROPOSAL_SCOPE_DISCUSSION',
          'VERBAL_ALIGNMENT',
          'CLOSED_WON',
          'CLOSED_LOST',
          'DEFERRED_NURTURE'
        ]
      }),
      field('company', 'RELATION'),
      field('pointOfContact', 'RELATION')
    ]
  }
];

const mockSchema = buildSchemaSnapshot(mockTwentyObjects);

describe('assessment normalization', () => {
  it('normalizes the production Netlify assessment payload shape', () => {
    const submission = normalizeNetlifySubmission(sampleSubmission);

    expect(submission).toMatchObject({
      submissionId: 'sample-assessment-2026-05-23-001',
      formName: 'assessment',
      person: {
        firstName: 'Jordan',
        lastName: 'Smith',
        email: 'jordan@example.com'
      },
      company: {
        name: 'Acme Workforce Ops',
        size: '26-75'
      },
      assessment: {
        formScore: 55,
        formGrade: 'D',
        formGradeLabel: 'Scaling risk',
        topWeaknesses: ['Reporting reliability (50)', 'Systems fragmentation (50)'],
        profile: {
          businessType: 'Staffing / recruiting / workforce vendor',
          teamSize: '26-75'
        }
      }
    });
    expect(submission.assessment.answers).toEqual({
      'reporting-trust': 2,
      'metric-ownership': 3,
      'stage-ownership': 3,
      'accountability-rhythm': 3,
      'system-agreement': 2,
      'duplicate-admin': 3,
      'handoff-control': 3,
      'scaling-control': 3
    });
  });

  it('handles malformed Netlify payloads as bad requests', () => {
    expect(() =>
      normalizeNetlifySubmission({
        payload: '{not-valid-json'
      })
    ).toThrow('Malformed Netlify payload');
  });

  it('falls back to a stable payload-based submission id when Netlify id is missing', () => {
    const body = structuredClone(sampleSubmission);
    delete body.payload.id;

    const first = normalizeNetlifySubmission(body);
    const second = normalizeNetlifySubmission(body);

    expect(first.submissionId).toMatch(/^payload:/);
    expect(first.submissionId).toBe(second.submissionId);
    expect(first.metadata.hasExternalSubmissionId).toBe(false);
  });
});

describe('assessment scoring', () => {
  it('parses answerSummary values', () => {
    expect(parseAnswerSummary('reporting-trust: 5; metric-ownership: 4')).toEqual({
      'reporting-trust': 5,
      'metric-ownership': 4
    });
  });

  it('mirrors the production frontend score calculation', () => {
    const submission = normalizeNetlifySubmission(sampleSubmission);
    const result = calculateAssessmentResults(submission.assessment.answers);

    expect(result).toMatchObject({
      score: 55,
      grade: 'D',
      label: 'Scaling risk',
      tone: 'Urgent',
      priority: 'high',
      answeredCount: 8,
      questionCount: 8
    });
    expect(result.dimensionScores.find((item) => item.id === 'reporting').score).toBe(50);
    expect(result.weakAreas.map((area) => area.id)).toEqual(['reporting', 'systems']);
  });

  it('uses the same grade thresholds as the production site', () => {
    expect(getGrade(86).grade).toBe('A');
    expect(getGrade(72).grade).toBe('B');
    expect(getGrade(58).grade).toBe('C');
    expect(getGrade(57).grade).toBe('D');
  });
});

describe('webhook validation', () => {
  it('accepts a valid webhook secret', () => {
    expect(() =>
      assertWebhookSecret(
        { 'x-visible-gap-secret': 'expected-secret' },
        'expected-secret',
        { environment: 'production', log: silentLog, correlationId: 'secret-ok' }
      )
    ).not.toThrow();
  });

  it('rejects an invalid webhook secret without leaking the received value', () => {
    expect(() =>
      assertWebhookSecret(
        { 'x-visible-gap-secret': 'wrong-secret' },
        'expected-secret',
        { environment: 'production', log: silentLog, correlationId: 'secret-bad' }
      )
    ).toThrow('Invalid webhook secret');
  });

  it('rejects missing webhook secret configuration outside development', () => {
    expect(() =>
      assertWebhookSecret({}, undefined, {
        environment: 'production',
        log: silentLog,
        correlationId: 'secret-missing'
      })
    ).toThrow('Webhook secret is not configured');
  });

  it('allows missing webhook secret only in development', () => {
    expect(() =>
      assertWebhookSecret({}, undefined, {
        environment: 'development',
        log: silentLog,
        correlationId: 'dev-bypass'
      })
    ).not.toThrow();
  });

  it('rejects missing required assessment fields', () => {
    const body = structuredClone(sampleSubmission);
    delete body.payload.data.email;
    delete body.payload.data.answerSummary;
    const submission = normalizeNetlifySubmission(body);
    const score = calculateAssessmentResults(submission.assessment.answers);

    expect(() => validateNetlifyAssessmentSubmission(submission, score)).toThrow(
      'Invalid assessment submission'
    );
  });

  it('rejects unexpected form names', () => {
    const body = structuredClone(sampleSubmission);
    body.payload.form_name = 'contact';
    body.payload.data['form-name'] = 'contact';
    const submission = normalizeNetlifySubmission(body);
    const score = calculateAssessmentResults(submission.assessment.answers);

    expect(() => validateNetlifyAssessmentSubmission(submission, score)).toThrow(
      'Invalid assessment submission'
    );
  });
});

describe('webhook rate limiting', () => {
  it('limits requests by generated key', () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 60000,
      max: 2,
      keyGenerator: () => 'test-key'
    });
    const statuses = [];
    const next = () => statuses.push('next');
    const createReq = () => ({
      headers: {},
      log: silentLog,
      correlationId: 'rate-limit-test'
    });
    const createRes = () => ({
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        statuses.push(this.statusCode);
      }
    });

    limiter(createReq(), createRes(), next);
    limiter(createReq(), createRes(), next);
    limiter(createReq(), createRes(), next);

    expect(statuses).toEqual(['next', 'next', 429]);
  });
});

describe('Twenty schema validation', () => {
  it('validates required CRM fields and select values', () => {
    const validation = validateTwentySchema(mockSchema);

    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('surfaces missing select values as human-readable errors', () => {
    const schemaWithMismatch = buildSchemaSnapshot([
      {
        ...mockTwentyObjects[0],
        fields: mockTwentyObjects[0].fields.map((fieldDefinition) =>
          fieldDefinition.name === 'leadstageAuto'
            ? {
                ...fieldDefinition,
                options: fieldDefinition.options.map((option) =>
                  option.value === 'DISQUALIFIED_NURTURE'
                    ? { ...option, value: 'DISQUALIFIED_NUTURE' }
                    : option
                )
              }
            : fieldDefinition
        )
      },
      ...mockTwentyObjects.slice(1)
    ]);
    const validation = validateTwentySchema(schemaWithMismatch);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain(
      'Field "person.leadstageAuto" is missing select option "DISQUALIFIED_NURTURE".'
    );
    expect(validation.warnings).toContain(
      'Field "person.leadstageAuto" has extra select option "DISQUALIFIED_NUTURE".'
    );
  });
});

describe('Twenty relationship validation', () => {
  it('plans expected relationship mappings without enabling relationship writes', () => {
    const validation = validateTwentyRelationships(mockSchema);

    expect(validation.ok).toBe(true);
    expect(validation.mappings.map((mapping) => mapping.key)).toEqual([
      'person.company',
      'task.taskTargets',
      'opportunity.company',
      'opportunity.pointOfContact'
    ]);
    expect(validation.mappings.every((mapping) => mapping.writeEnabled === false)).toBe(true);
    expect(validation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Relationship "person.company" exists')
      ])
    );
  });

  it('surfaces missing relationship fields before live relationship writes are attempted', () => {
    const schemaWithoutTaskTargets = buildSchemaSnapshot(
      mockTwentyObjects.map((object) =>
        object.nameSingular === 'task'
          ? {
              ...object,
              fields: object.fields.filter((fieldDefinition) =>
                fieldDefinition.name !== 'taskTargets'
              )
            }
          : object
      )
    );
    const validation = validateTwentyRelationships(schemaWithoutTaskTargets);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('Missing relationship field "task.taskTargets".');
  });
});

describe('sync test guardrails', () => {
  it('defaults to dry-run even if TWENTY_SYNC_ENABLED is accidentally true', () => {
    const guard = evaluateSyncTestMode({
      liveTest: undefined,
      twentySyncEnabled: true,
      supabaseEnabled: false,
      twentyApiKey: undefined,
      supabaseUrl: undefined,
      supabaseServiceRoleKey: undefined
    });

    expect(guard).toMatchObject({
      ok: true,
      mode: 'dry_run'
    });
    expect(guard.warnings).toContain(
      'TWENTY_SYNC_ENABLED is true, but LIVE_TEST is not true. The script will force dry-run mode.'
    );
  });

  it('blocks live test mode unless live sync and durable idempotency are explicit', () => {
    const guard = evaluateSyncTestMode({
      liveTest: true,
      twentySyncEnabled: false,
      supabaseEnabled: false,
      twentyApiKey: '',
      supabaseUrl: '',
      supabaseServiceRoleKey: ''
    });

    expect(guard.ok).toBe(false);
    expect(guard.errors).toEqual(
      expect.arrayContaining([
        'LIVE_TEST=true requires TWENTY_SYNC_ENABLED=true.',
        'LIVE_TEST=true requires SUPABASE_ENABLED=true for durable idempotency.',
        'LIVE_TEST=true requires TWENTY_API_KEY.'
      ])
    );
  });
});

describe('CRM payload generation', () => {
  it('builds People payloads for the assessment completion fields', () => {
    const submission = normalizeNetlifySubmission(sampleSubmission);
    const score = calculateAssessmentResults(submission.assessment.answers);
    const payload = createPersonPayload({
      submission,
      score,
      now: new Date('2026-05-23T00:00:00.000Z')
    });

    expect(payload).toMatchObject({
      name: { firstName: 'Jordan', lastName: 'Smith' },
      emails: { primaryEmail: 'jordan@example.com', additionalEmails: [] },
      assessmentCompleted: true,
      assessmentScore: 55,
      leadstageAuto: 'ASSESSMENT_COMPLETED',
      lastTouchDate: '2026-05-23',
      nextFollowUpDate: '2026-05-24'
    });
  });

  it('builds dry-run CRM payload groups with dedupe keys', () => {
    const submission = normalizeNetlifySubmission(sampleSubmission);
    const score = calculateAssessmentResults(submission.assessment.answers);
    const payloads = buildAssessmentCrmPayloads({ submission, score });

    expect(payloads.person.dedupeKey).toBe('person:email:jordan@example.com');
    expect(payloads.company.dedupeKey).toBe('company:name:Acme Workforce Ops');
    expect(payloads.task.dedupeKey).toBe(
      'submission:sample-assessment-2026-05-23-001:task:assessment-review'
    );
    expect(payloads.opportunity.action).toBe('create_or_update');
    expect(shouldCreateOpportunity(score)).toBe(true);
  });

  it('builds a schema-safe minimal Opportunity payload', () => {
    const submission = normalizeNetlifySubmission(sampleSubmission);
    const score = calculateAssessmentResults(submission.assessment.answers);
    const payload = createOpportunityPayload({ submission, score });

    expect(payload).toEqual({
      name: 'Acme Workforce Ops - Spot the Gap diagnostic',
      stage: 'TARGET_IDENTIFIED',
      dealValue: null,
      hiring: false
    });
    expect(payload).not.toHaveProperty('source');
    expect(payload).not.toHaveProperty('assessmentScore');
    expect(payload).not.toHaveProperty('assessmentGrade');
    expect(payload).not.toHaveProperty('assessmentLabel');
  });
});

describe('CRM dry-run execution', () => {
  it('routes workflow execution through the CRM adapter in dry-run mode', async () => {
    const operationalStore = createMemoryOperationalStore();
    const result = await processAssessmentSubmission({
      headers: {},
      config: testConfig,
      log: silentLog,
      body: sampleSubmission,
      schemaOverride: mockSchema,
      operationalStore
    });

    expect(result.status).toBe('dry_run');
    expect(result.score).toMatchObject({
      score: 55,
      grade: 'D',
      label: 'Scaling risk'
    });
    expect(result.crmSync).toMatchObject({
      provider: 'twenty',
      status: 'dry_run',
      dryRun: true
    });
    expect(result.crmSync.schemaValidation.ok).toBe(true);
    expect(result.crmSync.operations.map((operation) => operation.object)).toEqual([
      'company',
      'person',
      'task',
      'opportunity'
    ]);
    expect(result.crmSync.operations.every((operation) => operation.status === 'dry_run')).toBe(
      true
    );
    expect(operationalStore.snapshot().crmSyncLogs).toHaveLength(4);
  });

  it('can be constructed directly as a provider-agnostic CRM adapter', async () => {
    const submission = normalizeNetlifySubmission(sampleSubmission);
    const score = calculateAssessmentResults(submission.assessment.answers);
    const adapter = createCrmAdapter({
      provider: 'twenty',
      config: testConfig,
      log: silentLog,
      schemaOverride: mockSchema
    });

    const result = await adapter.syncAssessmentSubmission({ submission, score });

    expect(result.provider).toBe('twenty');
    expect(result.status).toBe('dry_run');
    expect(result.operations).toHaveLength(4);
  });
});

describe('idempotency and retry-safe workflow execution', () => {
  it('prevents duplicate replay after a completed dry-run workflow', async () => {
    const operationalStore = createMemoryOperationalStore();

    const first = await processAssessmentSubmission({
      headers: { 'x-correlation-id': 'corr-first' },
      config: testConfig,
      log: silentLog,
      body: sampleSubmission,
      schemaOverride: mockSchema,
      operationalStore
    });
    const second = await processAssessmentSubmission({
      headers: { 'x-correlation-id': 'corr-second' },
      config: testConfig,
      log: silentLog,
      body: sampleSubmission,
      schemaOverride: mockSchema,
      operationalStore
    });
    const snapshot = operationalStore.snapshot();

    expect(first.status).toBe('dry_run');
    expect(second).toMatchObject({
      status: 'duplicate_replay',
      duplicate: true,
      replayProtected: true
    });
    expect(snapshot.submissions).toHaveLength(1);
    expect(snapshot.crmSyncLogs).toHaveLength(4);
  });

  it('retries a partial failure without creating a second submission record', async () => {
    const operationalStore = createMemoryOperationalStore();
    const restClient = createFakeTwentyRestClient({ failOnceForObject: 'tasks' });

    const first = await processAssessmentSubmission({
      headers: { 'x-correlation-id': 'retry-corr-1' },
      config: liveTestConfig,
      log: silentLog,
      body: sampleSubmission,
      schemaOverride: mockSchema,
      operationalStore,
      restClient
    });
    const second = await processAssessmentSubmission({
      headers: { 'x-correlation-id': 'retry-corr-2' },
      config: liveTestConfig,
      log: silentLog,
      body: sampleSubmission,
      schemaOverride: mockSchema,
      operationalStore,
      restClient
    });
    const snapshot = operationalStore.snapshot();

    expect(first.status).toBe('partial_failure');
    expect(first.workflowSummary.operationStatusCounts.failed).toBe(1);
    expect(second.status).toBe('synced');
    expect(second.duplicate).toBe(true);
    expect(second.crmSync.operations.map((operation) => operation.status)).toEqual([
      'skipped',
      'skipped',
      'succeeded',
      'skipped'
    ]);
    expect(snapshot.submissions).toHaveLength(1);
    expect(snapshot.submissions[0].retry_count).toBe(2);
    expect(snapshot.crmSyncLogs).toHaveLength(8);
    expect(snapshot.crmSyncLogs.some((log) => log.status === 'failed')).toBe(true);
    expect(restClient.snapshot().companies).toHaveLength(1);
    expect(restClient.snapshot().people).toHaveLength(1);
    expect(restClient.snapshot().tasks).toHaveLength(1);
    expect(restClient.snapshot().opportunities).toHaveLength(1);
  });
});

describe('controlled live CRM synchronization', () => {
  it('creates CRM records through the adapter when live sync is enabled and schema is valid', async () => {
    const operationalStore = createMemoryOperationalStore();
    const restClient = createFakeTwentyRestClient();

    const result = await processAssessmentSubmission({
      headers: { 'x-correlation-id': 'live-corr' },
      config: liveTestConfig,
      log: silentLog,
      body: sampleSubmission,
      schemaOverride: mockSchema,
      operationalStore,
      restClient
    });
    const snapshot = operationalStore.snapshot();

    expect(result.status).toBe('synced');
    expect(result.crmSync).toMatchObject({
      provider: 'twenty',
      status: 'succeeded',
      dryRun: false
    });
    expect(result.crmSync.operations.map((operation) => operation.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded'
    ]);
    expect(restClient.snapshot().people).toHaveLength(1);
    expect(restClient.snapshot().companies).toHaveLength(1);
    expect(restClient.snapshot().tasks).toHaveLength(1);
    expect(restClient.snapshot().opportunities).toHaveLength(1);
    expect(snapshot.crmSyncLogs.every((log) => log.correlationId === 'live-corr')).toBe(true);
    expect(snapshot.workflowJobs[0]).toMatchObject({
      status: 'succeeded',
      attempt_count: 1
    });
  });

  it('blocks live writes when schema validation fails', async () => {
    const operationalStore = createMemoryOperationalStore();
    const restClient = createFakeTwentyRestClient();
    const invalidSchema = buildSchemaSnapshot([
      {
        ...mockTwentyObjects[0],
        fields: mockTwentyObjects[0].fields.filter((fieldDefinition) =>
          fieldDefinition.name !== 'assessmentCompleted'
        )
      },
      ...mockTwentyObjects.slice(1)
    ]);

    const result = await processAssessmentSubmission({
      headers: { 'x-correlation-id': 'schema-block-corr' },
      config: liveTestConfig,
      log: silentLog,
      body: sampleSubmission,
      schemaOverride: invalidSchema,
      operationalStore,
      restClient
    });

    expect(result.status).toBe('failed');
    expect(result.crmSync.status).toBe('blocked_schema_validation');
    expect(result.crmSync.schemaValidation.errors).toContain(
      'Missing field "person.assessmentCompleted".'
    );
    expect(restClient.snapshot().people).toHaveLength(0);
    expect(operationalStore.snapshot().crmSyncLogs).toHaveLength(4);
  });
});

function field(name, type, overrides = {}) {
  return {
    name,
    type,
    isActive: true,
    isCustom: false,
    ...overrides,
    options: overrides.options?.map((value, index) => ({
      id: `${name}-${value}`,
      label: value,
      value,
      position: index
    }))
  };
}

function createFakeTwentyRestClient({ failOnceForObject } = {}) {
  const records = {
    people: [],
    companies: [],
    tasks: [],
    opportunities: []
  };
  const failures = new Set(failOnceForObject ? [failOnceForObject] : []);

  return {
    async listRecords(objectPlural) {
      return records[objectPlural];
    },

    async findFirstRecord(objectPlural, predicate) {
      return records[objectPlural].find(predicate) ?? null;
    },

    async createRecord(objectPlural, payload) {
      if (failures.has(objectPlural)) {
        failures.delete(objectPlural);
        throw new Error(`Injected ${objectPlural} failure`);
      }

      const record = {
        id: `${objectPlural}-${records[objectPlural].length + 1}`,
        ...payload
      };

      records[objectPlural].push(record);
      return record;
    },

    async updateRecord(objectPlural, id, payload) {
      if (failures.has(objectPlural)) {
        failures.delete(objectPlural);
        throw new Error(`Injected ${objectPlural} failure`);
      }

      const index = records[objectPlural].findIndex((record) => record.id === id);
      const updated = {
        ...records[objectPlural][index],
        ...payload
      };

      records[objectPlural][index] = updated;
      return updated;
    },

    snapshot() {
      return {
        people: [...records.people],
        companies: [...records.companies],
        tasks: [...records.tasks],
        opportunities: [...records.opportunities]
      };
    }
  };
}
