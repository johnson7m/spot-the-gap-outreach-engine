import axios from 'axios';
import { normalizeTwentyApiBaseUrl } from './metadataClient.js';

export function createTwentyRestClient(config = {}) {
  const http = axios.create({
    baseURL: normalizeTwentyApiBaseUrl(config.apiBaseUrl),
    timeout: config.timeoutMs ?? 10000,
    headers: {
      Authorization: config.apiKey ? `Bearer ${config.apiKey}` : undefined,
      'Content-Type': 'application/json'
    }
  });

  return {
    async listRecords(objectPlural, params = {}) {
      const response = await http.get(`/rest/${objectPlural}`, {
        params: {
          limit: 60,
          ...params
        }
      });

      return unwrapListResponse(response.data, objectPlural);
    },

    async createRecord(objectPlural, payload) {
      const response = await http.post(`/rest/${objectPlural}`, payload);
      return unwrapRecordResponse(response.data, objectPlural);
    },

    async updateRecord(objectPlural, id, payload) {
      const response = await http.patch(`/rest/${objectPlural}/${id}`, payload);
      return unwrapRecordResponse(response.data, objectPlural);
    },

    async findFirstRecord(objectPlural, predicate) {
      const records = await this.listRecords(objectPlural);
      return records.find(predicate) ?? null;
    }
  };
}

export function unwrapListResponse(data, objectPlural) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data?.[objectPlural])) {
    return data.data[objectPlural];
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.[objectPlural])) {
    return data[objectPlural];
  }

  return [];
}

export function unwrapRecordResponse(data, objectPlural) {
  return (
    data?.data?.[objectPlural] ??
    data?.data?.[singularize(objectPlural)] ??
    data?.data ??
    data
  );
}

function singularize(value) {
  if (value === 'people') {
    return 'person';
  }

  if (value.endsWith('ies')) {
    return `${value.slice(0, -3)}y`;
  }

  return value.endsWith('s') ? value.slice(0, -1) : value;
}
