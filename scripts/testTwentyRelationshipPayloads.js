import { loadConfig } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { createTwentyMetadataClient } from '../src/integrations/twenty/metadataClient.js';
import { createTwentyRelationshipWriter } from '../src/integrations/twenty/relationshipWriter.js';
import { createTwentyRestClient } from '../src/integrations/twenty/restClient.js';

const SAMPLE_IDS = {
  personId: process.env.TEST_PERSON_ID ?? '00000000-0000-0000-0000-000000000001',
  companyId: process.env.TEST_COMPANY_ID ?? '00000000-0000-0000-0000-000000000002',
  taskId: process.env.TEST_TASK_ID ?? '00000000-0000-0000-0000-000000000003'
};

async function main() {
  const config = loadConfig();
  const liveRequested = process.env.LIVE_TEST === 'true';
  const liveAllowed =
    liveRequested &&
    config.twenty.syncEnabled &&
    config.twenty.relationshipWritesEnabled &&
    config.twenty.personCompanyLinkEnabled &&
    config.twenty.taskTargetLinkEnabled;

  if (liveRequested && !liveAllowed) {
    throw new Error(
      'Live relationship test requires LIVE_TEST=true, TWENTY_SYNC_ENABLED=true, TWENTY_RELATIONSHIP_WRITES_ENABLED=true, TWENTY_PERSON_COMPANY_LINK_ENABLED=true, and TWENTY_TASK_TARGET_LINK_ENABLED=true.'
    );
  }

  if (liveAllowed && !hasExplicitLiveIds()) {
    throw new Error(
      'Live relationship test requires TEST_PERSON_ID, TEST_COMPANY_ID, and TEST_TASK_ID.'
    );
  }

  const metadataClient = createTwentyMetadataClient(config.twenty, logger);
  const restClient = config.twenty.apiKey ? createTwentyRestClient(config.twenty) : null;
  const writer = createTwentyRelationshipWriter({
    config: config.twenty,
    dryRun: !liveAllowed,
    restClient,
    metadataClient,
    log: logger
  });
  const metadata = await writer.inspectRelationshipMetadata();
  const operations = [
    await writer.linkPersonToCompany({
      personId: SAMPLE_IDS.personId,
      companyId: SAMPLE_IDS.companyId,
      context: {
        script: 'testTwentyRelationshipPayloads'
      }
    }),
    await writer.linkTaskToPerson({
      taskId: SAMPLE_IDS.taskId,
      personId: SAMPLE_IDS.personId,
      context: {
        script: 'testTwentyRelationshipPayloads'
      }
    }),
    await writer.linkTaskToCompany({
      taskId: SAMPLE_IDS.taskId,
      companyId: SAMPLE_IDS.companyId,
      context: {
        script: 'testTwentyRelationshipPayloads'
      }
    })
  ];

  console.log(
    JSON.stringify(
      {
        inspectedAt: new Date().toISOString(),
        liveRequested,
        liveAllowed,
        dryRun: !liveAllowed,
        ids: liveAllowed ? SAMPLE_IDS : { ...SAMPLE_IDS, note: 'sample placeholder IDs' },
        metadata,
        operations: operations.map((operation) => ({
          key: operation.key,
          object: operation.object,
          action: operation.action,
          status: operation.status,
          dedupeKey: operation.dedupeKey,
          payload: operation.payload,
          reason: operation.reason,
          error: operation.error,
          responseId: operation.response?.id
        }))
      },
      null,
      2
    )
  );
}

function hasExplicitLiveIds() {
  return Boolean(process.env.TEST_PERSON_ID && process.env.TEST_COMPANY_ID && process.env.TEST_TASK_ID);
}

main().catch((error) => {
  console.error('Twenty relationship payload test failed.');
  console.error(
    JSON.stringify(
      {
        message: error.message,
        code: error.code,
        httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
