import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sampleAssessment from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import {
  clearTwentyQueueReadCache,
  createTwentyQueueDataSource
} from '../src/integrations/twenty/queueDataSource.js';
import { processAssessmentSubmission } from '../src/workflows/assessmentWorkflow.js';
import {
  applyMissingNextTaskPlan,
  buildMissingNextTaskOperation,
  buildMissingNextTaskRecoveryPlan,
  buildMissingNextTaskPayload,
  selectCurrentlyEligibleMissingNextTaskCandidateBatch,
  selectMissingNextTaskCandidateBatch,
  selectMissingNextTaskCandidates
} from '../src/workflows/outbound/applyMissingNextTasksWorkflow.js';
import {
  buildMissingNextTaskApplyOutputFromLogs,
  buildMissingNextTaskApplyOutput,
  loadMissingNextTaskApplyOutput,
  writeMissingNextTaskOutputFile
} from '../src/workflows/outbound/missingNextTaskApplyOutput.js';

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

describe('missing next-task apply workflow', () => {
  it('keeps Task writes blocked when live guards are disabled', async () => {
    const restClient = fakeTaskClient();
    const store = fakeOperationalStore();
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan(),
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
    expect(store.crmSyncLogs).toEqual([]);
    expect(store.outboundEvents).toEqual([]);
  });

  it('requires an explicit batch size for live apply', async () => {
    await expect(
      applyMissingNextTaskPlan({
        plan: fakeMissingNextTaskPlan(),
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
      code: 'MISSING_NEXT_TASK_BATCH_SIZE_REQUIRED'
    });
  });

  it('respects batch size and offset against eligible update records only', () => {
    const selected = selectMissingNextTaskCandidates(fakeMissingNextTaskPlan(), {
      batchSize: 1,
      offset: 1
    });

    expect(selected.map((record) => record.personId)).toEqual(['person-safe-2']);
  });

  it('selects the first currently eligible records in next_eligible mode and ignores offset', () => {
    const selection = selectMissingNextTaskCandidateBatch(fakeMissingNextTaskPlan(), {
      applyMode: 'next_eligible',
      batchSize: 1,
      offset: 99
    });

    expect(selection).toMatchObject({
      applyMode: 'next_eligible',
      eligibleCount: 2,
      selectedCount: 1,
      remainingEligibleCount: 1
    });
    expect(selection.records.map((record) => record.personId)).toEqual(['person-safe-1']);
  });

  it('reports no remaining eligible records when next_eligible has consumed the eligible set', async () => {
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan({
        plans: [safePlanRecord('person-safe-1')]
      }),
      config: baseConfig(),
      restClient: fakeTaskClient(),
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: false,
        liveTest: false,
        applyMode: 'next_eligible',
        batchSize: 5,
        offset: 50
      }
    });

    expect(result).toMatchObject({
      dryRun: true,
      eligibleCount: 1,
      selectedCount: 1,
      remainingEligibleCount: 0,
      recommendedNextCommand: null,
      nextRecommendedCommand: null,
      summary: {
        eligibleCount: 1,
        selectedCount: 1,
        remainingEligibleCount: 0
      }
    });
    expect(result.operations.map((operation) => operation.personId)).toEqual(['person-safe-1']);
  });

  it('returns next_eligible continuation guidance while eligible records remain', async () => {
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan(),
      config: baseConfig(),
      restClient: fakeTaskClient(),
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: false,
        liveTest: false,
        applyMode: 'next_eligible',
        batchSize: 1,
        offset: 1
      }
    });

    expect(result).toMatchObject({
      dryRun: true,
      remainingEligibleCount: 1,
      recommendedNextCommand:
        'MISSING_NEXT_TASK_APPLY_ENABLED=true LIVE_TEST=true MISSING_NEXT_TASK_APPLY_MODE=next_eligible MISSING_NEXT_TASK_BATCH_SIZE=1 npm run queues:apply-missing-next-tasks',
      nextRecommendedCommand:
        'MISSING_NEXT_TASK_APPLY_ENABLED=true LIVE_TEST=true MISSING_NEXT_TASK_APPLY_MODE=next_eligible MISSING_NEXT_TASK_BATCH_SIZE=1 npm run queues:apply-missing-next-tasks'
    });
    expect(result.operations.map((operation) => operation.personId)).toEqual(['person-safe-1']);
  });

  it('checks current Twenty Tasks before selecting a next_eligible live batch', async () => {
    const restClient = fakeTaskClient({
      tasks: [
        {
          id: 'task-existing-open',
          title: 'Existing open task',
          status: 'TODO',
          bodyV2: {
            markdown: 'Person ID: person-safe-1'
          }
        }
      ]
    });
    const selection = await selectCurrentlyEligibleMissingNextTaskCandidateBatch({
      client: restClient,
      plan: fakeMissingNextTaskPlan(),
      options: {
        applyMode: 'next_eligible',
        batchSize: 1,
        offset: 0
      }
    });

    expect(selection).toMatchObject({
      eligibleCount: 2,
      currentEligibleCount: 1,
      skippedExistingCount: 1,
      selectedCount: 1,
      remainingEligibleCount: 0,
      currentEligibilityChecked: true
    });
    expect(selection.records.map((record) => record.personId)).toEqual(['person-safe-2']);
  });

  it('live next_eligible skips already-handled records instead of reprocessing the first plan rows', async () => {
    const restClient = fakeTaskClient({
      tasks: [
        {
          id: 'task-existing-open',
          title: 'Existing open task',
          status: 'TODO',
          bodyV2: {
            markdown: 'Person ID: person-safe-1'
          }
        }
      ]
    });
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan(),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        applyMode: 'next_eligible',
        batchSize: 1,
        offset: 0
      }
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      currentEligibleCount: 1,
      skippedExistingCount: 1,
      remainingEligibleCount: 0,
      recommendedNextCommand: null,
      summary: {
        attempted: 1,
        succeeded: 1,
        currentEligibilityChecked: true,
        currentEligibleCount: 1,
        skippedExistingCount: 1,
        remainingEligibleCount: 0
      }
    });
    expect(result.operations.map((operation) => operation.personId)).toEqual(['person-safe-2']);
    expect(restClient.created.find((entry) => entry.objectPlural === 'tasks')).toMatchObject({
      payload: {
        title: 'Send value touch'
      }
    });
  });

  it('selects safe records only by default', () => {
    const selected = selectMissingNextTaskCandidates(fakeMissingNextTaskPlan(), {
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
    const payload = buildMissingNextTaskPayload({
      record,
      dedupeKey: 'outbound-cadence:person:person-safe-1:cadence:RELATIONSHIP_BUILDING_V1:stage:CONNECTION_REQUEST:task:connection_request',
      now: new Date('2026-06-05T15:00:00.000Z')
    });

    expect(payload).toMatchObject({
      title: 'Send relationship-oriented connection request',
      status: 'TODO',
      dueAt: '2026-06-06',
      assigneeId: 'workspace-member-rep'
    });
    expect(payload.bodyV2.markdown).toContain('Source: Missing next-task planner');
    expect(payload.bodyV2.markdown).toContain('Person ID: person-safe-1');
    expect(payload.bodyV2.markdown).toContain('Manual action required. Do not automate LinkedIn requests or messages.');
  });

  it('adjusts past recommended due dates again when building apply operations', () => {
    const operation = buildMissingNextTaskOperation({
      record: safePlanRecord('person-safe-past-due', {
        nextOutboundTouchDate: '2026-06-05',
        recommendedDueDate: '2026-06-05'
      }),
      now: new Date('2026-06-06T15:00:00.000Z')
    });

    expect(operation).toMatchObject({
      recommendedDueDate: '2026-06-08',
      originalRecommendedDueDate: '2026-06-05',
      dueDateAdjusted: true,
      dueDateAdjustmentReason: 'past_due_date:2026-06-05<2026-06-06'
    });
    expect(operation.taskPayload).toMatchObject({
      dueAt: '2026-06-08'
    });
    expect(operation.taskPayload.bodyV2.markdown).toContain('Due date adjusted: true');
  });

  it('avoids duplicate open Tasks for the Person during live apply', async () => {
    const restClient = fakeTaskClient({
      tasks: [
        {
          id: 'task-existing-open',
          title: 'Existing open task',
          status: 'TODO',
          bodyV2: {
            markdown: 'Person ID: person-safe-1'
          }
        }
      ]
    });
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan({
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
      skippedReason: 'Open Task already exists for Person.'
    });
    expect(restClient.created).toEqual([]);
  });

  it('does not use queue read cache during apply duplicate checks', async () => {
    clearTwentyQueueReadCache();

    const cachedQueueSource = createTwentyQueueDataSource({
      config: {
        apiKey: 'test-key'
      },
      queueRead: {
        cacheEnabled: true,
        retryEnabled: false
      },
      restClient: fakeEmptyQueueRestClient()
    });
    await cachedQueueSource.listAllQueueRecords({
      query: {
        ownerScope: 'all'
      }
    });

    const restClient = fakeTaskClient({
      tasks: [
        {
          id: 'task-existing-open',
          title: 'Existing open task',
          status: 'TODO',
          bodyV2: {
            markdown: 'Person ID: person-safe-1'
          }
        }
      ]
    });
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan({
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
      status: 'skipped',
      skippedReason: 'Open Task already exists for Person.'
    });
    expect(restClient.created).toEqual([]);

    clearTwentyQueueReadCache();
  });

  it('avoids duplicate Task creation when the dedupe key already exists', async () => {
    const operation = buildMissingNextTaskOperation({
      record: safePlanRecord('person-safe-1'),
      now: new Date('2026-06-05T15:00:00.000Z')
    });
    const restClient = fakeTaskClient({
      tasks: [
        {
          id: 'task-existing-dedupe',
          title: 'Existing deduped task',
          status: 'DONE',
          bodyV2: {
            markdown: `Dedupe key: ${operation.dedupeKey}`
          }
        }
      ]
    });
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan({
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
      now: new Date('2026-06-05T15:00:00.000Z')
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

  it('creates a Task, then creates and verifies the Person taskTarget', async () => {
    const restClient = fakeTaskClient();
    const store = fakeOperationalStore();
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan({
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
      action: 'missing_next_task_create',
      status: 'succeeded'
    });
    expect(store.outboundEvents[0]).toMatchObject({
      eventType: 'missing_next_task_created',
      actorType: 'system',
      status: 'sent'
    });
  });

  it('retries Twenty 429 errors before marking an operation failed', async () => {
    const restClient = fakeTaskClient({
      createFailures: {
        tasks: [httpError(429, 'Limit reached', { retryAfter: 2 })]
      }
    });
    const sleepCalls = [];
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan({
        plans: [safePlanRecord('person-safe-1')]
      }),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        batchSize: 1,
        offset: 0,
        writeDelayMs: 0,
        retryAfter429: true,
        maxRetryAttempts: 2,
        retryFallbackMs: 60000
      },
      sleep: async (ms) => {
        sleepCalls.push(ms);
      }
    });

    expect(sleepCalls).toEqual([2000]);
    expect(result).toMatchObject({
      status: 'succeeded',
      retryAfterSeconds: 2,
      summary: {
        attempted: 1,
        succeeded: 1
      }
    });
    expect(result.operations[0]).toMatchObject({
      status: 'verification_succeeded',
      retryAttempts: 1,
      retryAfterSeconds: 2
    });
    expect(restClient.created.filter((entry) => entry.objectPlural === 'tasks')).toHaveLength(1);
  });

  it('returns partial_success and recovery guidance when some operations fail', async () => {
    const restClient = fakeTaskClient({
      createFailures: {
        tasks: [null, httpError(429, 'Limit reached')]
      }
    });
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan({
        plans: [safePlanRecord('person-safe-1'), safePlanRecord('person-safe-2')]
      }),
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        batchSize: 2,
        offset: 0,
        writeDelayMs: 0,
        retryAfter429: false,
        maxRetryAttempts: 0,
        retryFallbackMs: 3000
      },
      sleep: async () => {}
    });

    expect(result).toMatchObject({
      status: 'partial_success',
      retryAfterSeconds: 3,
      summary: {
        attempted: 2,
        succeeded: 1,
        failed: 1
      },
      recommendedNextCommand:
        'MISSING_NEXT_TASK_APPLY_ENABLED=true LIVE_TEST=true npm run queues:recover-missing-next-tasks'
    });
  });

  it.each(['succeeded', 'partial_success', 'failed'])(
    'writes %s apply output with summary, operations, audit IDs, timestamp, and correlation ID',
    async (status) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'missing-next-output-'));
      const outputPath = join(tempDir, 'nested', 'apply-latest.json');
      const failed = status === 'failed';
      const output = buildMissingNextTaskApplyOutput({
        result: {
          status,
          dryRun: false,
          liveEnabled: true,
          guard: {},
          summary: {
            attempted: 1,
            succeeded: failed ? 0 : 1,
            failed: failed ? 1 : 0,
            verificationFailed: 0,
            skipped: 0,
            auditIds: ['audit-output-1'],
            outboundEventIds: ['event-output-1']
          },
          retryAfterSeconds: failed ? 60 : null,
          recommendedNextCommand: 'npm run queues:recover-missing-next-tasks',
          warnings: [],
          operations: [
            {
              correlationId: 'operation-correlation-1',
              personId: 'person-safe-1',
              status: failed ? 'failed' : 'verification_succeeded',
              audit: {
                id: 'audit-output-1'
              },
              outboundEvent: {
                id: 'event-output-1'
              }
            }
          ]
        },
        generatedAt: new Date('2026-06-08T18:00:00.000Z'),
        correlationId: 'batch-correlation-1'
      });

      try {
        await writeMissingNextTaskOutputFile(outputPath, output);
        const written = JSON.parse(await readFile(outputPath, 'utf8'));

        expect(written).toMatchObject({
          status,
          timestamp: '2026-06-08T18:00:00.000Z',
          correlationId: 'batch-correlation-1',
          operationCorrelationIds: ['operation-correlation-1'],
          summary: {
            auditIds: ['audit-output-1'],
            outboundEventIds: ['event-output-1']
          },
          operations: [
            {
              personId: 'person-safe-1',
              auditId: 'audit-output-1',
              outboundEventId: 'event-output-1'
            }
          ]
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  );

  it('recovers a failed operation without duplicating an existing deduped task', async () => {
    const operation = buildMissingNextTaskOperation({
      record: safePlanRecord('person-safe-1'),
      now: new Date('2026-06-05T15:00:00.000Z')
    });
    const recoveryPlan = buildMissingNextTaskRecoveryPlan({
      plan: fakeMissingNextTaskPlan({
        plans: [safePlanRecord('person-safe-1')]
      }),
      applyOutput: {
        status: 'partial_success',
        operations: [
          {
            personId: 'person-safe-1',
            status: 'failed',
            dedupeKey: operation.dedupeKey
          }
        ]
      }
    });
    const restClient = fakeTaskClient({
      tasks: [
        {
          id: 'task-existing-dedupe',
          title: 'Send relationship-oriented connection request',
          status: 'TODO',
          bodyV2: {
            markdown: `Dedupe key: ${operation.dedupeKey}`
          }
        }
      ]
    });
    const result = await applyMissingNextTaskPlan({
      plan: recoveryPlan,
      config: baseConfig(),
      restClient,
      operationalStore: fakeOperationalStore(),
      options: {
        applyEnabled: true,
        liveTest: true,
        batchSize: 1,
        offset: 0,
        writeDelayMs: 0
      },
      now: new Date('2026-06-05T15:00:00.000Z')
    });

    expect(result.operations[0]).toMatchObject({
      status: 'verification_succeeded',
      duplicateTaskSkipped: true,
      task: {
        id: 'task-existing-dedupe'
      },
      personTarget: {
        targetPersonId: 'person-safe-1'
      }
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

  it('handles a missing apply output file with an actionable recovery response', async () => {
    const loaded = await loadMissingNextTaskApplyOutput({
      applyOutputPath: '/tmp/visible-gap-missing-next-task-output.json',
      config: {
        supabase: {
          enabled: false
        }
      },
      fallbackLoader: async () => null,
      now: new Date('2026-06-08T18:00:00.000Z')
    });

    expect(loaded).toMatchObject({
      source: 'missing',
      missingFile: true,
      output: {
        ok: false,
        status: 'missing_apply_output',
        operations: [],
        recommendedNextCommand:
          'Re-run the apply command in dry-run mode or inspect Supabase crm_sync_logs for action=missing_next_task_create before recovery.'
      }
    });
    expect(loaded.warnings[0]).toContain('Apply output file was not found');
  });

  it('can reconstruct recovery input from Supabase-style CRM and outbound logs', () => {
    const fallbackOutput = buildMissingNextTaskApplyOutputFromLogs({
      crmSyncLogs: [
        {
          id: 'audit-fallback-1',
          correlation_id: 'missing-next-task:person-safe-1:abc',
          action: 'missing_next_task_create',
          dedupe_key:
            'outbound-cadence:person:person-safe-1:cadence:RELATIONSHIP_BUILDING_V1:stage:CONNECTION_REQUEST:task:connection_request',
          status: 'failed',
          request_payload: {
            taskPayload: {
              title: 'Send relationship-oriented connection request',
              dueAt: '2026-06-09'
            },
            personTarget: {
              targetPersonId: 'person-safe-1'
            }
          },
          error_payload: {
            message: 'Limit reached',
            retryAfterSeconds: 60
          },
          created_at: '2026-06-08T18:00:00.000Z'
        }
      ],
      outboundEvents: [
        {
          id: 'event-fallback-1',
          correlation_id: 'missing-next-task:person-safe-1:abc',
          event_type: 'missing_next_task_created',
          status: 'failed',
          payload: {
            personId: 'person-safe-1',
            personName: 'Lead person-safe-1',
            cadenceName: 'RELATIONSHIP_BUILDING_V1',
            cadenceStage: 'CONNECTION_REQUEST',
            latestTouchStatus: 'DRAFTED',
            recommendedTaskTitle: 'Send relationship-oriented connection request',
            recommendedDueDate: '2026-06-09',
            recommendedTaskType: 'connection_request'
          }
        }
      ],
      generatedAt: new Date('2026-06-08T18:00:00.000Z'),
      correlationId: 'fallback-source-1'
    });
    const recoveryPlan = buildMissingNextTaskRecoveryPlan({
      plan: fakeMissingNextTaskPlan({
        plans: [safePlanRecord('person-safe-1')]
      }),
      applyOutput: fallbackOutput
    });

    expect(fallbackOutput).toMatchObject({
      source: 'supabase_logs',
      status: 'failed',
      retryAfterSeconds: 60,
      operations: [
        {
          personId: 'person-safe-1',
          status: 'failed',
          auditId: 'audit-fallback-1',
          outboundEventId: 'event-fallback-1'
        }
      ]
    });
    expect(recoveryPlan).toMatchObject({
      recoverableOperationCount: 1,
      plans: [
        {
          personId: 'person-safe-1'
        }
      ]
    });
  });

  it('marks verification_failed when the created taskTarget cannot be verified', async () => {
    const result = await applyMissingNextTaskPlan({
      plan: fakeMissingNextTaskPlan({
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

  it('keeps optional Company taskTarget links disabled by default', () => {
    const operation = buildMissingNextTaskOperation({
      record: safePlanRecord('person-safe-1', {
        companyId: 'company-safe-1'
      }),
      linkCompany: false,
      now: new Date('2026-06-05T15:00:00.000Z')
    });

    expect(operation.companyTargetEnabled).toBe(false);
  });
});

describe('assessment workflow isolation', () => {
  it('keeps assessment processing unaffected by missing next-task apply helpers', async () => {
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

function fakeMissingNextTaskPlan(overrides = {}) {
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
        recommendedTaskType: 'value_touch',
        recommendedTaskTitle: 'Send value touch',
        cadenceStage: 'VALUE_TOUCH'
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
    cadenceStage: 'CONNECTION_REQUEST',
    latestTouchChannel: 'LINKEDIN',
    latestTouchStatus: 'DRAFTED',
    nextOutboundTouchDate: '2026-06-06',
    recommendedTaskTitle: 'Send relationship-oriented connection request',
    recommendedDueDate: '2026-06-06',
    recommendedTaskType: 'connection_request',
    confidence: 'high',
    evidence: ['No open task resolved through taskTargets or Person markers.'],
    safeToCreate: true,
    isTestRecord: false,
    testRecordReasons: [],
    warnings: [],
    ...overrides
  };
}

function fakeTaskClient({ tasks = [], taskTargets = [], persistTaskTargets = true, createFailures = {} } = {}) {
  return {
    tasks: [...tasks],
    taskTargets: [...taskTargets],
    createFailures,
    created: [],
    async listAllRecords(objectPlural) {
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
      if (objectPlural === 'tasks') {
        return this.tasks.find((task) => task.id === id) ?? null;
      }

      return null;
    },
    async createRecord(objectPlural, payload) {
      const failure = consumeFailure(this.createFailures, objectPlural);

      if (failure) {
        throw failure;
      }

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
    }
  };
}

function consumeFailure(failures, objectPlural) {
  const failure = failures[objectPlural];

  if (Array.isArray(failure)) {
    return failure.shift() ?? null;
  }

  return failure ?? null;
}

function httpError(status, message, { retryAfter } = {}) {
  const error = new Error(message);
  error.response = {
    status,
    data: {
      message
    },
    headers: retryAfter
      ? {
          'retry-after': String(retryAfter)
        }
      : {}
  };
  return error;
}

function fakeEmptyQueueRestClient() {
  return {
    async listAllRecords(objectPlural) {
      return {
        records: [],
        warnings: [],
        pagination: {
          objectPlural,
          pagesFetched: 1,
          totalFetched: 0,
          totalCount: 0,
          hasMore: false
        }
      };
    },
    async listRecords() {
      return [];
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
