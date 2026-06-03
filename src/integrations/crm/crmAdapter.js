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
    quickCapture: config.quickCapture ?? {},
    log,
    schemaOverride,
    restClient
  });

  return {
    provider,

    async syncAssessmentSubmission({ submission, score, completedOperations }) {
      return crmProvider.syncAssessment({ submission, score, completedOperations });
    },

    async syncQuickCaptureLead({ lead, payloads }) {
      return crmProvider.syncQuickCapture({ lead, payloads });
    },

    async syncQuickCaptureOperations({ lead, operations }) {
      return crmProvider.syncQuickCaptureOperations({ lead, operations });
    },

    async getPersonById(personId) {
      return crmProvider.getPersonById(personId);
    },

    async syncTaskCompletion({ personUpdate, nextTask }) {
      return crmProvider.syncTaskCompletion({ personUpdate, nextTask });
    }
  };
}
