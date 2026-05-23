import { findField, findObject } from './metadataClient.js';

export const twentyRelationshipExpectations = [
  {
    key: 'person.company',
    objectName: 'person',
    fieldName: 'company',
    targetObjectName: 'company',
    purpose: 'Associate the assessed Person with the Company.'
  },
  {
    key: 'task.taskTargets',
    objectName: 'task',
    fieldName: 'taskTargets',
    targetObjectName: 'person',
    purpose: 'Attach assessment review tasks to the Person and/or Company.'
  },
  {
    key: 'opportunity.company',
    objectName: 'opportunity',
    fieldName: 'company',
    targetObjectName: 'company',
    purpose: 'Associate diagnostic opportunity with the Company.'
  },
  {
    key: 'opportunity.pointOfContact',
    objectName: 'opportunity',
    fieldName: 'pointOfContact',
    targetObjectName: 'person',
    purpose: 'Associate diagnostic opportunity with the assessed Person.'
  }
];

export function validateTwentyRelationships(
  schema,
  expectations = twentyRelationshipExpectations
) {
  const mappings = [];
  const errors = [];
  const warnings = [];

  for (const expectation of expectations) {
    const objectMetadata = findObject(schema, expectation.objectName);

    if (!objectMetadata) {
      errors.push(`Missing object metadata for relationship "${expectation.key}".`);
      continue;
    }

    const field = findField(objectMetadata, expectation.fieldName);

    if (!field) {
      errors.push(`Missing relationship field "${expectation.key}".`);
      continue;
    }

    if (field.type !== 'RELATION') {
      errors.push(
        `Field "${expectation.key}" expected type RELATION, received ${field.type}.`
      );
      continue;
    }

    const relationType = field.settings?.relationType ?? 'UNKNOWN';
    const joinColumnName = field.settings?.joinColumnName;

    mappings.push({
      ...expectation,
      relationType,
      joinColumnName,
      supportedByMetadata: true,
      writeEnabled: false,
      reason:
        'Relationship field exists, but live relationship payload shape is intentionally unresolved until verified against Twenty in staging.'
    });

    warnings.push(
      `Relationship "${expectation.key}" exists (${relationType}) but writes are disabled until payload shape is confirmed.`
    );

    if (!joinColumnName && ['MANY_TO_ONE', 'ONE_TO_ONE'].includes(relationType)) {
      warnings.push(
        `Relationship "${expectation.key}" has no joinColumnName in metadata; payload mapping needs live confirmation.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    mappings
  };
}
