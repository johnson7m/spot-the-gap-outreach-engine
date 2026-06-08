import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import {
  applyManualLeadNormalizationPlan,
  buildManualLeadNormalizationPayload,
  selectManualLeadNormalizationCandidates,
  validateManualLeadNormalizationPlan
} from '../src/workflows/outbound/applyManualLeadNormalizationWorkflow.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('manual lead normalization apply workflow', () => {
  it('keeps Person writes blocked when live guards are disabled', async () => {
    const restClient = fakeRestClient();
    const result = await applyManualLeadNormalizationPlan({
      plan: fakePlan(),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: false,
        liveTest: false,
        batchSize: 8,
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
    expect(restClient.created).toEqual([]);
  });

  it('requires an explicit batch size for live apply', async () => {
    await expect(
      applyManualLeadNormalizationPlan({
        plan: fakePlan(),
        config: baseConfig(),
        restClient: fakeRestClient(),
        operationalStore: fakeOperationalStore(),
        options: {
          applyEnabled: true,
          liveTest: true,
          offset: 0
        }
      })
    ).rejects.toMatchObject({
      code: 'MANUAL_LEAD_NORMALIZATION_BATCH_SIZE_REQUIRED'
    });
  });

  it('respects batch size and offset against eligible records only', () => {
    const selected = selectManualLeadNormalizationCandidates(fakePlan(), {
      batchSize: 1,
      offset: 1
    });

    expect(selected.map((record) => record.personId)).toEqual(['person-safe-2']);
  });

  it('selects safe records only by default', () => {
    const selected = selectManualLeadNormalizationCandidates(fakePlan(), {
      batchSize: 10,
      offset: 0
    });

    expect(selected.map((record) => record.personId)).toEqual(['person-safe-1', 'person-safe-2']);
    expect(selected.map((record) => record.personId)).not.toContain('person-review');
    expect(selected.map((record) => record.personId)).not.toContain('person-test');
  });

  it('skips review and test records by default', async () => {
    const result = await applyManualLeadNormalizationPlan({
      plan: fakePlan({
        plans: [reviewRecord('person-review'), testRecord('person-test')]
      }),
      config: baseConfig(),
      restClient: fakeRestClient(),
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: false,
        liveTest: false,
        batchSize: 10,
        offset: 0
      }
    });

    expect(result.summary).toMatchObject({
      planned: 0,
      skipped: 0
    });
    expect(result.operations).toEqual([]);
  });

  it('does not overwrite non-empty outbound fields unless force is enabled', () => {
    const record = safeRecord('person-safe-1', {
      currentOutboundFields: {
        outboundPipelineType: null,
        cadenceName: 'RELATIONSHIP_BUILDING_V1',
        leadHealthScore: 40
      },
      recommendedUpdates: {
        outboundPipelineType: 'RELATIONSHIP_BUILDING',
        cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
        leadHealthScore: 45
      }
    });

    expect(buildManualLeadNormalizationPayload({ record, force: false })).toEqual({
      outboundPipelineType: 'RELATIONSHIP_BUILDING'
    });
    expect(buildManualLeadNormalizationPayload({ record, force: true })).toEqual({
      outboundPipelineType: 'RELATIONSHIP_BUILDING',
      cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
      leadHealthScore: 45
    });
  });

  it('rechecks live Person fields and preserves non-empty values before writing', async () => {
    const restClient = fakeRestClient({
      people: [
        {
          id: 'person-safe-1',
          cadenceName: 'RELATIONSHIP_BUILDING_V1',
          assessmentCompleted: false
        }
      ]
    });
    const result = await applyManualLeadNormalizationPlan({
      plan: fakePlan({
        plans: [
          safeRecord('person-safe-1', {
            currentOutboundFields: {
              cadenceName: null
            },
            recommendedUpdates: {
              outboundPipelineType: 'RELATIONSHIP_BUILDING',
              cadenceName: 'ASSESSMENT_CAMPAIGN_V1'
            }
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

    expect(restClient.updated[0]).toEqual({
      objectPlural: 'people',
      id: 'person-safe-1',
      payload: {
        outboundPipelineType: 'RELATIONSHIP_BUILDING'
      }
    });
    expect(result.operations[0].verification).toMatchObject({
      ok: true,
      protectedFieldsUnchanged: true,
      nonEmptyFieldsPreserved: true
    });
  });

  it('rejects protected assessment fields in the plan before live apply', () => {
    const validation = validateManualLeadNormalizationPlan({
      plans: [
        {
          personId: 'person-protected',
          recommendedUpdates: {
            assessmentCompleted: true
          }
        }
      ]
    });

    expect(validation).toMatchObject({
      ok: false,
      errors: [
        {
          personId: 'person-protected',
          protectedFields: ['assessmentCompleted']
        }
      ]
    });
  });

  it('updates People only, writes audit rows, and does not create Tasks or Companies', async () => {
    const restClient = fakeRestClient();
    const store = fakeOperationalStore();
    const result = await applyManualLeadNormalizationPlan({
      plan: fakePlan({
        plans: [safeRecord('person-safe-1')]
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
      personIdsAffected: ['person-safe-1'],
      fieldsUpdatedByPerson: {
        'person-safe-1': [
          'outboundPipelineType',
          'cadenceName',
          'cadenceStage',
          'latestTouchChannel',
          'latestTouchStatus'
        ]
      },
      auditIds: ['audit-1'],
      outboundEventIds: ['event-1']
    });
    expect(restClient.updated.map((entry) => entry.objectPlural)).toEqual(['people']);
    expect(restClient.created).toEqual([]);
    expect(store.crmSyncLogs[0]).toMatchObject({
      provider: 'twenty',
      objectName: 'person',
      action: 'manual_lead_normalization_update',
      status: 'succeeded'
    });
    expect(store.outboundEvents[0]).toMatchObject({
      eventType: 'manual_lead_normalized',
      status: 'sent'
    });
  });

  it('marks verification_failed when expected outbound fields are not reflected after update', async () => {
    const restClient = fakeRestClient({ ignoreUpdates: true });
    const result = await applyManualLeadNormalizationPlan({
      plan: fakePlan({
        plans: [safeRecord('person-safe-1')]
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
    expect(result.operations[0]).toMatchObject({
      status: 'verification_failed',
      verification: {
        ok: false,
        protectedFieldsUnchanged: true
      }
    });
  });

  it('allows force overwrite when explicitly enabled', async () => {
    const restClient = fakeRestClient({
      people: [
        {
          id: 'person-safe-1',
          cadenceName: 'RELATIONSHIP_BUILDING_V1',
          assessmentCompleted: false
        }
      ]
    });
    await applyManualLeadNormalizationPlan({
      plan: fakePlan({
        plans: [
          safeRecord('person-safe-1', {
            currentOutboundFields: {
              cadenceName: 'RELATIONSHIP_BUILDING_V1'
            },
            recommendedUpdates: {
              cadenceName: 'ASSESSMENT_CAMPAIGN_V1'
            }
          })
        ]
      }),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        force: true,
        batchSize: 1,
        offset: 0
      }
    });

    expect(restClient.updated[0]).toEqual({
      objectPlural: 'people',
      id: 'person-safe-1',
      payload: {
        cadenceName: 'ASSESSMENT_CAMPAIGN_V1'
      }
    });
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment processing unaffected by manual lead normalization apply helpers', async () => {
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

function fakePlan(overrides = {}) {
  return {
    status: 'dry_run',
    dryRun: true,
    plans: [
      safeRecord('person-safe-1'),
      safeRecord('person-safe-2', {
        recommendedUpdates: {
          outboundPipelineType: 'RELATIONSHIP_BUILDING',
          cadenceName: 'RELATIONSHIP_BUILDING_V1'
        }
      }),
      reviewRecord('person-review'),
      testRecord('person-test')
    ],
    ...overrides
  };
}

function safeRecord(personId, overrides = {}) {
  return {
    personId,
    personName: `Lead ${personId}`,
    companyId: 'company-safe',
    companyName: 'Safe Company',
    assignedRep: 'rep@visiblegap.com',
    leadStage: 'OUTREACH_INITIATED',
    assessmentCompleted: false,
    safeToNormalize: true,
    isTestRecord: false,
    currentOutboundFields: {
      outboundPipelineType: null,
      cadenceName: null,
      cadenceStage: null,
      latestTouchChannel: null,
      latestTouchStatus: null
    },
    recommendedUpdates: {
      outboundPipelineType: 'RELATIONSHIP_BUILDING',
      cadenceName: 'RELATIONSHIP_BUILDING_V1',
      cadenceStage: 'CONNECTION_REQUEST',
      latestTouchChannel: 'LINKEDIN',
      latestTouchStatus: 'SENT'
    },
    recommendedTaskAction: 'create_follow_up_task',
    ...overrides
  };
}

function reviewRecord(personId, overrides = {}) {
  return {
    ...safeRecord(personId),
    safeToNormalize: false,
    warnings: ['Owner could not be resolved; assign rep before applying normalization.'],
    ...overrides
  };
}

function testRecord(personId, overrides = {}) {
  return {
    ...safeRecord(personId),
    isTestRecord: true,
    testRecordReasons: ['Email looks synthetic: test@example.com'],
    ...overrides
  };
}

function fakeRestClient({ people = [], ignoreUpdates = false } = {}) {
  const records = new Map(
    [
      {
        id: 'person-safe-1',
        assessmentCompleted: false,
        assessmentScore: null,
        lastTouchDate: null,
        leadstageAuto: null,
        messageAngle: null,
        nextFollowUpDate: null
      },
      {
        id: 'person-safe-2',
        assessmentCompleted: false
      },
      ...people
    ].map((person) => [person.id, { ...person }])
  );

  return {
    records,
    updated: [],
    created: [],
    async getRecord(objectPlural, id) {
      if (objectPlural !== 'people') {
        return null;
      }

      return { ...(this.records.get(id) ?? { id }) };
    },
    async updateRecord(objectPlural, id, payload) {
      this.updated.push({
        objectPlural,
        id,
        payload
      });

      if (!ignoreUpdates && objectPlural === 'people') {
        const existing = this.records.get(id) ?? { id };
        this.records.set(id, {
          ...existing,
          ...payload
        });
      }

      return {
        id,
        ...payload
      };
    },
    async createRecord(objectPlural, payload) {
      this.created.push({
        objectPlural,
        payload
      });

      return {
        id: `${objectPlural}-created`,
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
