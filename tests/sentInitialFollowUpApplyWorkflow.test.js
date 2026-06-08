import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import {
  applySentInitialFollowUpPlan,
  buildSentInitialFollowUpOperation,
  buildSentInitialFollowUpTaskPayload,
  selectSentInitialFollowUpCandidates
} from '../src/workflows/outbound/applySentInitialFollowUpsWorkflow.js';

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('sent initial follow-up apply workflow', () => {
  it('keeps Task writes blocked when live guards are disabled', async () => {
    const restClient = fakeTaskClient();
    const store = fakeOperationalStore();
    const result = await applySentInitialFollowUpPlan({
      plan: fakeSentInitialFollowUpPlan(),
      config: baseConfig(),
      restClient,
      operationalStore: store,
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
    expect(restClient.created).toEqual([]);
    expect(restClient.updated).toEqual([]);
    expect(store.crmSyncLogs).toEqual([]);
    expect(store.outboundEvents).toEqual([]);
  });

  it('requires an explicit batch size for live apply', async () => {
    await expect(
      applySentInitialFollowUpPlan({
        plan: fakeSentInitialFollowUpPlan(),
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
      code: 'SENT_INITIAL_FOLLOW_UP_BATCH_SIZE_REQUIRED'
    });
  });

  it('respects batch size and offset against eligible records only', () => {
    const selected = selectSentInitialFollowUpCandidates(fakeSentInitialFollowUpPlan(), {
      batchSize: 1,
      offset: 1
    });

    expect(selected.map((record) => record.personId)).toEqual(['person-safe-2']);
  });

  it('selects only safe records by default', () => {
    const selected = selectSentInitialFollowUpCandidates(fakeSentInitialFollowUpPlan(), {
      batchSize: 10,
      offset: 0
    });

    expect(selected.map((record) => record.personId)).toEqual(['person-safe-1', 'person-safe-2']);
    expect(selected.map((record) => record.personId)).not.toContain('person-review');
    expect(selected.map((record) => record.personId)).not.toContain('person-test');
    expect(selected.map((record) => record.personId)).not.toContain('person-paused');
    expect(selected.map((record) => record.personId)).not.toContain('person-declined');
  });

  it('builds Task payloads with owner assignment and idempotency markers', () => {
    const record = safePlanRecord('person-safe-1');
    const payload = buildSentInitialFollowUpTaskPayload({
      record,
      dedupeKey: 'outbound-cadence:person:person-safe-1:cadence:RELATIONSHIP_BUILDING_V1:stage:INTRO_MESSAGE:task:introduction',
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(payload).toMatchObject({
      title: 'Send relationship follow-up / intro message',
      status: 'TODO',
      dueAt: '2026-06-08',
      assigneeId: 'workspace-member-rep'
    });
    expect(payload.bodyV2.markdown).toContain('Source: Sent initial follow-up planner');
    expect(payload.bodyV2.markdown).toContain('Person ID: person-safe-1');
    expect(payload.bodyV2.markdown).toContain('Next cadence stage: INTRO_MESSAGE');
    expect(payload.bodyV2.markdown).toContain('Manual action required. Do not automate LinkedIn requests or messages.');
  });

  it('avoids duplicate open post-initial follow-up Tasks during live apply', async () => {
    const restClient = fakeTaskClient({
      tasks: [
        {
          id: 'task-existing-follow-up',
          title: 'Send relationship follow-up / intro message',
          status: 'TODO',
          bodyV2: {
            markdown: ['Person ID: person-safe-1', 'Next cadence stage: INTRO_MESSAGE'].join('\n')
          }
        }
      ]
    });
    const result = await applySentInitialFollowUpPlan({
      plan: fakeSentInitialFollowUpPlan({
        plans: [safePlanRecord('person-safe-1')]
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
      skippedReason: 'Open post-initial follow-up Task already exists for Person.'
    });
    expect(restClient.created).toEqual([]);
  });

  it('avoids duplicate Task creation when the dedupe key already exists', async () => {
    const operation = buildSentInitialFollowUpOperation({
      record: safePlanRecord('person-safe-1'),
      now: new Date('2026-06-08T15:00:00.000Z')
    });
    const restClient = fakeTaskClient({
      tasks: [
        {
          id: 'task-existing-dedupe',
          title: 'Older deduped follow-up',
          status: 'DONE',
          bodyV2: {
            markdown: `Dedupe key: ${operation.dedupeKey}`
          }
        }
      ]
    });
    const result = await applySentInitialFollowUpPlan({
      plan: fakeSentInitialFollowUpPlan({
        plans: [safePlanRecord('person-safe-1')]
      }),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        batchSize: 1,
        offset: 0
      },
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(result.summary).toMatchObject({
      attempted: 1,
      succeeded: 1,
      taskIdsCreated: [],
      personIdsAffected: ['person-safe-1']
    });
    expect(result.operations[0]).toMatchObject({
      duplicateTaskSkipped: true,
      status: 'verification_succeeded'
    });
    expect(restClient.created).toEqual([
      {
        objectPlural: 'taskTargets',
        payload: {
          taskId: 'task-existing-dedupe',
          targetPersonId: 'person-safe-1'
        }
      }
    ]);
  });

  it('creates a Task, creates and verifies the Person taskTarget, and writes audit records', async () => {
    const restClient = fakeTaskClient();
    const store = fakeOperationalStore();
    const result = await applySentInitialFollowUpPlan({
      plan: fakeSentInitialFollowUpPlan({
        plans: [safePlanRecord('person-safe-1')]
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
      taskIdsCreated: ['task-created-1'],
      personIdsAffected: ['person-safe-1'],
      auditIds: ['audit-1'],
      outboundEventIds: ['event-1']
    });
    expect(restClient.created.map((entry) => entry.objectPlural)).toEqual(['tasks', 'taskTargets']);
    expect(restClient.created[1]).toMatchObject({
      objectPlural: 'taskTargets',
      payload: {
        taskId: 'task-created-1',
        targetPersonId: 'person-safe-1'
      }
    });
    expect(result.operations[0].verification).toMatchObject({
      ok: true,
      expectedTaskId: 'task-created-1',
      actualTaskId: 'task-created-1',
      expectedTargetPersonId: 'person-safe-1',
      actualTargetPersonId: 'person-safe-1'
    });
    expect(store.crmSyncLogs[0]).toMatchObject({
      provider: 'twenty',
      objectName: 'task',
      action: 'sent_initial_follow_up_create',
      status: 'succeeded'
    });
    expect(store.outboundEvents[0]).toMatchObject({
      eventType: 'sent_initial_follow_up_created',
      actorType: 'system',
      status: 'sent'
    });
  });

  it('marks verification_failed when the created taskTarget cannot be verified', async () => {
    const result = await applySentInitialFollowUpPlan({
      plan: fakeSentInitialFollowUpPlan({
        plans: [safePlanRecord('person-safe-1')]
      }),
      config: baseConfig(),
      restClient: fakeTaskClient({ persistTaskTargets: false }),
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
    expect(result.operations[0].status).toBe('verification_failed');
  });

  it('does not update Person cadence stage by default', async () => {
    const restClient = fakeTaskClient({
      people: [
        {
          id: 'person-safe-1',
          cadenceStage: 'NOT_STARTED'
        }
      ]
    });
    const result = await applySentInitialFollowUpPlan({
      plan: fakeSentInitialFollowUpPlan({
        plans: [safePlanRecord('person-safe-1')]
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

    expect(result.operations[0]).toMatchObject({
      personStageUpdateEnabled: false,
      personStagePayload: null,
      personStageUpdate: null
    });
    expect(restClient.updated).toEqual([]);
  });

  it('updates Person cadence stage only when explicitly flagged', async () => {
    const restClient = fakeTaskClient({
      people: [
        {
          id: 'person-safe-1',
          cadenceStage: 'NOT_STARTED'
        }
      ]
    });
    const result = await applySentInitialFollowUpPlan({
      plan: fakeSentInitialFollowUpPlan({
        plans: [safePlanRecord('person-safe-1')]
      }),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        updatePersonStage: true,
        batchSize: 1,
        offset: 0
      }
    });

    expect(restClient.updated).toEqual([
      {
        objectPlural: 'people',
        id: 'person-safe-1',
        payload: {
          cadenceStage: 'INTRO_MESSAGE'
        }
      }
    ]);
    expect(result.operations[0]).toMatchObject({
      status: 'verification_succeeded',
      personStageUpdateEnabled: true,
      personStagePayload: {
        cadenceStage: 'INTRO_MESSAGE'
      },
      verification: {
        personStageUpdateExpected: true,
        personStageVerified: true,
        actualPersonCadenceStage: 'INTRO_MESSAGE'
      }
    });
    expect(restClient.updated.map((entry) => entry.objectPlural)).not.toContain('tasks');
  });

  it('keeps optional Company taskTarget links disabled by default', () => {
    const operation = buildSentInitialFollowUpOperation({
      record: safePlanRecord('person-safe-1', {
        companyId: 'company-safe-1'
      }),
      linkCompany: false,
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(operation.companyTargetEnabled).toBe(false);
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment processing unaffected by sent-initial follow-up apply helpers', async () => {
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

function fakeSentInitialFollowUpPlan(overrides = {}) {
  return {
    status: 'dry_run',
    dryRun: true,
    plans: [
      safePlanRecord('person-safe-1'),
      {
        ...safePlanRecord('person-review'),
        safeToCreate: false,
        confidence: 'medium',
        warnings: ['Owner could not be resolved; task assignment may need manual review.']
      },
      safePlanRecord('person-test', {
        isTestRecord: true,
        testRecordReasons: ['Email looks synthetic: cadence-test@example.com']
      }),
      safePlanRecord('person-paused', {
        cadenceStage: 'PAUSED'
      }),
      safePlanRecord('person-declined', {
        latestTouchStatus: 'DECLINED'
      }),
      safePlanRecord('person-safe-2', {
        recommendedTaskType: 'assessment_positioning',
        recommendedTaskTitle: 'Send assessment positioning follow-up',
        recommendedNextCadenceStage: 'ASSESSMENT_POSITIONING',
        cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
        cadenceStage: 'CONNECTION_REQUEST'
      })
    ],
    ...overrides
  };
}

function safePlanRecord(personId, overrides = {}) {
  return {
    personId,
    personName: `Lead ${personId}`,
    owner: {
      id: 'workspace-member-rep',
      email: 'rep@visiblegap.com',
      name: 'Visible Gap Rep',
      workspaceMemberId: 'workspace-member-rep'
    },
    cadenceName: 'RELATIONSHIP_BUILDING_V1',
    cadenceStage: 'NOT_STARTED',
    recommendedNextCadenceStage: 'INTRO_MESSAGE',
    latestTouchChannel: 'LINKEDIN',
    latestTouchStatus: 'SENT',
    currentInitialTaskId: 'task-initial-existing',
    recommendedTaskTitle: 'Send relationship follow-up / intro message',
    recommendedDueDate: '2026-06-08',
    recommendedTaskType: 'introduction',
    confidence: 'high',
    evidence: ['No open post-initial follow-up task resolved through taskTargets or Person markers.'],
    safeToCreate: true,
    isTestRecord: false,
    testRecordReasons: [],
    warnings: [],
    ...overrides
  };
}

function fakeTaskClient({
  people = [],
  tasks = [],
  taskTargets = [],
  persistTaskTargets = true
} = {}) {
  return {
    people: [...people],
    tasks: [...tasks],
    taskTargets: [...taskTargets],
    created: [],
    updated: [],
    async listAllRecords(objectPlural) {
      if (objectPlural === 'people') {
        return {
          records: this.people
        };
      }

      if (objectPlural === 'tasks') {
        return {
          records: this.tasks
        };
      }

      if (objectPlural === 'taskTargets') {
        return {
          records: this.taskTargets
        };
      }

      return {
        records: []
      };
    },
    async getRecord(objectPlural, id) {
      if (objectPlural === 'people') {
        return this.people.find((person) => person.id === id) ?? null;
      }

      if (objectPlural === 'tasks') {
        return this.tasks.find((task) => task.id === id) ?? null;
      }

      return null;
    },
    async createRecord(objectPlural, payload) {
      this.created.push({
        objectPlural,
        payload
      });

      const record = {
        id: `${objectPlural === 'tasks' ? 'task-created' : 'task-target'}-${this.created.length}`,
        ...payload
      };

      if (objectPlural === 'tasks') {
        record.id = `task-created-${this.tasks.length + 1}`;
        this.tasks.push(record);
      }

      if (objectPlural === 'taskTargets' && persistTaskTargets) {
        record.id = `task-target-${this.taskTargets.length + 1}`;
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

      if (objectPlural === 'people') {
        const existing = this.people.find((person) => person.id === id);

        if (existing) {
          Object.assign(existing, payload);
          return existing;
        }

        const person = {
          id,
          ...payload
        };
        this.people.push(person);
        return person;
      }

      if (objectPlural === 'tasks') {
        const existing = this.tasks.find((task) => task.id === id);

        if (existing) {
          Object.assign(existing, payload);
          return existing;
        }
      }

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
