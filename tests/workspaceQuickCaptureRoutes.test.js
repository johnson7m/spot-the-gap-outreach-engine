import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { PROTECTED_ASSESSMENT_FIELDS } from '../src/integrations/twenty/quickCaptureClient.js';
import { requireWorkspaceSecret } from '../src/middleware/workspaceAuth.js';
import {
  handleQuickCaptureCommit,
  handleQuickCapturePreview
} from '../src/routes/api/quickCaptureRoutes.js';

const silentLogger = pino({ level: 'silent' });

const baseConfig = {
  env: 'test',
  corsOrigin: '*',
  crmProvider: 'twenty',
  workflowMaxAttempts: 3,
  webhookSharedSecret: undefined,
  webhookRateLimit: {
    windowMs: 60000,
    max: 30
  },
  workspace: {
    apiSecret: 'workspace-secret'
  },
  supabase: {
    enabled: false
  },
  twenty: {
    syncEnabled: false,
    apiBaseUrl: 'https://api.twenty.com',
    apiKey: undefined,
    workspaceId: undefined
  },
  quickCapture: {
    syncEnabled: false,
    apiPreviewEnabled: true,
    apiCommitEnabled: false,
    maxRetries: 0,
    retryBaseMs: 1
  }
};

const sampleLead = {
  fullName: 'Taylor Morgan',
  title: 'VP of Operations',
  companyName: 'Visible Gap Workspace Test Company',
  companyWebsite: 'https://workspace-test.example.com',
  linkedinUrl: 'https://www.linkedin.com/in/visiblegap-workspace-test',
  email: 'workspace.quick-capture-test@example.com',
  phone: '+1 555 010 0142',
  leadSource: 'LINKEDIN',
  outboundPipelineType: 'ASSESSMENT_CAMPAIGN',
  notes: 'Manual workspace API preview test.'
};

describe('workspace Quick Capture API', () => {
  it('previews a Quick Capture lead without live flags', async () => {
    const response = await invokePreview({ body: { lead: sampleLead } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        status: 'preview',
        dryRun: true,
        normalizedLead: {
          email: 'workspace.quick-capture-test@example.com',
          companyName: 'Visible Gap Workspace Test Company'
        },
        dedupePlan: {
          strategy: 'email',
          key: 'person:email:workspace.quick-capture-test@example.com'
        },
        protectedFieldCheck: {
          ok: true,
          excluded: true
        }
      }
    });
    expect(response.body.data.crmPayloadPreview.person.payload).not.toHaveProperty(
      'assessmentScore'
    );
  });

  it('forces preview mode and does not call CRM execution', async () => {
    let workflowInput;
    let crmCalled = false;
    await invokePreview({
      body: { lead: sampleLead },
      dependencies: {
        processQuickCaptureLeadFn: async (input) => {
          workflowInput = input;
          return fakeQuickCapturePlan();
        }
      }
    });

    expect(workflowInput).toMatchObject({
      dryRun: true,
      persistEvents: false
    });
    expect(workflowInput.config.twenty.syncEnabled).toBe(false);
    expect(workflowInput.config.supabase.enabled).toBe(false);
    expect(crmCalled).toBe(false);
  });

  it('rejects commit without the workspace secret', async () => {
    const response = await invokeWorkspaceSecret({
      config: {
        ...baseConfig,
        quickCapture: {
          ...baseConfig.quickCapture,
          apiCommitEnabled: true
        },
        twenty: {
          ...baseConfig.twenty,
          syncEnabled: true
        }
      },
      headers: {}
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.errors[0].code).toBe('INVALID_WORKSPACE_SECRET');
  });

  it('rejects commit when QUICK_CAPTURE_API_COMMIT_ENABLED is false', async () => {
    const response = await invokeCommit({
      config: {
        ...baseConfig,
        twenty: {
          ...baseConfig.twenty,
          syncEnabled: true
        }
      },
      headers: {
        'x-visible-gap-workspace-secret': 'workspace-secret'
      },
      body: { lead: sampleLead, previewId: 'preview-1' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.errors[0].code).toBe('QUICK_CAPTURE_COMMIT_DISABLED');
  });

  it('rejects commit when TWENTY_SYNC_ENABLED is false', async () => {
    const response = await invokeCommit({
      config: {
        ...baseConfig,
        quickCapture: {
          ...baseConfig.quickCapture,
          apiCommitEnabled: true
        }
      },
      headers: {
        'x-visible-gap-workspace-secret': 'workspace-secret'
      },
      body: { lead: sampleLead, previewId: 'preview-1' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.errors[0].code).toBe('TWENTY_SYNC_DISABLED');
  });

  it('commits through guarded CRM execution without protected assessment fields', async () => {
    let receivedPayloads;
    const response = await invokeCommit({
      config: {
        ...baseConfig,
        quickCapture: {
          ...baseConfig.quickCapture,
          apiCommitEnabled: true
        },
        twenty: {
          ...baseConfig.twenty,
          syncEnabled: true,
          apiKey: 'test-key'
        }
      },
      headers: {
        'x-visible-gap-workspace-secret': 'workspace-secret'
      },
      body: { lead: sampleLead, previewId: 'preview-1' },
      dependencies: {
        processQuickCaptureLeadFn: async () => fakeQuickCapturePlan(),
        createCrmAdapterFn: () => ({
          async syncQuickCaptureLead({ payloads }) {
            receivedPayloads = payloads;

            return {
              provider: 'twenty',
              status: 'succeeded',
              dryRun: false,
              operations: [
                succeededOperation('company', 'companies-1', payloads.company),
                succeededOperation('person', 'people-1', payloads.person),
                succeededOperation('task', 'tasks-1', payloads.task)
              ],
              skippedRelationships: []
            };
          }
        })
      }
    });

    for (const fieldName of PROTECTED_ASSESSMENT_FIELDS) {
      expect(receivedPayloads.person.payload).not.toHaveProperty(fieldName);
    }

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        status: 'succeeded',
        protectedFieldCheck: {
          ok: true,
          excluded: true
        },
        crmResults: [
          { object: 'company', id: 'companies-1' },
          { object: 'person', id: 'people-1' },
          { object: 'task', id: 'tasks-1' }
        ]
      }
    });
  });

  it('returns validation errors for malformed Quick Capture payloads', async () => {
    const response = await invokePreview({
      body: { lead: { fullName: 'Taylor Morgan', leadSource: 'LINKEDIN' } }
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.errors[0].code).toBe('QUICK_CAPTURE_VALIDATION_FAILED');
    expect(response.body.errors[0].message).toContain('companyName is required');
  });

  it('returns dedupe warnings when strong dedupe fields are missing', async () => {
    const response = await invokePreview({
      body: {
        lead: {
          fullName: 'Taylor Morgan',
          companyName: 'Visible Gap Workspace Test Company',
          leadSource: 'REFERRAL',
          outboundPipelineType: 'RELATIONSHIP_BUILDING',
          notes: 'Referral with enough context for manual capture.'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.dedupePlan).toMatchObject({
      strategy: 'name_company'
    });
    expect(response.body.data.dedupePlan.warnings).toEqual(
      expect.arrayContaining([
        'Email missing; Person dedupe will rely on LinkedIn URL or name plus company.',
        'LinkedIn URL missing; Person dedupe is less precise.',
        'Company domain missing; Company dedupe will rely on company name.'
      ])
    );
  });
});

async function invokePreview({ body, config = baseConfig, dependencies = {} } = {}) {
  const { req, res, next } = createMockExchange({ body, config });

  await handleQuickCapturePreview(req, res, next, {
    config,
    log: silentLogger,
    ...dependencies
  });

  if (res.error) {
    throw res.error;
  }

  return res;
}

async function invokeCommit({
  body,
  headers = {},
  config = baseConfig,
  dependencies = {}
} = {}) {
  const { req, res, next } = createMockExchange({ body, headers, config });
  const auth = requireWorkspaceSecret({ config, log: silentLogger });
  let authenticated = false;

  auth(req, res, () => {
    authenticated = true;
  });

  if (authenticated) {
    await handleQuickCaptureCommit(req, res, next, {
      config,
      log: silentLogger,
      ...dependencies
    });
  }

  if (res.error) {
    throw res.error;
  }

  return res;
}

async function invokeWorkspaceSecret({ headers = {}, config = baseConfig } = {}) {
  const { req, res, next } = createMockExchange({ body: {}, headers, config });
  const auth = requireWorkspaceSecret({ config, log: silentLogger });

  auth(req, res, next);

  if (res.error) {
    throw res.error;
  }

  return res;
}

function createMockExchange({ body = {}, headers = {}, config }) {
  const req = {
    body,
    headers,
    correlationId: 'test-correlation-id',
    log: silentLogger
  };
  const res = {
    statusCode: 200,
    body: undefined,
    error: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  const next = (error) => {
    res.error = error;
  };

  return { req, res, next, config };
}

function fakeQuickCapturePlan() {
  return {
    status: 'planned',
    dryRun: false,
    normalizedLead: {
      ...sampleLead,
      dedupe: {
        strategy: 'email',
        key: `person:email:${sampleLead.email}`
      }
    },
    scores: {
      icpFitScore: 90,
      leadHealthScore: 84
    },
    cadence: {
      cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
      cadenceStage: 'CONNECTION_REQUEST',
      firstTask: {
        title: 'Send assessment-oriented connection request',
        channel: 'LINKEDIN',
        dueAt: '2026-05-31T18:00:00.000Z'
      }
    },
    crmPayloads: {
      company: {
        object: 'company',
        action: 'upsert',
        dedupeKey: 'company:domain:workspace-test.example.com',
        payload: {
          name: sampleLead.companyName
        }
      },
      person: {
        object: 'person',
        action: 'upsert',
        dedupeKey: `person:email:${sampleLead.email}`,
        payload: {
          name: {
            firstName: 'Taylor',
            lastName: 'Morgan'
          },
          emails: {
            primaryEmail: sampleLead.email,
            additionalEmails: []
          },
          outboundPipelineType: 'ASSESSMENT_CAMPAIGN',
          cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
          cadenceStage: 'CONNECTION_REQUEST'
        }
      },
      task: {
        object: 'task',
        action: 'create',
        dedupeKey: `quick-capture:person:email:${sampleLead.email}:task`,
        payload: {
          title: 'Send assessment-oriented connection request'
        }
      }
    },
    outboundEvent: {
      planned: {
        correlationId: `quick-capture:person:email:${sampleLead.email}`,
        status: 'planned'
      },
      persisted: null
    },
    schemaValidation: {
      ok: true,
      warnings: [],
      errors: []
    },
    warnings: []
  };
}

function succeededOperation(object, id, operation) {
  return {
    object,
    action: operation.action === 'upsert' ? 'create' : operation.action,
    status: 'succeeded',
    dedupeKey: operation.dedupeKey,
    payload: operation.payload,
    response: {
      id
    },
    attempts: 1,
    retryCount: 0
  };
}
