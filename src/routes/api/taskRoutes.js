import express from 'express';
import { createCrmAdapter } from '../../integrations/crm/crmAdapter.js';
import { requireWorkspaceAuth } from '../../middleware/supabaseWorkspaceAuth.js';
import { createOperationalStore } from '../../persistence/operationalStore.js';
import { completeOutboundTaskWorkflow } from '../../workflows/outbound/completeTaskWorkflow.js';

const TASK_COMPLETION_WORKSPACE_ROLES = ['admin', 'operator', 'rep'];

export function createTaskApiRouter({
  config = {},
  log,
  completeOutboundTaskWorkflowFn = completeOutboundTaskWorkflow,
  createCrmAdapterFn = createCrmAdapter,
  createOperationalStoreFn = createOperationalStore,
  workspaceAuthSupabaseClient
} = {}) {
  const router = express.Router();

  router.post(
    '/:id/complete',
    requireWorkspaceAuth({
      config,
      log,
      allowedRoles: TASK_COMPLETION_WORKSPACE_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleTaskComplete(req, res, next, {
        config,
        log,
        completeOutboundTaskWorkflowFn,
        createCrmAdapterFn,
        createOperationalStoreFn
      });
    }
  );

  return router;
}

export async function handleTaskComplete(
  req,
  res,
  next,
  {
    config = {},
    log,
    completeOutboundTaskWorkflowFn = completeOutboundTaskWorkflow,
    createCrmAdapterFn = createCrmAdapter,
    createOperationalStoreFn = createOperationalStore
  } = {}
) {
  try {
    const crmAdapter = createCrmAdapterFn({
      provider: config.crmProvider ?? 'twenty',
      config,
      log: req.log ?? log
    });
    const operationalStore = config.supabase?.enabled
      ? createOperationalStoreFn({ config, log: req.log ?? log })
      : null;
    const result = await completeOutboundTaskWorkflowFn({
      input: {
        ...req.body,
        taskId: req.body?.taskId ?? req.params.id
      },
      config,
      log: req.log ?? log,
      workspaceUser: req.workspaceUser,
      crmAdapter,
      operationalStore,
      correlationId: req.correlationId
    });

    res.status(getStatusCode(result.status)).json(successEnvelope({
      correlationId: req.correlationId,
      data: toTaskCompletionResponse(result),
      warnings: buildTaskCompletionWarnings(result)
    }));
  } catch (error) {
    handleTaskCompletionError(error, req, res, next);
  }
}

function toTaskCompletionResponse(result) {
  return {
    status: result.status,
    personId: result.personId,
    taskId: result.taskId,
    transition: result.transition,
    personUpdate: result.personUpdate,
    nextTask: result.nextTask,
    crmResults: result.crmSync.operations.map((operation) => ({
      object: operation.object,
      action: operation.action,
      status: operation.status,
      id: operation.response?.id ?? operation.id,
      duplicateAvoided: operation.status === 'skipped',
      dedupeKey: operation.dedupeKey,
      error: operation.error?.message,
      responseBody: operation.error?.responseBody,
      payload: operation.payload
    })),
    relationshipResults: (result.crmSync.relationshipResults ?? []).map((operation) => ({
      key: operation.key,
      object: operation.object,
      action: operation.action,
      status: operation.status,
      id: operation.response?.id ?? operation.id,
      dedupeKey: operation.dedupeKey,
      payload: operation.payload,
      reason: operation.reason,
      error: operation.error?.message,
      responseBody: operation.error?.responseBody
    })),
    outboundEvents: {
      persisted: result.outboundEvents.persisted.length > 0,
      ids: result.outboundEvents.persisted.map((event) => event.id),
      planned: result.outboundEvents.planned
    },
    auditLogs: {
      persisted: result.auditLogs.length > 0,
      ids: result.auditLogs.map((log) => log.id)
    },
    workspaceUser: result.workspaceUser,
    skippedRelationships: result.skippedRelationships
  };
}

function buildTaskCompletionWarnings(result) {
  const warnings = [];

  for (const skipped of result.skippedRelationships ?? []) {
    warnings.push(`${skipped.key}: ${skipped.reason}`);
  }

  for (const operation of result.crmSync.relationshipResults ?? []) {
    if (operation.status === 'failed') {
      warnings.push(
        `Relationship ${operation.key} failed: ${operation.error?.message ?? 'Unknown error'}`
      );
    }
  }

  if (!result.nextTask) {
    warnings.push('No automatic next task was created for this terminal cadence stage.');
  }

  return warnings;
}

function getStatusCode(status) {
  if (['failed', 'partial_failure', 'blocked_configuration'].includes(status)) {
    return 207;
  }

  return 202;
}

function handleTaskCompletionError(error, req, res, next) {
  const code = error.code ?? 'TASK_COMPLETION_ERROR';
  const statusCode = error.statusCode ?? error.status ?? (code.endsWith('_FAILED') ? 422 : 500);

  if (statusCode >= 500) {
    next(error);
    return;
  }

  res.status(statusCode).json(
    errorEnvelope({
      correlationId: req.correlationId,
      code,
      message: error.message
    })
  );
}

function successEnvelope({ correlationId, data, warnings = [] }) {
  return {
    ok: true,
    correlationId,
    data,
    warnings,
    errors: []
  };
}

function errorEnvelope({ correlationId, code, message, data = null }) {
  return {
    ok: false,
    correlationId,
    data,
    warnings: [],
    errors: [
      {
        code,
        message
      }
    ]
  };
}
