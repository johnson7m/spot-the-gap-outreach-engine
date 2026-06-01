import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }

  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CORS_ORIGIN: z.string().default('*'),
  CRM_PROVIDER: z.enum(['twenty']).default('twenty'),
  WORKFLOW_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_SHARED_SECRET: z.string().optional(),
  WEBHOOK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  WORKSPACE_ALLOWED_ORIGIN: z.string().optional().or(z.literal('')),
  WORKSPACE_API_SECRET: z.string().optional(),
  SUPABASE_ENABLED: booleanFromEnv.default(false),
  SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  TWENTY_SYNC_ENABLED: booleanFromEnv.default(false),
  QUICK_CAPTURE_SYNC_ENABLED: booleanFromEnv.default(false),
  QUICK_CAPTURE_API_COMMIT_ENABLED: booleanFromEnv.default(false),
  QUICK_CAPTURE_API_PREVIEW_ENABLED: booleanFromEnv.default(true),
  TWENTY_BASE_URL: z.string().url().optional().or(z.literal('')),
  TWENTY_API_BASE_URL: z.string().url().optional().or(z.literal('')),
  TWENTY_API_KEY: z.string().optional(),
  TWENTY_WORKSPACE_ID: z.string().optional(),
  QUICK_CAPTURE_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  QUICK_CAPTURE_RETRY_BASE_MS: z.coerce.number().int().min(0).default(1000),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional().default('')
});

let cachedConfig;

export function loadConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');

    throw new Error(`Invalid environment configuration: ${details}`);
  }

  cachedConfig = {
    env: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    corsOrigin: parsed.data.CORS_ORIGIN,
    crmProvider: parsed.data.CRM_PROVIDER,
    workflowMaxAttempts: parsed.data.WORKFLOW_MAX_ATTEMPTS,
    webhookSharedSecret: parsed.data.WEBHOOK_SECRET ?? parsed.data.WEBHOOK_SHARED_SECRET,
    webhookRateLimit: {
      windowMs: parsed.data.WEBHOOK_RATE_LIMIT_WINDOW_MS,
      max: parsed.data.WEBHOOK_RATE_LIMIT_MAX
    },
    workspace: {
      allowedOrigin: parsed.data.WORKSPACE_ALLOWED_ORIGIN || undefined,
      apiSecret: parsed.data.WORKSPACE_API_SECRET
    },
    supabase: {
      enabled: parsed.data.SUPABASE_ENABLED,
      url: parsed.data.SUPABASE_URL || undefined,
      serviceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY
    },
    twenty: {
      syncEnabled: parsed.data.TWENTY_SYNC_ENABLED,
      apiBaseUrl:
        parsed.data.TWENTY_BASE_URL ||
        parsed.data.TWENTY_API_BASE_URL ||
        'https://api.twenty.com',
      apiKey: parsed.data.TWENTY_API_KEY,
      workspaceId: parsed.data.TWENTY_WORKSPACE_ID
    },
    quickCapture: {
      syncEnabled: parsed.data.QUICK_CAPTURE_SYNC_ENABLED,
      apiCommitEnabled: parsed.data.QUICK_CAPTURE_API_COMMIT_ENABLED,
      apiPreviewEnabled: parsed.data.QUICK_CAPTURE_API_PREVIEW_ENABLED,
      maxRetries: parsed.data.QUICK_CAPTURE_MAX_RETRIES,
      retryBaseMs: parsed.data.QUICK_CAPTURE_RETRY_BASE_MS
    },
    openai: {
      apiKey: parsed.data.OPENAI_API_KEY,
      model: parsed.data.OPENAI_MODEL
    }
  };

  return cachedConfig;
}
