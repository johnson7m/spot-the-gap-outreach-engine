import express from 'express';
import { requireWorkspaceAuth } from '../../middleware/supabaseWorkspaceAuth.js';
import {
  getWorkspaceSnapshotStatus,
  refreshWorkspaceSnapshot
} from '../../services/workspaceSnapshotService.js';

const SNAPSHOT_WORKSPACE_ROLES = ['admin', 'operator'];

export function createWorkspaceSnapshotApiRouter({
  config = {},
  log,
  workspaceAuthSupabaseClient,
  dataSource,
  refreshWorkspaceSnapshotFn = refreshWorkspaceSnapshot,
  getWorkspaceSnapshotStatusFn = getWorkspaceSnapshotStatus
} = {}) {
  const router = express.Router();

  router.get(
    '/status',
    requireWorkspaceAuth({
      config,
      log,
      allowedRoles: SNAPSHOT_WORKSPACE_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleWorkspaceSnapshotStatus(req, res, next, {
        config,
        getWorkspaceSnapshotStatusFn
      });
    }
  );

  router.post(
    '/refresh',
    requireWorkspaceAuth({
      config,
      log,
      allowedRoles: SNAPSHOT_WORKSPACE_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleWorkspaceSnapshotRefresh(req, res, next, {
        config,
        log,
        dataSource,
        refreshWorkspaceSnapshotFn
      });
    }
  );

  return router;
}

export async function handleWorkspaceSnapshotStatus(
  req,
  res,
  next,
  { config = {}, getWorkspaceSnapshotStatusFn = getWorkspaceSnapshotStatus } = {}
) {
  try {
    const result = getWorkspaceSnapshotStatusFn({ config });

    res.json(
      successEnvelope({
        correlationId: req.correlationId,
        data: {
          snapshot: result.metadata,
          countsByObjectType: result.metadata?.countsByObjectType ?? {},
          summary: result.snapshot?.classification ?? null
        }
      })
    );
  } catch (error) {
    next(error);
  }
}

export async function handleWorkspaceSnapshotRefresh(
  req,
  res,
  next,
  {
    config = {},
    log,
    dataSource,
    refreshWorkspaceSnapshotFn = refreshWorkspaceSnapshot
  } = {}
) {
  try {
    const result = await refreshWorkspaceSnapshotFn({
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
          snapshot: result.metadata,
          countsByObjectType: result.metadata?.countsByObjectType ?? {},
          summary: result.snapshot?.classification ?? null
        },
        warnings: result.snapshot?.warnings ?? []
      })
    );
  } catch (error) {
    next(error);
  }
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
