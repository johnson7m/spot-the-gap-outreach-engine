export function requireWorkspaceSecret({ config = {}, log } = {}) {
  return (req, res, next) => {
    const expectedSecret = config.workspace?.apiSecret;
    const providedSecret = req.headers['x-visible-gap-workspace-secret'];

    if (!expectedSecret) {
      log?.warn?.(
        { correlationId: req.correlationId },
        'Workspace API secret is not configured.'
      );

      res.status(503).json({
        ok: false,
        correlationId: req.correlationId,
        data: null,
        warnings: [],
        errors: [
          {
            code: 'WORKSPACE_SECRET_NOT_CONFIGURED',
            message: 'Workspace API secret is not configured.'
          }
        ]
      });
      return;
    }

    if (!providedSecret || providedSecret !== expectedSecret) {
      log?.warn?.(
        { correlationId: req.correlationId, hasSecret: Boolean(providedSecret) },
        'Workspace API request rejected.'
      );

      res.status(401).json({
        ok: false,
        correlationId: req.correlationId,
        data: null,
        warnings: [],
        errors: [
          {
            code: 'INVALID_WORKSPACE_SECRET',
            message: 'Invalid workspace API secret.'
          }
        ]
      });
      return;
    }

    next();
  };
}
