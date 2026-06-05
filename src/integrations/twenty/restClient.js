import axios from 'axios';
import { enrichTwentyRestError } from './errorDiagnostics.js';
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
    async listRecordsPage(objectPlural, params = {}) {
      const response = await http.get(`/rest/${objectPlural}`, {
        params: {
          limit: 60,
          ...params
        }
      });

      return unwrapListPage(response.data, objectPlural);
    },

    async listRecords(objectPlural, params = {}) {
      const page = await this.listRecordsPage(objectPlural, params);

      return page.records;
    },

    async listAllRecords(objectPlural, options = {}) {
      const pageSize = normalizePositiveInt(options.pageSize ?? options.limit, 100);
      const maxPages = normalizePositiveInt(options.maxPages, 10);
      const params = options.params ?? {};
      const records = [];
      const warnings = [];
      const seenCursors = new Set();
      let pagesFetched = 0;
      let totalCount = null;
      let pageInfo = null;
      let startingAfter = options.startingAfter ?? null;

      for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
        const page = await this.listRecordsPage(objectPlural, {
          ...params,
          limit: pageSize,
          ...(startingAfter ? { starting_after: startingAfter } : {})
        });

        pagesFetched = pageNumber;
        totalCount = page.totalCount ?? totalCount;
        pageInfo = page.pageInfo;
        records.push(...page.records);
        options.onPage?.({
          objectPlural,
          pageNumber,
          recordsFetched: page.records.length,
          totalFetched: records.length,
          totalCount,
          pageInfo
        });

        const nextCursor = pageInfo?.endCursor ?? null;

        if (!pageInfo?.hasNextPage || !nextCursor || page.records.length === 0) {
          startingAfter = nextCursor;
          break;
        }

        if (seenCursors.has(nextCursor)) {
          warnings.push(
            `Twenty pagination cursor repeated for ${objectPlural}; stopped to avoid an infinite read loop.`
          );
          startingAfter = nextCursor;
          break;
        }

        seenCursors.add(nextCursor);
        startingAfter = nextCursor;
      }

      const hasMore = Boolean(pageInfo?.hasNextPage);

      if (hasMore && pagesFetched >= maxPages) {
        warnings.push(
          `Twenty ${objectPlural} pagination stopped at LEGACY_RETROFIT_MAX_PAGES=${maxPages} while more pages are available.`
        );
      }

      return {
        records,
        totalCount,
        pageInfo,
        warnings,
        pagination: {
          objectPlural,
          mechanism: 'cursor',
          cursorParam: 'starting_after',
          pageSize,
          maxPages,
          pagesFetched,
          totalFetched: records.length,
          totalCount,
          hasMore,
          nextCursor: pageInfo?.endCursor ?? null
        }
      };
    },

    async getRecord(objectPlural, id) {
      const response = await http.get(`/rest/${objectPlural}/${id}`);
      return unwrapRecordResponse(response.data, objectPlural);
    },

    async createRecord(objectPlural, payload) {
      try {
        const response = await http.post(`/rest/${objectPlural}`, payload);
        return unwrapRecordResponse(response.data, objectPlural);
      } catch (error) {
        throw enrichTwentyRestError(error, {
          objectPlural,
          action: 'create',
          payload
        });
      }
    },

    async updateRecord(objectPlural, id, payload) {
      try {
        const response = await http.patch(`/rest/${objectPlural}/${id}`, payload);
        return unwrapRecordResponse(response.data, objectPlural);
      } catch (error) {
        throw enrichTwentyRestError(error, {
          objectPlural,
          action: 'update',
          payload,
          id
        });
      }
    },

    async findFirstRecord(objectPlural, predicate) {
      const records = await this.listRecords(objectPlural);
      return records.find(predicate) ?? null;
    }
  };
}

export function unwrapListResponse(data, objectPlural) {
  return unwrapListPage(data, objectPlural).records;
}

export function unwrapListPage(data, objectPlural) {
  const records = getListRecords(data, objectPlural);
  const totalCount = normalizeNullableInt(
    data?.totalCount ?? data?.data?.totalCount ?? data?.metadata?.totalCount
  );

  return {
    records,
    totalCount,
    pageInfo: data?.pageInfo ?? data?.data?.pageInfo ?? null
  };
}

function getListRecords(data, objectPlural) {
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
  const mutationRecord = getMutationRecord(data?.data);

  if (mutationRecord) {
    return mutationRecord;
  }

  return (
    data?.data?.[objectPlural] ??
    data?.data?.[singularize(objectPlural)] ??
    data?.data ??
    data
  );
}

function getMutationRecord(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return null;
  }

  const mutationEntry = Object.entries(value).find(
    ([key, record]) => /^(create|update)/.test(key) && record?.id
  );

  return mutationEntry?.[1] ?? null;
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

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function normalizeNullableInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}
