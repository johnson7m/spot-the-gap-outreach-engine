import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import {
  applyStalePriorStageTaskCleanupPlan,
  selectStalePriorStageTaskCleanupCandidates,
  verifyTaskClosed
} from '../src/workflows/outbound/applyStalePriorStageTaskCleanupWorkflow.js';

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('stale prior-stage task cleanup apply workflow', () => {
  it('keeps task cleanup writes blocked when live guards are disabled', async () => {
    const restClient = fakeTaskClient();
    const result = await applyStalePriorStageTaskCleanupPlan({
      plan: fakeCleanupPlan(),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: false,
        liveTest: false,
        batchSize: 5,
        offset: 0
      }
    });

    expect(result).toMatchObject({
      status: 'dry_run',
      dryRun: true,
      summary: {
        planned: 2,
        attempted: 0,
        succeeded: 0,
        failed: 0
      }
    });
    expect(restClient.updated).toEqual([]);
    expect(restClient.reads).toEqual([]);
  });

  it('requires an explicit batch size for live cleanup', async () => {
    await expect(
      applyStalePriorStageTaskCleanupPlan({
        plan: fakeCleanupPlan(),
        config: baseConfig(),
        restClient: fakeTaskClient(),
        operationalStore: fakeOperationalStore(),
        options: {
          applyEnabled: true,
          liveTest: true,
          offset: 0
        }
      })
    ).rejects.toMatchObject({
      code: 'STALE_PRIOR_STAGE_TASK_CLEANUP_BATCH_SIZE_REQUIRED'
    });
  });

  it('selects only safe planner candidates for cleanup', () => {
    const selected = selectStalePriorStageTaskCleanupCandidates(fakeCleanupPlan(), {
      batchSize: 10,
      offset: 0
    });

    expect(selected.map((record) => record.staleTaskId)).toEqual([
      'task-stale-1',
      'task-stale-2'
    ]);
  });

  it('closes only planner candidates and audits live results', async () => {
    const store = fakeOperationalStore();
    const restClient = fakeTaskClient({
      tasks: [
        taskRecord('task-stale-1'),
        taskRecord('task-stale-2'),
        taskRecord('task-unsafe')
      ]
    });
    const result = await applyStalePriorStageTaskCleanupPlan({
      plan: fakeCleanupPlan(),
      config: baseConfig(),
      restClient,
      operationalStore: store,
      options: {
        applyEnabled: true,
        liveTest: true,
        batchSize: 5,
        offset: 0
      }
    });

    expect(result.summary).toMatchObject({
      attempted: 2,
      succeeded: 2,
      failed: 0,
      verificationFailed: 0,
      taskIdsClosed: ['task-stale-1', 'task-stale-2']
    });
    expect(restClient.updated.map((update) => update.id)).toEqual(['task-stale-1', 'task-stale-2']);
    expect(restClient.updated.every((update) => update.objectPlural === 'tasks')).toBe(true);
    expect(restClient.updated.every((update) => update.payload.status === 'DONE')).toBe(true);
    expect(store.crmSyncLogs.map((log) => log.action)).toEqual([
      'stale_prior_stage_task_cleanup_close',
      'stale_prior_stage_task_cleanup_close'
    ]);
    expect(store.outboundEvents.map((event) => event.eventType)).toEqual([
      'stale_prior_stage_task_closed',
      'stale_prior_stage_task_closed'
    ]);
  });

  it('skips Tasks that are already DONE during the live recheck', async () => {
    const restClient = fakeTaskClient({
      tasks: [taskRecord('task-stale-1', { status: 'DONE' })]
    });
    const result = await applyStalePriorStageTaskCleanupPlan({
      plan: fakeCleanupPlan({
        records: [cleanupRecord('task-stale-1')]
      }),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        batchSize: 1,
        offset: 0
      }
    });

    expect(result.summary).toMatchObject({
      attempted: 0,
      succeeded: 0,
      skipped: 1
    });
    expect(result.operations[0]).toMatchObject({
      status: 'skipped',
      skippedReason: 'already_done'
    });
    expect(restClient.updated).toEqual([]);
  });

  it('surfaces verification failure when the Task status does not become DONE', async () => {
    const restClient = fakeTaskClient({
      tasks: [taskRecord('task-stale-1')],
      persistUpdates: false
    });
    const result = await applyStalePriorStageTaskCleanupPlan({
      plan: fakeCleanupPlan({
        records: [cleanupRecord('task-stale-1')]
      }),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        batchSize: 1,
        offset: 0
      }
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toMatchObject({
      attempted: 1,
      succeeded: 0,
      verificationFailed: 1
    });
    expect(result.operations[0].verification).toMatchObject({
      ok: false,
      beforeStatus: 'TODO',
      actualStatus: 'TODO'
    });
  });

  it('verifies DONE/completed-equivalent task statuses', () => {
    expect(verifyTaskClosed({
      before: taskRecord('task-1'),
      after: taskRecord('task-1', { status: 'DONE' })
    })).toMatchObject({
      ok: true,
      actualStatus: 'DONE'
    });
    expect(verifyTaskClosed({
      before: taskRecord('task-1'),
      after: taskRecord('task-1', { status: 'TODO' })
    })).toMatchObject({
      ok: false,
      actualStatus: 'TODO'
    });
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment processing unaffected by stale prior-stage cleanup helpers', async () => {
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

function baseConfig() {
  return {
    supabase: {
      enabled: true
    },
    twenty: {
      apiKey: 'test-key',
      apiBaseUrl: 'https://api.twenty.com'
    }
  };
}

function fakeCleanupPlan(overrides = {}) {
  return {
    generatedAt: '2026-06-11T22:00:00.000Z',
    records: [
      cleanupRecord('task-stale-1'),
      {
        ...cleanupRecord('task-unsafe'),
        safeToPlan: false
      },
      {
        ...cleanupRecord('task-wrong-action'),
        recommendedAction: 'manual_review'
      },
      cleanupRecord('task-stale-2', {
        personId: 'person-2',
        personName: 'Second Person'
      })
    ],
    ...overrides
  };
}

function cleanupRecord(taskId, overrides = {}) {
  return {
    personId: 'person-1',
    personName: 'First Person',
    owner: {
      email: 'rep@visiblegap.com'
    },
    cadenceName: 'RELATIONSHIP_BUILDING_V1',
    personCadenceStage: 'INTRO_MESSAGE',
    nextOutboundTouchDate: '2026-06-13',
    latestTouchStatus: 'SENT',
    staleTaskId: taskId,
    staleTaskTitle: 'Send relationship-oriented connection request',
    staleTaskStatus: 'TODO',
    staleTaskDueDate: '2026-06-08',
    staleTaskCadenceStage: 'NOT_STARTED',
    currentQueueTaskId: 'task-current',
    currentQueueTaskTitle: 'Send contextual introduction',
    currentQueueTaskDueDate: '2026-06-13',
    recommendedAction: 'close_or_review_prior_stage_task',
    safeToPlan: true,
    warnings: [],
    ...overrides
  };
}

function taskRecord(id, overrides = {}) {
  return {
    id,
    title: `Task ${id}`,
    status: 'TODO',
    dueAt: '2026-06-08T00:00:00.000Z',
    ...overrides
  };
}

function fakeTaskClient({ tasks = [], persistUpdates = true } = {}) {
  const taskMap = new Map(tasks.map((task) => [task.id, { ...task }]));

  return {
    reads: [],
    updated: [],

    async getRecord(objectPlural, id) {
      this.reads.push({
        objectPlural,
        id
      });

      return taskMap.get(id) ?? taskRecord(id);
    },

    async updateRecord(objectPlural, id, payload) {
      this.updated.push({
        objectPlural,
        id,
        payload
      });

      const existing = taskMap.get(id) ?? taskRecord(id);
      const updated = {
        ...existing,
        ...payload
      };

      if (persistUpdates) {
        taskMap.set(id, updated);
      }

      return updated;
    }
  };
}

function fakeOperationalStore() {
  const store = {
    crmSyncLogs: [],
    outboundEvents: [],
    async appendCrmSyncLog(entry) {
      const record = {
        id: `audit-${this.crmSyncLogs.length + 1}`,
        ...entry
      };
      this.crmSyncLogs.push(record);
      return record;
    },
    async appendOutboundEvent(entry) {
      const record = {
        id: `event-${this.outboundEvents.length + 1}`,
        ...entry
      };
      this.outboundEvents.push(record);
      return record;
    }
  };

  return store;
}
