import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import sampleLead from '../data/sample-quick-capture-lead.json' with { type: 'json' };
import { buildSchemaSnapshot } from '../src/integrations/twenty/metadataClient.js';
import {
  buildQuickCaptureCrmPayloads,
  createQuickCapturePersonPayload,
  createTwentyPhonePayload
} from '../src/integrations/twenty/outboundPayloadBuilders.js';
import { validateQuickCapturePersonPayload } from '../src/integrations/twenty/personPayloadValidator.js';
import {
  createQuickCaptureClient,
  PROTECTED_ASSESSMENT_FIELDS
} from '../src/integrations/twenty/quickCaptureClient.js';
import {
  validateTwentyOutboundSchema,
  validateTwentySchema
} from '../src/integrations/twenty/schemaValidator.js';
import { createMemoryOperationalStore } from '../src/persistence/memoryOperationalStore.js';
import {
  extractRetryAfterMs,
  isRetryableTwentyError
} from '../src/utils/retryPolicy.js';
import { mapWorkspaceUserToOutboundActorContext } from '../src/utils/outboundActorMapper.js';
import { planInitialCadence } from '../src/utils/cadencePlanner.js';
import { scoreOutboundLead } from '../src/utils/outboundLeadScoring.js';
import { evaluateQuickCaptureSyncTestMode } from '../src/utils/syncTestGuards.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import {
  assertFakeQuickCaptureLead,
  normalizeQuickCaptureLead
} from '../src/workflows/outbound/leadIntakeWorkflow.js';
import { processQuickCaptureLead } from '../src/workflows/outbound/quickCaptureWorkflow.js';

const testConfig = {
  env: 'development',
  crmProvider: 'twenty',
  workflowMaxAttempts: 3,
  webhookSharedSecret: undefined,
  supabase: {
    enabled: false
  },
  twenty: {
    syncEnabled: false,
    apiBaseUrl: 'https://api.twenty.com',
    apiKey: undefined
  }
};

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('Quick Capture normalization', () => {
  it('normalizes lead input and picks the strongest dedupe key', () => {
    const lead = normalizeQuickCaptureLead({
      fullName: ' Taylor   Morgan ',
      companyName: 'Visible Gap Quick Capture Test Company',
      companyWebsite: 'quickcapture-test.example.com',
      linkedinUrl: 'linkedin.com/in/visiblegap-quick-capture-test',
      email: 'Taylor@Example.COM',
      leadSource: 'LINKEDIN_MANUAL_CAPTURE',
      notes: 'Manual capture.'
    });

    expect(lead).toMatchObject({
      firstName: 'Taylor',
      lastName: 'Morgan',
      email: 'taylor@example.com',
      companyWebsite: 'https://quickcapture-test.example.com',
      companyDomain: 'quickcapture-test.example.com',
      linkedinUrl: 'https://linkedin.com/in/visiblegap-quick-capture-test',
      dedupe: {
        strategy: 'email',
        key: 'person:email:taylor@example.com'
      }
    });
  });

  it('falls back to LinkedIn URL and then name plus company for dedupe', () => {
    const linkedInLead = normalizeQuickCaptureLead({
      fullName: 'Taylor Morgan',
      companyName: 'Example Co',
      linkedinUrl: 'https://linkedin.com/in/taylor',
      leadSource: 'LINKEDIN_MANUAL_CAPTURE'
    });
    const fallbackLead = normalizeQuickCaptureLead({
      fullName: 'Taylor Morgan',
      companyName: 'Example Co',
      leadSource: 'REFERRAL',
      notes: 'Referral from partner.'
    });

    expect(linkedInLead.dedupe).toEqual({
      strategy: 'linkedin',
      key: 'person:linkedin:https://linkedin.com/in/taylor'
    });
    expect(fallbackLead.dedupe.strategy).toBe('name_company');
    expect(fallbackLead.dedupe.key).toMatch(/^person:name-company:/);
  });
});

describe('Quick Capture outbound actor mapping', () => {
  it('maps authenticated reps to a schema-allowed human actor type', () => {
    const actorContext = mapWorkspaceUserToOutboundActorContext({
      authenticated: true,
      userId: 'workspace-user-1',
      email: 'rep@visiblegap.com',
      fullName: 'Visible Gap Rep',
      role: 'rep',
      roleSource: 'profile'
    });

    expect(actorContext.actorType).toBe('human');
    expect(actorContext.actorType).not.toBe('workspace_user');
    expect(actorContext.workspaceUser).toMatchObject({
      userId: 'workspace-user-1',
      email: 'rep@visiblegap.com',
      role: 'rep',
      roleSource: 'profile'
    });
  });

  it('maps authenticated admins to human because admin is not an allowed actor_type', () => {
    const actorContext = mapWorkspaceUserToOutboundActorContext({
      authenticated: true,
      userId: 'workspace-admin-1',
      email: 'admin@visiblegap.com',
      fullName: 'Visible Gap Admin',
      role: 'admin',
      roleSource: 'profile',
      profileId: 'profile-admin-1'
    });

    expect(actorContext.actorType).toBe('human');
    expect(actorContext.workspaceUser).toMatchObject({
      profileId: 'profile-admin-1',
      role: 'admin'
    });
  });

  it('maps unauthenticated secret/dev activity to system', () => {
    expect(
      mapWorkspaceUserToOutboundActorContext({
        authenticated: false,
        role: 'rep',
        roleSource: 'workspace-secret'
      })
    ).toMatchObject({
      actorType: 'system',
      workspaceUser: {
        authenticated: false,
        role: 'rep',
        roleSource: 'workspace-secret'
      }
    });
  });
});

describe('Quick Capture scoring and cadence', () => {
  it('calculates preliminary ICP and lead health scores', () => {
    const lead = normalizeQuickCaptureLead(sampleLead);
    const scores = scoreOutboundLead(lead);

    expect(scores.icpFitScore).toBeGreaterThanOrEqual(75);
    expect(scores.leadHealthScore).toBeGreaterThanOrEqual(75);
    expect(scores).toMatchObject({
      staleRisk: 'LOW',
      discoveryReadiness: 'MONITOR'
    });
  });

  it('assigns assessment campaign cadence defaults', () => {
    const cadence = planInitialCadence({
      outboundPipelineType: 'ASSESSMENT_CAMPAIGN',
      availablePipelineTypes: ['ASSESSMENT_CAMPAIGN', 'RELATIONSHIP_BUILDING', 'GENERAL_PROSPECT'],
      availableCadenceNames: ['ASSESSMENT_CAMPAIGN_V1', 'RELATIONSHIP_BUILDING_V1', 'NONE'],
      availableCadenceStages: ['NOT_STARTED', 'CONNECTION_REQUEST'],
      now: new Date('2026-05-27T14:00:00.000Z')
    });

    expect(cadence).toMatchObject({
      pipelineType: 'ASSESSMENT_CAMPAIGN',
      cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
      cadenceStage: 'CONNECTION_REQUEST',
      nextOutboundTouchDate: '2026-05-28'
    });
    expect(cadence.firstTask.title).toBe('Send assessment-oriented connection request');
  });

  it('defaults missing pipeline to GENERAL_PROSPECT when the CRM supports it', () => {
    const cadence = planInitialCadence({
      availablePipelineTypes: ['ASSESSMENT_CAMPAIGN', 'RELATIONSHIP_BUILDING', 'GENERAL_PROSPECT'],
      availableCadenceNames: ['ASSESSMENT_CAMPAIGN_V1', 'RELATIONSHIP_BUILDING_V1', 'NONE'],
      availableCadenceStages: ['NOT_STARTED', 'CONNECTION_REQUEST'],
      now: new Date('2026-05-27T14:00:00.000Z')
    });

    expect(cadence).toMatchObject({
      pipelineType: 'GENERAL_PROSPECT',
      cadenceName: 'NONE',
      cadenceStage: 'NOT_STARTED'
    });
  });
});

describe('Quick Capture CRM payload generation', () => {
  it('builds outbound People, Company, and Task payloads', () => {
    const lead = normalizeQuickCaptureLead(sampleLead);
    const cadence = planInitialCadence({
      outboundPipelineType: lead.outboundPipelineType,
      availablePipelineTypes: ['ASSESSMENT_CAMPAIGN', 'RELATIONSHIP_BUILDING', 'GENERAL_PROSPECT'],
      availableCadenceNames: ['ASSESSMENT_CAMPAIGN_V1', 'RELATIONSHIP_BUILDING_V1', 'NONE'],
      availableCadenceStages: ['NOT_STARTED', 'CONNECTION_REQUEST'],
      now: new Date('2026-05-27T14:00:00.000Z')
    });
    const scores = {
      ...scoreOutboundLead(lead),
      outreachAngle: 'Assessment-oriented angle.'
    };
    const payloads = buildQuickCaptureCrmPayloads({
      lead,
      scores,
      cadence,
      supportedPersonFields: confirmedPersonFields({ includeQuickCaptureUrl: false })
    });

    expect(payloads.person.dedupeKey).toBe(
      'person:email:visiblegap.quick-capture-test@example.com'
    );
    expect(payloads.person.payload).toMatchObject({
      name: { firstName: 'Taylor', lastName: 'Morgan' },
      emails: {
        primaryEmail: 'visiblegap.quick-capture-test@example.com',
        additionalEmails: []
      },
      phones: {
        primaryPhoneCountryCode: 'US',
        primaryPhoneCallingCode: '+1',
        primaryPhoneNumber: '5550100142',
        additionalPhones: []
      },
      linkedinLink: {
        primaryLinkUrl: 'https://www.linkedin.com/in/visiblegap-quick-capture-test'
      },
      jobTitle: 'VP of Operations',
      leadSource: 'LINKEDIN_MANUAL_CAPTURE',
      outboundPipelineType: 'ASSESSMENT_CAMPAIGN',
      cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
      cadenceStage: 'CONNECTION_REQUEST',
      enrichmentStatus: 'PARTIAL',
      latestTouchChannel: 'LINKEDIN',
      latestTouchStatus: 'DRAFTED'
    });
    expect(payloads.person.payload).not.toHaveProperty('quickCaptureUrl');
    expect(payloads.company.payload).toMatchObject({
      name: 'Visible Gap Quick Capture Test Company',
      domainName: {
        primaryLinkUrl: 'https://quickcapture-test.example.com'
      }
    });
    expect(payloads.task.payload.bodyV2.markdown).toContain('Manual action required');
  });

  it('never includes protected assessment fields in Quick Capture Person payloads', () => {
    const lead = normalizeQuickCaptureLead(sampleLead);
    const payload = createQuickCapturePersonPayload({
      lead,
      scores: {
        icpFitScore: 80,
        leadHealthScore: 85,
        staleRisk: 'LOW',
        discoveryReadiness: 'MONITOR',
        outreachAngle: 'Angle.'
      },
      cadence: {
        pipelineType: 'ASSESSMENT_CAMPAIGN',
        cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
        cadenceStage: 'CONNECTION_REQUEST',
        nextOutboundTouchDate: '2026-05-28',
        firstTask: {
          channel: 'LINKEDIN'
        }
      },
      supportedPersonFields: confirmedPersonFields()
    });

    for (const fieldName of PROTECTED_ASSESSMENT_FIELDS) {
      expect(payload).not.toHaveProperty(fieldName);
    }
  });

  it('includes quickCaptureUrl only when the field is supported', () => {
    const lead = normalizeQuickCaptureLead(sampleLead);
    const payload = createQuickCapturePersonPayload({
      lead,
      scores: {
        icpFitScore: 80,
        leadHealthScore: 85,
        staleRisk: 'LOW',
        discoveryReadiness: 'MONITOR',
        outreachAngle: 'Angle.'
      },
      cadence: {
        pipelineType: 'ASSESSMENT_CAMPAIGN',
        cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
        cadenceStage: 'CONNECTION_REQUEST',
        nextOutboundTouchDate: '2026-05-28',
        firstTask: {
          channel: 'LINKEDIN'
        }
      },
      supportedPersonFields: confirmedPersonFields()
    });

    expect(payload.quickCaptureUrl).toEqual({
      primaryLinkUrl: 'https://www.linkedin.com/in/visiblegap-quick-capture-test',
      primaryLinkLabel: 'Quick Capture Source'
    });
  });

  it('omits unconfirmed Person fields instead of sending speculative fields', () => {
    const lead = normalizeQuickCaptureLead(sampleLead);
    const payload = createQuickCapturePersonPayload({
      lead,
      scores: {
        icpFitScore: 80,
        leadHealthScore: 85,
        staleRisk: 'LOW',
        discoveryReadiness: 'MONITOR',
        outreachAngle: 'Angle.'
      },
      cadence: {
        pipelineType: 'ASSESSMENT_CAMPAIGN',
        cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
        cadenceStage: 'CONNECTION_REQUEST',
        nextOutboundTouchDate: '2026-05-28',
        firstTask: {
          channel: 'LINKEDIN'
        }
      },
      supportedPersonFields: new Set(['name', 'emails', 'outboundPipelineType'])
    });

    expect(Object.keys(payload).sort()).toEqual(['emails', 'name', 'outboundPipelineType']);
    expect(payload).not.toHaveProperty('leadSource');
    expect(payload).not.toHaveProperty('phones');
    expect(payload).not.toHaveProperty('linkedinLink');
  });

  it('validates Person payload shapes and select values against metadata', () => {
    const lead = normalizeQuickCaptureLead(sampleLead);
    const payload = createQuickCapturePersonPayload({
      lead,
      scores: {
        icpFitScore: 80,
        leadHealthScore: 85,
        staleRisk: 'LOW',
        discoveryReadiness: 'MONITOR',
        outreachAngle: 'Angle.'
      },
      cadence: {
        pipelineType: 'ASSESSMENT_CAMPAIGN',
        cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
        cadenceStage: 'CONNECTION_REQUEST',
        nextOutboundTouchDate: '2026-05-28',
        firstTask: {
          channel: 'LINKEDIN'
        }
      },
      supportedPersonFields: confirmedPersonFields()
    });
    const validation = validateQuickCapturePersonPayload({
      payload,
      lead,
      schema: quickCapturePersonSchema
    });

    expect(validation.ok).toBe(true);
    expect(validation.includedFieldNames).toEqual(
      expect.arrayContaining(['emails', 'phones', 'linkedinLink', 'latestTouchStatus'])
    );
    expect(
      validation.fieldReport.find((fieldReport) => fieldReport.fieldName === 'phones')
    ).toMatchObject({
      status: 'included_valid'
    });
  });

  it('omits phone payload when the number lacks country and calling code shape', () => {
    expect(createTwentyPhonePayload('5555555555')).toBeNull();
    expect(createTwentyPhonePayload('+1 555 010 0142')).toEqual({
      primaryPhoneCountryCode: 'US',
      primaryPhoneCallingCode: '+1',
      primaryPhoneNumber: '5550100142',
      additionalPhones: []
    });
  });

  it('reports Person payload shape and select value mismatches before writes', () => {
    const validation = validateQuickCapturePersonPayload({
      payload: {
        name: { firstName: 'Taylor', lastName: 'Morgan' },
        emails: { primaryEmail: 'not-an-email', additionalEmails: [] },
        phones: { primaryPhoneNumber: '5555555555', additionalPhones: [] },
        linkedinLink: { primaryLinkUrl: 'linkedin.com/in/taylor', primaryLinkLabel: 'LinkedIn' },
        latestTouchStatus: 'UNSUPPORTED'
      },
      lead: {
        dedupe: {
          strategy: 'email'
        }
      },
      schema: quickCapturePersonSchema
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([
        'Field "emails.primaryEmail" is not a valid email address.',
        'Field "phones.primaryPhoneCountryCode" is required for Twenty phones shape.',
        'Field "phones.primaryPhoneCallingCode" is required for Twenty phones shape.',
        'Field "linkedinLink.primaryLinkUrl" must be an http(s) URL.',
        'Field "latestTouchStatus" value "UNSUPPORTED" is not in Twenty select options.'
      ])
    );
  });
});

describe('Quick Capture workflow dry-run safety', () => {
  it('plans CRM payloads and outbound event without writing to Twenty', async () => {
    const store = createMemoryOperationalStore();
    const result = await processQuickCaptureLead({
      input: sampleLead,
      config: testConfig,
      schemaOverride: outboundSchemaWithoutQuickCaptureUrl,
      operationalStore: store,
      persistEvents: true,
      now: new Date('2026-05-27T14:00:00.000Z')
    });

    expect(result.status).toBe('dry_run');
    expect(result.dryRun).toBe(true);
    expect(result.crmPayloads.person.action).toBe('upsert');
    expect(result.crmPayloads.task.action).toBe('create');
    expect(result.outboundEvent.persisted).toBeTruthy();
    expect(store.snapshot().outboundEvents).toHaveLength(1);
    expect(result.schemaValidation.ok).toBe(false);
    expect(result.warnings).toContain(
      'Outbound schema issue: Missing outbound field "person.quickCaptureUrl".'
    );
  });

  it('persists authenticated workspace user details without invalid actor types', async () => {
    const store = createMemoryOperationalStore();
    const result = await processQuickCaptureLead({
      input: sampleLead,
      config: testConfig,
      schemaOverride: outboundSchemaWithoutQuickCaptureUrl,
      operationalStore: store,
      persistEvents: true,
      workspaceUser: {
        authenticated: true,
        userId: 'workspace-user-1',
        email: 'rep@visiblegap.com',
        fullName: 'Visible Gap Rep',
        role: 'rep',
        roleSource: 'profile',
        profileId: 'profile-1'
      },
      now: new Date('2026-05-27T14:00:00.000Z')
    });

    expect(result.outboundEvent.planned.actorType).toBe('human');
    expect(result.outboundEvent.planned.actorType).not.toBe('workspace_user');
    expect(result.outboundEvent.planned.payload.workspaceUser).toMatchObject({
      authenticated: true,
      userId: 'workspace-user-1',
      email: 'rep@visiblegap.com',
      role: 'rep',
      roleSource: 'profile',
      profileId: 'profile-1'
    });
    expect(store.snapshot().outboundEvents[0]).toMatchObject({
      actorType: 'human',
      payload: {
        workspaceUser: {
          role: 'rep',
          roleSource: 'profile'
        }
      }
    });
  });
});

describe('Quick Capture live guardrails', () => {
  it('defaults to dry-run when live flags are absent', () => {
    const guard = evaluateQuickCaptureSyncTestMode({
      liveTest: undefined,
      quickCaptureSyncEnabled: false,
      twentySyncEnabled: false,
      twentyApiKey: undefined,
      supabaseEnabled: false
    });

    expect(guard).toMatchObject({
      ok: true,
      mode: 'dry_run'
    });
  });

  it('blocks live execution unless all explicit live flags are present', () => {
    const guard = evaluateQuickCaptureSyncTestMode({
      liveTest: true,
      quickCaptureSyncEnabled: false,
      twentySyncEnabled: true,
      twentyApiKey: 'test-key',
      supabaseEnabled: false
    });

    expect(guard).toMatchObject({
      ok: false,
      mode: 'blocked'
    });
    expect(guard.errors).toContain(
      'Quick Capture live test requires QUICK_CAPTURE_SYNC_ENABLED=true.'
    );
  });

  it('accepts only obviously fake live-test leads', () => {
    const safeLead = normalizeQuickCaptureLead(sampleLead);
    const unsafeLead = normalizeQuickCaptureLead({
      ...sampleLead,
      email: 'real.person@customer.com',
      companyName: 'Real Customer Inc',
      linkedinUrl: 'https://linkedin.com/in/real-person'
    });

    expect(() => assertFakeQuickCaptureLead(safeLead)).not.toThrow();
    expect(() => assertFakeQuickCaptureLead(unsafeLead)).toThrow(
      'Unsafe Quick Capture live test lead'
    );
  });
});

describe('Quick Capture live client planning', () => {
  it('updates an existing Person by email and skips duplicate task creation', async () => {
    const lead = normalizeQuickCaptureLead(sampleLead);
    const cadence = planInitialCadence({
      outboundPipelineType: lead.outboundPipelineType,
      availablePipelineTypes: ['ASSESSMENT_CAMPAIGN', 'RELATIONSHIP_BUILDING', 'GENERAL_PROSPECT'],
      availableCadenceNames: ['ASSESSMENT_CAMPAIGN_V1', 'RELATIONSHIP_BUILDING_V1', 'NONE'],
      availableCadenceStages: ['NOT_STARTED', 'CONNECTION_REQUEST'],
      now: new Date('2026-05-27T14:00:00.000Z')
    });
    const scores = {
      ...scoreOutboundLead(lead),
      outreachAngle: 'Assessment-oriented angle.'
    };
    const payloads = buildQuickCaptureCrmPayloads({
      lead,
      scores,
      cadence,
      supportedPersonFields: confirmedPersonFields()
    });
    const restClient = createFakeQuickCaptureRestClient({
      people: [
        {
          id: 'people-existing-1',
          emails: {
            primaryEmail: lead.email
          },
          name: {
            firstName: lead.firstName,
            lastName: lead.lastName
          }
        }
      ],
      tasks: [
        {
          id: 'tasks-existing-1',
          bodyV2: {
            markdown: `Dedupe key: ${payloads.task.dedupeKey}`
          }
        }
      ]
    });
    const client = createQuickCaptureClient({ dryRun: false, restClient });
    const result = await client.syncQuickCapture({ lead, payloads });

    expect(result.status).toBe('succeeded');
    expect(result.operations.find((operation) => operation.object === 'person')).toMatchObject({
      action: 'update',
      status: 'succeeded',
      duplicateAvoided: true,
      matchedBy: 'email'
    });
    expect(result.operations.find((operation) => operation.object === 'task')).toMatchObject({
      action: 'skip_existing',
      status: 'skipped',
      duplicateAvoided: true
    });
    expect(restClient.snapshot().people).toHaveLength(1);
    expect(restClient.snapshot().tasks).toHaveLength(1);
  });

  it('returns structured diagnostics for Person 400 responses', async () => {
    const { lead, payloads } = buildQuickCaptureTestPlan();
    const restClient = createPersonFailureRestClient({
      error: badRequestError({
        message: 'Validation failed',
        errors: [{ message: 'phones.primaryPhoneCountryCode is required' }]
      })
    });
    const client = createQuickCaptureClient({ dryRun: false, restClient });
    const result = await client.syncQuickCaptureOperations({
      lead,
      operations: [payloads.person]
    });

    expect(result.status).toBe('failed');
    expect(result.operations[0]).toMatchObject({
      object: 'person',
      status: 'failed',
      error: {
        httpStatus: 400,
        responseBody: {
          message: 'Validation failed'
        },
        validationMessages: expect.arrayContaining([
          'Validation failed',
          'phones.primaryPhoneCountryCode is required'
        ]),
        diagnostics: {
          failingOperation: {
            object: 'person',
            action: 'upsert',
            dedupeKey: 'person:email:visiblegap.quick-capture-test@example.com'
          },
          dedupeStrategy: 'email',
          fieldNames: expect.arrayContaining(['name', 'emails', 'phones']),
          sanitizedRequestPayload: {
            emails: {
              primaryEmail: 'visiblegap.quick-capture-test@example.com'
            }
          }
        }
      }
    });
  });
});

describe('Quick Capture retry and recovery behavior', () => {
  it('classifies Twenty 502 responses as retryable', () => {
    expect(
      isRetryableTwentyError({
        response: {
          status: 502,
          data: {
            details: {
              status: 502
            }
          }
        }
      })
    ).toBe(true);
  });

  it('extracts retry_after from a Twenty 429 response', () => {
    expect(
      extractRetryAfterMs({
        response: {
          status: 429,
          headers: {
            'retry-after': '2'
          }
        }
      })
    ).toBe(2000);
  });

  it('recovers a retryable failed Company operation without retrying Person or Task', async () => {
    const { lead, payloads } = buildQuickCaptureTestPlan();
    const delays = [];
    const restClient = createFlakyCompanyRestClient({
      failuresBeforeSuccess: 1,
      error: retryableHttpError(502, { retry_after: 1 })
    });
    const client = createQuickCaptureClient({
      dryRun: false,
      restClient,
      retry: {
        maxRetries: 1,
        baseMs: 1,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        }
      }
    });
    const result = await client.syncQuickCaptureOperations({
      lead,
      operations: [payloads.company]
    });

    expect(result.status).toBe('succeeded');
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      object: 'company',
      status: 'succeeded',
      attempts: 2,
      retryCount: 1
    });
    expect(delays).toEqual([1000]);
    expect(restClient.snapshot()).toMatchObject({
      peopleCreateCalls: 0,
      tasksCreateCalls: 0,
      companiesCreateCalls: 2
    });
  });

  it('stops retrying after the configured max retry count', async () => {
    const { lead, payloads } = buildQuickCaptureTestPlan();
    const restClient = createFlakyCompanyRestClient({
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      error: retryableHttpError(502)
    });
    const client = createQuickCaptureClient({
      dryRun: false,
      restClient,
      retry: {
        maxRetries: 1,
        baseMs: 1,
        sleep: async () => {}
      }
    });
    const result = await client.syncQuickCaptureOperations({
      lead,
      operations: [payloads.company]
    });

    expect(result.status).toBe('failed');
    expect(result.operations[0]).toMatchObject({
      object: 'company',
      status: 'failed',
      attempts: 2,
      retryCount: 1,
      maxRetries: 1
    });
    expect(result.operations[0].error).toMatchObject({
      status: 502,
      retryable: true
    });
    expect(restClient.snapshot().companiesCreateCalls).toBe(2);
  });

  it('does not duplicate existing Person or Task records when retrying only Company', async () => {
    const { lead, payloads } = buildQuickCaptureTestPlan();
    const restClient = createFakeQuickCaptureRestClient({
      people: [
        {
          id: 'people-existing-1',
          emails: {
            primaryEmail: lead.email
          }
        }
      ],
      tasks: [
        {
          id: 'tasks-existing-1',
          bodyV2: {
            markdown: `Dedupe key: ${payloads.task.dedupeKey}`
          }
        }
      ]
    });
    const client = createQuickCaptureClient({ dryRun: false, restClient });
    const result = await client.syncQuickCaptureOperations({
      lead,
      operations: [payloads.company]
    });

    expect(result.status).toBe('succeeded');
    expect(result.operations.map((operation) => operation.object)).toEqual(['company']);
    expect(restClient.snapshot().people).toHaveLength(1);
    expect(restClient.snapshot().tasks).toHaveLength(1);
  });
});

describe('outbound schema validation isolation', () => {
  it('does not make assessment schema validation depend on outbound fields', async () => {
    expect(validateTwentySchema(assessmentOnlySchema).ok).toBe(true);
    expect(validateTwentyOutboundSchema(assessmentOnlySchema).ok).toBe(false);

    const result = await processAssessmentSubmission({
      headers: {},
      config: testConfig,
      log: silentLog,
      body: sampleAssessment,
      schemaOverride: assessmentOnlySchema,
      operationalStore: createMemoryOperationalStore()
    });

    expect(result.status).toBe('dry_run');
    expect(result.crmSync.schemaValidation.ok).toBe(true);
  });
});

const assessmentOnlySchema = buildSchemaSnapshot([
  {
    nameSingular: 'person',
    namePlural: 'people',
    duplicateCriteria: [['emailsPrimaryEmail']],
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
    duplicateCriteria: [['name']],
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
]);

const outboundSchemaWithoutQuickCaptureUrl = buildSchemaSnapshot([
  {
    nameSingular: 'person',
    namePlural: 'people',
    fields: [
      ...assessmentOnlySchema.objectsBySingularName.person.fields,
      field('outboundPipelineType', 'SELECT', {
        isCustom: true,
        options: ['ASSESSMENT_CAMPAIGN', 'RELATIONSHIP_BUILDING', 'GENERAL_PROSPECT']
      }),
      field('cadenceName', 'SELECT', {
        isCustom: true,
        options: ['ASSESSMENT_CAMPAIGN_V1', 'RELATIONSHIP_BUILDING_V1', 'NONE']
      }),
      field('cadenceStage', 'SELECT', {
        isCustom: true,
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
      }),
      field('enrichmentStatus', 'SELECT', {
        isCustom: true,
        options: ['NOT_STARTED', 'PARTIAL', 'ENRICHED', 'NEEDS_REVIEW', 'FAILED']
      }),
      field('icpFitScore', 'NUMBER', { isCustom: true }),
      field('leadHealthScore', 'NUMBER', { isCustom: true }),
      field('lastOutboundTouchDate', 'DATE', { isCustom: true }),
      field('nextOutboundTouchDate', 'DATE', { isCustom: true }),
      field('outreachAngle', 'TEXT', { isCustom: true }),
      field('latestTouchChannel', 'SELECT', {
        isCustom: true,
        options: ['LINKEDIN', 'EMAIL', 'PHONE', 'TEXT', 'IN_PERSON', 'OTHER']
      }),
      field('latestTouchStatus', 'SELECT', {
        isCustom: true,
        options: ['DRAFTED', 'SENT', 'RESPONDED', 'NO_RESPONSE', 'BOUNCED', 'DECLINED', 'COMPLETED']
      }),
      field('staleRisk', 'SELECT', {
        isCustom: true,
        options: ['LOW', 'MEDIUM', 'HIGH', 'STALE']
      }),
      field('discoveryReadiness', 'SELECT', {
        isCustom: true,
        options: ['NOT_READY', 'MONITOR', 'READY', 'REQUESTED', 'BOOKED']
      })
    ]
  }
]);

const quickCapturePersonSchema = buildSchemaSnapshot([
  {
    nameSingular: 'person',
    namePlural: 'people',
    fields: [
      field('name', 'FULL_NAME'),
      field('emails', 'EMAILS'),
      field('phones', 'PHONES'),
      field('linkedinLink', 'LINKS'),
      field('jobTitle', 'TEXT'),
      field('company', 'RELATION'),
      field('owner', 'RELATION'),
      field('leadSource', 'TEXT'),
      field('outboundPipelineType', 'SELECT', {
        isCustom: true,
        options: ['ASSESSMENT_CAMPAIGN', 'RELATIONSHIP_BUILDING', 'GENERAL_PROSPECT']
      }),
      field('cadenceName', 'SELECT', {
        isCustom: true,
        options: ['ASSESSMENT_CAMPAIGN_V1', 'RELATIONSHIP_BUILDING_V1', 'NONE']
      }),
      field('cadenceStage', 'SELECT', {
        isCustom: true,
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
      }),
      field('enrichmentStatus', 'SELECT', {
        isCustom: true,
        options: ['NOT_STARTED', 'PARTIAL', 'ENRICHED', 'NEEDS_REVIEW', 'FAILED']
      }),
      field('icpFitScore', 'NUMBER', { isCustom: true }),
      field('leadHealthScore', 'NUMBER', { isCustom: true }),
      field('lastOutboundTouchDate', 'DATE', { isCustom: true }),
      field('nextOutboundTouchDate', 'DATE', { isCustom: true }),
      field('outreachAngle', 'TEXT', { isCustom: true }),
      field('latestTouchChannel', 'SELECT', {
        isCustom: true,
        options: ['LINKEDIN', 'EMAIL', 'PHONE', 'TEXT', 'IN_PERSON', 'OTHER']
      }),
      field('latestTouchStatus', 'SELECT', {
        isCustom: true,
        options: ['DRAFTED', 'SENT', 'RESPONDED', 'NO_RESPONSE', 'BOUNCED', 'DECLINED', 'COMPLETED']
      }),
      field('quickCaptureUrl', 'LINKS', { isCustom: true }),
      field('staleRisk', 'SELECT', {
        isCustom: true,
        options: ['LOW', 'MEDIUM', 'HIGH', 'STALE']
      }),
      field('discoveryReadiness', 'SELECT', {
        isCustom: true,
        options: ['NOT_READY', 'MONITOR', 'READY', 'REQUESTED', 'BOOKED']
      })
    ]
  }
]);

function buildQuickCaptureTestPlan() {
  const lead = normalizeQuickCaptureLead(sampleLead);
  const cadence = planInitialCadence({
    outboundPipelineType: lead.outboundPipelineType,
    availablePipelineTypes: ['ASSESSMENT_CAMPAIGN', 'RELATIONSHIP_BUILDING', 'GENERAL_PROSPECT'],
    availableCadenceNames: ['ASSESSMENT_CAMPAIGN_V1', 'RELATIONSHIP_BUILDING_V1', 'NONE'],
    availableCadenceStages: ['NOT_STARTED', 'CONNECTION_REQUEST'],
    now: new Date('2026-05-27T14:00:00.000Z')
  });
  const scores = {
    ...scoreOutboundLead(lead),
    outreachAngle: 'Assessment-oriented angle.'
  };

  return {
    lead,
    cadence,
    scores,
    payloads: buildQuickCaptureCrmPayloads({
      lead,
      scores,
      cadence,
      supportedPersonFields: confirmedPersonFields()
    })
  };
}

function confirmedPersonFields({ includeQuickCaptureUrl = true } = {}) {
  return new Set(
    [
      'name',
      'emails',
      'phones',
      'linkedinLink',
      'jobTitle',
      'leadSource',
      'outboundPipelineType',
      'cadenceName',
      'cadenceStage',
      'enrichmentStatus',
      'icpFitScore',
      'leadHealthScore',
      'nextOutboundTouchDate',
      'outreachAngle',
      'latestTouchChannel',
      'latestTouchStatus',
      includeQuickCaptureUrl ? 'quickCaptureUrl' : null,
      'staleRisk',
      'discoveryReadiness'
    ].filter(Boolean)
  );
}

function field(name, type, overrides = {}) {
  return {
    name,
    label: name,
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

function createFlakyCompanyRestClient({ failuresBeforeSuccess, error }) {
  const calls = {
    companiesCreateCalls: 0,
    peopleCreateCalls: 0,
    tasksCreateCalls: 0
  };
  const records = {
    companies: [],
    people: [],
    tasks: []
  };

  return {
    async findFirstRecord() {
      return null;
    },

    async createRecord(objectPlural, payload) {
      if (objectPlural === 'companies') {
        calls.companiesCreateCalls += 1;

        if (calls.companiesCreateCalls <= failuresBeforeSuccess) {
          throw error;
        }
      }

      if (objectPlural === 'people') {
        calls.peopleCreateCalls += 1;
      }

      if (objectPlural === 'tasks') {
        calls.tasksCreateCalls += 1;
      }

      const record = {
        id: `${objectPlural}-${records[objectPlural].length + 1}`,
        ...payload
      };

      records[objectPlural].push(record);
      return record;
    },

    async updateRecord(objectPlural, id, payload) {
      const index = records[objectPlural].findIndex((record) => record.id === id);
      records[objectPlural][index] = {
        ...records[objectPlural][index],
        ...payload
      };

      return records[objectPlural][index];
    },

    snapshot() {
      return {
        ...structuredClone(records),
        ...calls
      };
    }
  };
}

function retryableHttpError(status, details = {}) {
  const error = new Error(`Request failed with status code ${status}`);
  error.code = status === 429 ? 'ERR_TOO_MANY_REQUESTS' : 'ERR_BAD_RESPONSE';
  error.response = {
    status,
    data: {
      message: error.message,
      details: {
        status,
        retryable: true,
        ...details
      }
    }
  };

  return error;
}

function badRequestError(data) {
  const error = new Error('Request failed with status code 400');
  error.code = 'ERR_BAD_REQUEST';
  error.response = {
    status: 400,
    data
  };

  return error;
}

function createPersonFailureRestClient({ error }) {
  return {
    async findFirstRecord() {
      return null;
    },

    async createRecord(objectPlural) {
      if (objectPlural === 'people') {
        throw error;
      }

      return { id: `${objectPlural}-1` };
    },

    async updateRecord() {
      throw error;
    }
  };
}

function createFakeQuickCaptureRestClient(seed = {}) {
  const records = {
    people: [...(seed.people ?? [])],
    companies: [...(seed.companies ?? [])],
    tasks: [...(seed.tasks ?? [])]
  };

  return {
    async listRecords(objectPlural) {
      return records[objectPlural];
    },

    async findFirstRecord(objectPlural, predicate) {
      return records[objectPlural].find(predicate) ?? null;
    },

    async createRecord(objectPlural, payload) {
      const record = {
        id: `${objectPlural}-${records[objectPlural].length + 1}`,
        ...payload
      };

      records[objectPlural].push(record);
      return record;
    },

    async updateRecord(objectPlural, id, payload) {
      const index = records[objectPlural].findIndex((record) => record.id === id);
      records[objectPlural][index] = {
        ...records[objectPlural][index],
        ...payload
      };

      return records[objectPlural][index];
    },

    snapshot() {
      return structuredClone(records);
    }
  };
}
