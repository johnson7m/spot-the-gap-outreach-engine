import { loadConfig } from '../src/config/env.js';
import { createSupabaseClient } from '../src/integrations/supabase/client.js';
import { createTwentyMetadataClient } from '../src/integrations/twenty/metadataClient.js';
import {
  buildPersonMetadataComparison,
  validateQuickCapturePersonPayload
} from '../src/integrations/twenty/personPayloadValidator.js';
import { sanitizePayloadForDiagnostics } from '../src/integrations/twenty/errorDiagnostics.js';

async function main() {
  const config = loadConfig();

  if (!config.supabase?.enabled) {
    console.error('SUPABASE_ENABLED=true is required to inspect Quick Capture commit logs.');
    process.exitCode = 1;
    return;
  }

  const supabase = createSupabaseClient(config.supabase);
  const latestCommit = await findLatestQuickCaptureCommit(supabase);

  if (!latestCommit) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: 'no_quick_capture_commit_logs_found'
        },
        null,
        2
      )
    );
    return;
  }

  const [outboundEvent, crmLogs, schema] = await Promise.all([
    findOutboundEvent(supabase, latestCommit.correlation_id),
    findCrmLogs(supabase, latestCommit.correlation_id),
    discoverPersonSchema(config)
  ]);
  const personLog = crmLogs.find((log) => log.object_name === 'person') ?? null;
  const personPayload = extractPersonPayload(personLog?.request_payload);
  const personPayloadValidation = personPayload
    ? validateQuickCapturePersonPayload({
        payload: personPayload,
        lead: outboundEvent?.payload?.lead ?? {},
        schema
      })
    : null;
  const metadataComparison = schema ? buildPersonMetadataComparison({ schema }) : [];

  console.log(
    JSON.stringify(
      {
        ok: true,
        latestQuickCaptureCommit: {
          correlationId: latestCommit.correlation_id,
          createdAt: latestCommit.created_at
        },
        outboundEvent: outboundEvent
          ? {
              id: outboundEvent.id,
              status: outboundEvent.status,
              actorType: outboundEvent.actor_type,
              eventType: outboundEvent.event_type,
              payload: sanitizePayloadForDiagnostics(outboundEvent.payload)
            }
          : null,
        crmSyncLogs: crmLogs.map((log) => ({
          id: log.id,
          object: log.object_name,
          action: log.action,
          status: log.status,
          attempt: log.attempt,
          dedupeKey: log.dedupe_key,
          requestPayload: sanitizePayloadForDiagnostics(log.request_payload),
          responsePayload: sanitizePayloadForDiagnostics(log.response_payload),
          errorPayload: sanitizePayloadForDiagnostics(log.error_payload)
        })),
        person: {
          payload: sanitizePayloadForDiagnostics(personPayload),
          responseBody: sanitizePayloadForDiagnostics(personLog?.error_payload?.responseBody),
          validationMessages: personLog?.error_payload?.validationMessages ?? [],
          payloadValidation: personPayloadValidation,
          metadataComparison,
          recommendedFix: recommendPersonFix({ personPayload, personPayloadValidation, personLog })
        }
      },
      null,
      2
    )
  );
}

async function findLatestQuickCaptureCommit(supabase) {
  const response = await supabase
    .from('crm_sync_logs')
    .select('correlation_id,created_at')
    .like('correlation_id', 'quick-capture:%')
    .order('created_at', { ascending: false })
    .limit(1);

  if (response.error) {
    throw new Error(`Failed to inspect CRM sync logs: ${response.error.message}`);
  }

  return response.data?.[0] ?? null;
}

async function findOutboundEvent(supabase, correlationId) {
  const response = await supabase
    .from('outbound_events')
    .select('*')
    .eq('correlation_id', correlationId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (response.error) {
    throw new Error(`Failed to inspect outbound event: ${response.error.message}`);
  }

  return response.data?.[0] ?? null;
}

async function findCrmLogs(supabase, correlationId) {
  const response = await supabase
    .from('crm_sync_logs')
    .select('*')
    .eq('correlation_id', correlationId)
    .order('created_at', { ascending: true });

  if (response.error) {
    throw new Error(`Failed to inspect CRM sync logs: ${response.error.message}`);
  }

  return response.data ?? [];
}

async function discoverPersonSchema(config) {
  if (!config.twenty?.apiKey) {
    return null;
  }

  try {
    return await createTwentyMetadataClient(config.twenty).discoverSchema(['person']);
  } catch (error) {
    return null;
  }
}

function extractPersonPayload(requestPayload) {
  if (!requestPayload) {
    return null;
  }

  return requestPayload.payload ?? requestPayload;
}

function recommendPersonFix({ personPayload, personPayloadValidation, personLog }) {
  const recommendations = [];

  if (!personPayload) {
    recommendations.push('No Person request payload was found in crm_sync_logs.');
  }

  if (personPayload?.phones && !personPayloadValidation?.ok) {
    recommendations.push(
      'Inspect Person phones shape. Twenty PHONES writes require primaryPhoneCountryCode, primaryPhoneCallingCode, primaryPhoneNumber, and additionalPhones.'
    );
  }

  if (personLog?.error_payload?.httpStatus === 400) {
    recommendations.push(
      'Review the captured Twenty responseBody and validationMessages before retrying. Do not retry unchanged 400 payloads.'
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      'Payload fields are metadata-confirmed. If a 400 remains, use responseBody.validationMessages to update the field-shape validator.'
    );
  }

  return recommendations;
}

main().catch((error) => {
  console.error('Latest Quick Capture commit inspection failed.');
  console.error(
    JSON.stringify(
      {
        message: error.message,
        code: error.code
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
