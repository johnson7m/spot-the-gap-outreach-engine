import express from 'express';
import { requireWorkspaceAuth } from '../../middleware/supabaseWorkspaceAuth.js';
import { getExecutiveReportingWorkflow } from '../../workflows/reporting/getExecutiveReportingWorkflow.js';
import { getQueueHealthReportingWorkflow } from '../../workflows/reporting/getQueueHealthReportingWorkflow.js';
import { getOperationsReportingWorkflow } from '../../workflows/reporting/getOperationsReportingWorkflow.js';
import { getRepPerformanceReportingWorkflow } from '../../workflows/reporting/getRepPerformanceReportingWorkflow.js';
import { getCadenceAnalyticsReportingWorkflow } from '../../workflows/reporting/getCadenceAnalyticsReportingWorkflow.js';
import { getReadObservabilityReportingWorkflow } from '../../workflows/reporting/getReadObservabilityReportingWorkflow.js';

const REPORTING_WORKSPACE_ROLES = ['admin', 'operator', 'rep'];
const READ_OBSERVABILITY_ROLES = ['admin', 'operator'];

export function createReportingApiRouter({
  config = {},
  log,
  getExecutiveReportingWorkflowFn = getExecutiveReportingWorkflow,
  getQueueHealthReportingWorkflowFn = getQueueHealthReportingWorkflow,
  getRepPerformanceReportingWorkflowFn = getRepPerformanceReportingWorkflow,
  getOperationsReportingWorkflowFn = getOperationsReportingWorkflow,
  getCadenceAnalyticsReportingWorkflowFn = getCadenceAnalyticsReportingWorkflow,
  getReadObservabilityReportingWorkflowFn = getReadObservabilityReportingWorkflow,
  workspaceAuthSupabaseClient,
  dataSource,
  activitySource
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

  router.get(
    '/rep-performance',
    requireWorkspaceAuth({
      config,
      log,
      allowedRoles: REPORTING_WORKSPACE_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleRepPerformanceReportingFetch(req, res, next, {
        config,
        log,
        getRepPerformanceReportingWorkflowFn,
        dataSource,
        activitySource
      });
    }
  );

  router.get(
    '/operations',
    requireWorkspaceAuth({
      config,
      log,
      allowedRoles: REPORTING_WORKSPACE_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleOperationsReportingFetch(req, res, next, {
        config,
        log,
        getOperationsReportingWorkflowFn,
        activitySource
      });
    }
  );

  router.get(
    '/read-observability',
    requireWorkspaceAuth({
      config,
      log,
      allowedRoles: READ_OBSERVABILITY_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleReadObservabilityReportingFetch(req, res, next, {
        getReadObservabilityReportingWorkflowFn
      });
    }
  );

  router.get(
    '/cadence-analytics',
    requireWorkspaceAuth({
      config,
      log,
      allowedRoles: REPORTING_WORKSPACE_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleCadenceAnalyticsReportingFetch(req, res, next, {
        config,
        log,
        getCadenceAnalyticsReportingWorkflowFn,
        dataSource,
        activitySource
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

export async function handleRepPerformanceReportingFetch(
  req,
  res,
  next,
  {
    config = {},
    log,
    getRepPerformanceReportingWorkflowFn = getRepPerformanceReportingWorkflow,
    dataSource,
    activitySource
  } = {}
) {
  try {
    const result = await getRepPerformanceReportingWorkflowFn({
      query: req.query ?? {},
      config,
      log: req.log ?? log,
      workspaceUser: req.workspaceUser,
      dataSource,
      activitySource,
      correlationId: req.correlationId
    });

    res.json(successEnvelope({ correlationId: req.correlationId, data: result, warnings: result.warnings }));
  } catch (error) {
    handleReportingError(error, req, res, next);
  }
}

export async function handleOperationsReportingFetch(
  req,
  res,
  next,
  {
    config = {},
    log,
    getOperationsReportingWorkflowFn = getOperationsReportingWorkflow,
    activitySource
  } = {}
) {
  try {
    const result = await getOperationsReportingWorkflowFn({
      query: req.query ?? {},
      config,
      log: req.log ?? log,
      workspaceUser: req.workspaceUser,
      activitySource,
      correlationId: req.correlationId
    });

    res.json(successEnvelope({ correlationId: req.correlationId, data: result, warnings: result.warnings }));
  } catch (error) {
    handleReportingError(error, req, res, next);
  }
}

export async function handleCadenceAnalyticsReportingFetch(
  req,
  res,
  next,
  {
    config = {},
    log,
    getCadenceAnalyticsReportingWorkflowFn = getCadenceAnalyticsReportingWorkflow,
    dataSource,
    activitySource
  } = {}
) {
  try {
    const result = await getCadenceAnalyticsReportingWorkflowFn({
      query: req.query ?? {},
      config,
      log: req.log ?? log,
      workspaceUser: req.workspaceUser,
      dataSource,
      activitySource,
      correlationId: req.correlationId
    });

    res.json(successEnvelope({ correlationId: req.correlationId, data: result, warnings: result.warnings }));
  } catch (error) {
    handleReportingError(error, req, res, next);
  }
}

export async function handleReadObservabilityReportingFetch(
  req,
  res,
  next,
  {
    getReadObservabilityReportingWorkflowFn = getReadObservabilityReportingWorkflow
  } = {}
) {
  try {
    const result = await getReadObservabilityReportingWorkflowFn({
      query: req.query ?? {},
      workspaceUser: req.workspaceUser,
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
