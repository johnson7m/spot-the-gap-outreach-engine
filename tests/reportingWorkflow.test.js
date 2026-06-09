import { describe, expect, it } from 'vitest';
import { requireWorkspaceAuth } from '../src/middleware/supabaseWorkspaceAuth.js';
import {
  handleExecutiveReportingFetch,
  handleOperationsReportingFetch,
  handleQueueHealthReportingFetch,
  handleRepPerformanceReportingFetch
} from '../src/routes/api/reportingRoutes.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import { getExecutiveReportingWorkflow } from '../src/workflows/reporting/getExecutiveReportingWorkflow.js';
import { getQueueHealthReportingWorkflow } from '../src/workflows/reporting/getQueueHealthReportingWorkflow.js';
import { getOperationsReportingWorkflow } from '../src/workflows/reporting/getOperationsReportingWorkflow.js';
import { getRepPerformanceReportingWorkflow } from '../src/workflows/reporting/getRepPerformanceReportingWorkflow.js';
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

const repUser = {
  ...adminUser,
  role: 'rep'
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

  it('returns rep performance metrics by owner and activity source', async () => {
    const result = await getRepPerformanceReportingWorkflow({
      query: {
        ownerScope: 'all',
        assigneeScope: 'all',
        startDate: '2026-06-01',
        endDate: '2026-06-09',
        includeDiagnostics: true
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeReportingDataSource({
        tasks: reportingTasksWithActivityDates()
      }),
      activitySource: fakeActivitySource(),
      now: new Date('2026-06-09T15:00:00.000Z')
    });
    const rep = result.metrics.reps.find((candidate) => candidate.ownerEmail === 'rep@visiblegap.com');
    const missing = result.metrics.reps.find((candidate) => candidate.repKey === 'missing_owner');

    expect(result).toMatchObject({
      reportName: 'rep-performance',
      status: 'ok',
      dateRange: {
        startDate: '2026-06-01T00:00:00.000Z'
      }
    });
    expect(new Date(result.dateRange.endDate).toISOString().startsWith('2026-06-09')).toBe(
      true
    );
    expect(rep.metrics).toMatchObject({
      leadsOwned: 5,
      activeLeadCount: 4,
      freshLeadCount: 1,
      followUpCount: 1,
      pipelineReviewCount: 0,
      openTasksAssigned: 3,
      overdueTasksAssigned: 2,
      tasksCreated: 2,
      tasksCompleted: 2,
      touchesSent: 2,
      responses: 1,
      noResponses: 0,
      discoveryRequests: 1,
      assessmentRequests: 1,
      assessmentCompletions: 1
    });
    expect(missing.metrics).toMatchObject({
      leadsOwned: 1,
      activeLeadCount: 1,
      pipelineReviewCount: 1
    });
    expect(result.metrics.totals.leadsOwned).toBe(6);
    expect(result.diagnostics.sourceCounts).toMatchObject({
      outboundEvents: 5,
      crmSyncLogs: 2,
      assessmentSubmissions: 2
    });
  });

  it('filters rep activity by date range', async () => {
    const result = await getRepPerformanceReportingWorkflow({
      query: {
        ownerScope: 'all',
        assigneeScope: 'all',
        startDate: '2026-06-07',
        endDate: '2026-06-09'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeReportingDataSource({
        tasks: reportingTasksWithActivityDates()
      }),
      activitySource: fakeActivitySource(),
      now: new Date('2026-06-09T15:00:00.000Z')
    });
    const rep = result.metrics.reps.find((candidate) => candidate.ownerEmail === 'rep@visiblegap.com');

    expect(rep.metrics.tasksCreated).toBe(1);
    expect(rep.metrics.tasksCompleted).toBe(1);
    expect(rep.metrics.discoveryRequests).toBe(1);
    expect(rep.metrics.assessmentRequests).toBe(0);
    expect(rep.metrics.assessmentCompletions).toBe(1);
  });

  it('resolves task assignee workspace member IDs to rep email buckets', async () => {
    const result = await getRepPerformanceReportingWorkflow({
      query: {
        ownerScope: 'all',
        assigneeScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeReportingDataSource({
        people: [],
        tasks: [
          reportingTask('tasks-member-assigned', {
            assigneeId: 'workspace-member-rep',
            assignee: null
          })
        ],
        taskTargets: [],
        workspaceMembers: [
          {
            id: 'workspace-member-rep',
            userEmail: 'rep@visiblegap.com',
            name: {
              firstName: 'Visible Gap',
              lastName: 'Rep'
            }
          }
        ]
      }),
      activitySource: fakeActivitySource({
        outboundEvents: [],
        crmSyncLogs: [],
        assessmentSubmissions: []
      }),
      now: new Date('2026-06-09T15:00:00.000Z')
    });

    const rep = result.metrics.reps.find((candidate) => candidate.ownerEmail === 'rep@visiblegap.com');

    expect(rep).toBeTruthy();
    expect(rep.metrics.openTasksAssigned).toBe(1);
  });

  it('scopes rep performance to mine while preserving the missing-owner bucket', async () => {
    const result = await getRepPerformanceReportingWorkflow({
      query: {
        ownerScope: 'all',
        assigneeScope: 'all',
        startDate: '2026-06-01',
        endDate: '2026-06-09'
      },
      config: baseConfig,
      workspaceUser: repUser,
      dataSource: fakeReportingDataSource({
        people: [
          ...reportingPeople(),
          reportingLead('people-other-owner', {
            owner: {
              userEmail: 'other@visiblegap.com',
              name: 'Other Rep'
            }
          })
        ],
        tasks: [
          ...reportingTasksWithActivityDates(),
          reportingTask('tasks-other-owner', {
            assignee: {
              userEmail: 'other@visiblegap.com'
            }
          })
        ]
      }),
      activitySource: fakeActivitySource(),
      now: new Date('2026-06-09T15:00:00.000Z')
    });

    expect(result.ownerScope).toBe('mine');
    expect(result.metrics.reps.map((rep) => rep.repKey)).toEqual(
      expect.arrayContaining(['rep@visiblegap.com', 'missing_owner'])
    );
    expect(result.metrics.reps.map((rep) => rep.repKey)).not.toContain('other@visiblegap.com');
  });

  it('returns the reporting API envelope for rep performance', async () => {
    const response = await invokeReportingRoute({
      type: 'rep-performance',
      headers: {
        authorization: 'Bearer valid-token'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      correlationId: 'reporting-route-correlation',
      data: {
        reportName: 'rep-performance',
        metrics: {
          totals: expect.any(Object),
          reps: expect.any(Array)
        }
      },
      errors: []
    });
  });

  it('returns operations reporting metrics from Supabase activity logs', async () => {
    const result = await getOperationsReportingWorkflow({
      query: {
        startDate: '2026-06-01',
        endDate: '2026-06-09',
        includeDiagnostics: true
      },
      config: baseConfig,
      workspaceUser: adminUser,
      activitySource: fakeActivitySource({
        outboundEvents: operationsOutboundEvents(),
        crmSyncLogs: operationsCrmSyncLogs(),
        assessmentSubmissions: operationsAssessmentSubmissions()
      }),
      now: new Date('2026-06-09T15:00:00.000Z')
    });

    expect(result).toMatchObject({
      reportName: 'operations',
      status: 'ok',
      metrics: {
        totalOutboundEvents: 9,
        totalCrmSyncLogs: 6,
        successfulSyncs: 2,
        failedSyncs: 2,
        partialSuccessSyncs: 1,
        recoveryEvents: 2,
        duplicatePreventionEvents: 2,
        manualReviewEvents: 1,
        queueClassificationEvents: 1,
        taskCreationEvents: 4,
        taskCompletionEvents: 1,
        quickCaptureCommitEvents: 1,
        assessmentWebhookEvents: 2
      }
    });
    expect(result.breakdowns.byEventType).toMatchObject({
      task_completed: 1,
      missing_next_task_created: 2,
      sent_initial_follow_up_created: 2,
      quick_capture_planned: 1
    });
    expect(result.breakdowns.byStatus.crmSyncLogs).toMatchObject({
      succeeded: 2,
      failed: 2,
      partial_success: 1
    });
    expect(result.breakdowns.bySourceWorkflow.map((row) => row.workflow)).toEqual(
      expect.arrayContaining(['quick_capture', 'recovery', 'assessment_webhook'])
    );
    expect(result.breakdowns.byDay.find((row) => row.date === '2026-06-04')).toMatchObject({
      totalCrmSyncLogs: 2,
      failedSyncs: 1,
      taskCreationEvents: 2
    });
    expect(result.recentFailures).toHaveLength(4);
    expect(result.diagnostics.sourceCounts).toMatchObject({
      outboundEvents: 10,
      crmSyncLogs: 7,
      assessmentSubmissions: 3
    });
  });

  it('filters operations reporting by date range', async () => {
    const result = await getOperationsReportingWorkflow({
      query: {
        startDate: '2026-06-07',
        endDate: '2026-06-09'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      activitySource: fakeActivitySource({
        outboundEvents: operationsOutboundEvents(),
        crmSyncLogs: operationsCrmSyncLogs(),
        assessmentSubmissions: operationsAssessmentSubmissions()
      }),
      now: new Date('2026-06-09T15:00:00.000Z')
    });

    expect(result.metrics.totalOutboundEvents).toBe(3);
    expect(result.metrics.totalCrmSyncLogs).toBe(3);
    expect(result.metrics.assessmentWebhookEvents).toBe(1);
    expect(result.metrics.failedSyncs).toBe(1);
    expect(result.metrics.recoveryEvents).toBe(2);
  });

  it('sanitizes operations failure details', async () => {
    const result = await getOperationsReportingWorkflow({
      query: {
        startDate: '2026-06-01',
        endDate: '2026-06-09'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      activitySource: fakeActivitySource({
        outboundEvents: operationsOutboundEvents(),
        crmSyncLogs: operationsCrmSyncLogs(),
        assessmentSubmissions: []
      }),
      now: new Date('2026-06-09T15:00:00.000Z')
    });
    const serializedFailures = JSON.stringify(result.recentFailures);

    expect(serializedFailures).not.toContain('super-secret-token');
    expect(serializedFailures).not.toContain('sk-live-secret');
    expect(serializedFailures).toContain('[REDACTED]');
    expect(result.recentFailures[0]).not.toHaveProperty('request_payload');
  });

  it('returns the reporting API envelope for operations', async () => {
    const response = await invokeReportingRoute({
      type: 'operations',
      headers: {
        authorization: 'Bearer valid-token'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      correlationId: 'reporting-route-correlation',
      data: {
        reportName: 'operations',
        metrics: expect.any(Object),
        breakdowns: expect.any(Object),
        recentFailures: expect.any(Array)
      },
      errors: []
    });
  });

  it('uses read-only reporting sources without write methods', async () => {
    const readOnlySource = fakeReportingDataSource();
    const readOnlyActivity = fakeActivitySource();
    let sourceReadCount = 0;
    let activityReadCount = 0;
    const wrappedSource = {
      provider: readOnlySource.provider,
      async listAllQueueRecords(input) {
        sourceReadCount += 1;
        return readOnlySource.listAllQueueRecords(input);
      },
      async appendOutboundEvent() {
        throw new Error('Reporting must not write outbound events.');
      }
    };
    const wrappedActivity = {
      async listReportingActivityRecords(input) {
        activityReadCount += 1;
        return readOnlyActivity.listReportingActivityRecords(input);
      },
      async appendCrmSyncLog() {
        throw new Error('Reporting must not write CRM sync logs.');
      }
    };

    await getRepPerformanceReportingWorkflow({
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: wrappedSource,
      activitySource: wrappedActivity,
      now: new Date('2026-06-09T15:00:00.000Z')
    });

    expect(sourceReadCount).toBe(1);
    expect(activityReadCount).toBe(1);

    await getOperationsReportingWorkflow({
      query: {},
      config: baseConfig,
      workspaceUser: adminUser,
      activitySource: wrappedActivity,
      now: new Date('2026-06-09T15:00:00.000Z')
    });

    expect(activityReadCount).toBe(2);
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

  if (authenticated && type === 'rep-performance') {
    await handleRepPerformanceReportingFetch(req, res, next, {
      config,
      log: silentLog,
      dataSource: fakeReportingDataSource(),
      activitySource: fakeActivitySource()
    });
  }

  if (authenticated && type === 'operations') {
    await handleOperationsReportingFetch(req, res, next, {
      config,
      log: silentLog,
      activitySource: fakeActivitySource({
        outboundEvents: operationsOutboundEvents(),
        crmSyncLogs: operationsCrmSyncLogs(),
        assessmentSubmissions: operationsAssessmentSubmissions()
      })
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
        workspaceMembers: overrides.workspaceMembers ?? [],
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

function fakeActivitySource(overrides = {}) {
  return {
    async listReportingActivityRecords() {
      return {
        outboundEvents: overrides.outboundEvents ?? reportingOutboundEvents(),
        crmSyncLogs: overrides.crmSyncLogs ?? reportingCrmSyncLogs(),
        assessmentSubmissions: overrides.assessmentSubmissions ?? reportingAssessmentSubmissions(),
        warnings: overrides.warnings ?? []
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

function reportingTasksWithActivityDates() {
  return [
    reportingTask('tasks-fresh', {
      title: 'Send relationship-oriented connection request',
      dueAt: '2026-06-01',
      createdAt: '2026-06-02T10:00:00.000Z',
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
      createdAt: '2026-05-20T10:00:00.000Z',
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
      createdAt: '2026-06-08T10:00:00.000Z',
      bodyV2: {
        markdown: 'No Person ID marker.'
      }
    })
  ];
}

function reportingOutboundEvents() {
  return [
    {
      id: 'event-task-completed-response',
      event_type: 'task_completed',
      status: 'sent',
      created_at: '2026-06-02T12:00:00.000Z',
      payload: {
        workspaceUser: {
          email: 'rep@visiblegap.com',
          fullName: 'Visible Gap Rep'
        },
        completion: {
          touchStatus: 'RESPONDED'
        }
      }
    },
    {
      id: 'event-task-completed-no-response',
      event_type: 'task_completed',
      created_at: '2026-05-20T12:00:00.000Z',
      payload: {
        workspaceUser: {
          email: 'rep@visiblegap.com',
          fullName: 'Visible Gap Rep'
        },
        completion: {
          touchStatus: 'NO_RESPONSE'
        }
      }
    },
    {
      id: 'event-discovery',
      event_type: 'task_completed',
      created_at: '2026-06-08T12:00:00.000Z',
      payload: {
        workspaceUser: {
          email: 'rep@visiblegap.com',
          fullName: 'Visible Gap Rep'
        },
        nextCadenceStage: 'DISCOVERY_ASK'
      }
    },
    {
      id: 'event-assessment-request',
      event_type: 'assessment_requested',
      created_at: '2026-06-03T12:00:00.000Z',
      payload: {
        workspaceUser: {
          email: 'rep@visiblegap.com',
          fullName: 'Visible Gap Rep'
        }
      }
    },
    {
      id: 'event-old-task-created',
      event_type: 'missing_next_task_created',
      created_at: '2026-05-01T12:00:00.000Z',
      payload: {
        workspaceUser: {
          email: 'rep@visiblegap.com',
          fullName: 'Visible Gap Rep'
        }
      }
    }
  ];
}

function reportingCrmSyncLogs() {
  return [
    {
      id: 'log-task-created',
      object_name: 'task',
      action: 'create',
      status: 'succeeded',
      created_at: '2026-06-04T12:00:00.000Z',
      request_payload: {
        workspaceUser: {
          email: 'rep@visiblegap.com',
          fullName: 'Visible Gap Rep'
        }
      }
    },
    {
      id: 'log-old-task-created',
      object_name: 'task',
      action: 'create',
      status: 'succeeded',
      created_at: '2026-05-01T12:00:00.000Z',
      request_payload: {
        workspaceUser: {
          email: 'rep@visiblegap.com',
          fullName: 'Visible Gap Rep'
        }
      }
    }
  ];
}

function reportingAssessmentSubmissions() {
  return [
    {
      id: 'assessment-submission-current',
      created_at: '2026-06-08T14:00:00.000Z',
      normalized_payload: {
        workspaceUser: {
          email: 'rep@visiblegap.com',
          fullName: 'Visible Gap Rep'
        }
      }
    },
    {
      id: 'assessment-submission-old',
      created_at: '2026-05-01T14:00:00.000Z',
      normalized_payload: {
        workspaceUser: {
          email: 'rep@visiblegap.com',
          fullName: 'Visible Gap Rep'
        }
      }
    }
  ];
}

function operationsOutboundEvents() {
  return [
    {
      id: 'ops-event-task-completed',
      event_type: 'task_completed',
      status: 'sent',
      created_at: '2026-06-02T12:00:00.000Z',
      payload: {
        completion: {
          touchStatus: 'RESPONDED'
        }
      }
    },
    {
      id: 'ops-event-missing-task',
      event_type: 'missing_next_task_created',
      status: 'planned',
      created_at: '2026-06-04T12:00:00.000Z',
      payload: {
        workflow: 'missing_next_task_apply'
      }
    },
    {
      id: 'ops-event-sent-follow-up',
      event_type: 'sent_initial_follow_up_created',
      status: 'planned',
      created_at: '2026-06-05T12:00:00.000Z',
      payload: {
        workflow: 'sent_initial_follow_up_apply'
      }
    },
    {
      id: 'ops-event-quick-capture',
      event_type: 'quick_capture_planned',
      status: 'planned',
      created_at: '2026-06-06T12:00:00.000Z',
      payload: {
        workflow: 'quick_capture'
      }
    },
    {
      id: 'ops-event-recovery',
      event_type: 'missing_next_task_recovery',
      status: 'planned',
      created_at: '2026-06-08T12:00:00.000Z',
      payload: {
        workflow: 'recovery'
      }
    },
    {
      id: 'ops-event-duplicate',
      event_type: 'missing_next_task_created',
      status: 'planned',
      created_at: '2026-06-09T12:00:00.000Z',
      payload: {
        duplicateTaskSkipped: true
      }
    },
    {
      id: 'ops-event-manual-review',
      event_type: 'manual_review_required',
      status: 'planned',
      created_at: '2026-06-03T12:00:00.000Z',
      payload: {
        reason: 'requires_review'
      }
    },
    {
      id: 'ops-event-queue-classification',
      event_type: 'queue_classification_audit',
      status: 'planned',
      created_at: '2026-06-03T13:00:00.000Z',
      payload: {
        workflow: 'queue_classification'
      }
    },
    {
      id: 'ops-event-failed',
      event_type: 'sent_initial_follow_up_created',
      status: 'failed',
      created_at: '2026-06-09T13:00:00.000Z',
      error_payload: {
        message: 'Request failed with Bearer super-secret-token',
        apiKey: 'sk-live-secret',
        httpStatus: 429
      }
    },
    {
      id: 'ops-event-old',
      event_type: 'task_completed',
      status: 'sent',
      created_at: '2026-05-01T12:00:00.000Z'
    }
  ];
}

function operationsCrmSyncLogs() {
  return [
    {
      id: 'ops-log-success-task',
      object_name: 'task',
      action: 'create',
      status: 'succeeded',
      created_at: '2026-06-04T12:30:00.000Z',
      request_payload: {
        workflow: 'missing_next_task_apply'
      }
    },
    {
      id: 'ops-log-success-person',
      object_name: 'person',
      action: 'update',
      status: 'succeeded',
      created_at: '2026-06-07T12:00:00.000Z'
    },
    {
      id: 'ops-log-failed-company',
      object_name: 'company',
      action: 'update',
      status: 'failed',
      created_at: '2026-06-04T13:00:00.000Z',
      error_payload: {
        message: 'Company update failed',
        authorization: 'Bearer super-secret-token'
      }
    },
    {
      id: 'ops-log-partial',
      object_name: 'person',
      action: 'upsert',
      status: 'partial_success',
      created_at: '2026-06-08T13:00:00.000Z',
      response_payload: {
        status: 'partial_success'
      }
    },
    {
      id: 'ops-log-duplicate-skip',
      object_name: 'task',
      action: 'create',
      status: 'skipped',
      dedupe_key: 'task:duplicate',
      created_at: '2026-06-05T13:00:00.000Z',
      response_payload: {
        duplicateTaskSkipped: true
      }
    },
    {
      id: 'ops-log-recovery-failed',
      object_name: 'task',
      action: 'recovery_retry',
      status: 'failed',
      created_at: '2026-06-09T14:00:00.000Z',
      error_payload: {
        message: 'Recovery failed'
      }
    },
    {
      id: 'ops-log-old',
      object_name: 'task',
      action: 'create',
      status: 'succeeded',
      created_at: '2026-05-01T13:00:00.000Z'
    }
  ];
}

function operationsAssessmentSubmissions() {
  return [
    {
      id: 'ops-assessment-synced',
      sync_status: 'synced',
      created_at: '2026-06-02T14:00:00.000Z'
    },
    {
      id: 'ops-assessment-failed',
      sync_status: 'failed',
      created_at: '2026-06-08T14:00:00.000Z',
      error_payload: {
        message: 'Webhook sync failed'
      }
    },
    {
      id: 'ops-assessment-old',
      sync_status: 'synced',
      created_at: '2026-05-01T14:00:00.000Z'
    }
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
