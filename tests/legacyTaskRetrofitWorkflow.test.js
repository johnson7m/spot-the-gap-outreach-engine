import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import {
  buildLegacyTaskRetrofitPlans,
  planLegacyTaskRetrofit
} from '../src/workflows/outbound/legacyTaskRetrofitWorkflow.js';

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('legacy task retrofit planner', () => {
  it('leaves existing taskTarget Person links alone', () => {
    const plans = buildLegacyTaskRetrofitPlans(fakeRecords());
    const linked = plans.find((plan) => plan.taskId === 'task-linked');

    expect(linked).toMatchObject({
      currentTargetPersonId: 'person-1',
      inferredTargetPersonId: null,
      recommendedAction: 'leave_unassigned',
      safeToUpdate: false,
      confidence: 'high'
    });
  });

  it('recommends task-to-person links from body Person ID markers', () => {
    const plans = buildLegacyTaskRetrofitPlans(fakeRecords());
    const bodyLinked = plans.find((plan) => plan.taskId === 'task-body');

    expect(bodyLinked).toMatchObject({
      currentTargetPersonId: null,
      inferredTargetPersonId: 'person-2',
      confidence: 'medium',
      recommendedAction: 'link_task_to_person',
      safeToUpdate: true
    });
    expect(bodyLinked.evidence.resolutionPath).toEqual(['task body Person ID marker']);
  });

  it('uses Person name matching as manual-reviewable evidence', () => {
    const plans = buildLegacyTaskRetrofitPlans(fakeRecords());
    const nameMatched = plans.find((plan) => plan.taskId === 'task-name');

    expect(nameMatched).toMatchObject({
      inferredTargetPersonId: 'person-3',
      confidence: 'medium',
      recommendedAction: 'link_task_to_person',
      safeToUpdate: true
    });
    expect(nameMatched.warnings).toContain(
      'Task relationship inference used Person name matching; review before writing taskTarget relationships.'
    );
  });

  it('buckets unresolved tasks as leave_unassigned', () => {
    const plans = buildLegacyTaskRetrofitPlans(fakeRecords());
    const unassigned = plans.find((plan) => plan.taskId === 'task-unassigned');

    expect(unassigned).toMatchObject({
      currentTargetPersonId: null,
      inferredTargetPersonId: null,
      confidence: 'unknown',
      recommendedAction: 'leave_unassigned',
      safeToUpdate: false
    });
    expect(unassigned.warnings).toContain('No reliable Person inference found; leave unassigned until reviewed.');
  });

  it('runs the planner in dry-run mode without writes', async () => {
    const result = await planLegacyTaskRetrofit({
      config: {
        twenty: {
          apiKey: 'test-key',
          apiBaseUrl: 'https://api.twenty.com'
        }
      },
      dataSource: {
        provider: 'fake-twenty',
        async listAllQueueRecords() {
          return {
            ...fakeRecords(),
            warnings: [],
            pagination: {
              objects: {
                tasks: {
                  pagesFetched: 1,
                  totalFetched: 4,
                  totalCount: 4,
                  hasMore: false
                }
              }
            }
          };
        }
      },
      log: silentLog,
      now: new Date('2026-06-05T15:00:00.000Z')
    });

    expect(result).toMatchObject({
      status: 'dry_run',
      dryRun: true,
      summary: {
        totalTasks: 4,
        safeToUpdate: 2,
        unassignedTasks: 1
      }
    });
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment webhook processing unaffected by legacy task retrofit helpers', async () => {
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

function fakeRecords() {
  return {
    people: [
      person('person-1', 'Linked Lead'),
      person('person-2', 'Body Marker'),
      person('person-3', 'Named Person')
    ],
    tasks: [
      {
        id: 'task-linked',
        title: 'Linked task',
        status: 'TODO'
      },
      {
        id: 'task-body',
        title: 'Manual follow-up',
        status: 'TODO',
        bodyV2: {
          markdown: 'Person ID: person-2'
        }
      },
      {
        id: 'task-name',
        title: 'Follow up with Named Person',
        status: 'TODO'
      },
      {
        id: 'task-unassigned',
        title: 'Follow up with unknown lead',
        status: 'TODO'
      }
    ],
    taskTargets: [
      {
        id: 'task-target-1',
        taskId: 'task-linked',
        targetPersonId: 'person-1'
      }
    ],
    workspaceMembers: [],
    noteTargets: [],
    timelineActivities: []
  };
}

function person(id, fullName) {
  const [firstName, ...rest] = fullName.split(' ');

  return {
    id,
    name: {
      firstName,
      lastName: rest.join(' ')
    }
  };
}
