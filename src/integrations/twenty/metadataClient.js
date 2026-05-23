import axios from 'axios';

const DEFAULT_OBJECT_NAMES = ['person', 'company', 'task', 'opportunity'];

export function createTwentyMetadataClient(config = {}, log) {
  const http = axios.create({
    baseURL: normalizeTwentyApiBaseUrl(config.apiBaseUrl),
    timeout: config.timeoutMs ?? 10000,
    headers: {
      Authorization: config.apiKey ? `Bearer ${config.apiKey}` : undefined,
      'Content-Type': 'application/json'
    }
  });

  return {
    async listObjects() {
      if (!config.apiKey) {
        const error = new Error('Twenty API key is required for metadata discovery.');
        error.code = 'TWENTY_AUTH_MISSING';
        throw error;
      }

      const response = await http.get('/rest/metadata/objects');
      return response.data?.data?.objects ?? [];
    },

    async discoverSchema(objectNames = DEFAULT_OBJECT_NAMES) {
      const objects = await this.listObjects();
      const schema = buildSchemaSnapshot(objects, objectNames);

      log?.info(
        { objectNames: Object.keys(schema.objectsBySingularName) },
        'Twenty metadata discovery completed'
      );

      return schema;
    },

    async fetchObjectMetadata(objectName) {
      const schema = await this.discoverSchema([objectName]);
      return findObject(schema, objectName);
    }
  };
}

export function buildSchemaSnapshot(objects = [], objectNames = DEFAULT_OBJECT_NAMES) {
  const wanted = new Set(objectNames);
  const selectedObjects = objects.filter(
    (object) => wanted.has(object.nameSingular) || wanted.has(object.namePlural)
  );

  return {
    discoveredAt: new Date().toISOString(),
    objectsBySingularName: Object.fromEntries(
      selectedObjects.map((object) => [object.nameSingular, normalizeObjectMetadata(object)])
    ),
    objectsByPluralName: Object.fromEntries(
      selectedObjects.map((object) => [object.namePlural, normalizeObjectMetadata(object)])
    )
  };
}

export function findObject(schema, objectName) {
  return (
    schema.objectsBySingularName?.[objectName] ??
    schema.objectsByPluralName?.[objectName] ??
    null
  );
}

export function findField(objectMetadata, fieldName) {
  return objectMetadata?.fieldsByName?.[fieldName] ?? null;
}

export function normalizeTwentyApiBaseUrl(apiBaseUrl = 'https://api.twenty.com') {
  return apiBaseUrl.replace(/\/rest\/?$/, '').replace(/\/$/, '');
}

function normalizeObjectMetadata(object) {
  const activeFields = (object.fields ?? []).filter((field) => field.isActive !== false);

  return {
    id: object.id,
    nameSingular: object.nameSingular,
    namePlural: object.namePlural,
    labelSingular: object.labelSingular,
    labelPlural: object.labelPlural,
    duplicateCriteria: object.duplicateCriteria,
    fields: activeFields,
    fieldsByName: Object.fromEntries(activeFields.map((field) => [field.name, field])),
    relationships: activeFields.filter((field) => field.type === 'RELATION')
  };
}
