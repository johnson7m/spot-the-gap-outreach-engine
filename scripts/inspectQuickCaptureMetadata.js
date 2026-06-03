import { loadConfig } from '../src/config/env.js';
import { createTwentyMetadataClient, findObject } from '../src/integrations/twenty/metadataClient.js';
import { createTwentyRestClient } from '../src/integrations/twenty/restClient.js';

const OBJECT_NAMES = ['person', 'company', 'task', 'workspaceMember'];

const FIELD_NAMES = {
  person: ['owner'],
  company: ['segment', 'industry', 'accountOwner'],
  task: ['assignee'],
  workspaceMember: ['name', 'userEmail', 'userId']
};

async function main() {
  const config = loadConfig();
  const metadataClient = createTwentyMetadataClient(config.twenty);
  const schema = await metadataClient.discoverSchema(OBJECT_NAMES);
  const restClient = createTwentyRestClient(config.twenty);
  const [workspaceMembers, recordShapes] = await Promise.all([
    safeListWorkspaceMembers(restClient),
    inspectRecordShapes(restClient)
  ]);

  console.log(
    JSON.stringify(
      {
        inspectedAt: new Date().toISOString(),
        fields: Object.fromEntries(
          OBJECT_NAMES.map((objectName) => [
            objectName,
            inspectObjectFields(schema, objectName, FIELD_NAMES[objectName] ?? [])
          ])
        ),
        workspaceMembers,
        recordShapes
      },
      null,
      2
    )
  );
}

async function inspectRecordShapes(restClient) {
  const shapes = {};

  for (const objectPlural of ['people', 'companies', 'tasks']) {
    try {
      const records = await restClient.listRecords(objectPlural, { limit: 1 });
      shapes[objectPlural] = records[0] ? Object.keys(records[0]).sort() : [];
    } catch (error) {
      shapes[objectPlural] = {
        error: error.message,
        httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status
      };
    }
  }

  return shapes;
}

function inspectObjectFields(schema, objectName, fieldNames) {
  const objectMetadata = findObject(schema, objectName);

  return fieldNames.map((fieldName) => {
    const field = objectMetadata?.fieldsByName?.[fieldName] ?? null;

    return {
      fieldName,
      exists: Boolean(field),
      label: field?.label,
      type: field?.type,
      isCustom: field?.isCustom,
      options: (field?.options ?? []).map((option) =>
        typeof option === 'string' ? option : option.value
      ),
      relationTargetObjectMetadataNameSingular: field?.relationTargetObjectMetadataNameSingular,
      relationTargetObjectMetadataNamePlural: field?.relationTargetObjectMetadataNamePlural,
      joinColumnName: field?.joinColumnName
    };
  });
}

async function safeListWorkspaceMembers(restClient) {
  try {
    const records = await restClient.listRecords('workspaceMembers', { limit: 100 });

    return records.map((record) => ({
      id: record.id,
      name: record.name,
      userEmail: record.userEmail,
      userId: record.userId
    }));
  } catch (error) {
    return {
      error: error.message,
      httpStatus: error.twentyDiagnostics?.httpStatus ?? error.response?.status,
      responseBody: error.twentyDiagnostics?.responseBody ?? error.response?.data
    };
  }
}

main().catch((error) => {
  console.error('Quick Capture metadata inspection failed.');
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
