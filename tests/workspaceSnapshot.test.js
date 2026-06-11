import { describe, expect, it, beforeEach } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { handleTaskComplete } from '../src/routes/api/taskRoutes.js';
import {
  clearWorkspaceSnapshotCache,
  getWorkspaceSnapshot,
  getWorkspaceSnapshotStatus
} from '../src/services/workspaceSnapshotService.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import { getOutboundQueueSummaryWorkflow } from '../src/workflows/outbound/getQueueWorkflow.js';
import { getExecutiveReportingWorkflow } from '../src/workflows/reporting/getExecutiveReportingWorkflow.js';

const snapshotConfig = {
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
  workspaceSnapshot: {
    enabled: true,
    ttlSeconds: 120
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

const adminUser = {
  authenticated: true,
  userId: 'workspace-user-1',
  email: 'rep@visiblegap.com',
  fullName: 'Visible Gap Rep',
  role: 'admin',
  roleSource: 'profile',
  profileId: 'profile-1'
};

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('workspace snapshot service', () => {
  beforeEach(() => {
    clearWorkspaceSnapshotCache();
  });

  it('serves valid snapshot cache hits without repeating source reads', async () => {
    const dataSource = countingSnapshotDataSource();

    const first = await getWorkspaceSnapshot({
      config: snapshotConfig,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:00:00.000Z')
    });
    const second = await getWorkspaceSnapshot({
      config: snapshotConfig,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:01:00.000Z')
    });

    expect(dataSource.readCount()).toBe(1);
    expect(first.metadata.cacheStatus).toBe('miss');
    expect(second.metadata.cacheStatus).toBe('hit');
    expect(second.metadata.countsByObjectType).toMatchObject({
      people: 2,
      tasks: 2,
      taskTargets: 1
    });
  });

  it('rebuilds when forceRefresh is requested', async () => {
    const dataSource = countingSnapshotDataSource();

    await getWorkspaceSnapshot({
      config: snapshotConfig,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:00:00.000Z')
    });
    const refreshed = await getWorkspaceSnapshot({
      forceRefresh: true,
      config: snapshotConfig,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:00:30.000Z')
    });

    expect(dataSource.readCount()).toBe(2);
    expect(refreshed.metadata.cacheStatus).toBe('refresh');
    expect(refreshed.metadata.forceRefresh).toBe(true);
  });

  it('rebuilds after the configured TTL expires', async () => {
    const dataSource = countingSnapshotDataSource();
    const config = {
      ...snapshotConfig,
      workspaceSnapshot: {
        enabled: true,
        ttlSeconds: 1
      }
    };

    await getWorkspaceSnapshot({
      config,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:00:00.000Z')
    });
    const rebuilt = await getWorkspaceSnapshot({
      config,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:00:02.000Z')
    });

    expect(dataSource.readCount()).toBe(2);
    expect(rebuilt.metadata.cacheStatus).toBe('miss');
  });

  it('marks the snapshot stale after a successful workspace write path', async () => {
    const dataSource = countingSnapshotDataSource();

    await getWorkspaceSnapshot({
      config: snapshotConfig,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:00:00.000Z')
    });
    await invokeTaskCompleteRoute();

    const status = getWorkspaceSnapshotStatus({ config: snapshotConfig });

    expect(status.metadata.cacheStatus).toBe('stale');
    expect(status.metadata.invalidated).toBe(true);
    expect(status.metadata.invalidationReason).toBe('task_completion');
  });

  it('lets queue summary reuse the shared snapshot', async () => {
    const dataSource = countingSnapshotDataSource();

    const first = await getOutboundQueueSummaryWorkflow({
      query: {
        ownerScope: 'all'
      },
      config: snapshotConfig,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:00:00.000Z')
    });
    const second = await getOutboundQueueSummaryWorkflow({
      query: {
        ownerScope: 'all'
      },
      config: snapshotConfig,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:00:30.000Z')
    });

    expect(dataSource.readCount()).toBe(1);
    expect(first.snapshot.cacheStatus).toBe('miss');
    expect(second.snapshot.cacheStatus).toBe('hit');
    expect(second.counts).toMatchObject({
      freshLeads: 1,
      followUps: 1
    });
  });

  it('lets executive reporting reuse the shared snapshot', async () => {
    const dataSource = countingSnapshotDataSource();

    const first = await getExecutiveReportingWorkflow({
      query: {
        ownerScope: 'all'
      },
      config: snapshotConfig,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:00:00.000Z')
    });
    const second = await getExecutiveReportingWorkflow({
      query: {
        ownerScope: 'all'
      },
      config: snapshotConfig,
      dataSource,
      workspaceUser: adminUser,
      now: new Date('2026-06-11T12:00:30.000Z')
    });

    expect(dataSource.readCount()).toBe(1);
    expect(first.snapshot.cacheStatus).toBe('miss');
    expect(second.snapshot.cacheStatus).toBe('hit');
    expect(second.metrics).toMatchObject({
      totalPeople: 2,
      expectedRealPeople: 2
    });
  });

  it('does not affect assessment webhook processing', async () => {
    const result = await processAssessmentSubmission({
      body: sampleAssessment,
      headers: {
        'x-visible-gap-secret': 'test-secret'
      },
      config: {
        ...snapshotConfig,
        webhookSharedSecret: 'test-secret',
        twenty: {
          ...snapshotConfig.twenty,
          syncEnabled: false
        }
      },
      log: silentLog
    });

    expect(result.status).toBe('dry_run');
    expect(result.crmSync.status).toBe('dry_run');
  });
});

function countingSnapshotDataSource() {
  let reads = 0;

  return {
    provider: 'snapshot-test-source',
    readCount() {
      return reads;
    },
    async listAllQueueRecords() {
      reads += 1;

      return {
        people: snapshotPeople(),
        companies: [],
        tasks: snapshotTasks(),
        taskTargets: snapshotTaskTargets(),
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

function snapshotPeople() {
  return [
    snapshotPerson('people-fresh', {
      cadenceStage: 'CONNECTION_REQUEST',
      latestTouchStatus: 'DRAFTED'
    }),
    snapshotPerson('people-follow', {
      cadenceStage: 'INTRO_MESSAGE',
      latestTouchStatus: 'SENT'
    })
  ];
}

function snapshotPerson(id, overrides = {}) {
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
    emails: {
      primaryEmail: `${id}@visiblegap.test`
    },
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

function snapshotTasks() {
  return [
    snapshotTask('tasks-fresh', {
      title: 'Send relationship-oriented connection request',
      bodyV2: {
        markdown: [
          'Person ID: people-fresh',
          'Cadence: RELATIONSHIP_BUILDING_V1',
          'Cadence stage: CONNECTION_REQUEST',
          'Task type: connection_request'
        ].join('\n')
      }
    }),
    snapshotTask('tasks-follow', {
      title: 'Send contextual introduction',
      bodyV2: {
        markdown: [
          'Person ID: people-follow',
          'Cadence: RELATIONSHIP_BUILDING_V1',
          'Next cadence stage: INTRO_MESSAGE',
          'Latest touch status: SENT'
        ].join('\n')
      }
    })
  ];
}

function snapshotTask(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? id,
    status: 'TODO',
    dueAt: '2026-06-10',
    assignee: {
      userEmail: 'rep@visiblegap.com'
    },
    ...overrides
  };
}

function snapshotTaskTargets() {
  return [
    {
      id: 'target-fresh',
      taskId: 'tasks-fresh',
      targetPersonId: 'people-fresh'
    }
  ];
}

async function invokeTaskCompleteRoute() {
  const req = {
    body: {
      personId: 'people-fresh',
      completion: {
        channel: 'LINKEDIN',
        touchStatus: 'SENT'
      }
    },
    params: {
      id: 'tasks-fresh'
    },
    correlationId: 'snapshot-task-complete',
    log: silentLog,
    workspaceUser: adminUser
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };

  await handleTaskComplete(req, res, (error) => {
    throw error;
  }, {
    config: snapshotConfig,
    log: silentLog,
    createCrmAdapterFn: () => ({}),
    createOperationalStoreFn: () => null,
    completeOutboundTaskWorkflowFn: async () => ({
      status: 'succeeded',
      personId: 'people-fresh',
      taskId: 'tasks-fresh',
      transition: null,
      personUpdate: null,
      nextTask: null,
      crmSync: {
        operations: [
          {
            object: 'person',
            action: 'update',
            status: 'succeeded',
            response: {
              id: 'people-fresh'
            }
          }
        ],
        relationshipResults: []
      },
      outboundEvents: {
        persisted: [],
        planned: []
      },
      auditLogs: [],
      workspaceUser: adminUser,
      skippedRelationships: []
    })
  });

  expect(res.statusCode).toBe(202);
}
