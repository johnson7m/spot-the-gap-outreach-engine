import { describe, expect, it } from 'vitest';
import { requireWorkspaceAuth } from '../src/middleware/supabaseWorkspaceAuth.js';
import {
  handleExecutiveReportingFetch,
  handleQueueHealthReportingFetch
} from '../src/routes/api/reportingRoutes.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import { getExecutiveReportingWorkflow } from '../src/workflows/reporting/getExecutiveReportingWorkflow.js';
import { getQueueHealthReportingWorkflow } from '../src/workflows/reporting/getQueueHealthReportingWorkflow.js';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };

const baseConfig = {
  env: 'test',
  crmProvider: 'twenty',
  workflowMaxAttempts: 3,
  supabase: {
    enabled: false,
    jwtVerificationEnabled: true,
    authRequiredForWorkspaceApi: true
  },
  workspace: {
    apiSecret: 'workspace-secret'
  },
  twenty: {
    syncEnabled: false,
    apiBaseUrl: 'https://api.twenty.com',
    apiKey: 'test-key'
  },
  quickCapture: {
    syncEnabled: false,
    apiPreviewEnabled: true,
    apiCommitEnabled: false,
    maxRetries: 0,
    retryBaseMs: 1
  }
};

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

const adminUser = {
  authenticated: true,
  userId: 'workspace-user-1',
  email: 'rep@visiblegap.com',
  fullName: 'Visible Gap Rep',
  role: 'admin',
  roleSource: 'profile',
  profileId: 'profile-1'
};

describe('reporting workflows', () => {
  it('returns Phase 1 executive reporting metrics from read-only queue data', async () => {
    const result = await getExecutiveReportingWorkflow({
      query: {
        ownerScope: 'all',
        assigneeScope: 'all',
        includeDiagnostics: true
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeReportingDataSource(),
      now: new Date('2026-06-09T15:00:00.000Z')
    });

    expect(result).toMatchObject({
      reportName: 'executive',
      status: 'ok',
      dataSource: 'fake-twenty',
      metrics: {
        totalPeople: 7,
        hiddenTestRecords: 1,
        expectedRealPeople: 6,
        activeLeads: 5,
        freshLeads: 1,
        followUps: 1,
        warmAssessments: 1,
        pipelineReview: 1,
        staleRecovery: 1,
        activeClients: 1,
        unclassifiedPeople: 0,
        totalOpenTasks: 3,
        overdueTasks: 2
      }
    });
    expect(result.diagnostics.countsByDisposition).toMatchObject({
      fresh_lead: 1,
      follow_up: 1,
      warm_assessment: 1,
      stale_recovery: 1,
      pipeline_review: 1,
      active_client: 1,
      hidden_test_record: 1
    });
  });

  it('returns Phase 1 queue health metrics from coverage reasons and queue counts', async () => {
    const result = await getQueueHealthReportingWorkflow({
      query: {
        ownerScope: 'all',
        assigneeScope: 'all',
        includeDiagnostics: true
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeReportingDataSource(),
      now: new Date('2026-06-09T15:00:00.000Z')
    });

    expect(result).toMatchObject({
      reportName: 'queue-health',
      metrics: {
        queueCounts: {
          freshLeads: 1,
          followUps: 1,
          warmAssessments: 1,
          staleRecovery: 1,
          pipelineReview: 1,
          unassignedTasks: 1
        },
        overdueCountsByQueue: {
          freshLeads: 1,
          followUps: 1,
          warmAssessments: 0,
          staleRecovery: 0,
          pipelineReview: 0,
          unassignedTasks: 0
        },
        ownerMissing: 1,
        emailMissing: 1,
        companyMissing: 1,
        linkedinMissing: 1,
        enrichmentPartial: 1,
        missingNextTask: 1,
        unresolvedReviewItems: 1,
        unassignedTasks: 1,
        hiddenTestRecords: 1
      }
    });
  });

  it('returns the reporting API envelope for executive and queue-health routes', async () => {
    const executiveResponse = await invokeReportingRoute({
      type: 'executive',
      headers: {
        authorization: 'Bearer valid-token'
      }
    });
    const queueHealthResponse = await invokeReportingRoute({
      type: 'queue-health',
      headers: {
        authorization: 'Bearer valid-token'
      }
    });

    expect(executiveResponse.statusCode).toBe(200);
    expect(executiveResponse.body).toMatchObject({
      ok: true,
      correlationId: 'reporting-route-correlation',
      data: {
        reportName: 'executive',
        metrics: expect.any(Object)
      },
      errors: []
    });
    expect(queueHealthResponse.statusCode).toBe(200);
    expect(queueHealthResponse.body).toMatchObject({
      ok: true,
      correlationId: 'reporting-route-correlation',
      data: {
        reportName: 'queue-health',
        metrics: expect.any(Object)
      },
      errors: []
    });
  });

  it('reports degraded status instead of empty metrics when critical reporting reads fail', async () => {
    const result = await getExecutiveReportingWorkflow({
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: degradedReportingDataSource(),
      now: new Date('2026-06-09T15:00:00.000Z')
    });

    expect(result).toMatchObject({
      reportName: 'executive',
      status: 'degraded_rate_limited',
      isPartial: true,
      partialReason: 'twenty_rate_limited',
      retryAfterSeconds: 60,
      metrics: null
    });
  });

  it('does not affect assessment webhook processing', async () => {
    const result = await processAssessmentSubmission({
      body: sampleAssessment,
      headers: {
        'x-visible-gap-secret': 'test-secret'
      },
      config: {
        ...baseConfig,
        webhookSharedSecret: 'test-secret',
        twenty: {
          ...baseConfig.twenty,
          syncEnabled: false
        }
      },
      log: silentLog
    });

    expect(result.status).toBe('dry_run');
    expect(result.crmSync.status).toBe('dry_run');
  });
});

async function invokeReportingRoute({
  type,
  headers = {},
  query = {},
  config = baseConfig,
  supabaseClient = createFakeWorkspaceSupabaseClient({ profile: workspaceProfile() })
} = {}) {
  const { req, res, next } = createMockExchange({
    headers,
    query
  });
  const auth = requireWorkspaceAuth({
    config,
    log: silentLog,
    allowedRoles: ['admin', 'operator', 'rep'],
    supabaseClient
  });
  let authenticated = false;

  await auth(req, res, () => {
    authenticated = true;
  });

  if (authenticated && type === 'executive') {
    await handleExecutiveReportingFetch(req, res, next, {
      config,
      log: silentLog,
      dataSource: fakeReportingDataSource()
    });
  }

  if (authenticated && type === 'queue-health') {
    await handleQueueHealthReportingFetch(req, res, next, {
      config,
      log: silentLog,
      dataSource: fakeReportingDataSource()
    });
  }

  if (res.error) {
    throw res.error;
  }

  return res;
}

function fakeReportingDataSource(overrides = {}) {
  return {
    provider: 'fake-twenty',
    async listAllQueueRecords() {
      return {
        people: overrides.people ?? reportingPeople(),
        companies: overrides.companies ?? [],
        tasks: overrides.tasks ?? reportingTasks(),
        taskTargets: overrides.taskTargets ?? reportingTaskTargets(),
        noteTargets: [],
        timelineActivities: [],
        workspaceMembers: [],
        warnings: [],
        readStatus: {
          status: 'ok',
          isPartial: false
        }
      };
    }
  };
}

function degradedReportingDataSource() {
  return {
    provider: 'fake-twenty',
    async listAllQueueRecords() {
      return {
        people: [],
        companies: [],
        tasks: [],
        taskTargets: [],
        noteTargets: [],
        timelineActivities: [],
        workspaceMembers: [],
        warnings: ['Twenty full queue read skipped people: Request failed with status code 429'],
        readStatus: {
          status: 'degraded_rate_limited',
          isPartial: true,
          partialReason: 'twenty_rate_limited',
          retryAfterSeconds: 60,
          criticalFailures: ['people'],
          nonCriticalFailures: []
        }
      };
    }
  };
}

function reportingPeople() {
  return [
    reportingLead('people-fresh', {
      cadenceStage: 'CONNECTION_REQUEST',
      latestTouchStatus: 'DRAFTED'
    }),
    reportingLead('people-follow', {
      cadenceStage: 'INTRO_MESSAGE',
      latestTouchStatus: 'SENT'
    }),
    reportingLead('people-warm', {
      assessmentCompleted: true,
      leadstageAuto: 'ASSESSMENT_COMPLETED',
      discoveryReadiness: 'READY'
    }),
    reportingLead('people-stale', {
      cadenceStage: 'VALUE_TOUCH',
      latestTouchStatus: 'NO_RESPONSE',
      staleRisk: 'HIGH'
    }),
    reportingLead('people-review', {
      email: null,
      company: null,
      linkedinLink: null,
      cadenceStage: 'INTRO_MESSAGE',
      latestTouchStatus: 'RESPONDED',
      enrichmentStatus: 'PARTIAL',
      owner: null
    }),
    reportingLead('people-active-client', {
      leadStage: 'ACTIVE_CLIENT',
      cadenceStage: 'ACTIVE_CLIENT',
      latestTouchStatus: 'COMPLETED'
    }),
    reportingLead('people-test', {
      name: {
        firstName: 'Webhook',
        lastName: 'Test'
      },
      emails: {
        primaryEmail: 'webhook-test@example.com'
      }
    })
  ];
}

function reportingLead(id, overrides = {}) {
  const email = overrides.email === null ? null : `${id}@visiblegap.test`;

  return {
    id,
    name: {
      firstName: 'Visible',
      lastName: id.replace(/^people-/, '')
    },
    jobTitle: 'Operations Leader',
    company: {
      name: `${id} Company`
    },
    emails: email
      ? {
          primaryEmail: email
        }
      : undefined,
    linkedinLink: {
      primaryLinkUrl: `https://www.linkedin.com/in/${id}`
    },
    outboundPipelineType: 'RELATIONSHIP_BUILDING',
    cadenceName: 'RELATIONSHIP_BUILDING_V1',
    cadenceStage: 'CONNECTION_REQUEST',
    latestTouchStatus: 'DRAFTED',
    latestTouchChannel: 'LINKEDIN',
    owner: {
      userEmail: 'rep@visiblegap.com',
      name: 'Visible Gap Rep'
    },
    ...overrides
  };
}

function reportingTasks() {
  return [
    reportingTask('tasks-fresh', {
      title: 'Send relationship-oriented connection request',
      dueAt: '2026-06-01',
      bodyV2: {
        markdown: [
          'Person ID: people-fresh',
          'Cadence: RELATIONSHIP_BUILDING_V1',
          'Cadence stage: CONNECTION_REQUEST',
          'Task type: connection_request'
        ].join('\n')
      }
    }),
    reportingTask('tasks-follow', {
      title: 'Send contextual introduction',
      dueAt: '2026-06-01',
      bodyV2: {
        markdown: [
          'Person ID: people-follow',
          'Cadence: RELATIONSHIP_BUILDING_V1',
          'Next cadence stage: INTRO_MESSAGE',
          'Latest touch status: SENT'
        ].join('\n')
      }
    }),
    reportingTask('tasks-unassigned', {
      title: 'Review orphaned CRM task',
      dueAt: '2026-06-12',
      bodyV2: {
        markdown: 'No Person ID marker.'
      }
    })
  ];
}

function reportingTask(id, overrides = {}) {
  return {
    id,
    title: 'Follow up',
    status: 'TODO',
    dueAt: '2026-06-09',
    assignee: {
      userEmail: 'rep@visiblegap.com'
    },
    ...overrides
  };
}

function reportingTaskTargets() {
  return [
    {
      id: 'target-fresh',
      taskId: 'tasks-fresh',
      targetPersonId: 'people-fresh'
    },
    {
      id: 'target-follow',
      taskId: 'tasks-follow',
      targetPersonId: 'people-follow'
    }
  ];
}

function createMockExchange({ headers = {}, query = {} } = {}) {
  const req = {
    body: {},
    headers,
    params: {},
    query,
    correlationId: 'reporting-route-correlation',
    log: silentLog
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
    if (error) {
      res.error = error;
    }
  };

  return { req, res, next };
}

function createFakeWorkspaceSupabaseClient({ profile } = {}) {
  return {
    auth: {
      async getUser(token) {
        if (token !== 'valid-token') {
          return {
            data: {
              user: null
            },
            error: {
              message: 'invalid token'
            }
          };
        }

        return {
          data: {
            user: {
              id: profile.user_id,
              email: profile.email
            }
          },
          error: null
        };
      }
    },
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return {
            data: profile,
            error: null
          };
        }
      };
    }
  };
}

function workspaceProfile(overrides = {}) {
  return {
    id: 'profile-1',
    user_id: 'workspace-user-1',
    email: 'rep@visiblegap.com',
    full_name: 'Visible Gap Rep',
    role: 'admin',
    is_active: true,
    ...overrides
  };
}
