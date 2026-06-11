import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { requireWorkspaceAuth } from '../src/middleware/supabaseWorkspaceAuth.js';
import { createMemoryOperationalStore } from '../src/persistence/memoryOperationalStore.js';
import { handleTaskComplete } from '../src/routes/api/taskRoutes.js';
import { planCadenceTransition } from '../src/utils/cadenceTransitionEngine.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import { completeOutboundTaskWorkflow } from '../src/workflows/outbound/completeTaskWorkflow.js';

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

const workspaceUser = {
  authenticated: true,
  userId: 'workspace-user-1',
  email: 'rep@visiblegap.com',
  fullName: 'Visible Gap Rep',
  role: 'rep',
  roleSource: 'profile',
  profileId: 'profile-1'
};

describe('cadence transition engine', () => {
  it('transitions Assessment Campaign from CONNECTION_REQUEST to INTRO_MESSAGE', () => {
    const transition = planCadenceTransition({
      cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
      currentCadenceStage: 'CONNECTION_REQUEST',
      completion: {
        channel: 'LINKEDIN',
        touchStatus: 'SENT'
      },
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(transition).toMatchObject({
      cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
      oldCadenceStage: 'CONNECTION_REQUEST',
      newCadenceStage: 'INTRO_MESSAGE',
      channel: 'LINKEDIN',
      touchStatus: 'SENT',
      lastOutboundTouchDate: '2026-06-03',
      nextOutboundTouchDate: '2026-06-05',
      nextTask: {
        title: 'Send assessment positioning message',
        dueInDays: 2
      }
    });
  });

  it('transitions Relationship Building from CONNECTION_REQUEST to INTRO_MESSAGE', () => {
    const transition = planCadenceTransition({
      cadenceName: 'RELATIONSHIP_BUILDING_V1',
      currentCadenceStage: 'CONNECTION_REQUEST',
      completion: {
        channel: 'LINKEDIN',
        touchStatus: 'SENT'
      },
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(transition).toMatchObject({
      cadenceName: 'RELATIONSHIP_BUILDING_V1',
      oldCadenceStage: 'CONNECTION_REQUEST',
      newCadenceStage: 'INTRO_MESSAGE',
      nextOutboundTouchDate: '2026-06-05',
      nextTask: {
        title: 'Send contextual introduction',
        dueInDays: 2
      }
    });
  });

  it('transitions Relationship Building from NOT_STARTED after first touch is sent', () => {
    const transition = planCadenceTransition({
      cadenceName: 'RELATIONSHIP_BUILDING_V1',
      currentCadenceStage: 'NOT_STARTED',
      completion: {
        channel: 'LINKEDIN',
        touchStatus: 'SENT'
      },
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(transition).toMatchObject({
      cadenceName: 'RELATIONSHIP_BUILDING_V1',
      oldCadenceStage: 'NOT_STARTED',
      newCadenceStage: 'INTRO_MESSAGE',
      nextTask: {
        title: 'Send contextual introduction',
        taskType: 'CONTEXTUAL_INTRODUCTION'
      }
    });
  });
});

describe('task completion workflow', () => {
  it('updates outbound touch fields and creates exactly one next task', async () => {
    const store = createMemoryOperationalStore();
    const result = await completeOutboundTaskWorkflow({
      input: taskCompletionInput(),
      config: {
        ...baseConfig,
        supabase: {
          ...baseConfig.supabase,
          enabled: true
        }
      },
      workspaceUser,
      operationalStore: store,
      crmAdapter: createFakeTaskCompletionCrmAdapter({
        person: personRecord()
      }),
      correlationId: 'task-completion-test-1',
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.status).toBe('succeeded');
    expect(result.personUpdate.payload).toMatchObject({
      cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
      cadenceStage: 'INTRO_MESSAGE',
      latestTouchChannel: 'LINKEDIN',
      latestTouchStatus: 'SENT',
      lastOutboundTouchDate: '2026-06-03',
      nextOutboundTouchDate: '2026-06-05'
    });
    expect(result.completedTask.payload).toMatchObject({
      status: 'DONE',
      completedAt: '2026-06-03T15:00:00.000Z'
    });
    expect(result.crmSync.operations.filter((operation) => operation.object === 'task')).toHaveLength(2);
    expect(result.nextTask.payload.bodyV2.markdown).toContain('Person ID: people-1');
    expect(result.nextTask.payload.bodyV2.markdown).toContain(`Dedupe key: ${result.nextTask.dedupeKey}`);

    const snapshot = store.snapshot();
    expect(snapshot.outboundEvents.map((event) => event.eventType)).toEqual([
      'task_completed',
      'next_task_created'
    ]);
    expect(snapshot.crmSyncLogs.map((log) => log.objectName)).toEqual(['task', 'person', 'task']);
  });

  it('records duplicate next task avoidance when the CRM skips an existing task', async () => {
    const result = await completeOutboundTaskWorkflow({
      input: taskCompletionInput(),
      config: baseConfig,
      workspaceUser,
      crmAdapter: createFakeTaskCompletionCrmAdapter({
        person: personRecord(),
        taskOperationStatus: 'skipped'
      }),
      correlationId: 'task-completion-test-duplicate',
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.status).toBe('succeeded');
    expect(result.crmSync.operations.find((operation) => operation.dedupeKey === result.nextTask.dedupeKey)).toMatchObject({
      action: 'skip_existing',
      status: 'skipped',
      dedupeKey: result.nextTask.dedupeKey
    });
  });

  it('keeps task completion succeeded when next Task relationship linking fails', async () => {
    const result = await completeOutboundTaskWorkflow({
      input: taskCompletionInput(),
      config: baseConfig,
      workspaceUser,
      crmAdapter: createFakeTaskCompletionCrmAdapter({
        person: personRecord(),
        relationshipResults: [
          {
            key: 'task.taskTargets.person',
            object: 'taskTarget',
            action: 'link_task_to_person',
            status: 'failed',
            dedupeKey: 'relationship:task:tasks-next-1:person:people-1',
            payload: {
              taskId: 'tasks-next-1',
              targetPersonId: 'people-1'
            },
            error: {
              message: 'Relationship write failed in test.'
            }
          }
        ]
      }),
      correlationId: 'task-completion-test-relationship-failure',
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.status).toBe('succeeded');
    expect(result.crmSync.relationshipResults).toEqual([
      expect.objectContaining({
        key: 'task.taskTargets.person',
        status: 'failed',
        error: {
          message: 'Relationship write failed in test.'
        }
      })
    ]);
    expect(result.crmSync.operations.map((operation) => operation.object)).toEqual(['task', 'person', 'task']);
  });

  it('does not create a next task for terminal cadence stages', async () => {
    const result = await completeOutboundTaskWorkflow({
      input: taskCompletionInput({
        personSnapshot: personRecord({
          cadenceStage: 'ASSESSMENT_CHECK_IN'
        }),
        completion: {
          touchStatus: 'NO_RESPONSE'
        }
      }),
      config: baseConfig,
      workspaceUser,
      crmAdapter: createFakeTaskCompletionCrmAdapter({
        person: personRecord({
          cadenceStage: 'ASSESSMENT_CHECK_IN'
        })
      }),
      correlationId: 'task-completion-test-terminal',
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.transition).toMatchObject({
      oldCadenceStage: 'ASSESSMENT_CHECK_IN',
      newCadenceStage: 'PAUSED',
      terminal: true
    });
    expect(result.nextTask).toBeNull();
    expect(result.crmSync.operations.map((operation) => operation.object)).toEqual(['task', 'person']);
  });
});

describe('task completion API auth', () => {
  it('rejects unauthenticated task completion requests', async () => {
    const response = await invokeTaskComplete({
      body: taskCompletionInput(),
      dependencies: {
        completeOutboundTaskWorkflowFn: async () => {
          throw new Error('Workflow should not run without auth.');
        }
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.errors[0].code).toBe('WORKSPACE_AUTH_REQUIRED');
  });

  it('accepts authenticated reps and returns structured completion results', async () => {
    const response = await invokeTaskComplete({
      headers: {
        authorization: 'Bearer valid-token'
      },
      body: taskCompletionInput(),
      dependencies: {
        createCrmAdapterFn: () =>
          createFakeTaskCompletionCrmAdapter({
            person: personRecord()
          })
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      correlationId: 'route-test-correlation',
      data: {
        status: 'succeeded',
        personId: 'people-1',
        taskId: 'tasks-1',
        transition: {
          oldCadenceStage: 'CONNECTION_REQUEST',
          newCadenceStage: 'INTRO_MESSAGE'
        },
        crmResults: [
          {
            object: 'task',
            action: 'update',
            status: 'succeeded'
          },
          {
            object: 'person',
            status: 'succeeded'
          },
          {
            object: 'task',
            status: 'succeeded'
          }
        ]
      }
    });
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment webhook processing unaffected by task completion workflow additions', async () => {
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
      log: silentLog,
      operationalStore: createMemoryOperationalStore()
    });

    expect(result.status).toBe('dry_run');
    expect(result.crmSync.status).toBe('dry_run');
  });
});

function taskCompletionInput(overrides = {}) {
  return {
    personId: 'people-1',
    taskId: 'tasks-1',
    completion: {
      channel: 'LINKEDIN',
      touchStatus: 'SENT',
      messageBody: 'Manual message sent outside the system.',
      notes: 'Rep completed the first touch.',
      completedAt: '2026-06-03T15:00:00.000Z',
      ...(overrides.completion ?? {})
    },
    ...overrides
  };
}

function personRecord(overrides = {}) {
  return {
    id: 'people-1',
    name: {
      firstName: 'Taylor',
      lastName: 'Morgan'
    },
    company: {
      name: 'Visible Gap Test Company'
    },
    cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
    cadenceStage: 'CONNECTION_REQUEST',
    ...overrides
  };
}

async function invokeTaskComplete({
  body,
  headers = {},
  config = baseConfig,
  supabaseClient = createFakeWorkspaceSupabaseClient({ profile: workspaceProfile() }),
  dependencies = {}
} = {}) {
  const { req, res, next } = createMockExchange({
    body,
    headers,
    params: {
      id: body?.taskId ?? 'tasks-1'
    }
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
    await handleTaskComplete(req, res, next, {
      config,
      log: silentLog,
      ...dependencies
    });
  }

  if (res.error) {
    throw res.error;
  }

  return res;
}

function createMockExchange({ body = {}, headers = {}, params = {} } = {}) {
  const req = {
    body,
    headers,
    params,
    correlationId: 'route-test-correlation',
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

function createFakeTaskCompletionCrmAdapter({
  person,
  taskOperationStatus = 'succeeded',
  relationshipResults = []
} = {}) {
  return {
    async getPersonById(personId) {
      expect(personId).toBe('people-1');
      return person;
    },

    async syncTaskCompletion({ completedTask, personUpdate, nextTask }) {
      const operations = [
        {
          object: 'task',
          action: 'update',
          status: 'succeeded',
          id: completedTask.id,
          dedupeKey: completedTask.dedupeKey,
          payload: completedTask.payload,
          response: {
            id: completedTask.id,
            ...completedTask.payload
          },
          attempts: 1
        },
        {
          object: 'person',
          action: 'update',
          status: 'succeeded',
          id: personUpdate.id,
          dedupeKey: personUpdate.dedupeKey,
          payload: personUpdate.payload,
          response: {
            id: personUpdate.id,
            ...personUpdate.payload
          },
          attempts: 1
        }
      ];

      if (nextTask) {
        operations.push(
          taskOperationStatus === 'skipped'
            ? {
                object: 'task',
                action: 'skip_existing',
                status: 'skipped',
                dedupeKey: nextTask.dedupeKey,
                payload: nextTask.payload,
                response: {
                  id: 'tasks-existing-1'
                },
                attempts: 1
              }
            : {
                object: 'task',
                action: 'create',
                status: 'succeeded',
                dedupeKey: nextTask.dedupeKey,
                payload: nextTask.payload,
                response: {
                  id: 'tasks-next-1'
                },
                attempts: 1
              }
        );
      }

      return {
        provider: 'twenty',
        status: 'succeeded',
        dryRun: false,
        operations,
        relationshipResults,
        skippedRelationships: [
          {
            key: 'task.taskTargets',
            status: 'skipped',
            reason: 'Relationship writes remain disabled.'
          }
        ]
      };
    }
  };
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
