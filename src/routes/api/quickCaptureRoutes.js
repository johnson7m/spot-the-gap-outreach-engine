import express from 'express';
import { createCrmAdapter } from '../../integrations/crm/crmAdapter.js';
import { PROTECTED_ASSESSMENT_FIELDS } from '../../integrations/twenty/quickCaptureClient.js';
import { createOperationalStore } from '../../persistence/operationalStore.js';
import {
  createSupabaseWorkspaceAuth,
  requireWorkspaceAuthOrSecret
} from '../../middleware/supabaseWorkspaceAuth.js';
import { sanitizeWorkspaceUser } from '../../utils/outboundActorMapper.js';
import { processQuickCaptureLead } from '../../workflows/outbound/quickCaptureWorkflow.js';

const QUICK_CAPTURE_WORKSPACE_ROLES = ['admin', 'operator', 'rep'];

export function createQuickCaptureApiRouter({
  config = {},
  log,
  processQuickCaptureLeadFn = processQuickCaptureLead,
  createCrmAdapterFn = createCrmAdapter,
  createOperationalStoreFn = createOperationalStore,
  workspaceAuthSupabaseClient
} = {}) {
  const router = express.Router();

  router.post(
    '/preview',
    createSupabaseWorkspaceAuth({
      config,
      log,
      required: Boolean(config.supabase?.authRequiredForWorkspaceApi),
      allowedRoles: QUICK_CAPTURE_WORKSPACE_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleQuickCapturePreview(req, res, next, {
        config,
        log,
        processQuickCaptureLeadFn
      });
    }
  );

  router.post(
    '/commit',
    requireWorkspaceAuthOrSecret({
      config,
      log,
      allowedRoles: QUICK_CAPTURE_WORKSPACE_ROLES,
      supabaseClient: workspaceAuthSupabaseClient
    }),
    async (req, res, next) => {
      await handleQuickCaptureCommit(req, res, next, {
        config,
        log,
        processQuickCaptureLeadFn,
        createCrmAdapterFn,
        createOperationalStoreFn
      });
    }
  );

  return router;
}

export async function handleQuickCapturePreview(
  req,
  res,
  next,
  { config = {}, log, processQuickCaptureLeadFn = processQuickCaptureLead } = {}
) {
  try {
    if (config.quickCapture?.apiPreviewEnabled === false) {
      res.status(403).json(
        errorEnvelope({
          correlationId: req.correlationId,
          code: 'QUICK_CAPTURE_PREVIEW_DISABLED',
          message: 'Quick Capture preview API is disabled.'
        })
      );
      return;
    }

    const plan = await buildPreviewPlan({
      body: req.body,
      config,
      log: req.log ?? log,
      workspaceUser: req.workspaceUser,
      processQuickCaptureLeadFn
    });

    res.json(
      successEnvelope({
        correlationId: req.correlationId,
        data: toPreviewResponse(plan),
        warnings: plan.warnings
      })
    );
  } catch (error) {
    handleQuickCaptureError(error, req, res, next);
  }
}

export async function handleQuickCaptureCommit(
  req,
  res,
  next,
  {
    config = {},
    log,
    processQuickCaptureLeadFn = processQuickCaptureLead,
    createCrmAdapterFn = createCrmAdapter,
    createOperationalStoreFn = createOperationalStore
  } = {}
) {
  try {
    const guardError = validateCommitGuards(config);

    if (guardError) {
      res.status(403).json(
        errorEnvelope({
          correlationId: req.correlationId,
          ...guardError
        })
      );
      return;
    }

    const operationalStore = config.supabase?.enabled
      ? createOperationalStoreFn({ config, log: req.log ?? log })
      : null;
    const plan = await processQuickCaptureLeadFn({
      input: extractLeadPayload(req.body),
      config,
      operationalStore,
      dryRun: false,
      persistEvents: Boolean(config.supabase?.enabled),
      workspaceUser: req.workspaceUser,
      log: req.log ?? log
    });

    if (!plan.schemaValidation?.ok) {
      res.status(422).json(
        errorEnvelope({
          correlationId: req.correlationId,
          code: 'QUICK_CAPTURE_SCHEMA_VALIDATION_FAILED',
          message: 'Quick Capture commit blocked because outbound schema validation failed.',
          data: {
            schemaValidation: plan.schemaValidation,
            warnings: plan.warnings
          }
        })
      );
      return;
    }

    const personPayloadValidation = plan.crmPayloads?.person?.payloadValidation;

    if (personPayloadValidation && !personPayloadValidation.ok) {
      res.status(422).json(
        errorEnvelope({
          correlationId: req.correlationId,
          code: 'PERSON_PAYLOAD_VALIDATION_FAILED',
          message: 'Quick Capture commit blocked because the Person payload is not safe to write to Twenty.',
          data: {
            partialResults: {
              outboundEvent: {
                id: plan.outboundEvent?.persisted?.id ?? null,
                status: plan.outboundEvent?.persisted?.status ?? plan.outboundEvent?.planned?.status
              },
              crmResults: [],
              auditLogs: []
            },
            personPayloadValidation: plan.crmPayloads.person.payloadValidation,
            protectedFieldCheck: buildProtectedFieldCheck(plan.crmPayloads.person.payload)
          }
        })
      );
      return;
    }

    const adapter = createCrmAdapterFn({
      provider: config.crmProvider ?? 'twenty',
      config,
      log: req.log ?? log
    });
    const crmSync = await adapter.syncQuickCaptureLead({
      lead: plan.normalizedLead,
      payloads: plan.crmPayloads
    });
    const auditLogs = operationalStore
      ? await appendQuickCaptureCrmAuditLogs({
          store: operationalStore,
          plan,
          crmSync
        })
      : [];
    const statusCode = ['failed', 'partial_failure', 'blocked_configuration'].includes(
      crmSync.status
    )
      ? 207
      : 202;

    res.status(statusCode).json(
      successEnvelope({
        correlationId: req.correlationId,
        data: toCommitResponse({ plan, crmSync, auditLogs, workspaceUser: req.workspaceUser }),
        warnings: [...plan.warnings, ...buildRelationshipWarnings(crmSync.relationshipResults)]
      })
    );
  } catch (error) {
    handleQuickCaptureError(error, req, res, next);
  }
}

async function buildPreviewPlan({
  body,
  config,
  log,
  workspaceUser,
  processQuickCaptureLeadFn
}) {
  return processQuickCaptureLeadFn({
    input: extractLeadPayload(body),
    config: {
      ...config,
      twenty: {
        ...config.twenty,
        syncEnabled: false
      },
      supabase: {
        ...config.supabase,
        enabled: false
      }
    },
    dryRun: true,
    persistEvents: false,
    workspaceUser,
    log
  });
}

function extractLeadPayload(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  return body.lead ?? body.input ?? body;
}

function toPreviewResponse(plan) {
  return {
    status: 'preview',
    dryRun: true,
    normalizedLead: plan.normalizedLead,
    dedupePlan: buildDedupePlan(plan),
    crmPayloadPreview: plan.crmPayloads,
    firstTaskPreview: {
      plan: plan.cadence?.firstTask,
      payload: plan.crmPayloads?.task
    },
    cadencePlan: plan.cadence,
    schemaValidation: plan.schemaValidation,
    protectedFieldCheck: buildProtectedFieldCheck(plan.crmPayloads?.person?.payload),
    personPayloadValidation: plan.crmPayloads?.person?.payloadValidation,
    outboundEventPreview: plan.outboundEvent?.planned,
    workspaceUser: sanitizeWorkspaceUser(plan.workspaceUser),
    workspaceMember: plan.workspaceMember ?? null
  };
}

function toCommitResponse({ plan, crmSync, auditLogs, workspaceUser }) {
  return {
    status: crmSync.status,
    normalizedLead: plan.normalizedLead,
    dedupePlan: buildDedupePlan(plan),
    outboundEvent: {
      id: plan.outboundEvent?.persisted?.id ?? null,
      status: plan.outboundEvent?.persisted?.status ?? plan.outboundEvent?.planned?.status
    },
    crmResults: crmSync.operations.map((operation) => ({
      object: operation.object,
      action: operation.action,
      status: operation.status,
      id: operation.response?.id,
      duplicateAvoided: operation.duplicateAvoided,
      matchedBy: operation.matchedBy,
      dedupeKey: operation.dedupeKey,
      error: operation.error?.message,
      httpStatus: operation.error?.httpStatus,
      responseBody: operation.error?.responseBody,
      validationMessages: operation.error?.validationMessages,
      diagnostics: operation.error?.diagnostics,
      payloadValidation: operation.payloadValidation
    })),
    relationshipResults: (crmSync.relationshipResults ?? []).map(toRelationshipResponse),
    auditLogs: {
      persisted: auditLogs.length > 0,
      ids: auditLogs.map((record) => record.id)
    },
    workspaceUser: sanitizeWorkspaceUser(workspaceUser ?? plan.workspaceUser),
    workspaceMember: plan.workspaceMember ?? null,
    protectedFieldCheck: buildProtectedFieldCheck(plan.crmPayloads?.person?.payload),
    personPayloadValidation: plan.crmPayloads?.person?.payloadValidation,
    skippedRelationships: crmSync.skippedRelationships ?? []
  };
}

function toRelationshipResponse(operation) {
  return {
    key: operation.key,
    object: operation.object,
    action: operation.action,
    status: operation.status,
    id: operation.response?.id ?? operation.id,
    dedupeKey: operation.dedupeKey,
    payload: operation.payload,
    reason: operation.reason,
    error: operation.error?.message,
    httpStatus: operation.error?.httpStatus,
    responseBody: operation.error?.responseBody,
    metadataValidation: operation.metadataValidation
  };
}

function buildDedupePlan(plan) {
  const lead = plan.normalizedLead ?? {};
  const companyOperation = plan.crmPayloads?.company;
  const warnings = [];

  if (!lead.email) {
    warnings.push('Email missing; Person dedupe will rely on LinkedIn URL or name plus company.');
  }

  if (!lead.linkedinUrl) {
    warnings.push('LinkedIn URL missing; Person dedupe is less precise.');
  }

  if (!lead.companyDomain) {
    warnings.push('Company domain missing; Company dedupe will rely on company name.');
  }

  return {
    strategy: lead.dedupe?.strategy,
    key: lead.dedupe?.key,
    companyDedupeKey: companyOperation?.dedupeKey ?? null,
    duplicateCandidates: [],
    requiresMergeDecision: false,
    warnings
  };
}

function buildProtectedFieldCheck(personPayload = {}) {
  const present = PROTECTED_ASSESSMENT_FIELDS.filter((fieldName) =>
    Object.hasOwn(personPayload, fieldName)
  );

  return {
    ok: present.length === 0,
    excluded: present.length === 0,
    protectedFields: PROTECTED_ASSESSMENT_FIELDS,
    present
  };
}

function validateCommitGuards(config = {}) {
  if (!config.quickCapture?.apiCommitEnabled) {
    return {
      code: 'QUICK_CAPTURE_COMMIT_DISABLED',
      message: 'Quick Capture commit API is disabled.'
    };
  }

  if (!config.twenty?.syncEnabled) {
    return {
      code: 'TWENTY_SYNC_DISABLED',
      message: 'Quick Capture commit requires TWENTY_SYNC_ENABLED=true.'
    };
  }

  return null;
}

async function appendQuickCaptureCrmAuditLogs({ store, plan, crmSync }) {
  const logs = [];
  const startedAt = new Date().toISOString();
  const finishedAt = startedAt;

  for (const operation of [
    ...crmSync.operations,
    ...(crmSync.relationshipResults ?? [])
  ]) {
    logs.push(
      await store.appendCrmSyncLog({
        assessmentSubmissionId: null,
        workflowJobId: null,
        correlationId: plan.outboundEvent.planned.correlationId,
        provider: crmSync.provider,
        objectName: operation.object,
        action: operation.action,
        dedupeKey: operation.dedupeKey,
        status: normalizeAuditStatus(operation.status),
        attempt: operation.attempts ?? 1,
        requestPayload: {
          payload: operation.payload,
          fieldNames: Object.keys(operation.payload ?? {}),
          dedupeStrategy: plan.normalizedLead?.dedupe?.strategy ?? null,
          payloadValidation: operation.payloadValidation,
          workspaceUser: sanitizeWorkspaceUser(plan.workspaceUser)
        },
        responsePayload: operation.response,
        errorPayload: operation.error,
        startedAt,
        finishedAt
      })
    );
  }

  return logs;
}

function buildRelationshipWarnings(relationshipResults = []) {
  return relationshipResults
    .filter((operation) => ['failed', 'skipped'].includes(operation.status))
    .map((operation) => {
      if (operation.status === 'failed') {
        return `Relationship ${operation.key} failed: ${operation.error?.message ?? 'Unknown error'}`;
      }

      return `Relationship ${operation.key} skipped: ${operation.reason ?? 'No reason returned'}`;
    });
}

function normalizeAuditStatus(status) {
  if (['dry_run', 'skipped', 'failed'].includes(status)) {
    return status;
  }

  return 'succeeded';
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

function errorEnvelope({ correlationId, code, message, data = null, error = {} }) {
  return {
    ok: false,
    correlationId,
    data,
    warnings: [],
    errors: [
      {
        code,
        message,
        ...error
      }
    ]
  };
}

function handleQuickCaptureError(error, req, res, next) {
  if (isOutboundEventConstraintError(error)) {
    res.status(422).json(
      errorEnvelope({
        correlationId: req.correlationId,
        code: 'OUTBOUND_EVENT_CONSTRAINT_ERROR',
        message:
          'Quick Capture outbound event persistence failed because the actor type is not allowed by the database schema.',
        data: {
          partialResults: {
            outboundEvent: null,
            crmResults: [],
            auditLogs: []
          }
        },
        error: {
          operation: 'outbound_event_persist',
          retryable: false
        }
      })
    );
    return;
  }

  if (!/Invalid quick capture lead/.test(error.message)) {
    next(error);
    return;
  }

  res.status(400).json(
    errorEnvelope({
      correlationId: req.correlationId,
      code: 'QUICK_CAPTURE_VALIDATION_FAILED',
      message: error.message,
      data: {
        details: error.details ?? []
      }
    })
  );
}

function isOutboundEventConstraintError(error) {
  const haystack = [
    error?.message,
    error?.code,
    error?.details?.message,
    error?.details?.details,
    error?.details?.hint,
    error?.details?.code,
    error?.details?.constraint
  ]
    .filter(Boolean)
    .join(' ');

  return (
    error?.code === '23514' &&
    /outbound_events_actor_type_check|outbound_events.*actor_type|actor_type/i.test(haystack)
  );
}
