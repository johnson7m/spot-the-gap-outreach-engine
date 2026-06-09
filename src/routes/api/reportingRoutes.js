import express from 'express';
import { requireWorkspaceAuth } from '../../middleware/supabaseWorkspaceAuth.js';
import { getExecutiveReportingWorkflow } from '../../workflows/reporting/getExecutiveReportingWorkflow.js';
import { getQueueHealthReportingWorkflow } from '../../workflows/reporting/getQueueHealthReportingWorkflow.js';

const REPORTING_WORKSPACE_ROLES = ['admin', 'operator', 'rep'];

export function createReportingApiRouter({
  config = {},
  log,
  getExecutiveReportingWorkflowFn = getExecutiveReportingWorkflow,
  getQueueHealthReportingWorkflowFn = getQueueHealthReportingWorkflow,
  workspaceAuthSupabaseClient,
  dataSource
} = {}) {
  const router = express.Router();

  router.get(
    '/executive',
    requireWorkspaceAuth({
      config,
      log,
      allowedRoles: REPORTING_WORKSPACE_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleExecutiveReportingFetch(req, res, next, {
        config,
        log,
        getExecutiveReportingWorkflowFn,
        dataSource
      });
    }
  );

  router.get(
    '/queue-health',
    requireWorkspaceAuth({
      config,
      log,
      allowedRoles: REPORTING_WORKSPACE_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleQueueHealthReportingFetch(req, res, next, {
        config,
        log,
        getQueueHealthReportingWorkflowFn,
        dataSource
      });
    }
  );

  return router;
}

export async function handleExecutiveReportingFetch(
  req,
  res,
  next,
  {
    config = {},
    log,
    getExecutiveReportingWorkflowFn = getExecutiveReportingWorkflow,
    dataSource
  } = {}
) {
  try {
    const result = await getExecutiveReportingWorkflowFn({
      query: req.query ?? {},
      config,
      log: req.log ?? log,
      workspaceUser: req.workspaceUser,
      dataSource,
      correlationId: req.correlationId
    });

    res.json(successEnvelope({ correlationId: req.correlationId, data: result, warnings: result.warnings }));
  } catch (error) {
    handleReportingError(error, req, res, next);
  }
}

export async function handleQueueHealthReportingFetch(
  req,
  res,
  next,
  {
    config = {},
    log,
    getQueueHealthReportingWorkflowFn = getQueueHealthReportingWorkflow,
    dataSource
  } = {}
) {
  try {
    const result = await getQueueHealthReportingWorkflowFn({
      query: req.query ?? {},
      config,
      log: req.log ?? log,
      workspaceUser: req.workspaceUser,
      dataSource,
      correlationId: req.correlationId
    });

    res.json(successEnvelope({ correlationId: req.correlationId, data: result, warnings: result.warnings }));
  } catch (error) {
    handleReportingError(error, req, res, next);
  }
}

function handleReportingError(error, req, res, next) {
  const statusCode = error.statusCode ?? error.status ?? 500;

  if (statusCode >= 500 && error.code !== 'TWENTY_REPORTING_READ_FAILED') {
    next(error);
    return;
  }

  res.status(statusCode).json(
    errorEnvelope({
      correlationId: req.correlationId,
      code: error.code ?? 'REPORTING_FETCH_FAILED',
      message: error.message
    })
  );
}

function successEnvelope({ correlationId, data, warnings = [] }) {
  return {
    ok: true,
    correlationId,
    data,
    warnings: warnings ?? [],
    errors: []
  };
}

function errorEnvelope({ correlationId, code, message }) {
  return {
    ok: false,
    correlationId,
    data: null,
    warnings: [],
    errors: [
      {
        code,
        message
      }
    ]
  };
}
