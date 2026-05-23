import { createTwentyProvider } from '../twenty/twentyProvider.js';

export function createCrmAdapter({
  provider = 'twenty',
  config = {},
  log,
  schemaOverride,
  restClient
} = {}) {
  if (provider !== 'twenty') {
    throw new Error(`Unsupported CRM provider "${provider}".`);
  }

  const crmProvider = createTwentyProvider({
    config: config.twenty ?? config,
    log,
    schemaOverride,
    restClient
  });

  return {
    provider,

    async syncAssessmentSubmission({ submission, score, completedOperations }) {
      return crmProvider.syncAssessment({ submission, score, completedOperations });
    }
  };
}
