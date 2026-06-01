import { createOperationalStore } from '../../persistence/operationalStore.js';
import { buildQuickCaptureCrmPayloads } from '../../integrations/twenty/outboundPayloadBuilders.js';
import { createTwentyMetadataClient, findObject } from '../../integrations/twenty/metadataClient.js';
import { validateTwentyOutboundSchema } from '../../integrations/twenty/schemaValidator.js';
import { planInitialCadence } from '../../utils/cadencePlanner.js';
import {
  buildOutboundOutreachAngle,
  scoreOutboundLead
} from '../../utils/outboundLeadScoring.js';
import { normalizeQuickCaptureLead } from './leadIntakeWorkflow.js';

export async function processQuickCaptureLead({
  input,
  config = {},
  log,
  schemaOverride,
  operationalStore,
  now = new Date(),
  dryRun = true,
  persistEvents
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
  const shouldPersistEvents =
    persistEvents ?? Boolean(config.supabase?.enabled && operationalStore);
  const outboundEvent = buildOutboundEvent({
    lead: leadForScoring,
    scores,
    cadence,
    payloads,
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
    outboundEvent: {
      planned: outboundEvent,
      persisted: persistedOutboundEvent
    },
    schemaValidation: schemaResult.validation,
    schemaWarnings: schemaResult.warnings,
    warnings: [
      ...schemaResult.warnings,
      ...(schemaResult.validation?.warnings ?? []),
      ...(schemaResult.validation?.errors ?? []).map((error) => `Outbound schema issue: ${error}`)
    ]
  };
}

function buildOutboundEvent({ lead, scores, cadence, payloads, now }) {
  return {
    assessmentSubmissionId: null,
    correlationId: `quick-capture:${lead.dedupe.key}`,
    eventType: 'quick_capture_planned',
    channel: cadence.firstTask.channel.toLowerCase(),
    status: 'planned',
    actorType: 'system',
    requiresApproval: true,
    payload: {
      capturedAt: now.toISOString(),
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
