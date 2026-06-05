import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { PROTECTED_ASSESSMENT_FIELDS } from '../src/integrations/twenty/quickCaptureClient.js';
import { createTwentyQueueDataSource } from '../src/integrations/twenty/queueDataSource.js';
import {
  buildLegacyRetrofitRecommendation,
  classifyLegacyLead
} from '../src/utils/legacyLeadClassifier.js';
import { resolveLegacyOwner } from '../src/utils/legacyOwnerResolver.js';
import { mapLegacyLeadStage } from '../src/utils/legacyLeadStageMapper.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import { planLegacyLeadRetrofit } from '../src/workflows/outbound/legacyLeadRetrofitWorkflow.js';

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('legacy lead classification', () => {
  it('maps Event=true leads to relationship building', () => {
    const result = classifyLegacyLead({
      person: legacyPerson({ eventCustom: true }),
      evidence: emptyEvidence()
    });

    expect(result.inferred.outboundPipelineType).toBe('RELATIONSHIP_BUILDING');
    expect(result.inferred.cadenceName).toBe('RELATIONSHIP_BUILDING_V1');
    expect(result.evidence.classificationReasons).toContain('Event boolean is true.');
  });

  it('maps task history to relationship building', () => {
    const result = classifyLegacyLead({
      person: legacyPerson(),
      evidence: {
        ...emptyEvidence(),
        taskCount: 2
      }
    });

    expect(result.inferred.outboundPipelineType).toBe('RELATIONSHIP_BUILDING');
    expect(result.evidence.classificationReasons).toContain('Task history exists.');
  });

  it('maps leads with no relationship evidence to the assessment campaign', () => {
    const result = classifyLegacyLead({
      person: legacyPerson(),
      evidence: emptyEvidence()
    });

    expect(result.inferred.outboundPipelineType).toBe('ASSESSMENT_CAMPAIGN');
    expect(result.inferred.cadenceName).toBe('ASSESSMENT_CAMPAIGN_V1');
    expect(result.inferred.latestTouchStatus).toBe('DRAFTED');
  });

  it('maps manual leadStage values to outbound cadence recommendations', () => {
    expect(mapLegacyLeadStage('IDENTIFIED').updates).toMatchObject({
      cadenceStage: 'NOT_STARTED',
      discoveryReadiness: 'NOT_READY'
    });
    expect(
      mapLegacyLeadStage('OUTREACH_INITIATED', {
        hasConnectionTask: true
      }).updates
    ).toMatchObject({
      cadenceStage: 'INTRO_MESSAGE',
      latestTouchStatus: 'SENT'
    });
    expect(mapLegacyLeadStage('DISCOVERY_READY').updates).toMatchObject({
      cadenceStage: 'DISCOVERY_ASK',
      discoveryReadiness: 'READY',
      leadHealthScore: 85
    });
    expect(mapLegacyLeadStage('UNQUALIFIED_CLOSED').updates).toMatchObject({
      cadenceStage: 'PAUSED',
      staleRisk: 'STALE',
      latestTouchStatus: 'DECLINED'
    });
  });

  it('uses completed LinkedIn Day 2 task history to advance cadence inference', () => {
    const recommendation = buildLegacyRetrofitRecommendation({
      person: legacyPerson({
        leadStage: 'OUTREACH_INITIATED'
      }),
      evidence: {
        ...emptyEvidence(),
        taskCount: 2,
        completedTaskCount: 1,
        historicalTaskStage: 'VALUE_TOUCH',
        historicalTaskIds: ['task-li-day-2'],
        historicalTaskReasons: ['Completed task "LI: Day 2" maps to VALUE_TOUCH.']
      },
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(recommendation.inferredCadenceStage).toBe('VALUE_TOUCH');
    expect(recommendation.evidence.historicalTaskStage).toBe('VALUE_TOUCH');
    expect(recommendation.evidence.completedTaskCount).toBe(1);
    expect(recommendation.warnings).toContain(
      'Historical task evidence advanced cadence inference to VALUE_TOUCH.'
    );
  });

  it('never recommends protected assessment fields for legacy retrofit updates', () => {
    const recommendation = buildLegacyRetrofitRecommendation({
      person: legacyPerson({
        assessmentCompleted: false,
        assessmentScore: 42,
        lastTouchDate: '2026-06-01',
        leadstageAuto: 'NEW_LEAD',
        messageAngle: 'Protected assessment angle',
        nextFollowUpDate: '2026-06-10'
      }),
      evidence: {
        ...emptyEvidence(),
        taskCount: 1
      },
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    for (const fieldName of PROTECTED_ASSESSMENT_FIELDS) {
      expect(recommendation.recommendedUpdates).not.toHaveProperty(fieldName);
    }
  });

  it('adds unresolved owner warnings without blocking otherwise safe updates', () => {
    const recommendation = buildLegacyRetrofitRecommendation({
      person: legacyPerson({
        owner: {
          name: 'Unknown Owner'
        }
      }),
      evidence: emptyEvidence(),
      ownerResolution: resolveLegacyOwner({
        person: legacyPerson({
          owner: {
            name: 'Unknown Owner'
          }
        }),
        workspaceMembers: []
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(recommendation.ownerResolutionStatus).toBe('unresolved');
    expect(recommendation.warnings).toContain(
      'Owner could not be resolved; retrofit can proceed but rep assignment may need review.'
    );
    expect(recommendation.safeToUpdate).toBe(true);
  });
});

describe('legacy owner resolution', () => {
  it('resolves ownerId through workspaceMembers', () => {
    const owner = resolveLegacyOwner({
      person: legacyPerson({
        ownerId: 'workspace-member-chandler'
      }),
      workspaceMembers: [
        {
          id: 'workspace-member-chandler',
          userEmail: 'chandler@visiblegap.com',
          name: {
            firstName: 'Chandler',
            lastName: 'Johnson'
          }
        }
      ]
    });

    expect(owner).toMatchObject({
      ownerId: 'workspace-member-chandler',
      ownerEmail: 'chandler@visiblegap.com',
      ownerWorkspaceMemberId: 'workspace-member-chandler',
      ownerResolutionStatus: 'resolved',
      recommendedWorkspaceEmail: 'chandler@visiblegap.com'
    });
  });

  it.each([
    ['Chandler Johnson', 'chandler@visiblegap.com', 'resolved'],
    ['Brayson Grider', 'brayson.grider@visiblegap.com', 'resolved'],
    ['Darrean Beller', 'darrean.beller@visiblegap.com', 'resolved'],
    ['Visible Gap', 'hello@visiblegap.com', 'legacy_visible_gap']
  ])('maps legacy owner name %s to %s', (ownerName, expectedEmail, expectedStatus) => {
    const owner = resolveLegacyOwner({
      person: legacyPerson({
        owner: {
          name: ownerName
        }
      }),
      workspaceMembers: []
    });

    expect(owner.ownerName).toBe(ownerName);
    expect(owner.ownerEmail).toBe(expectedEmail);
    expect(owner.recommendedWorkspaceEmail).toBe(expectedEmail);
    expect(owner.ownerResolutionStatus).toBe(expectedStatus);
  });

  it('keeps existing ownerId as the winner over Created By', () => {
    const owner = resolveLegacyOwner({
      person: legacyPerson({
        ownerId: 'workspace-member-chandler',
        createdBy: {
          workspaceMemberId: 'workspace-member-brayson',
          name: 'Brayson Grider'
        }
      }),
      workspaceMembers: workspaceMembers()
    });

    expect(owner).toMatchObject({
      ownerId: 'workspace-member-chandler',
      ownerName: 'Chandler Johnson',
      ownerEmail: 'chandler@visiblegap.com',
      ownerWorkspaceMemberId: 'workspace-member-chandler',
      createdById: 'workspace-member-brayson',
      createdByName: 'Brayson Grider',
      createdByEmail: 'brayson.grider@visiblegap.com',
      ownerResolutionStatus: 'resolved',
      ownerRecommendation: null,
      recommendedWorkspaceEmail: 'chandler@visiblegap.com'
    });
  });

  it('uses Created By when owner is missing', () => {
    const owner = resolveLegacyOwner({
      person: legacyPerson({
        createdBy: {
          source: 'MANUAL',
          workspaceMemberId: 'workspace-member-brayson',
          name: 'Brayson Grider',
          context: {}
        }
      }),
      workspaceMembers: workspaceMembers()
    });

    expect(owner).toMatchObject({
      ownerId: null,
      ownerName: 'Brayson Grider',
      ownerEmail: 'brayson.grider@visiblegap.com',
      ownerWorkspaceMemberId: 'workspace-member-brayson',
      createdById: 'workspace-member-brayson',
      createdByName: 'Brayson Grider',
      createdByEmail: 'brayson.grider@visiblegap.com',
      inferredOwnerName: 'Brayson Grider',
      inferredOwnerEmail: 'brayson.grider@visiblegap.com',
      inferredOwnerWorkspaceMemberId: 'workspace-member-brayson',
      ownerResolutionStatus: 'inferred_from_created_by',
      recommendedWorkspaceEmail: 'brayson.grider@visiblegap.com',
      ownerRecommendation: {
        source: 'created_by',
        recommendedOwnerEmail: 'brayson.grider@visiblegap.com',
        futureOwnerRecommendation: {
          ownerId: 'workspace-member-brayson'
        }
      }
    });
  });

  it.each([
    ['Chandler Johnson', 'chandler@visiblegap.com'],
    ['Brayson Grider', 'brayson.grider@visiblegap.com'],
    ['Darrean Beller', 'darrean.beller@visiblegap.com']
  ])('maps Created By name %s to %s when owner is missing', (createdByName, expectedEmail) => {
    const owner = resolveLegacyOwner({
      person: legacyPerson({
        createdBy: {
          source: 'MANUAL',
          name: createdByName,
          context: {}
        }
      }),
      workspaceMembers: []
    });

    expect(owner.createdByName).toBe(createdByName);
    expect(owner.ownerResolutionStatus).toBe('inferred_from_created_by');
    expect(owner.ownerEmail).toBe(expectedEmail);
    expect(owner.recommendedWorkspaceEmail).toBe(expectedEmail);
    expect(owner.ownerRecommendation).toMatchObject({
      source: 'created_by',
      recommendedOwnerEmail: expectedEmail
    });
  });

  it('maps Visible Gap Created By to Chandler when no stronger user-level creator exists', () => {
    const owner = resolveLegacyOwner({
      person: legacyPerson({
        createdBy: {
          source: 'MANUAL',
          workspaceMemberId: 'workspace-member-visible-gap',
          name: 'Visible Gap',
          context: {}
        }
      }),
      workspaceMembers: workspaceMembers()
    });

    expect(owner).toMatchObject({
      createdById: 'workspace-member-visible-gap',
      createdByName: 'Visible Gap',
      createdByEmail: 'hello@visiblegap.com',
      ownerName: 'Chandler Johnson',
      ownerEmail: 'chandler@visiblegap.com',
      ownerWorkspaceMemberId: 'workspace-member-chandler',
      ownerResolutionStatus: 'inferred_from_created_by',
      ownerRecommendation: {
        source: 'created_by_visible_gap_fallback',
        recommendedOwnerEmail: 'chandler@visiblegap.com'
      }
    });
  });

  it('adds a missing-owner warning when Created By cannot be resolved', () => {
    const owner = resolveLegacyOwner({
      person: legacyPerson({
        createdBy: {
          source: 'IMPORT',
          name: 'Unknown Creator',
          context: {}
        }
      }),
      workspaceMembers: []
    });

    expect(owner).toMatchObject({
      createdByName: 'Unknown Creator',
      ownerResolutionStatus: 'missing',
      ownerRecommendation: null,
      recommendedWorkspaceEmail: null
    });
    expect(owner.warnings).toContain('Owner missing and Created By could not be resolved.');
  });
});

describe('legacy lead retrofit planner', () => {
  it('fetches multiple cursor pages in all mode', async () => {
    const result = await planLegacyLeadRetrofit({
      config: {
        twenty: {
          apiKey: 'metadata-only',
          apiBaseUrl: 'https://api.twenty.com'
        }
      },
      dataSource: fakeLegacyDataSource({
        allRecords: true,
        pagination: {
          requestedMode: 'all',
          pageSize: 2,
          maxPages: 3,
          objects: {
            people: {
              objectPlural: 'people',
              mechanism: 'cursor',
              cursorParam: 'starting_after',
              pageSize: 2,
              maxPages: 3,
              pagesFetched: 2,
              totalFetched: 3,
              totalCount: 3,
              hasMore: false,
              nextCursor: 'cursor-page-2'
            }
          }
        }
      }),
      metadataClient: fakeMetadataClient(),
      log: silentLog,
      all: true,
      pageSize: 2,
      maxPages: 3,
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.pagination).toMatchObject({
      requestedMode: 'all',
      pageSize: 2,
      pagesFetched: 2,
      totalFetched: 3,
      totalCount: 3,
      hasMore: false,
      finalPlanCount: 3
    });
    expect(result.summary.totalRecords).toBe(3);
  });

  it('warns when all mode fetches exactly one 100-record page while more likely exists', async () => {
    const people = Array.from({ length: 100 }, (_, index) =>
      legacyPerson({
        id: `legacy-${index}`,
        emails: {
          primaryEmail: `legacy-${index}@example.com`
        }
      })
    );
    const result = await planLegacyLeadRetrofit({
      config: {
        twenty: {
          apiKey: 'metadata-only',
          apiBaseUrl: 'https://api.twenty.com'
        }
      },
      dataSource: fakeLegacyDataSource({
        allRecords: true,
        people,
        pagination: {
          requestedMode: 'all',
          pageSize: 100,
          maxPages: 10,
          objects: {
            people: {
              objectPlural: 'people',
              mechanism: 'single_page_fallback',
              pageSize: 100,
              maxPages: 10,
              pagesFetched: 1,
              totalFetched: 100,
              totalCount: 323,
              hasMore: true,
              nextCursor: 'cursor-page-1'
            }
          }
        }
      }),
      metadataClient: fakeMetadataClient(),
      log: silentLog,
      all: true,
      pageSize: 100,
      maxPages: 10,
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.warnings).toContain(
      'LEGACY_RETROFIT_ALL=true fetched exactly one page while Twenty reports more records; check cursor pagination before applying.'
    );
    expect(result.warnings.join(' ')).toContain('stopped before all People were fetched');
  });

  it('uses the Twenty queue data source all-record cursor fetch path', async () => {
    const calls = [];
    const dataSource = createTwentyQueueDataSource({
      restClient: {
        async listAllRecords(objectPlural, options) {
          calls.push({ objectPlural, options });
          return {
            records: objectPlural === 'people' ? [legacyPerson({ id: 'people-page-1' })] : [],
            warnings: [],
            pagination: {
              objectPlural,
              mechanism: 'cursor',
              cursorParam: 'starting_after',
              pageSize: options.pageSize,
              maxPages: options.maxPages,
              pagesFetched: objectPlural === 'people' ? 2 : 1,
              totalFetched: objectPlural === 'people' ? 1 : 0,
              totalCount: objectPlural === 'people' ? 1 : 0,
              hasMore: false,
              nextCursor: null
            }
          };
        }
      }
    });

    const result = await dataSource.listAllQueueRecords({
      pageSize: 100,
      maxPages: 10
    });

    expect(calls.find((call) => call.objectPlural === 'people')).toMatchObject({
      options: {
        pageSize: 100,
        maxPages: 10
      }
    });
    expect(result.people).toHaveLength(1);
    expect(result.pagination.objects.people).toMatchObject({
      mechanism: 'cursor',
      pagesFetched: 2
    });
  });

  it('builds a dry-run plan from taskTargets without live writes', async () => {
    const result = await planLegacyLeadRetrofit({
      config: {
        twenty: {
          apiKey: 'metadata-only',
          apiBaseUrl: 'https://api.twenty.com'
        }
      },
      dataSource: fakeLegacyDataSource(),
      metadataClient: fakeMetadataClient(),
      log: silentLog,
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    const byId = new Map(result.plans.map((plan) => [plan.personId, plan]));

    expect(result.status).toBe('dry_run');
    expect(result.dryRun).toBe(true);
    expect(result.summary).toMatchObject({
      totalRecords: 3,
      needingUpdate: 3,
      safeToUpdate: 3,
      recordsWithResolvedOwner: 1,
      recordsWithMissingOwner: 1,
      recordsWithUnresolvedOwner: 0,
      recordsInferredFromCreatedBy: 1,
      recordsStillMissingOwner: 1,
      recordsOwnedByVisibleGap: 0
    });
    expect(result.summary.recordsByOwner).toMatchObject({
      'Chandler Johnson': 1,
      'Brayson Grider': 1,
      'Missing owner': 1
    });
    expect(result.summary.recordsByCreatedBy).toMatchObject({
      'Brayson Grider': 1,
      'Missing Created By': 2
    });
    expect(result.summary.recordsByRecommendedWorkspaceEmail).toMatchObject({
      'chandler@visiblegap.com': 1,
      'brayson.grider@visiblegap.com': 1
    });
    expect(result.summary.ownerRecommendationsByPerson['legacy-task']).toMatchObject({
      name: 'Legacy Lead',
      createdByName: 'Brayson Grider',
      recommendedOwnerEmail: 'brayson.grider@visiblegap.com',
      source: 'created_by'
    });
    expect(byId.get('legacy-event').inferredPipelineType).toBe('RELATIONSHIP_BUILDING');
    expect(byId.get('legacy-event')).toMatchObject({
      ownerId: 'workspace-member-chandler',
      ownerName: 'Chandler Johnson',
      ownerEmail: 'chandler@visiblegap.com',
      ownerWorkspaceMemberId: 'workspace-member-chandler',
      ownerResolutionStatus: 'resolved',
      recommendedWorkspaceEmail: 'chandler@visiblegap.com'
    });
    expect(byId.get('legacy-task').inferredPipelineType).toBe('RELATIONSHIP_BUILDING');
    expect(byId.get('legacy-task').evidence.taskTargetIds).toEqual(['target-legacy-task']);
    expect(byId.get('legacy-task').ownerResolutionStatus).toBe('inferred_from_created_by');
    expect(byId.get('legacy-task').ownerRecommendation).toMatchObject({
      recommendedOwnerEmail: 'brayson.grider@visiblegap.com',
      futureOwnerRecommendation: {
        ownerId: 'workspace-member-brayson'
      }
    });
    expect(byId.get('legacy-task').recommendedUpdates).not.toHaveProperty('ownerId');
    expect(byId.get('legacy-new').inferredPipelineType).toBe('ASSESSMENT_CAMPAIGN');
    expect(result.metadata.fields.eventBoolean).toMatchObject({
      exists: true,
      name: 'eventCustom',
      type: 'BOOLEAN'
    });
    expect(result.metadata.fields.manualLeadStage.options).toContain('DISCOVERY_READY');
    expect(result.metadata.fields.createdBy).toMatchObject({
      exists: true,
      name: 'createdBy',
      type: 'ACTOR'
    });
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment processing unaffected by legacy retrofit planning helpers', async () => {
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

function legacyPerson(overrides = {}) {
  return {
    id: 'legacy-person',
    name: {
      firstName: 'Legacy',
      lastName: 'Lead'
    },
    emails: {
      primaryEmail: 'legacy@example.com'
    },
    company: {
      name: 'Legacy Co'
    },
    ...overrides
  };
}

function emptyEvidence() {
  return {
    taskCount: 0,
    noteCount: 0,
    timelineCount: 0,
    hasConnectionTask: false
  };
}

function fakeLegacyDataSource({ allRecords = false, people, pagination } = {}) {
  const records = {
    people: people ?? [
      legacyPerson({
        id: 'legacy-event',
        eventCustom: true,
        leadStage: 'ENGAGED',
        ownerId: 'workspace-member-chandler',
        emails: {
          primaryEmail: 'event@example.com'
        }
      }),
      legacyPerson({
        id: 'legacy-task',
        createdBy: {
          source: 'MANUAL',
          workspaceMemberId: 'workspace-member-brayson',
          name: 'Brayson Grider',
          context: {}
        },
        emails: {
          primaryEmail: 'task@example.com'
        }
      }),
      legacyPerson({
        id: 'legacy-new',
        emails: {
          primaryEmail: 'new@example.com'
        }
      })
    ],
    tasks: [
      {
        id: 'task-legacy-task',
        title: 'Send connection request',
        bodyV2: {
          markdown: 'Cadence note'
        }
      }
    ],
    taskTargets: [
      {
        id: 'target-legacy-task',
        taskId: 'task-legacy-task',
        targetPersonId: 'legacy-task'
      }
    ],
    noteTargets: [],
    timelineActivities: [],
    workspaceMembers: workspaceMembers(),
    warnings: []
  };

  return {
    provider: 'fake-twenty',
    async listQueueRecords() {
      return records;
    },
    ...(allRecords
      ? {
          async listAllQueueRecords() {
            return {
              ...records,
              pagination
            };
          }
        }
      : {})
  };
}

function workspaceMembers() {
  return [
    {
      id: 'workspace-member-chandler',
      userEmail: 'chandler@visiblegap.com',
      name: {
        firstName: 'Chandler',
        lastName: 'Johnson'
      }
    },
    {
      id: 'workspace-member-brayson',
      userEmail: 'brayson.grider@visiblegap.com',
      name: {
        firstName: 'Brayson',
        lastName: 'Grider'
      }
    },
    {
      id: 'workspace-member-darrean',
      userEmail: 'darrean.beller@visiblegap.com',
      name: {
        firstName: 'Darrean',
        lastName: 'Beller'
      }
    },
    {
      id: 'workspace-member-visible-gap',
      userEmail: 'hello@visiblegap.com',
      name: {
        firstName: 'Visible',
        lastName: 'Gap'
      }
    }
  ];
}

function fakeMetadataClient() {
  return {
    async discoverSchema() {
      return {
        objectsBySingularName: {
          person: {
            fieldsByName: {
              eventCustom: field('eventCustom', 'Event', 'BOOLEAN'),
              leadStage: field('leadStage', 'Lead Stage', 'SELECT', {
                options: [
                  'IDENTIFIED',
                  'OUTREACH_INITIATED',
                  'ENGAGED',
                  'ACTIVE_CONVERSATION',
                  'DISCOVERY_READY',
                  'UNQUALIFIED_CLOSED',
                  'ACTIVE_CLIENT'
                ]
              }),
              owner: field('owner', 'Owner', 'RELATION', {
                relationType: 'MANY_TO_ONE',
                joinColumnName: 'ownerId'
              }),
              createdBy: field('createdBy', 'Created by', 'ACTOR'),
              company: field('company', 'Company', 'RELATION', {
                relationType: 'MANY_TO_ONE',
                joinColumnName: 'companyId'
              }),
              taskTargets: field('taskTargets', 'Task Targets', 'RELATION'),
              noteTargets: field('noteTargets', 'Note Targets', 'RELATION'),
              timelineActivities: field('timelineActivities', 'Timeline Activities', 'RELATION')
            }
          }
        },
        objectsByPluralName: {}
      };
    }
  };
}

function field(name, label, type, extras = {}) {
  return {
    name,
    label,
    type,
    options: (extras.options ?? []).map((value) => ({ value })),
    settings: {
      relationType: extras.relationType,
      joinColumnName: extras.joinColumnName
    }
  };
}
