import { findField, findObject } from './metadataClient.js';

export const twentySchemaExpectations = {
  person: {
    requiredFields: {
      name: { type: 'FULL_NAME' },
      emails: { type: 'EMAILS' },
      linkedinLink: { type: 'LINKS' },
      company: { type: 'RELATION' },
      jobTitle: { type: 'TEXT' },
      assessmentCompleted: { type: 'BOOLEAN' },
      assessmentScore: { type: 'NUMBER' },
      lastTouchDate: { type: 'DATE' },
      leadstageAuto: {
        type: 'SELECT',
        options: [
          'NEW_LEAD',
          'RESEARCHED',
          'CONNECTION_REQUESTED',
          'CONNECTED',
          'MESSAGE_SENT',
          'FOLLOW_UP_NEEDED',
          'ASSESSMENT_SENT',
          'ASSESSMENT_COMPLETED',
          'DISCOVERY_REQUESTED',
          'DISQUALIFIED_NURTURE'
        ]
      },
      messageAngle: { type: 'TEXT' },
      nextFollowUpDate: { type: 'DATE' }
    }
  },
  company: {
    requiredFields: {
      name: { type: 'TEXT' },
      domainName: { type: 'LINKS' },
      people: { type: 'RELATION' },
      operationalMaturityScore: { type: 'RATING', options: ['RATING_1', 'RATING_2', 'RATING_3', 'RATING_4', 'RATING_5'] }
    }
  },
  task: {
    requiredFields: {
      title: { type: 'TEXT' },
      bodyV2: { type: 'RICH_TEXT' },
      dueAt: { type: 'DATE_TIME' },
      status: { type: 'SELECT', options: ['TODO', 'IN_PROGRESS', 'DONE'] },
      taskTargets: { type: 'RELATION' }
    }
  },
  opportunity: {
    requiredFields: {
      name: { type: 'TEXT' },
      stage: {
        type: 'SELECT',
        options: [
          'TARGET_IDENTIFIED',
          'CONNECTION_SENT',
          'CONNECTED',
          'CONVERSATION_STARTED',
          'QUALIFIED',
          'CALL_SCHEDULED',
          'OPPORTUNITY',
          'DISCOVERY_SCHEDULED',
          'DISCOVERY_COMPLETED',
          'SOLUTION_ALIGNMENT',
          'PROPOSAL_SCOPE_DISCUSSION',
          'VERBAL_ALIGNMENT',
          'CLOSED_WON',
          'CLOSED_LOST',
          'DEFERRED_NURTURE'
        ]
      },
      company: { type: 'RELATION' },
      pointOfContact: { type: 'RELATION' }
    }
  }
};

export function validateTwentySchema(schema, expectations = twentySchemaExpectations) {
  const errors = [];
  const warnings = [];
  const objects = {};

  for (const [objectName, expectation] of Object.entries(expectations)) {
    const objectMetadata = findObject(schema, objectName);

    if (!objectMetadata) {
      errors.push(`Missing Twenty object metadata for "${objectName}".`);
      continue;
    }

    objects[objectName] = {
      nameSingular: objectMetadata.nameSingular,
      namePlural: objectMetadata.namePlural,
      duplicateCriteria: objectMetadata.duplicateCriteria,
      fields: {}
    };

    for (const [fieldName, fieldExpectation] of Object.entries(expectation.requiredFields)) {
      const field = findField(objectMetadata, fieldName);

      if (!field) {
        errors.push(`Missing field "${objectName}.${fieldName}".`);
        continue;
      }

      objects[objectName].fields[fieldName] = {
        type: field.type,
        isCustom: field.isCustom,
        options: optionValues(field)
      };

      if (field.type !== fieldExpectation.type) {
        errors.push(
          `Field "${objectName}.${fieldName}" expected type ${fieldExpectation.type}, received ${field.type}.`
        );
      }

      if (fieldExpectation.options) {
        const actualOptions = new Set(optionValues(field));

        for (const expectedOption of fieldExpectation.options) {
          if (!actualOptions.has(expectedOption)) {
            errors.push(
              `Field "${objectName}.${fieldName}" is missing select option "${expectedOption}".`
            );
          }
        }

        for (const actualOption of actualOptions) {
          if (!fieldExpectation.options.includes(actualOption)) {
            warnings.push(
              `Field "${objectName}.${fieldName}" has extra select option "${actualOption}".`
            );
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    objects
  };
}

function optionValues(field) {
  return (field.options ?? []).map((option) =>
    typeof option === 'string' ? option : option.value
  );
}
