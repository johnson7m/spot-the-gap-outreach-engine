import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/env.js';
import { logger } from './config/logger.js';
import { createFixedWindowRateLimiter } from './middleware/rateLimit.js';
import { createQuickCaptureApiRouter } from './routes/api/quickCaptureRoutes.js';
import { createQueueApiRouter } from './routes/api/queueRoutes.js';
import { createReportingApiRouter } from './routes/api/reportingRoutes.js';
import { createTaskApiRouter } from './routes/api/taskRoutes.js';
import { processAssessmentSubmission } from './workflows/assessmentWorkflow.js';
import { createCorrelationId } from './utils/idempotency.js';

export function createApp({
  config = loadConfig(),
  appLogger = logger,
  quickCaptureApiDependencies = {},
  queueApiDependencies = {},
  reportingApiDependencies = {},
  taskApiDependencies = {}
} = {}) {
  const app = express();

  app.use(helmet());
  app.use(cors(createCorsOptions(config)));
  app.use(pinoHttp({ logger: appLogger }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use((req, res, next) => {
    req.correlationId = createCorrelationId(req.headers);
    req.headers['x-correlation-id'] = req.correlationId;
    res.setHeader('x-correlation-id', req.correlationId);
    next();
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'spot-the-gap-outreach-engine',
      environment: config.env
    });
  });

  app.use(
    '/api/quick-capture',
    createQuickCaptureApiRouter({
      config,
      log: appLogger,
      ...quickCaptureApiDependencies
    })
  );

  app.use(
    '/api/tasks',
    createTaskApiRouter({
      config,
      log: appLogger,
      ...taskApiDependencies
    })
  );

  app.use(
    '/api/queues',
    createQueueApiRouter({
      config,
      log: appLogger,
      ...queueApiDependencies
    })
  );

  app.use(
    '/api/reporting',
    createReportingApiRouter({
      config,
      log: appLogger,
      ...reportingApiDependencies
    })
  );

  const webhookRateLimiter = createFixedWindowRateLimiter({
    windowMs: config.webhookRateLimit?.windowMs,
    max: config.webhookRateLimit?.max,
    keyGenerator: (req) =>
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.ip ?? 'unknown'
  });

  app.post('/webhooks/netlify/spot-the-gap', webhookRateLimiter, async (req, res, next) => {
    try {
      const result = await processAssessmentSubmission({
        body: req.body,
        headers: req.headers,
        config,
        log: req.log
      });

      res.status(202).json({
        status: result.status,
        correlationId: result.correlationId,
        submissionId: result.submissionId,
        duplicate: result.duplicate,
        replayProtected: result.replayProtected,
        score: result.score,
        workflowSummary: result.workflowSummary,
        crmSync: {
          status: result.crmSync.status,
          reason: result.crmSync.reason,
          operationCount: result.crmSync.operations.length
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const statusCode = error.statusCode ?? error.status ?? 500;
    req.log?.error({ error }, 'Request failed');

    res.status(statusCode).json({
      status: 'error',
      message: statusCode >= 500 ? 'Internal server error' : error.message
    });
  });

  return app;
}

function createCorsOptions(config = {}) {
  if (config.corsOrigin === '*') {
    return { origin: true };
  }

  const allowedOrigins = new Set(
    [config.corsOrigin, config.workspace?.allowedOrigin].filter(Boolean)
  );

  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origin is not allowed by CORS.'));
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = createApp({ config, appLogger: logger });

  app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.env },
      'Spot the Gap Outreach Engine listening'
    );
  });
}
