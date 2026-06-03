import { describe, expect, it } from 'vitest';
import {
  createPersonCompanyOperation,
  createTaskTargetOperation,
  createTwentyRelationshipWriter,
  inspectTwentyRelationshipMetadata
} from '../src/integrations/twenty/relationshipWriter.js';

const enabledConfig = {
  apiKey: 'test-key',
  relationshipWritesEnabled: true,
  personCompanyLinkEnabled: true,
  taskTargetLinkEnabled: true
};

describe('Twenty relationship writer', () => {
  it('skips relationship writes when feature flags are disabled', async () => {
    const writer = createTwentyRelationshipWriter({
      config: {
        relationshipWritesEnabled: false,
        personCompanyLinkEnabled: false,
        taskTargetLinkEnabled: false
      },
      dryRun: false
    });

    const result = await writer.linkPersonToCompany({
      personId: 'people-1',
      companyId: 'companies-1'
    });

    expect(result).toMatchObject({
      key: 'person.company',
      status: 'skipped',
      payload: {
        companyId: 'companies-1'
      }
    });
  });

  it('builds confirmed Person to Company and Task to Person payloads', () => {
    expect(
      createPersonCompanyOperation({
        personId: 'people-1',
        companyId: 'companies-1'
      })
    ).toMatchObject({
      key: 'person.company',
      object: 'person',
      action: 'link_company',
      payload: {
        companyId: 'companies-1'
      }
    });

    expect(
      createTaskTargetOperation({
        taskId: 'tasks-1',
        targetId: 'people-1',
        targetType: 'person'
      })
    ).toMatchObject({
      key: 'task.taskTargets.person',
      object: 'taskTarget',
      action: 'link_task_to_person',
      payload: {
        taskId: 'tasks-1',
        targetPersonId: 'people-1'
      }
    });
  });

  it('validates live metadata shapes for Person company and Task targets', () => {
    const metadata = inspectTwentyRelationshipMetadata(relationshipSchema());

    expect(metadata.relationships.personCompany).toMatchObject({
      ok: true,
      payloadShape: {
        objectPlural: 'people',
        method: 'PATCH',
        fields: ['companyId']
      }
    });
    expect(metadata.relationships.taskTargetPerson).toMatchObject({
      ok: true,
      payloadShape: {
        objectPlural: 'taskTargets',
        method: 'POST',
        fields: ['taskId', 'targetPersonId']
      }
    });
    expect(metadata.relationships.taskTargetCompany).toMatchObject({
      ok: true,
      payloadShape: {
        objectPlural: 'taskTargets',
        method: 'POST',
        fields: ['taskId', 'targetCompanyId']
      }
    });
  });

  it('updates Person.companyId when metadata and flags allow it', async () => {
    const writes = [];
    const writer = createTwentyRelationshipWriter({
      config: enabledConfig,
      dryRun: false,
      schemaOverride: relationshipSchema(),
      restClient: {
        async getRecord(objectPlural, id) {
          expect(objectPlural).toBe('people');
          expect(id).toBe('people-1');
          return {
            id,
            companyId: null
          };
        },
        async updateRecord(objectPlural, id, payload) {
          writes.push({ objectPlural, id, payload });
          return {
            id,
            ...payload
          };
        }
      }
    });

    const result = await writer.linkPersonToCompany({
      personId: 'people-1',
      companyId: 'companies-1'
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      action: 'update',
      response: {
        id: 'people-1',
        companyId: 'companies-1'
      }
    });
    expect(writes).toEqual([
      {
        objectPlural: 'people',
        id: 'people-1',
        payload: {
          companyId: 'companies-1'
        }
      }
    ]);
  });

  it('creates Task target rows for Person links', async () => {
    const writes = [];
    const writer = createTwentyRelationshipWriter({
      config: enabledConfig,
      dryRun: false,
      schemaOverride: relationshipSchema(),
      restClient: {
        async findFirstRecord() {
          return null;
        },
        async createRecord(objectPlural, payload) {
          writes.push({ objectPlural, payload });
          return {
            id: 'task-targets-1',
            ...payload
          };
        }
      }
    });

    const result = await writer.linkTaskToPerson({
      taskId: 'tasks-1',
      personId: 'people-1'
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      action: 'create',
      response: {
        id: 'task-targets-1'
      }
    });
    expect(writes).toEqual([
      {
        objectPlural: 'taskTargets',
        payload: {
          taskId: 'tasks-1',
          targetPersonId: 'people-1'
        }
      }
    ]);
  });

  it('returns structured relationship failures instead of throwing', async () => {
    const writer = createTwentyRelationshipWriter({
      config: enabledConfig,
      dryRun: false,
      schemaOverride: relationshipSchema(),
      restClient: {
        async findFirstRecord() {
          return null;
        },
        async createRecord() {
          const error = new Error('Request failed with status code 400');
          error.twentyDiagnostics = {
            httpStatus: 400,
            responseBody: {
              message: 'Invalid task target payload'
            }
          };
          throw error;
        }
      }
    });

    const result = await writer.linkTaskToPerson({
      taskId: 'tasks-1',
      personId: 'people-1'
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        message: 'Request failed with status code 400',
        httpStatus: 400,
        responseBody: {
          message: 'Invalid task target payload'
        },
        sanitizedRequestPayload: {
          taskId: 'tasks-1',
          targetPersonId: 'people-1'
        }
      }
    });
  });
});

function relationshipSchema() {
  return {
    objectsBySingularName: {
      person: {
        fieldsByName: {
          company: relationField('company', 'RELATION', 'MANY_TO_ONE', 'companyId')
        }
      },
      company: {
        fieldsByName: {
          people: relationField('people', 'RELATION', 'ONE_TO_MANY'),
          accountOwner: relationField('accountOwner', 'RELATION', 'MANY_TO_ONE', 'accountOwnerId')
        }
      },
      task: {
        fieldsByName: {
          taskTargets: relationField('taskTargets', 'RELATION', 'ONE_TO_MANY'),
          assignee: relationField('assignee', 'RELATION', 'MANY_TO_ONE', 'assigneeId')
        }
      },
      taskTarget: {
        fieldsByName: {
          task: relationField('task', 'RELATION', 'MANY_TO_ONE', 'taskId'),
          targetPerson: relationField('targetPerson', 'MORPH_RELATION', 'MANY_TO_ONE', 'targetPersonId'),
          targetCompany: relationField('targetCompany', 'MORPH_RELATION', 'MANY_TO_ONE', 'targetCompanyId')
        }
      },
      noteTarget: {
        fieldsByName: {
          note: relationField('note', 'RELATION', 'MANY_TO_ONE', 'noteId'),
          targetPerson: relationField('targetPerson', 'MORPH_RELATION', 'MANY_TO_ONE', 'targetPersonId'),
          targetCompany: relationField('targetCompany', 'MORPH_RELATION', 'MANY_TO_ONE', 'targetCompanyId')
        }
      }
    },
    objectsByPluralName: {}
  };
}

function relationField(name, type, relationType, joinColumnName) {
  return {
    name,
    label: name,
    type,
    isCustom: false,
    settings: {
      relationType,
      ...(joinColumnName ? { joinColumnName } : {})
    }
  };
}
