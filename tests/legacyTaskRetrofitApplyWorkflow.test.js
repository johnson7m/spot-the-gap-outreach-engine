import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import {
  applyLegacyTaskRetrofitPlan,
  buildCompanyTaskTargetPayload,
  buildPersonTaskTargetPayload,
  buildTaskApplyOperation,
  selectTaskApplyCandidates
} from '../src/workflows/outbound/applyLegacyTaskRetrofitWorkflow.js';

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('legacy task retrofit apply workflow', () => {
  it('keeps taskTarget writes blocked when live guards are disabled', async () => {
    const restClient = fakeTaskTargetClient();
    const result = await applyLegacyTaskRetrofitPlan({
      plan: fakeTaskPlan(),
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
        planned: 3,
        attempted: 0,
        succeeded: 0,
        failed: 0
      }
    });
    expect(restClient.created).toEqual([]);
  });

  it('respects batch size and offset against eligible task records only', () => {
    const selected = selectTaskApplyCandidates(fakeTaskPlan(), {
      batchSize: 1,
      offset: 1
    });

    expect(selected.map((record) => record.taskId)).toEqual(['task-safe-2']);
  });

  it('only selects safe link_task_to_person candidates', () => {
    const selected = selectTaskApplyCandidates(fakeTaskPlan(), {
      batchSize: 10,
      offset: 0
    });

    expect(selected.map((record) => record.taskId)).toEqual([
      'task-safe-1',
      'task-safe-2',
      'task-completed'
    ]);
    expect(selected.map((record) => record.recommendedAction)).toEqual([
      'link_task_to_person',
      'link_task_to_person',
      'link_task_to_person'
    ]);
    expect(selected.map((record) => record.taskId)).not.toContain('task-unassigned');
    expect(selected.map((record) => record.taskId)).not.toContain('task-company-only');
    expect(selected.map((record) => record.taskId)).not.toContain('task-manual-review');
    expect(selected.map((record) => record.taskId)).not.toContain('task-existing-target');
  });

  it('builds confirmed taskTarget payload shapes', () => {
    expect(buildPersonTaskTargetPayload(safeTaskRecord('task-safe-1'))).toEqual({
      taskId: 'task-safe-1',
      targetPersonId: 'person-safe-1'
    });
    expect(buildCompanyTaskTargetPayload(safeTaskRecord('task-safe-1'))).toEqual({
      taskId: 'task-safe-1',
      targetCompanyId: 'company-safe-1'
    });
  });

  it('keeps company taskTarget links disabled by default', () => {
    const operation = buildTaskApplyOperation({
      record: safeTaskRecord('task-safe-1', {
        inferredTargetCompanyId: 'company-safe-1'
      }),
      linkCompany: false,
      now: new Date('2026-06-05T15:00:00.000Z')
    });

    expect(operation.personTargetPayload).toEqual({
      taskId: 'task-safe-1',
      targetPersonId: 'person-safe-1'
    });
    expect(operation.companyTargetPayload).toBeNull();
  });

  it('adds optional company taskTarget payload only when explicitly enabled', () => {
    const operation = buildTaskApplyOperation({
      record: safeTaskRecord('task-safe-1', {
        inferredTargetCompanyId: 'company-safe-1'
      }),
      linkCompany: true,
      now: new Date('2026-06-05T15:00:00.000Z')
    });

    expect(operation.companyTargetPayload).toEqual({
      taskId: 'task-safe-1',
      targetCompanyId: 'company-safe-1'
    });
  });

  it('avoids duplicate taskTarget links during live execution', async () => {
    const restClient = fakeTaskTargetClient({
      taskTargets: [
        {
          id: 'existing-task-target',
          taskId: 'task-safe-1',
          targetPersonId: 'person-safe-1'
        }
      ]
    });
    const result = await applyLegacyTaskRetrofitPlan({
      plan: fakeTaskPlan({
        plans: [safeTaskRecord('task-safe-1')]
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
      attempted: 1,
      succeeded: 1,
      failed: 0,
      verificationFailed: 0
    });
    expect(result.operations[0]).toMatchObject({
      status: 'verification_succeeded',
      duplicateSkipped: true
    });
    expect(restClient.created).toEqual([]);
  });

  it('verifies the taskTarget after write and audits the live result', async () => {
    const store = fakeOperationalStore();
    const restClient = fakeTaskTargetClient();
    const result = await applyLegacyTaskRetrofitPlan({
      plan: fakeTaskPlan({
        plans: [safeTaskRecord('task-safe-1')]
      }),
      config: baseConfig(),
      restClient,
      operationalStore: store,
      options: {
        applyEnabled: true,
        liveTest: true,
        batchSize: 1,
        offset: 0
      }
    });

    expect(result.summary).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      verificationFailed: 0,
      taskIdsLinked: ['task-safe-1'],
      personIdsLinked: ['person-safe-1'],
      auditIds: ['audit-1'],
      outboundEventIds: ['event-1']
    });
    expect(result.operations[0].verification).toMatchObject({
      ok: true,
      taskId: 'task-safe-1',
      expectedTargetPersonId: 'person-safe-1',
      actualTargetPersonId: 'person-safe-1'
    });
    expect(store.crmSyncLogs[0]).toMatchObject({
      provider: 'twenty',
      objectName: 'taskTarget',
      action: 'legacy_task_retrofit_create',
      status: 'succeeded'
    });
    expect(store.outboundEvents[0]).toMatchObject({
      eventType: 'legacy_task_retrofit_applied',
      actorType: 'system',
      status: 'sent'
    });
  });

  it('reports verification failure without creating cadence tasks', async () => {
    const restClient = fakeTaskTargetClient({ persistCreates: false });
    const result = await applyLegacyTaskRetrofitPlan({
      plan: fakeTaskPlan({
        plans: [safeTaskRecord('task-safe-1')]
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
      attempted: 1,
      succeeded: 0,
      verificationFailed: 1
    });
    expect(restClient.created).toEqual([
      {
        objectPlural: 'taskTargets',
        payload: {
          taskId: 'task-safe-1',
          targetPersonId: 'person-safe-1'
        }
      }
    ]);
    expect(restClient.updated).toEqual([]);
    expect(restClient.created.map((entry) => entry.objectPlural)).not.toContain('tasks');
  });

  it('does not reopen completed tasks or patch task status', async () => {
    const restClient = fakeTaskTargetClient();
    await applyLegacyTaskRetrofitPlan({
      plan: fakeTaskPlan({
        plans: [
          safeTaskRecord('task-completed', {
            taskStatus: 'DONE',
            inferredTargetPersonId: 'person-completed'
          })
        ]
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

    expect(restClient.updated).toEqual([]);
    expect(restClient.created).toEqual([
      {
        objectPlural: 'taskTargets',
        payload: {
          taskId: 'task-completed',
          targetPersonId: 'person-completed'
        }
      }
    ]);
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment processing unaffected by legacy task retrofit apply helpers', async () => {
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

function fakeTaskPlan(overrides = {}) {
  return {
    status: 'dry_run',
    dryRun: true,
    plans: [
      safeTaskRecord('task-safe-1'),
      {
        ...safeTaskRecord('task-unassigned', {
          inferredTargetPersonId: null,
          confidence: 'unknown'
        }),
        recommendedAction: 'leave_unassigned',
        safeToUpdate: false
      },
      {
        ...safeTaskRecord('task-company-only', {
          inferredTargetPersonId: null,
          inferredTargetCompanyId: 'company-only'
        }),
        recommendedAction: 'link_task_to_company',
        safeToUpdate: false
      },
      {
        ...safeTaskRecord('task-manual-review'),
        recommendedAction: 'manual_review',
        safeToUpdate: false
      },
      {
        ...safeTaskRecord('task-existing-target', {
          currentTargetPersonId: 'person-existing'
        }),
        recommendedAction: 'leave_unassigned',
        safeToUpdate: false
      },
      safeTaskRecord('task-safe-2', {
        inferredTargetPersonId: 'person-safe-2'
      }),
      safeTaskRecord('task-completed', {
        taskStatus: 'DONE',
        inferredTargetPersonId: 'person-completed'
      })
    ],
    ...overrides
  };
}

function safeTaskRecord(taskId, overrides = {}) {
  const suffix = taskId.replace('task-', '');

  return {
    taskId,
    taskTitle: `Follow up ${suffix}`,
    taskStatus: 'TODO',
    currentTargetPersonId: null,
    currentTargetCompanyId: null,
    inferredTargetPersonId: `person-${suffix}`,
    inferredTargetCompanyId: `company-${suffix}`,
    inferredTargetPersonName: `Lead ${suffix}`,
    confidence: 'medium',
    recommendedAction: 'link_task_to_person',
    safeToUpdate: true,
    warnings: [],
    ...overrides
  };
}

function fakeTaskTargetClient({ taskTargets = [], persistCreates = true } = {}) {
  return {
    taskTargets: [...taskTargets],
    created: [],
    updated: [],
    async listAllRecords(objectPlural) {
      if (objectPlural !== 'taskTargets') {
        return {
          records: []
        };
      }

      return {
        records: this.taskTargets
      };
    },
    async createRecord(objectPlural, payload) {
      this.created.push({
        objectPlural,
        payload
      });

      const record = {
        id: `${objectPlural}-${this.created.length}`,
        ...payload
      };

      if (persistCreates) {
        this.taskTargets.push(record);
      }

      return record;
    },
    async updateRecord(objectPlural, id, payload) {
      this.updated.push({
        objectPlural,
        id,
        payload
      });

      return {
        id,
        ...payload
      };
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
