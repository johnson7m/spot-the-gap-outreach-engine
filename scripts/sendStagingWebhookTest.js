import sampleSubmission from '../data/sample-netlify-assessment-submission.json' with { type: 'json' };
import { loadConfig } from '../src/config/env.js';

async function main() {
  const config = loadConfig();
  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET ?? process.env.WEBHOOK_SHARED_SECRET;

  if (!webhookUrl) {
    throw new Error('WEBHOOK_URL is required. Example: https://engine.example.com/webhooks/netlify/spot-the-gap');
  }

  if (!webhookSecret) {
    throw new Error('WEBHOOK_SECRET is required for staging webhook tests.');
  }

  const healthUrl = new URL('/health', webhookUrl).toString();
  const body = createMarkedWebhookPayload();
  const expectedMode = process.env.LIVE_TEST === 'true' ? 'live' : 'dry-run';

  printPlan({
    webhookUrl,
    healthUrl,
    expectedMode,
    submissionId: body.payload.id,
    contactEmail: body.payload.data.email,
    company: body.payload.data.company,
    localTwentySyncEnabled: config.twenty.syncEnabled
  });

  const healthResponse = await fetch(healthUrl);
  const healthText = await healthResponse.text();

  if (!healthResponse.ok) {
    throw new Error(`Health check failed with ${healthResponse.status}: ${healthText}`);
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-visible-gap-secret': webhookSecret,
      'x-correlation-id': `staging-webhook-test-${body.payload.id}`
    },
    body: JSON.stringify(body)
  });
  const responseText = await response.text();
  const responseJson = safeJson(responseText);
  const correlationId = response.headers.get('x-correlation-id');

  console.log('');
  console.log('Staging Webhook Test - Result');
  console.log('=============================');
  console.log(
    JSON.stringify(
      {
        health: {
          status: healthResponse.status,
          ok: healthResponse.ok,
          body: safeJson(healthText) ?? healthText
        },
        webhook: {
          status: response.status,
          ok: response.ok,
          correlationId,
          body: responseJson ?? responseText
        }
      },
      null,
      2
    )
  );
  console.log('');

  if (!response.ok) {
    process.exitCode = 1;
  }
}

function createMarkedWebhookPayload() {
  const payload = structuredClone(sampleSubmission);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  payload.payload.id = process.env.TEST_SUBMISSION_ID ?? `staging-netlify-webhook-test-${timestamp}`;
  payload.payload.created_at = process.env.TEST_SUBMITTED_AT ?? new Date().toISOString();
  payload.payload.data.name = process.env.TEST_CONTACT_NAME ?? 'Visible Gap Webhook Test';
  payload.payload.data.email =
    process.env.TEST_CONTACT_EMAIL ?? 'visiblegap.webhook-test@example.com';
  payload.payload.data.company =
    process.env.TEST_COMPANY_NAME ?? 'Visible Gap Webhook Test Company';
  payload.payload.data.businessType = 'Internal staging Netlify webhook test';

  return payload;
}

function printPlan({
  webhookUrl,
  healthUrl,
  expectedMode,
  submissionId,
  contactEmail,
  company,
  localTwentySyncEnabled
}) {
  console.log('');
  console.log('Staging Webhook Test - Plan');
  console.log('===========================');
  console.log(
    JSON.stringify(
      {
        healthUrl,
        webhookUrl,
        expectedMode,
        note:
          'The deployed service controls actual dry-run/live behavior through TWENTY_SYNC_ENABLED.',
        localTwentySyncEnabled,
        testRecord: {
          submissionId,
          contactEmail,
          company
        }
      },
      null,
      2
    )
  );
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Staging webhook test failed.');
    console.error(error.message);
    process.exitCode = 1;
  });
}
