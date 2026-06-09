import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { requireWorkspaceAuth } from '../src/middleware/supabaseWorkspaceAuth.js';
import {
  clearTwentyQueueReadCache,
  createTwentyQueueDataSource
} from '../src/integrations/twenty/queueDataSource.js';
import { handleQueueFetch, handleQueueSummaryFetch } from '../src/routes/api/queueRoutes.js';
import {
  buildQueueClassificationDiagnostics,
  buildQueueCoverageAudit
} from '../src/services/queueService.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import {
  getOutboundQueueSummaryWorkflow,
  getOutboundQueueWorkflow
} from '../src/workflows/outbound/getQueueWorkflow.js';
import { buildMissingNextTaskPlans } from '../src/workflows/outbound/missingNextTaskPlanner.js';
import { buildManualLeadNormalizationPlans } from '../src/workflows/outbound/manualLeadNormalizationPlanner.js';
import { buildSentInitialFollowUpPlans } from '../src/workflows/outbound/sentInitialFollowUpPlanner.js';

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

  it('returns queue pagination metadata with page count and total count', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all',
        limit: 1,
        offset: 0
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource(),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result).toMatchObject({
      count: 1,
      totalCount: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
      nextOffset: 1
    });
    expect(result.items).toHaveLength(1);
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

  it('keeps newly generated initial tasks with old Person next-touch dates in Fresh Leads', async () => {
    const people = [
      queueLead('people-generated-initial', {
        cadenceName: 'RELATIONSHIP_BUILDING_V1',
        cadenceStage: 'NOT_STARTED',
        latestTouchStatus: 'DRAFTED',
        nextOutboundTouchDate: '2026-06-05'
      })
    ];
    const tasks = [
      queueTask('tasks-generated-initial', {
        personId: 'people-generated-initial',
        title: 'Send relationship-oriented connection request',
        dueAt: '2026-06-08',
        bodyV2: {
          markdown: [
            'Source: Missing next-task planner',
            'Person ID: people-generated-initial',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Cadence stage: NOT_STARTED',
            'Task type: connection_request',
            'Due date adjusted: true'
          ].join('\n')
        }
      })
    ];
    const fresh = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-06T15:00:00.000Z')
    });
    const stale = await getOutboundQueueWorkflow({
      queueSlug: 'stale-recovery',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-06T15:00:00.000Z')
    });

    expect(fresh.items.map((item) => item.personId)).toEqual(['people-generated-initial']);
    expect(fresh.items[0]).toMatchObject({
      taskId: 'tasks-generated-initial',
      queueClassification: 'fresh_initial_task'
    });
    expect(stale.items.map((item) => item.personId)).not.toContain('people-generated-initial');
  });

  it('does not route SENT initial-touch gaps to Stale Recovery solely because next-touch is old', async () => {
    const people = [
      queueLead('people-sent-initial-old-date', {
        cadenceName: 'RELATIONSHIP_BUILDING_V1',
        cadenceStage: 'NOT_STARTED',
        latestTouchStatus: 'SENT',
        nextOutboundTouchDate: '2026-06-01'
      })
    ];
    const tasks = [
      queueTask('tasks-sent-initial-old-date', {
        personId: 'people-sent-initial-old-date',
        title: 'Send relationship-oriented connection request',
        bodyV2: {
          markdown: [
            'Person ID: people-sent-initial-old-date',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Cadence stage: NOT_STARTED',
            'Task type: connection_request'
          ].join('\n')
        }
      })
    ];
    const stale = await getOutboundQueueWorkflow({
      queueSlug: 'stale-recovery',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-06T15:00:00.000Z')
    });
    const followUps = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-08'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-06T15:00:00.000Z')
    });

    expect(stale.items.map((item) => item.personId)).not.toContain('people-sent-initial-old-date');
    expect(followUps.items.map((item) => item.personId)).toEqual(['people-sent-initial-old-date']);
  });

  it('still routes genuinely stale post-initial records to Stale Recovery', async () => {
    const people = [
      queueLead('people-post-initial-stale', {
        cadenceStage: 'INTRO_MESSAGE',
        latestTouchStatus: 'NO_RESPONSE',
        nextOutboundTouchDate: '2026-06-01',
        lastOutboundTouchDate: '2026-04-30'
      })
    ];
    const tasks = [
      queueTask('tasks-post-initial-stale', {
        personId: 'people-post-initial-stale',
        title: 'Send contextual introduction',
        bodyV2: {
          markdown: [
            'Person ID: people-post-initial-stale',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Next cadence stage: INTRO_MESSAGE',
            'Latest touch status: NO_RESPONSE'
          ].join('\n')
        }
      })
    ];
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'stale-recovery',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-06T15:00:00.000Z')
    });

    expect(result.items.map((item) => item.personId)).toEqual(['people-post-initial-stale']);
    expect(result.items[0].queueClassificationReasons).toEqual(
      expect.arrayContaining(['latest_touch_no_response', 'last_outbound_touch_older_than_30_days'])
    );
    expect(result.items[0].staleReason).toBe(
      'Latest touch is NO_RESPONSE and last outbound touch is 37 days old.'
    );
  });

  it('keeps overdue post-initial follow-up tasks in Follow-Ups instead of Stale Recovery', async () => {
    const people = [
      queueLead('people-overdue-follow-up', {
        cadenceStage: 'INTRO_MESSAGE',
        latestTouchStatus: 'SENT',
        nextOutboundTouchDate: '2026-06-01'
      })
    ];
    const tasks = [
      queueTask('tasks-overdue-follow-up', {
        personId: 'people-overdue-follow-up',
        title: 'Send contextual introduction',
        dueAt: '2026-06-01',
        bodyV2: {
          markdown: [
            'Person ID: people-overdue-follow-up',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Next cadence stage: INTRO_MESSAGE',
            'Latest touch status: SENT'
          ].join('\n')
        }
      })
    ];
    const followUps = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-08'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });
    const stale = await getOutboundQueueWorkflow({
      queueSlug: 'stale-recovery',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(followUps.items.map((item) => item.personId)).toEqual(['people-overdue-follow-up']);
    expect(followUps.items[0]).toMatchObject({
      dueStatus: 'overdue',
      isOverdueTask: true,
      overdueDays: 7,
      queueClassification: 'follow_up_post_initial_touch'
    });
    expect(stale.items).toHaveLength(0);
  });

  it('keeps overdue first-touch tasks in Fresh Leads instead of Stale Recovery', async () => {
    const people = [
      queueLead('people-overdue-fresh', {
        cadenceStage: 'CONNECTION_REQUEST',
        latestTouchStatus: 'DRAFTED',
        nextOutboundTouchDate: '2026-05-15'
      })
    ];
    const tasks = [
      queueTask('tasks-overdue-fresh', {
        personId: 'people-overdue-fresh',
        title: 'Send relationship-oriented connection request',
        dueAt: '2026-06-01',
        bodyV2: {
          markdown: [
            'Person ID: people-overdue-fresh',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Cadence stage: CONNECTION_REQUEST',
            'Task type: connection_request'
          ].join('\n')
        }
      })
    ];
    const fresh = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });
    const stale = await getOutboundQueueWorkflow({
      queueSlug: 'stale-recovery',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(fresh.items.map((item) => item.personId)).toEqual(['people-overdue-fresh']);
    expect(fresh.items[0]).toMatchObject({
      dueStatus: 'overdue',
      isOverdueTask: true,
      overdueDays: 7,
      queueClassification: 'fresh_initial_task'
    });
    expect(stale.items).toHaveLength(0);
  });

  it('does not classify old nextOutboundTouchDate alone as Stale Recovery', async () => {
    const people = [
      queueLead('people-old-next-touch-only', {
        cadenceStage: 'INTRO_MESSAGE',
        latestTouchStatus: 'SENT',
        nextOutboundTouchDate: '2026-05-01'
      })
    ];
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'stale-recovery',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks: [] }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(result.items).toHaveLength(0);
  });

  it('routes staleRisk=STALE records to Stale Recovery with a stale reason', async () => {
    const people = [
      queueLead('people-stale-risk', {
        cadenceStage: 'VALUE_TOUCH',
        latestTouchStatus: 'SENT',
        staleRisk: 'STALE'
      })
    ];
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'stale-recovery',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks: [] }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(result.items[0]).toMatchObject({
      personId: 'people-stale-risk',
      staleReason: 'staleRisk=STALE',
      queueClassificationReasons: expect.arrayContaining(['stale_risk_stale'])
    });
  });

  it('routes PAUSED stalled cadence records to Stale Recovery', async () => {
    const people = [
      queueLead('people-paused-stalled', {
        cadenceStage: 'PAUSED',
        latestTouchStatus: 'NO_RESPONSE'
      })
    ];
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'stale-recovery',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks: [] }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(result.items[0]).toMatchObject({
      personId: 'people-paused-stalled',
      staleReason: 'Cadence is PAUSED after stalled/no-response outreach.',
      queueClassificationReasons: expect.arrayContaining(['cadence_paused_stalled'])
    });
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

  it('keeps fresh leads actionable when no open task exists', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({
        tasks: []
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });
    const freshLead = result.items.find((item) => item.personId === 'people-fresh');

    expect(freshLead.warnings).toContain(
      'No open task exists yet; create the first cadence task.'
    );
    expect(freshLead.suggestedResolutionActions).toEqual(['create_next_task']);
  });

  it('keeps NOT_STARTED relationship connection requests in Fresh Leads only', async () => {
    const people = [
      queueLead('people-initial-relationship', {
        cadenceName: 'RELATIONSHIP_BUILDING_V1',
        cadenceStage: 'NOT_STARTED',
        latestTouchStatus: 'DRAFTED'
      })
    ];
    const tasks = [
      queueTask('tasks-initial-relationship', {
        personId: 'people-initial-relationship',
        title: 'Send relationship-oriented connection request',
        bodyV2: {
          markdown: [
            'Person ID: people-initial-relationship',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Cadence stage: NOT_STARTED',
            'Task type: connection_request'
          ].join('\n')
        }
      })
    ];
    const fresh = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });
    const followUps = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-04'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(fresh.items.map((item) => item.personId)).toEqual(['people-initial-relationship']);
    expect(fresh.items[0]).toMatchObject({
      taskId: 'tasks-initial-relationship',
      queueClassification: 'fresh_initial_task',
      queueClassificationReasons: expect.arrayContaining([
        'fresh_initial_task',
        'cadence_not_started',
        'initial_outreach_task_open'
      ])
    });
    expect(followUps.items).toHaveLength(0);
  });

  it('keeps NOT_STARTED assessment connection requests in Fresh Leads only', async () => {
    const people = [
      queueLead('people-initial-assessment', {
        cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
        cadenceStage: 'NOT_STARTED',
        latestTouchStatus: 'DRAFTED',
        outboundPipelineType: 'ASSESSMENT_CAMPAIGN'
      })
    ];
    const tasks = [
      queueTask('tasks-initial-assessment', {
        personId: 'people-initial-assessment',
        title: 'Send assessment-oriented connection request',
        bodyV2: {
          markdown: [
            'Person ID: people-initial-assessment',
            'Cadence: ASSESSMENT_CAMPAIGN_V1',
            'Cadence stage: NOT_STARTED',
            'Task type: connection_request'
          ].join('\n')
        }
      })
    ];
    const fresh = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });
    const followUps = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-04'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(fresh.items.map((item) => item.personId)).toEqual(['people-initial-assessment']);
    expect(followUps.items).toHaveLength(0);
  });

  it('excludes SENT initial connection requests from Fresh Leads and surfaces a follow-up gap', async () => {
    const people = [
      queueLead('people-sent-initial', {
        cadenceName: 'RELATIONSHIP_BUILDING_V1',
        cadenceStage: 'NOT_STARTED',
        latestTouchStatus: 'SENT'
      })
    ];
    const tasks = [
      queueTask('tasks-sent-initial', {
        personId: 'people-sent-initial',
        title: 'Send relationship-oriented connection request',
        bodyV2: {
          markdown: [
            'Person ID: people-sent-initial',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Cadence stage: NOT_STARTED',
            'Task type: connection_request'
          ].join('\n')
        }
      })
    ];
    const fresh = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });
    const followUps = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-04'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(fresh.items).toHaveLength(0);
    expect(followUps.items).toHaveLength(1);
    expect(followUps.items[0]).toMatchObject({
      personId: 'people-sent-initial',
      taskId: 'tasks-sent-initial',
      queueClassification: 'follow_up_after_initial_sent',
      suggestedResolutionActions: ['create_follow_up_task'],
      queueClassificationReasons: expect.arrayContaining([
        'latest_touch_sent',
        'initial_touch_already_sent',
        'needs_next_follow_up_task'
      ])
    });
    expect(followUps.items[0].warnings).toContain(
      'Initial touch appears sent, but no follow-up task exists.'
    );
  });

  it('shows SENT initial-touch People with no follow-up task as a create-follow-up gap', async () => {
    const people = [
      queueLead('people-sent-no-task', {
        cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
        cadenceStage: 'CONNECTION_REQUEST',
        latestTouchStatus: 'SENT',
        outboundPipelineType: 'ASSESSMENT_CAMPAIGN'
      })
    ];
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks: [] }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      personId: 'people-sent-no-task',
      taskId: null,
      queueClassification: 'follow_up_after_initial_sent',
      suggestedResolutionActions: ['create_follow_up_task'],
      queueClassificationReasons: expect.arrayContaining([
        'latest_touch_sent',
        'initial_touch_already_sent',
        'needs_next_follow_up_task'
      ])
    });
  });

  it('routes SENT initial-touch People with open post-initial tasks to Follow-Ups', async () => {
    const people = [
      queueLead('people-sent-follow-up-task', {
        cadenceName: 'RELATIONSHIP_BUILDING_V1',
        cadenceStage: 'NOT_STARTED',
        latestTouchStatus: 'SENT'
      })
    ];
    const tasks = [
      queueTask('tasks-sent-follow-up', {
        personId: 'people-sent-follow-up-task',
        title: 'Send contextual introduction',
        bodyV2: {
          markdown: [
            'Person ID: people-sent-follow-up-task',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Next cadence stage: INTRO_MESSAGE',
            'Latest touch status: SENT'
          ].join('\n')
        }
      })
    ];
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-04'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      personId: 'people-sent-follow-up-task',
      taskId: 'tasks-sent-follow-up',
      queueClassification: 'follow_up_after_initial_sent',
      queueClassificationReasons: expect.arrayContaining([
        'latest_touch_sent',
        'initial_touch_already_sent',
        'open_follow_up_task'
      ])
    });
  });

  it('puts INTRO_MESSAGE open tasks in Follow-Ups', async () => {
    const people = [
      queueLead('people-intro', {
        cadenceStage: 'INTRO_MESSAGE',
        latestTouchStatus: 'SENT'
      })
    ];
    const tasks = [
      queueTask('tasks-intro', {
        personId: 'people-intro',
        title: 'Send contextual introduction',
        bodyV2: {
          markdown: [
            'Person ID: people-intro',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Next cadence stage: INTRO_MESSAGE',
            'Latest touch status: SENT'
          ].join('\n')
        }
      })
    ];
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-04'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items.map((item) => item.personId)).toEqual(['people-intro']);
    expect(result.items[0]).toMatchObject({
      queueClassification: 'follow_up_post_initial_touch',
      queueClassificationReasons: expect.arrayContaining(['post_initial_cadence_stage'])
    });
  });

  it('puts ASSESSMENT_POSITIONING open tasks in Follow-Ups', async () => {
    const people = [
      queueLead('people-assessment-positioning', {
        outboundPipelineType: 'ASSESSMENT_CAMPAIGN',
        cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
        cadenceStage: 'ASSESSMENT_POSITIONING',
        latestTouchStatus: 'SENT'
      })
    ];
    const tasks = [
      queueTask('tasks-assessment-positioning', {
        personId: 'people-assessment-positioning',
        title: 'Send assessment positioning message',
        bodyV2: {
          markdown: [
            'Person ID: people-assessment-positioning',
            'Cadence: ASSESSMENT_CAMPAIGN_V1',
            'Next cadence stage: ASSESSMENT_POSITIONING',
            'Latest touch status: SENT'
          ].join('\n')
        }
      })
    ];
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-04'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items.map((item) => item.personId)).toEqual(['people-assessment-positioning']);
    expect(result.items[0].queueClassification).toBe('follow_up_post_initial_touch');
  });

  it('keeps legacy LI Day 2 tasks in Follow-Ups when history indicates outreach started', async () => {
    const people = [
      queueLead('people-legacy-day-2', {
        cadenceStage: 'NOT_STARTED',
        latestTouchStatus: 'DRAFTED'
      })
    ];
    const tasks = [
      queueTask('tasks-legacy-day-2', {
        personId: 'people-legacy-day-2',
        title: 'LI - Day 2',
        bodyV2: {
          markdown: [
            'Person ID: people-legacy-day-2',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Cadence stage: NOT_STARTED'
          ].join('\n')
        }
      })
    ];
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-04'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items.map((item) => item.personId)).toEqual(['people-legacy-day-2']);
    expect(result.items[0]).toMatchObject({
      queueClassification: 'follow_up_legacy_task_history',
      queueClassificationReasons: ['follow_up_legacy_task_history']
    });
  });

  it('does not put the same initial person/task pair in Fresh and Follow-Up by default', async () => {
    const people = [
      queueLead('people-no-duplicate', {
        cadenceStage: 'NOT_STARTED',
        latestTouchStatus: 'DRAFTED'
      })
    ];
    const tasks = [
      queueTask('tasks-no-duplicate', {
        personId: 'people-no-duplicate',
        title: 'Send relationship-oriented connection request',
        bodyV2: {
          markdown: [
            'Person ID: people-no-duplicate',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Cadence stage: NOT_STARTED',
            'Task type: connection_request'
          ].join('\n')
        }
      })
    ];
    const fresh = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });
    const followUps = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {
        ownerScope: 'all',
        dueBefore: '2026-06-04'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(fresh.items.map((item) => `${item.personId}:${item.taskId}`)).toEqual([
      'people-no-duplicate:tasks-no-duplicate'
    ]);
    expect(followUps.items.map((item) => `${item.personId}:${item.taskId}`)).toEqual([]);
  });

  it('can include classification diagnostics for matched and excluded queues', async () => {
    const people = [
      queueLead('people-diagnostics', {
        cadenceStage: 'NOT_STARTED',
        latestTouchStatus: 'DRAFTED'
      })
    ];
    const tasks = [
      queueTask('tasks-diagnostics', {
        personId: 'people-diagnostics',
        title: 'Send relationship-oriented connection request',
        bodyV2: {
          markdown: [
            'Person ID: people-diagnostics',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Cadence stage: NOT_STARTED',
            'Task type: connection_request'
          ].join('\n')
        }
      })
    ];
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all',
        includeDiagnostics: 'true'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items[0].classificationDiagnostics).toMatchObject({
      matchedQueues: ['fresh-leads'],
      finalQueue: 'fresh-leads',
      excludedQueues: [
        expect.objectContaining({
          queueSlug: 'follow-ups',
          classificationReasons: ['excluded_initial_outreach_fresh_lead']
        })
      ]
    });
  });

  it('adds sent-initial follow-up diagnostics and recommended fixes', () => {
    const report = buildQueueClassificationDiagnostics({
      people: [
        queueLead('people-diagnostic-sent-initial', {
          cadenceStage: 'CONNECTION_REQUEST',
          latestTouchStatus: 'SENT'
        })
      ],
      tasks: [
        queueTask('tasks-diagnostic-sent-initial', {
          personId: 'people-diagnostic-sent-initial',
          title: 'Send relationship-oriented connection request',
          bodyV2: {
            markdown: [
              'Person ID: people-diagnostic-sent-initial',
              'Cadence: RELATIONSHIP_BUILDING_V1',
              'Cadence stage: CONNECTION_REQUEST',
              'Task type: connection_request'
            ].join('\n')
          }
        })
      ],
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(report.items[0]).toMatchObject({
      personId: 'people-diagnostic-sent-initial',
      latestTouchStatus: 'SENT',
      initialTaskDetected: true,
      firstTouchAlreadySent: true,
      followUpTaskDetected: false,
      recommendedFix: 'create_follow_up_task',
      matchedQueues: ['follow-ups', 'pipeline-review'],
      finalQueue: 'follow-ups'
    });
  });

  it('assigns every non-test Person an explicit coverage disposition', () => {
    const audit = buildQueueCoverageAudit({
      people: [
        queueLead('people-coverage-fresh', {
          cadenceStage: 'CONNECTION_REQUEST',
          latestTouchStatus: 'DRAFTED'
        }),
        queueLead('people-coverage-follow', {
          cadenceStage: 'INTRO_MESSAGE',
          latestTouchStatus: 'SENT'
        }),
        queueLead('people-coverage-warm', {
          assessmentCompleted: true,
          leadstageAuto: 'ASSESSMENT_COMPLETED'
        }),
        queueLead('people-coverage-stale', {
          cadenceStage: 'VALUE_TOUCH',
          latestTouchStatus: 'NO_RESPONSE',
          staleRisk: 'STALE'
        }),
        queueLead('people-coverage-review', {
          emails: {
            primaryEmail: ''
          },
          linkedinLink: null,
          enrichmentStatus: 'PARTIAL',
          latestTouchStatus: 'RESPONDED'
        }),
        queueLead('people-coverage-closed', {
          cadenceStage: 'COMPLETED',
          latestTouchStatus: 'COMPLETED'
        }),
        queueLead('people-coverage-client', {
          leadStage: 'ACTIVE_CLIENT',
          cadenceStage: 'ACTIVE_CLIENT'
        }),
        {
          ...queueLead('people-coverage-test'),
          name: {
            firstName: 'Webhook',
            lastName: 'Test'
          },
          emails: {
            primaryEmail: 'coverage-test@example.com'
          }
        }
      ],
      tasks: [
        queueTask('tasks-coverage-fresh', {
          personId: 'people-coverage-fresh',
          title: 'Send relationship-oriented connection request'
        }),
        queueTask('tasks-coverage-follow', {
          personId: 'people-coverage-follow',
          title: 'Send contextual introduction',
          bodyV2: {
            markdown: [
              'Person ID: people-coverage-follow',
              'Cadence: RELATIONSHIP_BUILDING_V1',
              'Next cadence stage: INTRO_MESSAGE',
              'Latest touch status: SENT'
            ].join('\n')
          }
        })
      ],
      now: new Date('2026-06-08T15:00:00.000Z')
    });
    const byId = Object.fromEntries(audit.records.map((record) => [record.personId, record]));

    expect(audit.summary).toMatchObject({
      totalPeople: 8,
      hiddenTestRecords: 1,
      expectedRealPeople: 7,
      accountedForPeople: 7,
      unclassifiedPeople: 0
    });
    expect(byId['people-coverage-fresh'].disposition).toBe('fresh_lead');
    expect(byId['people-coverage-follow'].disposition).toBe('follow_up');
    expect(byId['people-coverage-warm'].disposition).toBe('warm_assessment');
    expect(byId['people-coverage-stale'].disposition).toBe('stale_recovery');
    expect(byId['people-coverage-review'].disposition).toBe('pipeline_review');
    expect(byId['people-coverage-closed'].disposition).toBe('terminal_closed');
    expect(byId['people-coverage-client'].disposition).toBe('active_client');
    expect(byId['people-coverage-test'].disposition).toBe('hidden_test_record');
  });

  it('counts unclassified People when no queue rule or terminal disposition applies', () => {
    const audit = buildQueueCoverageAudit({
      people: [
        queueLead('people-unclassified', {
          company: {
            name: 'Complete Data Co'
          },
          emails: {
            primaryEmail: 'complete@visiblegap.com'
          },
          linkedinLink: {
            primaryLinkUrl: 'https://www.linkedin.com/in/complete-data'
          },
          outboundPipelineType: 'RELATIONSHIP_BUILDING',
          cadenceName: 'RELATIONSHIP_BUILDING_V1',
          cadenceStage: 'VALUE_TOUCH',
          latestTouchStatus: 'SENT'
        })
      ],
      tasks: [
        queueTask('tasks-unclassified-future', {
          personId: 'people-unclassified',
          title: 'Administrative placeholder task',
          dueAt: '2026-06-20',
          bodyV2: {
            markdown: [
              'Person ID: people-unclassified',
              'Cadence: RELATIONSHIP_BUILDING_V1',
              'Next cadence stage: VALUE_TOUCH'
            ].join('\n')
          }
        })
      ],
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(audit.summary.unclassifiedPeople).toBe(1);
    expect(audit.summary.accountedForPeople).toBe(0);
    expect(audit.records[0]).toMatchObject({
      disposition: 'unclassified_needs_rule',
      exclusionReasons: expect.arrayContaining(['no_action_rule_missing']),
      recommendedFix: 'define_queue_rule'
    });
  });

  it('explains Pipeline Review-only People with explicit exclusion reasons', () => {
    const audit = buildQueueCoverageAudit({
      people: [
        queueLead('people-pipeline-only', {
          emails: {
            primaryEmail: ''
          },
          linkedinLink: null,
          company: null,
          outboundPipelineType: '',
          cadenceName: '',
          cadenceStage: '',
          leadStage: 'OUTREACH_INITIATED'
        })
      ],
      tasks: [],
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(audit.records[0]).toMatchObject({
      finalQueue: 'pipeline-review',
      disposition: 'pipeline_review',
      matchedQueueCandidates: ['pipeline-review'],
      exclusionReasons: expect.arrayContaining([
        'missing_company',
        'missing_email',
        'missing_linkedin',
        'missing_outbound_fields',
        'needs_manual_normalization',
        'ready_for_normalization'
      ]),
      recommendedFix: 'enrich_company'
    });
  });

  it('keeps Pipeline Review totalCount scoped to final Pipeline Review records by default', async () => {
    const { people, tasks } = pipelineReviewPrecedenceFixture();
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(result.totalCount).toBe(1);
    expect(result.items.map((item) => item.personId)).toEqual(['people-final-pipeline-review']);
    expect(result.diagnostics).toMatchObject({
      reviewedPeopleCount: 5,
      finalPipelineReviewCount: 1
    });
  });

  it('can expose all reviewed People in Pipeline Review diagnostics mode', async () => {
    const { people, tasks } = pipelineReviewPrecedenceFixture();
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query: {
        ownerScope: 'all',
        includeAllReviewed: 'true'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(result.totalCount).toBe(5);
    expect(result.items.map((item) => item.personId)).toEqual(
      expect.arrayContaining([
        'people-final-fresh-review',
        'people-final-follow-review',
        'people-final-warm-review',
        'people-final-stale-review',
        'people-final-pipeline-review'
      ])
    );
    expect(result.diagnostics).toMatchObject({
      reviewedPeopleCount: 5,
      finalPipelineReviewCount: 1
    });

    const diagnosticsResult = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query: {
        ownerScope: 'all',
        includeDiagnostics: 'true'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(diagnosticsResult.totalCount).toBe(5);
  });

  it('keeps Pipeline Review endpoint count aligned with coverage audit final disposition', async () => {
    const { people, tasks } = pipelineReviewPrecedenceFixture();
    const queue = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });
    const audit = buildQueueCoverageAudit({
      people,
      tasks,
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(queue.totalCount).toBe(audit.summary.countsByDisposition.pipeline_review);
    expect(queue.totalCount).toBe(1);
  });

  it('keeps summary Pipeline Review count aligned with endpoint totalCount for ownerScope=all', async () => {
    const { people, tasks } = pipelineReviewPrecedenceFixture();
    const dataSource = fakeQueueDataSource({ people, tasks });
    const query = {
      ownerScope: 'all'
    };
    const queue = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query,
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource,
      now: new Date('2026-06-08T15:00:00.000Z')
    });
    const summary = await getOutboundQueueSummaryWorkflow({
      query,
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource,
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(summary.counts.pipelineReview).toBe(queue.totalCount);
    expect(summary.counts.pipelineReview).toBe(1);
  });

  it('does not filter Pipeline Review by dueStatus when dueStatus is unset', async () => {
    const { people, tasks } = pipelineReviewPrecedenceFixture();
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({ people, tasks }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(result.totalCount).toBe(1);
    expect(result.items[0]).toMatchObject({
      personId: 'people-final-pipeline-review',
      dueStatus: 'none'
    });
  });

  it('hides obvious test records by default and includes them only when requested', async () => {
    const testPerson = {
      ...queuePeople()[0],
      id: 'people-test-record',
      name: {
        firstName: 'Scooby',
        lastName: 'Doo'
      },
      company: {
        name: 'Visible Gap Sync Test Company'
      },
      emails: {
        primaryEmail: 'visiblegap.sync-test@example.com'
      }
    };
    const hiddenResult = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({
        people: [testPerson],
        tasks: []
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });
    const includedResult = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all',
        includeTestRecords: 'true'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({
        people: [testPerson],
        tasks: []
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(hiddenResult.items).toHaveLength(0);
    expect(hiddenResult.diagnostics.hiddenTestRecords).toBe(1);
    expect(includedResult.items).toHaveLength(1);
    expect(includedResult.items[0]).toMatchObject({
      personId: 'people-test-record',
      isTestRecord: true
    });
  });

  it('flags placeholder manual records as synthetic', async () => {
    const testPerson = {
      ...queuePeople()[0],
      id: 'people-placeholder-record',
      name: {
        firstName: 'Joe',
        lastName: 'Schmoe'
      },
      company: {
        name: 'example'
      },
      emails: {
        primaryEmail: ''
      }
    };
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query: {
        ownerScope: 'all',
        includeTestRecords: 'true',
        includeAllReviewed: 'true'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({
        people: [testPerson],
        tasks: []
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.items[0]).toMatchObject({
      personId: 'people-placeholder-record',
      isTestRecord: true
    });
    expect(result.items[0].testRecordReasons).toEqual(
      expect.arrayContaining([
        'Name looks synthetic: Joe Schmoe',
        'Company looks synthetic: example'
      ])
    );
  });

  it('moves noisy timeline pagination warnings into diagnostics metadata', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {},
      config: baseConfig,
      workspaceUser: repUser,
      dataSource: fakeQueueDataSource({
        warnings: [
          'Twenty timelineActivities pagination stopped at 10 pages with more records available; queue relationship resolution may be incomplete.'
        ]
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.warnings).not.toContain(
      'Twenty timelineActivities pagination stopped at 10 pages with more records available; queue relationship resolution may be incomplete.'
    );
    expect(result.diagnostics.timelinePaginationWarning).toBe(
      'Twenty timelineActivities pagination stopped at 10 pages with more records available; queue relationship resolution may be incomplete.'
    );
  });

  it('does not return empty success when a critical People read is rate-limited', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {},
      config: {
        ...baseConfig,
        queueRead: {
          retryEnabled: false,
          cacheEnabled: false
        }
      },
      workspaceUser: repUser,
      dataSource: createTwentyQueueDataSource({
        config: {
          apiKey: 'test-key'
        },
        queueRead: {
          retryEnabled: false,
          cacheEnabled: false
        },
        restClient: fakeTwentyQueueRestClient({
          failures: {
            people: httpError(429, 'People rate limited', { retryAfter: 3 })
          }
        })
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result).toMatchObject({
      status: 'degraded_rate_limited',
      isPartial: true,
      partialReason: 'twenty_rate_limited',
      retryAfterSeconds: 3,
      count: null,
      items: []
    });
    expect(result.warnings).toContain('Queue data is temporarily rate-limited by Twenty. Retry shortly.');
  });

  it('does not return empty success when critical taskTargets are rate-limited', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'follow-ups',
      query: {},
      config: {
        ...baseConfig,
        queueRead: {
          retryEnabled: false,
          cacheEnabled: false
        }
      },
      workspaceUser: repUser,
      dataSource: createTwentyQueueDataSource({
        config: {
          apiKey: 'test-key'
        },
        queueRead: {
          retryEnabled: false,
          cacheEnabled: false
        },
        restClient: fakeTwentyQueueRestClient({
          failures: {
            taskTargets: httpError(429, 'Task targets rate limited')
          }
        })
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result).toMatchObject({
      status: 'degraded_rate_limited',
      isPartial: true,
      partialReason: 'twenty_rate_limited',
      count: null,
      items: []
    });
    expect(result.diagnostics.queueReadStatus.criticalFailures).toEqual([
      expect.objectContaining({
        objectPlural: 'taskTargets',
        httpStatus: 429
      })
    ]);
  });

  it('keeps non-critical timelineActivities failures as partial warnings only', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: {
        ...baseConfig,
        queueRead: {
          retryEnabled: false,
          cacheEnabled: false
        }
      },
      workspaceUser: adminUser,
      dataSource: createTwentyQueueDataSource({
        config: {
          apiKey: 'test-key'
        },
        queueRead: {
          retryEnabled: false,
          cacheEnabled: false
        },
        restClient: fakeTwentyQueueRestClient({
          failures: {
            timelineActivities: httpError(429, 'Timeline rate limited')
          }
        })
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.status).toBe('ok');
    expect(result.isPartial).toBe(true);
    expect(result.partialReason).toBe('twenty_non_critical_read_failed');
    expect(result.count).toBeGreaterThan(0);
    expect(result.warnings).toContain('Twenty full queue read skipped timelineActivities: Timeline rate limited');
  });

  it('retries transient queue read errors with bounded attempts', async () => {
    const restClient = fakeTwentyQueueRestClient({
      failures: {
        people: [httpError(502, 'Temporary upstream failure')]
      }
    });
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: {
        ...baseConfig,
        queueRead: {
          retryEnabled: true,
          retryMaxAttempts: 2,
          retryBaseMs: 0,
          cacheEnabled: false
        }
      },
      workspaceUser: adminUser,
      dataSource: createTwentyQueueDataSource({
        config: {
          apiKey: 'test-key'
        },
        queueRead: {
          retryEnabled: true,
          retryMaxAttempts: 2,
          retryBaseMs: 0,
          cacheEnabled: false
        },
        restClient
      }),
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(result.status).toBe('ok');
    expect(restClient.calls.people).toBe(2);
  });

  it('returns stale cache when a critical read is rate-limited after a successful read', async () => {
    clearTwentyQueueReadCache();
    const queueRead = {
      retryEnabled: false,
      cacheEnabled: true,
      cacheTtlSeconds: 90
    };
    const restClient = fakeTwentyQueueRestClient();
    const dataSource = createTwentyQueueDataSource({
      config: {
        apiKey: 'test-key'
      },
      queueRead,
      restClient
    });
    await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: {
        ...baseConfig,
        queueRead
      },
      workspaceUser: adminUser,
      dataSource,
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    restClient.failures.people = httpError(429, 'People rate limited', { retryAfter: 5 });

    const stale = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all'
      },
      config: {
        ...baseConfig,
        queueRead
      },
      workspaceUser: adminUser,
      dataSource,
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(stale).toMatchObject({
      status: 'stale_cache',
      isPartial: false,
      partialReason: 'twenty_rate_limited',
      retryAfterSeconds: 5
    });
    expect(stale.count).toBeGreaterThan(0);
    expect(stale.diagnostics.queueReadStatus.cache).toMatchObject({
      status: 'hit',
      ttlSeconds: 90
    });

    restClient.failures.people = httpError(429, 'People rate limited', { retryAfter: 5 });

    const bypassed = await getOutboundQueueWorkflow({
      queueSlug: 'fresh-leads',
      query: {
        ownerScope: 'all',
        bypassCache: 'true'
      },
      config: {
        ...baseConfig,
        queueRead
      },
      workspaceUser: adminUser,
      dataSource,
      now: new Date('2026-06-03T15:00:00.000Z')
    });

    expect(bypassed).toMatchObject({
      status: 'degraded_rate_limited',
      isPartial: true,
      partialReason: 'twenty_rate_limited',
      count: null
    });
    expect(bypassed.diagnostics.queueReadStatus.cache).toMatchObject({
      status: 'bypassed',
      bypass: true
    });

    clearTwentyQueueReadCache();
  });

  it('adds pipeline review reasons for review categories', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query: {},
      config: baseConfig,
      workspaceUser: repUser,
      dataSource: fakeQueueDataSource(),
      now: new Date('2026-06-03T15:00:00.000Z')
    });
    const reviewItem = result.items.find((item) => item.personId === 'people-review');

    expect(reviewItem.reviewReasons).toEqual(
      expect.arrayContaining([
        'missing_email',
        'missing_linkedin',
        'missing_company',
        'enrichment_partial',
        'missing_next_task'
      ])
    );
  });

  it('resolves Person Company relation from fetched Company records', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({
        people: [
          {
            id: 'people-manual-company',
            name: {
              firstName: 'Joseph',
              lastName: 'Dailey'
            },
            companyId: 'company-joseph',
            linkedinLink: {
              primaryLinkUrl: 'https://www.linkedin.com/in/joseph-dailey'
            },
            leadStage: 'OUTREACH_INITIATED',
            assessmentCompleted: false,
            ownerId: 'workspace-member-rep'
          }
        ],
        companies: [
          {
            id: 'company-joseph',
            name: 'Joseph Company',
            segment: 'SMB',
            industry: 'PROFESSIONAL_SERVICES',
            linkedinLink: {
              primaryLinkUrl: 'https://www.linkedin.com/company/joseph-company'
            }
          }
        ],
        workspaceMembers: [
          {
            id: 'workspace-member-rep',
            userEmail: 'rep@visiblegap.com'
          }
        ],
        tasks: [],
        taskTargets: []
      }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });
    const item = result.items[0];

    expect(item).toMatchObject({
      personId: 'people-manual-company',
      companyName: 'Joseph Company',
      targetCompanyId: 'company-joseph',
      companySegment: 'SMB',
      companyIndustry: 'PROFESSIONAL_SERVICES',
      leadStage: 'OUTREACH_INITIATED',
      queueClassification: 'pipeline_review_ready_for_normalization'
    });
    expect(item.reviewReasons).not.toContain('missing_company');
    expect(item.reviewReasons).toEqual(
      expect.arrayContaining(['missing_outbound_fields', 'needs_manual_normalization', 'ready_for_normalization'])
    );
    expect(item.suggestedResolutionActions).toContain('normalize_manual_lead');
  });

  it('marks unresolved Company relation separately from missing company', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'pipeline-review',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({
        people: [
          {
            id: 'people-company-id-only',
            name: {
              firstName: 'Company',
              lastName: 'Only'
            },
            companyId: 'company-missing-from-read',
            linkedinLink: {
              primaryLinkUrl: 'https://www.linkedin.com/in/company-only'
            },
            leadStage: 'OUTREACH_INITIATED',
            assessmentCompleted: false,
            ownerId: 'workspace-member-rep'
          }
        ],
        companies: [],
        workspaceMembers: [
          {
            id: 'workspace-member-rep',
            userEmail: 'rep@visiblegap.com'
          }
        ],
        tasks: [],
        taskTargets: []
      }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });
    const item = result.items[0];

    expect(item.companyName).toBeNull();
    expect(item.targetCompanyId).toBe('company-missing-from-read');
    expect(item.reviewReasons).not.toContain('missing_company');
    expect(item.reviewReasons).toContain('company_relation_unresolved');
    expect(item.suggestedResolutionActions).toContain('review_company_relation');
  });

  it('detects manually-created People with leadStage and missing outbound fields', () => {
    const plan = buildManualLeadNormalizationPlans(
      {
        people: [
          {
            id: 'people-joseph',
            name: {
              firstName: 'Joseph',
              lastName: 'Dailey'
            },
            companyId: 'company-joseph',
            linkedinLink: {
              primaryLinkUrl: 'https://www.linkedin.com/in/joseph-dailey'
            },
            leadStage: 'OUTREACH_INITIATED',
            assessmentCompleted: false,
            ownerId: 'workspace-member-darrean'
          }
        ],
        companies: [
          {
            id: 'company-joseph',
            name: 'Joseph Company',
            segment: 'MID_MARKET',
            industry: 'CONSULTING'
          }
        ],
        tasks: [],
        taskTargets: [],
        workspaceMembers: [
          {
            id: 'workspace-member-darrean',
            userEmail: 'darrean.beller@visiblegap.com',
            name: {
              firstName: 'Darrean',
              lastName: 'Beller'
            }
          }
        ]
      },
      {
        now: new Date('2026-06-08T15:00:00.000Z')
      }
    );

    expect(plan.records).toHaveLength(1);
    expect(plan.records[0]).toMatchObject({
      personId: 'people-joseph',
      assignedRep: 'darrean.beller@visiblegap.com',
      leadStage: 'OUTREACH_INITIATED',
      assessmentCompleted: false,
      safeToNormalize: true,
      recommendedUpdates: {
        outboundPipelineType: 'RELATIONSHIP_BUILDING',
        cadenceName: 'RELATIONSHIP_BUILDING_V1',
        cadenceStage: 'CONNECTION_REQUEST',
        latestTouchChannel: 'LINKEDIN',
        latestTouchStatus: 'SENT'
      },
      recommendedTaskAction: 'create_follow_up_task',
      recommendedTaskTitle: 'Send relationship follow-up / intro message'
    });
    expect(Object.keys(plan.records[0].recommendedUpdates)).not.toContain('assessmentCompleted');
  });

  it('does not treat assessmentCompleted=false as Warm Assessment', async () => {
    const result = await getOutboundQueueWorkflow({
      queueSlug: 'warm-assessments',
      query: {
        ownerScope: 'all'
      },
      config: baseConfig,
      workspaceUser: adminUser,
      dataSource: fakeQueueDataSource({
        people: [
          {
            id: 'people-false-assessment',
            name: {
              firstName: 'False',
              lastName: 'Assessment'
            },
            assessmentCompleted: false,
            leadstageAuto: 'NEW_LEAD',
            owner: {
              userEmail: 'rep@visiblegap.com'
            }
          }
        ],
        tasks: [],
        taskTargets: []
      }),
      now: new Date('2026-06-08T15:00:00.000Z')
    });

    expect(result.items).toEqual([]);
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
    expect(result.count).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBeNull();
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

describe('queue summary API', () => {
  it('returns queue counts and overdue counts', async () => {
    const response = await invokeQueueSummaryRoute({
      headers: {
        authorization: 'Bearer valid-token'
      },
      query: {
        ownerScope: 'all'
      },
      dependencies: {
        dataSource: fakeQueueDataSource()
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      correlationId: 'queue-route-correlation',
      data: {
        counts: {
          freshLeads: expect.any(Number),
          followUps: expect.any(Number),
          warmAssessments: expect.any(Number),
          staleRecovery: expect.any(Number),
          pipelineReview: expect.any(Number),
          unassignedTasks: expect.any(Number)
        },
        overdueTasksByQueue: {
          freshLeads: expect.any(Number),
          followUps: expect.any(Number)
        },
        hiddenTestRecords: expect.any(Number),
        totalPeople: expect.any(Number),
        expectedRealPeople: expect.any(Number),
        accountedForPeople: expect.any(Number),
        unclassifiedPeople: expect.any(Number),
        countsByDisposition: expect.any(Object),
        countsByFinalQueue: expect.any(Object)
      },
      errors: []
    });
  });

  it('returns Pipeline Review count as final Pipeline Review disposition count', async () => {
    const { people, tasks } = pipelineReviewPrecedenceFixture();
    const response = await invokeQueueSummaryRoute({
      headers: {
        authorization: 'Bearer valid-token'
      },
      query: {
        ownerScope: 'all'
      },
      dependencies: {
        dataSource: fakeQueueDataSource({ people, tasks })
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.counts.pipelineReview).toBe(1);
    expect(response.body.data.countsByDisposition.pipeline_review).toBe(1);
    expect(response.body.data.diagnostics).toMatchObject({
      reviewedPeopleCount: 5,
      finalPipelineReviewCount: 1
    });
  });
});

describe('missing next-task planner', () => {
  it('finds non-terminal People with no open task', () => {
    const result = buildMissingNextTaskPlans(
      {
        people: [
          {
            id: 'people-missing-task',
            name: {
              firstName: 'Parker',
              lastName: 'Lane'
            },
            company: {
              name: 'Northstar Operations Co'
            },
            emails: {
              primaryEmail: 'parker@northstarops.com'
            },
            cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
            cadenceStage: 'CONNECTION_REQUEST',
            latestTouchStatus: 'DRAFTED',
            latestTouchChannel: 'LINKEDIN',
            nextOutboundTouchDate: '2026-06-05',
            owner: {
              userEmail: 'rep@visiblegap.com'
            }
          }
        ],
        tasks: [],
        taskTargets: []
      },
      {
        now: new Date('2026-06-03T15:00:00.000Z')
      }
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      personId: 'people-missing-task',
      recommendedTaskTitle: 'Send assessment-oriented connection request',
      recommendedTaskType: 'connection_request',
      recommendedDueDate: '2026-06-05',
      confidence: 'high',
      safeToCreate: true
    });
  });

  it('skips SENT initial-touch People so connection requests are not duplicated', () => {
    const result = buildMissingNextTaskPlans(
      {
        people: [
          missingTaskPerson('people-sent-initial-missing-task', {
            cadenceName: 'RELATIONSHIP_BUILDING_V1',
            cadenceStage: 'CONNECTION_REQUEST',
            latestTouchStatus: 'SENT'
          })
        ],
        tasks: [],
        taskTargets: []
      },
      {
        now: new Date('2026-06-03T15:00:00.000Z')
      }
    );

    expect(result.records).toHaveLength(0);
  });

  it('adjusts past recommended due dates and preserves the original outbound date', () => {
    const result = buildMissingNextTaskPlans(
      {
        people: [
          missingTaskPerson('people-past-due', {
            nextOutboundTouchDate: '2026-06-05'
          })
        ],
        tasks: [],
        taskTargets: []
      },
      {
        now: new Date('2026-06-06T15:00:00.000Z')
      }
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      originalNextOutboundTouchDate: '2026-06-05',
      originalRecommendedDueDate: '2026-06-05',
      recommendedDueDate: '2026-06-08',
      dueDateAdjusted: true,
      dueDateAdjustmentReason: 'past_due_date:2026-06-05<2026-06-06'
    });
  });

  it('adjusts same-day due dates after the project business cutoff', () => {
    const result = buildMissingNextTaskPlans(
      {
        people: [
          missingTaskPerson('people-same-day-after-cutoff', {
            nextOutboundTouchDate: '2026-06-05'
          })
        ],
        tasks: [],
        taskTargets: []
      },
      {
        now: new Date('2026-06-06T01:30:00.000Z')
      }
    );

    expect(result.records[0]).toMatchObject({
      recommendedDueDate: '2026-06-08',
      dueDateAdjusted: true,
      dueDateAdjustmentReason: 'same_day_after_business_cutoff:2026-06-05'
    });
  });

  it('excludes terminal, paused, completed, and active-client People', () => {
    const result = buildMissingNextTaskPlans({
      people: [
        missingTaskPerson('people-completed', {
          cadenceStage: 'COMPLETED'
        }),
        missingTaskPerson('people-paused', {
          cadenceStage: 'PAUSED'
        }),
        missingTaskPerson('people-client', {
          leadstageAuto: 'ACTIVE_CLIENT'
        }),
        missingTaskPerson('people-declined', {
          latestTouchStatus: 'DECLINED'
        })
      ],
      tasks: [],
      taskTargets: []
    });

    expect(result.records).toHaveLength(0);
  });

  it('hides missing-task test records by default and can include them for diagnostics', () => {
    const records = {
      people: [
        missingTaskPerson('people-test-missing-task', {
          name: {
            firstName: 'Webhook',
            lastName: 'Test'
          },
          company: {
            name: 'Cadence Test Company'
          },
          emails: {
            primaryEmail: 'cadence-test@example.com'
          }
        })
      ],
      tasks: [],
      taskTargets: []
    };

    const hidden = buildMissingNextTaskPlans(records);
    const included = buildMissingNextTaskPlans(records, {
      includeTestRecords: true
    });

    expect(hidden.records).toHaveLength(0);
    expect(hidden.hiddenTestRecords).toBe(1);
    expect(included.records).toHaveLength(1);
    expect(included.records[0]).toMatchObject({
      isTestRecord: true,
      safeToCreate: false
    });
  });

  it('does not plan a next task when an open task is already linked', () => {
    const result = buildMissingNextTaskPlans({
      people: [missingTaskPerson('people-has-task')],
      tasks: [
        {
          id: 'tasks-existing',
          status: 'TODO',
          title: 'Existing task'
        }
      ],
      taskTargets: [
        {
          id: 'task-target-existing',
          taskId: 'tasks-existing',
          targetPersonId: 'people-has-task'
        }
      ]
    });

    expect(result.records).toHaveLength(0);
  });
});

describe('sent initial follow-up planner', () => {
  it('finds SENT relationship initial-touch records and recommends INTRO_MESSAGE', () => {
    const result = buildSentInitialFollowUpPlans(
      {
        people: [
          missingTaskPerson('people-relationship-sent', {
            cadenceName: 'RELATIONSHIP_BUILDING_V1',
            cadenceStage: 'CONNECTION_REQUEST',
            latestTouchStatus: 'SENT',
            nextOutboundTouchDate: '2026-06-04'
          })
        ],
        tasks: [
          {
            id: 'tasks-relationship-initial',
            status: 'TODO',
            title: 'Send relationship-oriented connection request',
            personId: 'people-relationship-sent',
            bodyV2: {
              markdown: [
                'Person ID: people-relationship-sent',
                'Cadence: RELATIONSHIP_BUILDING_V1',
                'Cadence stage: CONNECTION_REQUEST',
                'Task type: connection_request'
              ].join('\n')
            }
          }
        ],
        taskTargets: []
      },
      {
        now: new Date('2026-06-03T15:00:00.000Z')
      }
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      personId: 'people-relationship-sent',
      currentInitialTaskId: 'tasks-relationship-initial',
      recommendedNextCadenceStage: 'INTRO_MESSAGE',
      recommendedTaskTitle: 'Send relationship follow-up / intro message',
      recommendedTaskType: 'introduction',
      safeToCreate: true
    });
  });

  it('finds SENT assessment initial-touch records and recommends ASSESSMENT_POSITIONING', () => {
    const result = buildSentInitialFollowUpPlans(
      {
        people: [
          missingTaskPerson('people-assessment-sent', {
            outboundPipelineType: 'ASSESSMENT_CAMPAIGN',
            cadenceName: 'ASSESSMENT_CAMPAIGN_V1',
            cadenceStage: 'NOT_STARTED',
            latestTouchStatus: 'SENT'
          })
        ],
        tasks: [],
        taskTargets: []
      },
      {
        now: new Date('2026-06-03T15:00:00.000Z')
      }
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      personId: 'people-assessment-sent',
      currentInitialTaskId: null,
      recommendedNextCadenceStage: 'ASSESSMENT_POSITIONING',
      recommendedTaskTitle: 'Send assessment positioning follow-up',
      recommendedTaskType: 'assessment_positioning',
      safeToCreate: true
    });
  });

  it('does not plan when a post-initial follow-up task already exists', () => {
    const result = buildSentInitialFollowUpPlans({
      people: [
        missingTaskPerson('people-sent-with-follow-up', {
          cadenceName: 'RELATIONSHIP_BUILDING_V1',
          cadenceStage: 'NOT_STARTED',
          latestTouchStatus: 'SENT'
        })
      ],
      tasks: [
        {
          id: 'tasks-existing-follow-up',
          status: 'TODO',
          title: 'Send contextual introduction',
          personId: 'people-sent-with-follow-up',
          bodyV2: {
            markdown: [
              'Person ID: people-sent-with-follow-up',
              'Cadence: RELATIONSHIP_BUILDING_V1',
              'Next cadence stage: INTRO_MESSAGE'
            ].join('\n')
          }
        }
      ],
      taskTargets: []
    });

    expect(result.records).toHaveLength(0);
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

async function invokeQueueSummaryRoute({
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
    await handleQueueSummaryFetch(req, res, next, {
      config,
      log: silentLog,
      dataSource: fakeQueueDataSource(),
      ...dependencies
    });
  }

  if (res.error) {
    throw res.error;
  }

  return res;
}

function pipelineReviewPrecedenceFixture() {
  return {
    people: [
      queueLead('people-final-fresh-review', {
        cadenceStage: 'CONNECTION_REQUEST',
        latestTouchStatus: 'DRAFTED',
        enrichmentStatus: 'PARTIAL'
      }),
      queueLead('people-final-follow-review', {
        cadenceStage: 'INTRO_MESSAGE',
        latestTouchStatus: 'SENT',
        enrichmentStatus: 'PARTIAL'
      }),
      queueLead('people-final-warm-review', {
        assessmentCompleted: true,
        leadstageAuto: 'ASSESSMENT_COMPLETED',
        enrichmentStatus: 'PARTIAL'
      }),
      queueLead('people-final-stale-review', {
        cadenceStage: 'VALUE_TOUCH',
        latestTouchStatus: 'NO_RESPONSE',
        staleRisk: 'STALE',
        enrichmentStatus: 'PARTIAL'
      }),
      queueLead('people-final-pipeline-review', {
        cadenceStage: 'VALUE_TOUCH',
        latestTouchStatus: 'RESPONDED',
        enrichmentStatus: 'PARTIAL'
      })
    ],
    tasks: [
      queueTask('tasks-final-fresh-review', {
        personId: 'people-final-fresh-review',
        title: 'Send relationship-oriented connection request'
      }),
      queueTask('tasks-final-follow-review', {
        personId: 'people-final-follow-review',
        title: 'Send contextual introduction',
        dueAt: '2026-06-08',
        bodyV2: {
          markdown: [
            'Person ID: people-final-follow-review',
            'Cadence: RELATIONSHIP_BUILDING_V1',
            'Next cadence stage: INTRO_MESSAGE',
            'Latest touch status: SENT'
          ].join('\n')
        }
      })
    ]
  };
}

function fakeQueueDataSource(overrides = {}) {
  return {
    provider: 'fake-twenty',
    async listQueueRecords() {
      return {
        people: overrides.people ?? queuePeople(),
        companies: overrides.companies ?? [],
        tasks: overrides.tasks ?? queueTasks(),
        taskTargets: overrides.taskTargets ?? [],
        noteTargets: overrides.noteTargets ?? [],
        timelineActivities: overrides.timelineActivities ?? [],
        workspaceMembers: overrides.workspaceMembers ?? [],
        warnings: overrides.warnings ?? []
      };
    }
  };
}

function fakeTwentyQueueRestClient({ failures = {}, records = {} } = {}) {
  const client = {
    failures,
    calls: {
      people: 0,
      companies: 0,
      tasks: 0,
      taskTargets: 0,
      noteTargets: 0,
      timelineActivities: 0,
      workspaceMembers: 0
    },
    async listAllRecords(objectPlural) {
      this.calls[objectPlural] = (this.calls[objectPlural] ?? 0) + 1;
      const failure = consumeFailure(this.failures, objectPlural);

      if (failure) {
        throw failure;
      }

      const objectRecords = records[objectPlural] ?? defaultTwentyQueueRecords(objectPlural);

      return {
        records: objectRecords,
        warnings: [],
        pagination: {
          objectPlural,
          pagesFetched: 1,
          totalFetched: objectRecords.length,
          totalCount: objectRecords.length,
          hasMore: false
        }
      };
    },
    async listRecords(objectPlural) {
      return (await this.listAllRecords(objectPlural)).records;
    }
  };

  return client;
}

function consumeFailure(failures, objectPlural) {
  const failure = failures[objectPlural];

  if (Array.isArray(failure)) {
    return failure.shift() ?? null;
  }

  return failure ?? null;
}

function defaultTwentyQueueRecords(objectPlural) {
  if (objectPlural === 'people') {
    return queuePeople();
  }

  if (objectPlural === 'tasks') {
    return queueTasks();
  }

  if (objectPlural === 'companies') {
    return [];
  }

  if (objectPlural === 'taskTargets') {
    return [
      {
        id: 'task-target-fresh',
        taskId: 'tasks-fresh',
        targetPersonId: 'people-fresh'
      },
      {
        id: 'task-target-follow',
        taskId: 'tasks-follow',
        targetPersonId: 'people-follow'
      }
    ];
  }

  if (objectPlural === 'workspaceMembers') {
    return [
      {
        id: 'workspace-member-rep',
        userEmail: 'rep@visiblegap.com',
        name: {
          firstName: 'Visible Gap',
          lastName: 'Rep'
        }
      },
      {
        id: 'workspace-member-other',
        userEmail: 'other@visiblegap.com'
      }
    ];
  }

  return [];
}

function httpError(status, message, { retryAfter } = {}) {
  const error = new Error(message);
  error.response = {
    status,
    data: {
      message
    },
    headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }
  };
  return error;
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
        name: 'Northstar Operations Co'
      },
      emails: {
        primaryEmail: 'taylor@northstarops.com'
      },
      linkedinLink: {
        primaryLinkUrl: 'https://www.linkedin.com/in/taylor-morgan'
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
        name: 'Evergreen Process Co'
      },
      emails: {
        primaryEmail: 'jordan@evergreenprocess.com'
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

function queueLead(id, overrides = {}) {
  return {
    id,
    name: {
      firstName: 'Alex',
      lastName: id.replace(/^people-/, '').replace(/-/g, ' ')
    },
    jobTitle: 'Operations Leader',
    company: {
      name: 'Northstar Operations Co'
    },
    emails: {
      primaryEmail: `${id.replace(/[^a-z0-9]/gi, '.')}@northstarops.com`
    },
    linkedinLink: {
      primaryLinkUrl: `https://www.linkedin.com/in/${id}`
    },
    outboundPipelineType: 'RELATIONSHIP_BUILDING',
    cadenceName: 'RELATIONSHIP_BUILDING_V1',
    cadenceStage: 'NOT_STARTED',
    latestTouchStatus: 'DRAFTED',
    latestTouchChannel: 'LINKEDIN',
    leadHealthScore: 60,
    icpFitScore: 70,
    owner: {
      userEmail: 'rep@visiblegap.com',
      name: 'Visible Gap Rep'
    },
    ...overrides
  };
}

function queueTask(id, overrides = {}) {
  return {
    id,
    title: 'Send relationship-oriented connection request',
    status: 'TODO',
    dueAt: '2026-06-04',
    assignee: {
      userEmail: 'rep@visiblegap.com'
    },
    ...overrides
  };
}

function missingTaskPerson(id, overrides = {}) {
  return {
    id,
    name: {
      firstName: 'Parker',
      lastName: 'Lane'
    },
    company: {
      name: 'Northstar Operations Co'
    },
    emails: {
      primaryEmail: 'parker@northstarops.com'
    },
    cadenceName: 'RELATIONSHIP_BUILDING_V1',
    cadenceStage: 'CONNECTION_REQUEST',
    latestTouchStatus: 'DRAFTED',
    latestTouchChannel: 'LINKEDIN',
    owner: {
      userEmail: 'rep@visiblegap.com'
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
