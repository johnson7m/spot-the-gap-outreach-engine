import express from 'express';
import { requireWorkspaceAuth } from '../../middleware/supabaseWorkspaceAuth.js';
import { getOutboundQueueWorkflow } from '../../workflows/outbound/getQueueWorkflow.js';

const QUEUE_WORKSPACE_ROLES = ['admin', 'operator', 'rep'];
const QUEUE_ROUTES = [
  ['fresh-leads', '/fresh-leads'],
  ['follow-ups', '/follow-ups'],
  ['warm-assessments', '/warm-assessments'],
  ['stale-recovery', '/stale-recovery'],
  ['pipeline-review', '/pipeline-review']
];

export function createQueueApiRouter({
  config = {},
  log,
  getOutboundQueueWorkflowFn = getOutboundQueueWorkflow,
  workspaceAuthSupabaseClient,
  dataSource
} = {}) {
  const router = express.Router();

  for (const [queueSlug, path] of QUEUE_ROUTES) {
    router.get(
      path,
      requireWorkspaceAuth({
        config,
        log,
        allowedRoles: QUEUE_WORKSPACE_ROLES,
        supabaseClient: workspaceAuthSupabaseClient
      }),
      async (req, res, next) => {
        await handleQueueFetch(req, res, next, {
          queueSlug,
          config,
          log,
          getOutboundQueueWorkflowFn,
          dataSource
        });
      }
    );
  }

  return router;
}

export async function handleQueueFetch(
  req,
  res,
  next,
  {
    queueSlug,
    config = {},
    log,
    getOutboundQueueWorkflowFn = getOutboundQueueWorkflow,
    dataSource
  } = {}
) {
  try {
    const result = await getOutboundQueueWorkflowFn({
      queueSlug,
      query: req.query ?? {},
      config,
      log: req.log ?? log,
      workspaceUser: req.workspaceUser,
      dataSource,
      correlationId: req.correlationId
    });

    res.json(
      successEnvelope({
        correlationId: req.correlationId,
        data: {
          queueName: result.queueName,
          queueSlug: result.queueSlug,
          items: result.items,
          count: result.count,
          limit: result.limit,
          offset: result.offset,
          ownerScope: result.ownerScope,
          dataSource: result.dataSource,
          warnings: result.warnings
        },
        warnings: result.warnings
      })
    );
  } catch (error) {
    handleQueueError(error, req, res, next);
  }
}

function handleQueueError(error, req, res, next) {
  const statusCode = error.statusCode ?? error.status ?? 500;

  if (statusCode >= 500 && error.code !== 'TWENTY_QUEUE_READ_FAILED') {
    next(error);
    return;
  }

  res.status(statusCode).json(
    errorEnvelope({
      correlationId: req.correlationId,
      code: error.code ?? 'QUEUE_FETCH_FAILED',
      message: error.message,
      data: {
        details: error.details ?? null
      }
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
