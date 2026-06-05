import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import {
  applyLegacyOwnerCleanup,
  buildOwnerUpdatePayload,
  planLegacyOwnerCleanup,
  selectOwnerApplyCandidates
} from '../src/workflows/outbound/legacyOwnerCleanupWorkflow.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('legacy owner cleanup planner', () => {
  it('uses the confirmed owner join column for payload shape', () => {
    const plan = planLegacyOwnerCleanup({
      retrofitPlan: fakeRetrofitPlan(),
      now: new Date('2026-06-05T12:00:00.000Z')
    });

    expect(plan.metadata.payloadShape).toMatchObject({
      method: 'PATCH',
      objectPlural: 'people',
      relationField: 'owner',
      joinColumnName: 'ownerId',
      examplePayload: {
        ownerId: '<workspaceMemberId>'
      }
    });
    expect(buildOwnerUpdatePayload(plan.recommendations[0])).toEqual({
      ownerId: 'workspace-member-brayson'
    });
  });

  it('includes missing-owner recommendations and skips existing owners by default', () => {
    const plan = planLegacyOwnerCleanup({
      retrofitPlan: fakeRetrofitPlan()
    });

    expect(plan.summary).toMatchObject({
      totalRecommendations: 2,
      safeToUpdate: 1,
      skippedExistingOwner: 1
    });
    expect(plan.recommendations.find((record) => record.personId === 'person-missing-owner')).toMatchObject({
      safeToUpdate: true,
      currentOwnerId: null,
      recommendedOwnerId: 'workspace-member-brayson'
    });
    expect(plan.recommendations.find((record) => record.personId === 'person-existing-owner')).toMatchObject({
      safeToUpdate: false,
      currentOwnerId: 'workspace-member-chandler'
    });
  });

  it('allows existing owner recommendations when force overwrite is enabled', () => {
    const plan = planLegacyOwnerCleanup({
      retrofitPlan: fakeRetrofitPlan(),
      forceOverwrite: true
    });

    expect(plan.summary).toMatchObject({
      totalRecommendations: 2,
      safeToUpdate: 2,
      skippedExistingOwner: 0
    });
    expect(plan.recommendations.find((record) => record.personId === 'person-existing-owner')).toMatchObject({
      safeToUpdate: true,
      reason: 'Existing owner overwrite explicitly requested.'
    });
  });
});

describe('legacy owner cleanup apply workflow', () => {
  it('does not write without live guards', async () => {
    const restClient = fakeRestClient();
    const ownerPlan = planLegacyOwnerCleanup({
      retrofitPlan: fakeRetrofitPlan()
    });
    const result = await applyLegacyOwnerCleanup({
      plan: ownerPlan,
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
      planned: 1,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      verificationFailed: 0
    });
    expect(restClient.updated).toEqual([]);
  });

  it('respects batch size, offset, and missing-owner-only defaults', () => {
    const ownerPlan = planLegacyOwnerCleanup({
      retrofitPlan: {
        ...fakeRetrofitPlan(),
        plans: [
          missingOwnerRecord('person-1'),
          missingOwnerRecord('person-2'),
          missingOwnerRecord('person-3')
        ]
      }
    });

    expect(
      selectOwnerApplyCandidates(ownerPlan, {
        batchSize: 1,
        offset: 1
      }).map((record) => record.personId)
    ).toEqual(['person-2']);
  });

  it('updates owner and verifies ownerId after write', async () => {
    const store = fakeOperationalStore();
    const restClient = fakeRestClient();
    const ownerPlan = planLegacyOwnerCleanup({
      retrofitPlan: fakeRetrofitPlan()
    });
    const result = await applyLegacyOwnerCleanup({
      plan: ownerPlan,
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

    expect(result.dryRun).toBe(false);
    expect(result.summary).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      verificationFailed: 0,
      personIdsUpdated: ['person-missing-owner'],
      auditIds: ['audit-1'],
      outboundEventIds: ['event-1']
    });
    expect(restClient.updated).toEqual([
      {
        objectPlural: 'people',
        id: 'person-missing-owner',
        payload: {
          ownerId: 'workspace-member-brayson'
        }
      }
    ]);
    expect(restClient.fetched).toEqual([
      {
        objectPlural: 'people',
        id: 'person-missing-owner'
      }
    ]);
    expect(store.crmSyncLogs[0]).toMatchObject({
      status: 'succeeded',
      action: 'legacy_owner_cleanup_update'
    });
    expect(store.outboundEvents[0]).toMatchObject({
      eventType: 'legacy_owner_cleanup_applied',
      status: 'sent'
    });
  });

  it('marks verification_failed when fetched ownerId does not match expected owner', async () => {
    const ownerPlan = planLegacyOwnerCleanup({
      retrofitPlan: fakeRetrofitPlan()
    });
    const result = await applyLegacyOwnerCleanup({
      plan: ownerPlan,
      config: baseConfig(),
      restClient: fakeRestClient({
        verifiedOwnerId: 'workspace-member-other'
      }),
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        batchSize: 5,
        offset: 0
      }
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toMatchObject({
      attempted: 1,
      succeeded: 0,
      verificationFailed: 1
    });
    expect(result.operations[0]).toMatchObject({
      status: 'verification_failed',
      verification: {
        ok: false,
        expectedOwnerId: 'workspace-member-brayson',
        actualOwnerId: 'workspace-member-other'
      }
    });
  });

  it('does not include protected assessment fields in owner cleanup payloads', () => {
    const ownerPlan = planLegacyOwnerCleanup({
      retrofitPlan: fakeRetrofitPlan()
    });

    expect(buildOwnerUpdatePayload(ownerPlan.recommendations[0])).toEqual({
      ownerId: 'workspace-member-brayson'
    });
    expect(buildOwnerUpdatePayload(ownerPlan.recommendations[0])).not.toHaveProperty('assessmentScore');
    expect(buildOwnerUpdatePayload(ownerPlan.recommendations[0])).not.toHaveProperty('leadstageAuto');
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment processing unaffected by legacy owner cleanup helpers', async () => {
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

function fakeRetrofitPlan() {
  return {
    metadata: {
      fields: {
        owner: {
          exists: true,
          name: 'owner',
          label: 'Owner',
          type: 'RELATION',
          joinColumnName: 'ownerId'
        }
      }
    },
    plans: [
      missingOwnerRecord('person-missing-owner'),
      {
        ...missingOwnerRecord('person-existing-owner'),
        ownerId: 'workspace-member-chandler',
        ownerName: 'Chandler Johnson'
      },
      {
        personId: 'person-no-recommendation',
        name: 'No Recommendation',
        ownerId: null,
        ownerRecommendation: null
      }
    ]
  };
}

function missingOwnerRecord(personId) {
  return {
    personId,
    name: `Lead ${personId}`,
    ownerId: null,
    ownerName: null,
    createdByName: 'Brayson Grider',
    ownerRecommendation: {
      source: 'created_by',
      recommendedOwnerName: 'Brayson Grider',
      recommendedOwnerEmail: 'brayson.grider@visiblegap.com',
      recommendedOwnerWorkspaceMemberId: 'workspace-member-brayson',
      futureOwnerRecommendation: {
        ownerId: 'workspace-member-brayson'
      }
    }
  };
}

function fakeRestClient({ fail = false, verifiedOwnerId = 'workspace-member-brayson' } = {}) {
  return {
    updated: [],
    fetched: [],
    async updateRecord(objectPlural, id, payload) {
      this.updated.push({ objectPlural, id, payload });

      if (fail) {
        const error = new Error('Twenty owner update failed');
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
    },
    async getRecord(objectPlural, id) {
      this.fetched.push({ objectPlural, id });

      return {
        id,
        ownerId: verifiedOwnerId
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
