import { createOperationalStore } from '../../persistence/operationalStore.js';
import { buildQuickCaptureCrmPayloads } from '../../integrations/twenty/outboundPayloadBuilders.js';
import { createTwentyMetadataClient, findObject } from '../../integrations/twenty/metadataClient.js';
import { validateTwentyOutboundSchema } from '../../integrations/twenty/schemaValidator.js';
import { planInitialCadence } from '../../utils/cadencePlanner.js';
import {
  buildOutboundOutreachAngle,
  scoreOutboundLead
} from '../../utils/outboundLeadScoring.js';
import { validateQuickCapturePersonPayload } from '../../integrations/twenty/personPayloadValidator.js';
import {
  mapWorkspaceUserToOutboundActorContext,
  sanitizeWorkspaceUser
} from '../../utils/outboundActorMapper.js';
import { normalizeQuickCaptureLead } from './leadIntakeWorkflow.js';

export async function processQuickCaptureLead({
  input,
  config = {},
  log,
  schemaOverride,
  operationalStore,
  now = new Date(),
  dryRun = true,
  persistEvents,
  workspaceUser
}) {
  const normalizedLead = normalizeQuickCaptureLead(input);
  const schemaResult = await discoverOutboundSchema({
    config,
    schemaOverride,
    log
  });
  const personFieldOptions = getPersonFieldOptions(schemaResult.schema);
  const cadence = planInitialCadence({
    outboundPipelineType: normalizedLead.outboundPipelineType,
    availablePipelineTypes: personFieldOptions.outboundPipelineType,
    availableCadenceNames: personFieldOptions.cadenceName,
    availableCadenceStages: personFieldOptions.cadenceStage,
    now
  });
  const leadForScoring = {
    ...normalizedLead,
    outboundPipelineType: cadence.pipelineType
  };
  const baseScores = scoreOutboundLead(leadForScoring);
  const scores = {
    ...baseScores,
    outreachAngle: buildOutboundOutreachAngle(leadForScoring, baseScores)
  };
  const payloads = buildQuickCaptureCrmPayloads({
    lead: leadForScoring,
    scores,
    cadence,
    supportedPersonFields: personFieldOptions.supportedFields
  });
  const personPayloadValidation = validateQuickCapturePersonPayload({
    payload: payloads.person.payload,
    lead: leadForScoring,
    schema: schemaResult.schema
  });

  payloads.person.payloadValidation = personPayloadValidation;

  const shouldPersistEvents =
    persistEvents ?? Boolean(config.supabase?.enabled && operationalStore);
  const outboundEvent = buildOutboundEvent({
    lead: leadForScoring,
    scores,
    cadence,
    payloads,
    workspaceUser,
    now
  });
  let persistedOutboundEvent = null;

  if (shouldPersistEvents) {
    const store = operationalStore ?? createOperationalStore({ config, log });
    persistedOutboundEvent = await store.appendOutboundEvent(outboundEvent);
  }

  return {
    status: dryRun ? 'dry_run' : 'planned',
    dryRun,
    normalizedLead: leadForScoring,
    scores,
    cadence,
    crmPayloads: payloads,
    workspaceUser: sanitizeWorkspaceUser(workspaceUser),
    outboundEvent: {
      planned: outboundEvent,
      persisted: persistedOutboundEvent
    },
    schemaValidation: schemaResult.validation,
    schemaWarnings: schemaResult.warnings,
    warnings: [
      ...schemaResult.warnings,
      ...(schemaResult.validation?.warnings ?? []),
      ...(schemaResult.validation?.errors ?? []).map((error) => `Outbound schema issue: ${error}`),
      ...buildPersonPayloadWarnings({ lead: leadForScoring, personPayloadValidation })
    ]
  };
}

function buildOutboundEvent({ lead, scores, cadence, payloads, workspaceUser, now }) {
  const actorContext = mapWorkspaceUserToOutboundActorContext(workspaceUser);

  return {
    assessmentSubmissionId: null,
    correlationId: `quick-capture:${lead.dedupe.key}`,
    eventType: 'quick_capture_planned',
    channel: cadence.firstTask.channel.toLowerCase(),
    status: 'planned',
    actorType: actorContext.actorType,
    requiresApproval: true,
    payload: {
      capturedAt: now.toISOString(),
      workspaceUser: actorContext.workspaceUser,
      lead,
      scores,
      cadence,
      crmDedupeKeys: Object.fromEntries(
        Object.entries(payloads)
          .filter(([, operation]) => operation)
          .map(([key, operation]) => [key, operation.dedupeKey])
      )
    },
    scheduledFor: cadence.firstTask.dueAt
  };
}

async function discoverOutboundSchema({ config, schemaOverride, log }) {
  if (schemaOverride) {
    return {
      schema: schemaOverride,
      validation: validateTwentyOutboundSchema(schemaOverride),
      warnings: []
    };
  }

  if (!config.twenty?.apiKey) {
    return {
      schema: null,
      validation: {
        ok: false,
        errors: [],
        warnings: ['Twenty metadata discovery skipped because TWENTY_API_KEY is not configured.'],
        objects: {}
      },
      warnings: ['Twenty metadata discovery skipped because TWENTY_API_KEY is not configured.']
    };
  }

  try {
    const schema = await createTwentyMetadataClient(config.twenty, log).discoverSchema([
      'person',
      'company',
      'task'
    ]);

    return {
      schema,
      validation: validateTwentyOutboundSchema(schema),
      warnings: []
    };
  } catch (error) {
    return {
      schema: null,
      validation: {
        ok: false,
        errors: [error.message],
        warnings: [],
        objects: {}
      },
      warnings: [`Twenty outbound metadata discovery failed: ${error.message}`]
    };
  }
}

function getPersonFieldOptions(schema) {
  const person = schema ? findObject(schema, 'person') : null;
  const fieldsByName = person?.fieldsByName ?? {};
  const supportedFields = new Set(Object.keys(fieldsByName));

  return {
    supportedFields,
    outboundPipelineType: getOptions(fieldsByName.outboundPipelineType),
    cadenceName: getOptions(fieldsByName.cadenceName),
    cadenceStage: getOptions(fieldsByName.cadenceStage)
  };
}

function getOptions(field) {
  return (field?.options ?? []).map((option) =>
    typeof option === 'string' ? option : option.value
  );
}

function buildPersonPayloadWarnings({ lead, personPayloadValidation }) {
  const warnings = [];

  if (lead.phone && !personPayloadValidation.sanitizedRequestPayload?.phones) {
    warnings.push(
      'Person phone omitted because Twenty PHONES writes require country code and calling code; capture E.164 +1 numbers to write phones safely.'
    );
  }

  for (const error of personPayloadValidation.errors ?? []) {
    warnings.push(`Person payload issue: ${error.message}`);
  }

  return warnings;
}
