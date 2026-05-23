import pino from 'pino';

export function createLogger(level = process.env.LOG_LEVEL ?? 'info') {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.x-visible-gap-secret',
        'config.twenty.apiKey',
        'config.openai.apiKey'
      ],
      remove: true
    }
  });
}

export const logger = createLogger();
