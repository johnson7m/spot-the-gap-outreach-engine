import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '../src/config/env.js';
import { createTwentyMetadataClient } from '../src/integrations/twenty/metadataClient.js';
import { validateTwentyRelationships } from '../src/integrations/twenty/relationshipValidator.js';
import {
  validateTwentyOutboundSchema,
  validateTwentySchema
} from '../src/integrations/twenty/schemaValidator.js';

const REQUIRED_TABLES = [
  'assessment_submissions',
  'outbound_events',
  'crm_sync_logs',
  'workflow_jobs'
];

async function main() {
  const config = loadConfig();
  const summary = {
    env: validateEnvironment(config),
    supabase: null,
    twenty: null,
    ready: false
  };

  if (config.supabase.url && config.supabase.serviceRoleKey) {
    summary.supabase = await safeValidate('Supabase', () => validateSupabase(config));
  }

  if (config.twenty.apiKey && config.twenty.apiBaseUrl) {
    summary.twenty = await safeValidate('Twenty', () => validateTwenty(config));
  }

  summary.ready =
    summary.env.blockers.length === 0 &&
    summary.supabase?.ok === true &&
    summary.twenty?.ok === true;

  printReadinessSummary(summary);

  if (!summary.ready) {
    process.exitCode = 1;
  }
}

async function safeValidate(label, validate) {
  try {
    return await validate();
  } catch (error) {
    return {
      ok: false,
      blockers: [`${label} validation failed: ${error.message}`],
      warnings: []
    };
  }
}

export function validateEnvironment(config) {
  const blockers = [];
  const warnings = [];

  if (!config.supabase.enabled) {
    blockers.push('SUPABASE_ENABLED must be true for staging readiness.');
  }

  if (!config.supabase.url) {
    blockers.push('SUPABASE_URL is required.');
  }

  if (!config.supabase.serviceRoleKey) {
    blockers.push('SUPABASE_SERVICE_ROLE_KEY is required for server-side staging checks.');
  }

  if (!config.twenty.apiKey) {
    blockers.push('TWENTY_API_KEY is required.');
  }

  if (!config.twenty.apiBaseUrl) {
    blockers.push('TWENTY_BASE_URL is required.');
  }

  if (config.twenty.syncEnabled) {
    warnings.push('TWENTY_SYNC_ENABLED is true. Keep it false until the final live test step.');
  }

  if (!config.webhookSharedSecret) {
    warnings.push('WEBHOOK_SECRET is not configured yet. This remains a pre-production TODO.');
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings
  };
}

async function validateSupabase(config) {
  const client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
  const tableResults = [];

  for (const tableName of REQUIRED_TABLES) {
    const result = await client
      .from(tableName)
      .select('*', { count: 'exact', head: true });

    tableResults.push({
      tableName,
      ok: !result.error,
      error: result.error?.message
    });
  }

  return {
    ok: tableResults.every((result) => result.ok),
    tableResults
  };
}

async function validateTwenty(config) {
  const metadataClient = createTwentyMetadataClient(config.twenty);
  const schema = await metadataClient.discoverSchema();
  const schemaValidation = validateTwentySchema(schema);
  const outboundSchemaValidation = validateTwentyOutboundSchema(schema);
  const relationshipValidation = validateTwentyRelationships(schema);
  const leadstageAuto = schemaValidation.objects.person?.fields.leadstageAuto;
  const leadstageValues = leadstageAuto?.options ?? [];
  const warnings = [
    ...schemaValidation.warnings,
    ...outboundSchemaValidation.warnings,
    ...outboundSchemaValidation.errors.map((error) => `Outbound schema warning: ${error}`),
    ...relationshipValidation.warnings
  ];
  const blockers = [
    ...schemaValidation.errors,
    ...relationshipValidation.errors
  ];

  if (leadstageValues.includes('DISQUALIFIED_NUTURE')) {
    warnings.push(
      'leadstageAuto still contains DISQUALIFIED_NUTURE. Rename it to DISQUALIFIED_NURTURE in Twenty.'
    );
  }

  if (!leadstageValues.includes('DISQUALIFIED_NURTURE')) {
    blockers.push('leadstageAuto is missing required value DISQUALIFIED_NURTURE.');
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    objects: Object.keys(schemaValidation.objects),
    outboundObjects: Object.keys(outboundSchemaValidation.objects),
    relationships: relationshipValidation.mappings
  };
}

function printReadinessSummary(summary) {
  const lines = [
    '',
    'Spot the Gap Outreach Engine - Staging Readiness',
    '================================================',
    `Overall: ${summary.ready ? 'READY' : 'NOT READY'}`,
    '',
    `Environment: ${summary.env.ok ? 'ok' : 'blocked'}`
  ];

  for (const blocker of summary.env.blockers) {
    lines.push(`  BLOCKER: ${blocker}`);
  }

  for (const warning of summary.env.warnings) {
    lines.push(`  WARN: ${warning}`);
  }

  if (summary.supabase) {
    lines.push('', `Supabase: ${summary.supabase.ok ? 'ok' : 'blocked'}`);
    for (const blocker of summary.supabase.blockers ?? []) {
      lines.push(`  BLOCKER: ${blocker}`);
    }

    for (const warning of summary.supabase.warnings ?? []) {
      lines.push(`  WARN: ${warning}`);
    }

    for (const table of summary.supabase.tableResults ?? []) {
      lines.push(
        `  ${table.ok ? 'OK' : 'MISSING'}: ${table.tableName}${table.error ? ` (${table.error})` : ''}`
      );
    }
  }

  if (summary.twenty) {
    lines.push('', `Twenty: ${summary.twenty.ok ? 'ok' : 'blocked'}`);
    lines.push(`  Objects: ${(summary.twenty.objects ?? []).join(', ')}`);

    for (const blocker of summary.twenty.blockers ?? []) {
      lines.push(`  BLOCKER: ${blocker}`);
    }

    for (const warning of summary.twenty.warnings ?? []) {
      lines.push(`  WARN: ${warning}`);
    }

    for (const relationship of summary.twenty.relationships ?? []) {
      lines.push(
        `  RELATION: ${relationship.key} (${relationship.relationType}) - writeEnabled=${relationship.writeEnabled}`
      );
    }
  }

  lines.push('');
  console.log(lines.join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Staging readiness check failed unexpectedly.');
    console.error(error);
    process.exitCode = 1;
  });
}
