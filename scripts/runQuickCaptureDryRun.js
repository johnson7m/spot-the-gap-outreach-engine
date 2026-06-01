import sampleLead from '../data/sample-quick-capture-lead.json' with { type: 'json' };
import { loadConfig } from '../src/config/env.js';
import { processQuickCaptureLead } from '../src/workflows/outbound/quickCaptureWorkflow.js';

async function main() {
  const config = loadConfig();
  const persistEvents = process.env.QUICK_CAPTURE_PERSIST_EVENTS === 'true';
  const safeConfig = {
    ...config,
    twenty: {
      ...config.twenty,
      syncEnabled: false
    },
    supabase: {
      ...config.supabase,
      enabled: persistEvents && config.supabase.enabled
    }
  };
  const result = await processQuickCaptureLead({
    input: sampleLead,
    config: safeConfig,
    dryRun: true,
    persistEvents,
    now: new Date('2026-05-27T14:00:00.000Z')
  });

  printDryRun(result, { persistEvents });
}

function printDryRun(result, { persistEvents }) {
  const output = {
    status: result.status,
    dryRun: result.dryRun,
    twentyWrites: 'disabled',
    supabaseOutboundEventPersistence:
      persistEvents && result.outboundEvent.persisted ? 'persisted' : 'not_persisted',
    normalizedLead: result.normalizedLead,
    scores: result.scores,
    cadence: result.cadence,
    crmPayloads: result.crmPayloads,
    outboundEventPlan: result.outboundEvent.planned,
    schemaValidation: result.schemaValidation,
    warnings: result.warnings
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error('Quick Capture dry-run failed.');
  console.error(
    JSON.stringify(
      {
        message: error.message,
        details: error.details
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
