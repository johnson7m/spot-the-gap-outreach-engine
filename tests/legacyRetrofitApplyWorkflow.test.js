import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import {
  applyLegacyRetrofitPlan,
  buildPersonUpdatePayload,
  selectApplyCandidates,
  validateNoProtectedFields
} from '../src/workflows/outbound/applyLegacyRetrofitWorkflow.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('legacy retrofit apply workflow', () => {
  it('keeps writes blocked when live guards are disabled', async () => {
    const restClient = fakeRestClient();

    const result = await applyLegacyRetrofitPlan({
      plan: fakePlan(),
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

    expect(result.dryRun).toBe(true);
    expect(result.summary).toMatchObject({
      planned: 2,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0
    });
    expect(restClient.updated).toEqual([]);
  });

  it('respects batch size and offset', () => {
    expect(
      selectApplyCandidates(fakePlan(), {
        batchSize: 1,
        offset: 1
      }).map((record) => record.personId)
    ).toEqual(['person-safe-2']);
  });

  it('excludes already-retrofitted records from apply selection', () => {
    const selected = selectApplyCandidates(
      fakePlan({
        plans: [
          alreadyRetrofittedRecord('person-already-1'),
          safeRecord('person-safe-1'),
          alreadyRetrofittedRecord('person-already-2'),
          safeRecord('person-safe-2')
        ]
      }),
      {
        batchSize: 10,
        offset: 0
      }
    );

    expect(selected.map((record) => record.personId)).toEqual(['person-safe-1', 'person-safe-2']);
  });

  it('applies batch offset to eligible update records instead of raw plan rows', () => {
    const selected = selectApplyCandidates(
      fakePlan({
        plans: [
          alreadyRetrofittedRecord('person-already-1'),
          safeRecord('person-safe-1'),
          alreadyRetrofittedRecord('person-already-2'),
          safeRecord('person-safe-2'),
          safeRecord('person-safe-3')
        ]
      }),
      {
        batchSize: 1,
        offset: 1
      }
    );

    expect(selected.map((record) => record.personId)).toEqual(['person-safe-2']);
  });

  it('skips manual review records by default', () => {
    const selected = selectApplyCandidates(fakePlan(), {
      batchSize: 10,
      offset: 0
    });

    expect(selected.map((record) => record.personId)).not.toContain('person-manual-review');
  });

  it('excludes ownerRecommendation and owner fields from update payloads', () => {
    const payload = buildPersonUpdatePayload({
      record: {
        currentFields: {},
        ownerRecommendation: {
          futureOwnerRecommendation: {
            ownerId: 'workspace-member-owner'
          }
        },
        recommendedUpdates: {
          outboundPipelineType: 'RELATIONSHIP_BUILDING',
          ownerId: 'workspace-member-owner',
          ownerName: 'Chandler Johnson',
          recommendedWorkspaceEmail: 'chandler@visiblegap.com'
        }
      }
    });

    expect(payload).toEqual({
      outboundPipelineType: 'RELATIONSHIP_BUILDING'
    });
  });

  it('rejects protected assessment fields before applying', () => {
    const validation = validateNoProtectedFields({
      plans: [
        {
          personId: 'person-protected',
          recommendedUpdates: {
            assessmentScore: 90
          }
        }
      ]
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors[0]).toMatchObject({
      personId: 'person-protected',
      protectedFields: ['assessmentScore']
    });
  });

  it('applies only missing fields unless force overwrite is enabled', () => {
    const record = {
      currentFields: {
        cadenceStage: 'CONNECTION_REQUEST',
        leadHealthScore: null
      },
      recommendedUpdates: {
        cadenceStage: 'INTRO_MESSAGE',
        leadHealthScore: 55
      }
    };

    expect(buildPersonUpdatePayload({ record, forceOverwrite: false })).toEqual({
      leadHealthScore: 55
    });
    expect(buildPersonUpdatePayload({ record, forceOverwrite: true })).toEqual({
      cadenceStage: 'INTRO_MESSAGE',
      leadHealthScore: 55
    });
  });

  it('plans crm_sync_logs and outbound_events in dry-run mode', async () => {
    const result = await applyLegacyRetrofitPlan({
      plan: fakePlan(),
      config: baseConfig(),
      options: {
        batchSize: 1,
        offset: 0
      }
    });

    expect(result.operations[0].crmSyncLog.planned).toMatchObject({
      provider: 'twenty',
      objectName: 'person',
      action: 'legacy_retrofit_update',
      status: 'dry_run'
    });
    expect(result.operations[0].outboundEvent.planned).toMatchObject({
      eventType: 'legacy_retrofit_applied',
      actorType: 'system',
      status: 'planned'
    });
  });

  it('writes crm_sync_logs and outbound_events during guarded live execution', async () => {
    const store = fakeOperationalStore();
    const restClient = fakeRestClient();
    const result = await applyLegacyRetrofitPlan({
      plan: fakePlan(),
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

    expect(result.dryRun).toBe(false);
    expect(result.summary).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      personIdsUpdated: ['person-safe-1'],
      auditIds: ['audit-1'],
      outboundEventIds: ['event-1']
    });
    expect(restClient.updated).toEqual([
      {
        objectPlural: 'people',
        id: 'person-safe-1',
        payload: {
          outboundPipelineType: 'RELATIONSHIP_BUILDING',
          cadenceName: 'RELATIONSHIP_BUILDING_V1'
        }
      }
    ]);
    expect(store.crmSyncLogs[0]).toMatchObject({
      status: 'succeeded',
      objectName: 'person'
    });
    expect(store.outboundEvents[0]).toMatchObject({
      eventType: 'legacy_retrofit_applied',
      status: 'sent'
    });
  });

  it('stops after repeated failures', async () => {
    const restClient = fakeRestClient({ fail: true });
    const result = await applyLegacyRetrofitPlan({
      plan: fakePlan({
        plans: [
          safeRecord('person-safe-1'),
          safeRecord('person-safe-2'),
          safeRecord('person-safe-3')
        ]
      }),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        batchSize: 3,
        offset: 0
      }
    });

    expect(result.summary).toMatchObject({
      attempted: 2,
      failed: 2,
      skipped: 1
    });
    expect(result.operations[2]).toMatchObject({
      status: 'skipped',
      skippedReason: 'Stopped after repeated failures.'
    });
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment processing unaffected by legacy retrofit apply helpers', async () => {
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
        currentFields: {
          outboundPipelineType: 'RELATIONSHIP_BUILDING',
          cadenceName: null
        },
        recommendedUpdates: {
          outboundPipelineType: 'ASSESSMENT_CAMPAIGN',
          cadenceName: 'ASSESSMENT_CAMPAIGN_V1'
        }
      }),
      {
        ...safeRecord('person-manual-review'),
        safeToUpdate: false,
        warnings: ['Missing strong contact identifiers; manual review recommended.']
      }
    ],
    ...overrides
  };
}

function safeRecord(personId, overrides = {}) {
  return {
    personId,
    name: `Lead ${personId}`,
    safeToUpdate: true,
    currentFields: {
      outboundPipelineType: null,
      cadenceName: null
    },
    recommendedUpdates: {
      outboundPipelineType: 'RELATIONSHIP_BUILDING',
      cadenceName: 'RELATIONSHIP_BUILDING_V1'
    },
    ownerRecommendation: {
      futureOwnerRecommendation: {
        ownerId: 'workspace-member-owner'
      }
    },
    ...overrides
  };
}

function alreadyRetrofittedRecord(personId, overrides = {}) {
  return {
    ...safeRecord(personId),
    recommendedUpdates: {},
    currentFields: {
      outboundPipelineType: 'RELATIONSHIP_BUILDING',
      cadenceName: 'RELATIONSHIP_BUILDING_V1'
    },
    safeToUpdate: false,
    warnings: ['No missing outbound fields detected.'],
    ...overrides
  };
}

function fakeRestClient({ fail = false } = {}) {
  return {
    updated: [],
    async updateRecord(objectPlural, id, payload) {
      this.updated.push({ objectPlural, id, payload });

      if (fail) {
        const error = new Error('Twenty update failed');
        error.twentyDiagnostics = {
          httpStatus: 400,
          responseBody: {
            message: 'Bad Request'
          }
        };
        throw error;
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
