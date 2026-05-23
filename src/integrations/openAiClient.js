import OpenAI from 'openai';

export function createOpenAiClient(config) {
  if (!config?.apiKey) {
    return null;
  }

  return new OpenAI({ apiKey: config.apiKey });
}

export async function draftPersonalization({ config, context }) {
  const client = createOpenAiClient(config);

  if (!client || !config?.model) {
    return {
      status: 'skipped',
      reason: 'OpenAI credentials and model are not configured.',
      context
    };
  }

  return {
    status: 'pending_implementation',
    reason: 'Personalization prompts require approval before model calls are enabled.',
    context
  };
}
