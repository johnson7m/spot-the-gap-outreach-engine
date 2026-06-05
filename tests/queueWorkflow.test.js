import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { requireWorkspaceAuth } from '../src/middleware/supabaseWorkspaceAuth.js';
import { handleQueueFetch } from '../src/routes/api/queueRoutes.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import { getOutboundQueueWorkflow } from '../src/workflows/outbound/getQueueWorkflow.js';

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
    syncEnabled: true,
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

const repUser = {
  authenticated: true,
  userId: 'workspace-user-1',
  email: 'rep@visiblegap.com',
  fullName: 'Visible Gap Rep',
  role: 'rep',
  roleSource: 'profile',
  profileId: 'profile-1'
};

const adminUser = {
  ...repUser,
  role: 'admin'
};

describe('outbound queue workflow', () => {
  it('returns structured data for every workspace queue endpoint', async () => {
    for (const queueSlug of [
      'fresh-leads',
      'follow-ups',
      'warm-assessments',
      'stale-recovery',
      'pipeline-review',
      'unassigned-tasks'
    ]) {
      const response = await invokeQueueRoute({
        queueSlug,
        headers: {
          authorization: 'Bearer valid-token'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        correlationId: 'queue-route-correlation',
        data: {
          queueSlug,
          items: expect.any(Array),
          count: expect.any(Number),
          warnings: expect.any(Array)
        },
        errors: []
      });
    }
  });

  it('defaults reps to owned queue items where ownership data is available', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: repUser,
      dataSource: fakeQueueDataSource(),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.ownerScope).toBe('mine');
    expect(result.items.map((item) => item.personId)).toEqual(['people-fresh']);
    expect(result.warnings).toContain(
      'Rep requests for ownerScope=all are treated as ownerScope=mine.'
    );
  });

  it('allows admins and operators to request all queue items', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource(),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items.map((item) => item.personId)).toEqual([
      'people-fresh',
      'people-other-fresh'
    ]);
  });

  it('identifies stale recovery leads', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'stale-recovery',
      query: {},
      config: baseConfig,
      workspaceUser: repUser,
      dataSource: fakeQueueDataSource(),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items.map((item) => item.personId)).toContain('people-stale');
    expect(result.items.find((item) => item.personId === 'people-stale').warnings).toContain(
      'Stale risk is HIGH.'
    );
  });

  it('identifies warm assessment leads from protected assessment fields', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'warm-assessments',
      query: {},
      config: baseConfig,
      workspaceUser: repUser,
      dataSource: fakeQueueDataSource(),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items.map((item) => item.personId)).toContain('people-warm');
  });

  it('surfaces relationship fallback warnings when task body parsing is used', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {},
      config: baseConfig,
      workspaceUser: repUser,
      dataSource: fakeQueueDataSource(),
      now: new Date('2026-06-03T15:00:00.000Z')
    });
    const freshLead = result.items.find((item) => item.personId === 'people-fresh');

    expect(freshLead.warnings).toContain(
      'Task relationship fallback used: Person ID was parsed from task body because no taskTarget Person link was found.'
    );
  });

  it('uses taskTargets to resolve task-person links without fallback warnings', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {},
      config: baseConfig,
      workspaceUser: repUser,
      dataSource: fakeQueueDataSource({
        taskTargets: [
          {
            id: 'task-target-fresh',
            taskId: 'tasks-fresh',
            targetPersonId: 'people-fresh',
            targetCompanyId: 'company-fresh'
          }
        ]
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    const freshLead = result.items.find((item) => item.personId === 'people-fresh');

    expect(freshLead.taskId).toBe('tasks-fresh');
    expect(freshLead.personLinkSource).toBe('task_target');
    expect(freshLead.personResolutionPath).toEqual(['taskTarget.targetPersonId']);
    expect(freshLead.warnings).not.toContain(
      'Task relationship fallback used: Person ID was parsed from task body because no taskTarget Person link was found.'
    );
    expect(freshLead.warnings).not.toContain(
      'No open task found for this fresh lead; task relationship may be unavailable.'
    );
  });

  it('maps owner and task assignee IDs to workspace member emails', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {},
      config: baseConfig,
      workspaceUser: repUser,
      dataSource: fakeQueueDataSource({
        people: [
          {
            id: 'people-member-owned',
            name: {
              firstName: 'Member',
              lastName: 'Owned'
            },
            company: {
              name: 'Owner Mapping Co'
            },
            outboundPipelineType: 'RELATIONSHIP_BUILDING',
            cadenceName: 'RELATIONSHIP_BUILDING_V1',
            cadenceStage: 'CONNECTION_REQUEST',
            latestTouchStatus: 'DRAFTED',
            ownerId: 'workspace-member-rep'
          }
        ],
        tasks: [
          {
            id: 'tasks-member-owned',
            title: 'Send relationship-oriented connection request',
            status: 'TODO',
            dueAt: '2026-06-04',
            personId: 'people-member-owned',
            assigneeId: 'workspace-member-rep'
          }
        ],
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
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].owner).toMatchObject({
      id: 'workspace-member-rep',
      email: 'rep@visiblegap.com',
      workspaceMemberId: 'workspace-member-rep',
      source: 'person_owner_and_task_assignee',
      taskAssignee: {
        id: 'workspace-member-rep',
        email: 'rep@visiblegap.com',
        workspaceMemberId: 'workspace-member-rep',
        source: 'task_assignee_workspace_member'
      }
    });
    expect(result.items[0].assignedRepDetails).toMatchObject({
      email: 'rep@visiblegap.com',
      workspaceMemberId: 'workspace-member-rep'
    });
  });

  it('excludes unassigned tasks from follow-ups by default and returns a hidden count warning', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-04'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({
        people: [],
        tasks: [
          {
            id: 'tasks-unassigned',
            title: 'Follow up with unknown lead',
            status: 'TODO',
            dueAt: '2026-06-04',
            bodyV2: {
              markdown: ['Cadence: RELATIONSHIP_BUILDING_V1', 'Next cadence stage: VALUE_TOUCH'].join('\n')
            }
          }
        ]
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items).toHaveLength(0);
    expect(result.warnings).toContain(
      '1 unassigned tasks hidden. Review Unassigned Tasks queue.'
    );
  });

  it('can include unassigned tasks in follow-ups when explicitly requested', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-04',
        includeUnassigned: 'true'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({
        people: [],
        tasks: [
          {
            id: 'tasks-unassigned',
            title: 'Follow up with unknown lead',
            status: 'TODO',
            dueAt: '2026-06-04',
            bodyV2: {
              markdown: ['Cadence: RELATIONSHIP_BUILDING_V1', 'Next cadence stage: VALUE_TOUCH'].join('\n')
            }
          }
        ]
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      taskId: 'tasks-unassigned',
      personId: null,
      queueBucket: 'unassigned_tasks',
      suggestedResolutionActions: [
        'associate_person',
        'associate_company',
        'dismiss_from_my_view',
        'leave_unassigned'
      ]
    });
    expect(result.items[0].warnings).toContain(
      'Task does not expose a Person ID or parsable Person ID marker.'
    );
  });

  it('returns only unassigned tasks from the unassigned tasks queue', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'unassigned-tasks',
      query: {
        assigneeScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({
        people: [
          {
            id: 'people-named',
            name: {
              firstName: 'Named',
              lastName: 'Lead'
            },
            owner: {
              userEmail: 'rep@visiblegap.com'
            }
          }
        ],
        tasks: [
          {
            id: 'tasks-unassigned',
            title: 'Administrative follow-up',
            status: 'TODO',
            dueAt: '2026-06-07',
            bodyV2: {
              markdown: 'No person context yet. Needs review before associating.'
            },
            assignee: {
              userEmail: 'rep@visiblegap.com',
              name: 'Visible Gap Rep'
            }
          },
          {
            id: 'tasks-linked',
            title: 'Linked task',
            status: 'TODO',
            dueAt: '2026-06-07'
          },
          {
            id: 'tasks-inferred',
            title: 'Follow up with Named Lead',
            status: 'TODO',
            dueAt: '2026-06-07'
          }
        ],
        taskTargets: [
          {
            id: 'target-linked',
            taskId: 'tasks-linked',
            targetPersonId: 'people-named'
          }
        ]
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.queueSlug).toBe('unassigned-tasks');
    expect(result.items.map((item) => item.taskId)).toEqual(['tasks-unassigned']);
    expect(result.items[0]).toMatchObject({
      personId: null,
      taskId: 'tasks-unassigned',
      taskTitle: 'Administrative follow-up',
      taskStatus: 'TODO',
      taskDueDate: '2026-06-07',
      assignedRep: 'rep@visiblegap.com',
      source: 'twenty:task-unassigned',
      suggestedResolutionActions: [
        'associate_person',
        'associate_company',
        'dismiss_from_my_view',
        'leave_unassigned'
      ]
    });
    expect(result.items[0].taskBodyExcerpt).toContain('No person context yet.');
    expect(result.items[0].warnings).toContain(
      'Task has no taskTarget Person link and no confident inferred Person.'
    );
  });

  it('filters unassigned tasks by assignee scope, status, due date, limit, and offset', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'unassigned-tasks',
      query: {
        assigneeScope: 'mine',
        status: 'TODO',
        dueBefore: '2026-06-05',
        limit: 1,
        offset: 1
      },
      config: baseConfig,
      workspaceUser: repUser,
      dataSource: fakeQueueDataSource({
        people: [],
        tasks: [
          unassignedTask('tasks-owned-1', {
            dueAt: '2026-06-04',
            assignee: {
              userEmail: 'rep@visiblegap.com'
            }
          }),
          unassignedTask('tasks-owned-2', {
            dueAt: '2026-06-05',
            assignee: {
              userEmail: 'rep@visiblegap.com'
            }
          }),
          unassignedTask('tasks-other', {
            dueAt: '2026-06-04',
            assignee: {
              userEmail: 'other@visiblegap.com'
            }
          }),
          unassignedTask('tasks-done', {
            status: 'DONE',
            dueAt: '2026-06-04',
            assignee: {
              userEmail: 'rep@visiblegap.com'
            }
          }),
          unassignedTask('tasks-later', {
            dueAt: '2026-06-06',
            assignee: {
              userEmail: 'rep@visiblegap.com'
            }
          })
        ]
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.assigneeScope).toBe('mine');
    expect(result.count).toBe(2);
    expect(result.items.map((item) => item.taskId)).toEqual(['tasks-owned-2']);
  });
});

describe('queue API auth', () => {
  it('rejects unauthenticated queue requests', async () => {
    const response = await invokeQueueRoute({
      queueSlug: 'fresh-leads',
      dependencies: {
        getOutboundQueueWorkflowFn: async () => {
          throw new Error('Queue workflow should not run without auth.');
        }
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.errors[0].code).toBe('WORKSPACE_AUTH_REQUIRED');
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment webhook processing unaffected by queue endpoints', async () => {
    const result = await processAssessmentSubmission({
      body: sampleAssessment,
      headers: {},
      config: {
        crmProvider: 'twenty',
        webhookSharedSecret: undefined,
        twenty: {
          syncEnabled: false,
          apiBaseUrl: 'https://api.twenty.com',
          apiKey: undefined
        },
        workflowMaxAttempts: 3
      },
      log: silentLog
    });

    expect(result.status).toBe('dry_run');
    expect(result.crmSync.status).toBe('dry_run');
  });
});

async function invokeQueueRoute({
  queueSlug,
  headers = {},
  query = {},
  config = baseConfig,
  supabaseClient = createFakeWorkspaceSupabaseClient({ profile: workspaceProfile() }),
  dependencies = {}
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

  if (authenticated) {
    await handleQueueFetch(req, res, next, {
      queueSlug,
      config,
      log: silentLog,
      getOutboundQueueWorkflowFn: getOutboundQueueWorkflow,
      dataSource: fakeQueueDataSource(),
      ...dependencies
    });
  }

  if (res.error) {
    throw res.error;
  }

  return res;
}

function fakeQueueDataSource(overrides = {}) {
  return {
    provider: 'fake-twenty',
    async listQueueRecords() {
      return {
        people: overrides.people ?? queuePeople(),
        tasks: overrides.tasks ?? queueTasks(),
        taskTargets: overrides.taskTargets ?? [],
        noteTargets: overrides.noteTargets ?? [],
        timelineActivities: overrides.timelineActivities ?? [],
        workspaceMembers: overrides.workspaceMembers ?? [],
        warnings: []
      };
    }
  };
}

function queuePeople() {
  return [
    {
      id: 'people-fresh',
      name: {
        firstName: 'Taylor',
        lastName: 'Morgan'
      },
      jobTitle: 'Operations Director',
      company: {
        name: 'Visible Gap Test Co'
      },
      emails: {
        primaryEmail: 'taylor@example.com'
      },
      linkedinLink: {
        primaryLinkUrl: 'https://www.linkedin.com/in/taylor-test'
      },
      outboundPipelineType: 'ASSESSMENT_CAMPAIGN',
      cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
      cadenceStage: 'CONNECTION_REQUEST',
      latestTouchStatus: 'DRAFTED',
      latestTouchChannel: 'LINKEDIN',
      leadHealthScore: 62,
      icpFitScore: 70,
      nextOutboundTouchDate: '2026-06-04',
      outreachAngle: 'Operational visibility',
      leadSource: 'LINKEDIN',
      owner: {
        userEmail: 'rep@visiblegap.com',
        name: 'Visible Gap Rep'
      }
    },
    {
      id: 'people-other-fresh',
      name: {
        firstName: 'Jordan',
        lastName: 'Lee'
      },
      company: {
        name: 'Other Test Co'
      },
      emails: {
        primaryEmail: 'jordan@example.com'
      },
      outboundPipelineType: 'RELATIONSHIP_BUILDING',
      cadenceName: 'RELATIONSHIP_BUILDING_V1',
      cadenceStage: 'CONNECTION_REQUEST',
      latestTouchStatus: 'DRAFTED',
      owner: {
        userEmail: 'other@visiblegap.com'
      }
    },
    {
      id: 'people-follow',
      name: {
        firstName: 'Casey',
        lastName: 'Rivers'
      },
      company: {
        name: 'Follow Up Co'
      },
      outboundPipelineType: 'RELATIONSHIP_BUILDING',
      cadenceName: 'RELATIONSHIP_BUILDING_V1',
      cadenceStage: 'INTRO_MESSAGE',
      latestTouchStatus: 'SENT',
      owner: {
        userEmail: 'rep@visiblegap.com'
      }
    },
    {
      id: 'people-warm',
      name: {
        firstName: 'Riley',
        lastName: 'Stone'
      },
      company: {
        name: 'Warm Co'
      },
      assessmentCompleted: true,
      leadstageAuto: 'ASSESSMENT_COMPLETED',
      discoveryReadiness: 'READY',
      owner: {
        userEmail: 'rep@visiblegap.com'
      }
    },
    {
      id: 'people-stale',
      name: {
        firstName: 'Avery',
        lastName: 'North'
      },
      company: {
        name: 'Stale Co'
      },
      outboundPipelineType: 'RELATIONSHIP_BUILDING',
      cadenceName: 'RELATIONSHIP_BUILDING_V1',
      cadenceStage: 'VALUE_TOUCH',
      latestTouchStatus: 'NO_RESPONSE',
      staleRisk: 'HIGH',
      nextOutboundTouchDate: '2026-05-20',
      owner: {
        userEmail: 'rep@visiblegap.com'
      }
    },
    {
      id: 'people-review',
      name: {
        firstName: 'Morgan',
        lastName: 'Review'
      },
      outboundPipelineType: 'ASSESSMENT_CAMPAIGN',
      cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
      cadenceStage: 'INTRO_MESSAGE',
      enrichmentStatus: 'PARTIAL',
      owner: {
        userEmail: 'rep@visiblegap.com'
      }
    }
  ];
}

function queueTasks() {
  return [
    {
      id: 'tasks-fresh',
      title: 'Send assessment-oriented connection request',
      status: 'TODO',
      dueAt: '2026-06-04',
      bodyV2: {
        markdown: [
          'Source: Quick Capture',
          'Person ID: people-fresh',
          'Cadence: ASSESSMENT_CAMPAIGN_V1',
          'Cadence stage: CONNECTION_REQUEST',
          'Channel: LINKEDIN'
        ].join('\n')
      },
      assignee: {
        userEmail: 'rep@visiblegap.com'
      }
    },
    {
      id: 'tasks-other-fresh',
      title: 'Send relationship-oriented connection request',
      status: 'TODO',
      dueAt: '2026-06-04',
      personId: 'people-other-fresh',
      assignee: {
        userEmail: 'other@visiblegap.com'
      }
    },
    {
      id: 'tasks-follow',
      title: 'Send contextual introduction',
      status: 'TODO',
      dueAt: '2026-06-02',
      personId: 'people-follow',
      bodyV2: {
        markdown: [
          'Source: Outbound cadence task completion',
          'Person ID: people-follow',
          'Cadence: RELATIONSHIP_BUILDING_V1',
          'Next cadence stage: INTRO_MESSAGE',
          'Channel: LINKEDIN',
          'Latest touch status: SENT'
        ].join('\n')
      },
      assignee: {
        userEmail: 'rep@visiblegap.com'
      }
    }
  ];
}

function unassignedTask(id, overrides = {}) {
  return {
    id,
    title: `Unassigned task ${id}`,
    status: 'TODO',
    dueAt: '2026-06-04',
    bodyV2: {
      markdown: 'No Person ID marker or unique lead name.'
    },
    ...overrides
  };
}

function createMockExchange({ headers = {}, query = {} } = {}) {
  const req = {
    body: {},
    headers,
    params: {},
    query,
    correlationId: 'queue-route-correlation',
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
    res.error = error;
  };

  return { req, res, next };
}

function workspaceProfile({ role = 'rep', is_active = true } = {}) {
  return {
    id: 'profile-1',
    user_id: 'workspace-user-1',
    email: 'rep@visiblegap.com',
    full_name: 'Visible Gap Rep',
    role,
    is_active,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z'
  };
}

function createFakeWorkspaceSupabaseClient({ profile, token = 'valid-token' } = {}) {
  return {
    auth: {
      async getUser(providedToken) {
        if (providedToken !== token) {
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
              id: 'workspace-user-1',
              email: 'rep@visiblegap.com'
            }
          },
          error: null
        };
      }
    },
    from(tableName) {
      expect(tableName).toBe('workspace_profiles');

      return {
        select() {
          return this;
        },
        eq(column, value) {
          expect(column).toBe('user_id');
          expect(value).toBe('workspace-user-1');
          return this;
        },
        async maybeSingle() {
          return {
            data: profile ?? null,
            error: null
          };
        }
      };
    }
  };
}
