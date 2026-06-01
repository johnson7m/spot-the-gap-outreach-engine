import { createClient } from '@supabase/supabase-js';
import { requireWorkspaceSecret } from './workspaceAuth.js';

const WORKSPACE_ROLES = new Set(['admin', 'operator', 'rep']);

export function createSupabaseWorkspaceAuth({
  config = {},
  log,
  required = false,
  allowedRoles,
  supabaseClient
} = {}) {
  return async (req, res, next) => {
    const result = await resolveWorkspaceUser({
      req,
      config,
      log,
      required,
      supabaseClient
    });

    if (!result.ok) {
      sendWorkspaceAuthError(res, req.correlationId, result);
      return;
    }

    req.workspaceUser = result.workspaceUser;

    if (
      req.workspaceUser.authenticated &&
      allowedRoles &&
      !allowedRoles.includes(req.workspaceUser.role)
    ) {
      sendWorkspaceAuthError(res, req.correlationId, {
        statusCode: 403,
        code: 'WORKSPACE_ROLE_FORBIDDEN',
        message: 'Workspace role is not allowed for this operation.'
      });
      return;
    }

    next();
  };
}

export function requireWorkspaceAuth({
  config = {},
  log,
  allowedRoles,
  supabaseClient
} = {}) {
  return createSupabaseWorkspaceAuth({
    config,
    log,
    required: true,
    allowedRoles,
    supabaseClient
  });
}

export function requireWorkspaceRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.workspaceUser?.authenticated) {
      sendWorkspaceAuthError(res, req.correlationId, {
        statusCode: 401,
        code: 'WORKSPACE_AUTH_REQUIRED',
        message: 'Workspace authentication is required.'
      });
      return;
    }

    if (!allowedRoles.includes(req.workspaceUser.role)) {
      sendWorkspaceAuthError(res, req.correlationId, {
        statusCode: 403,
        code: 'WORKSPACE_ROLE_FORBIDDEN',
        message: 'Workspace role is not allowed for this operation.'
      });
      return;
    }

    next();
  };
}

export function requireWorkspaceAuthOrSecret({
  config = {},
  log,
  allowedRoles = ['admin', 'operator', 'rep'],
  supabaseClient
} = {}) {
  return async (req, res, next) => {
    const authResult = await resolveWorkspaceUser({
      req,
      config,
      log,
      required: false,
      supabaseClient
    });

    if (authResult.ok && authResult.workspaceUser.authenticated) {
      req.workspaceUser = authResult.workspaceUser;

      if (!allowedRoles.includes(req.workspaceUser.role)) {
        sendWorkspaceAuthError(res, req.correlationId, {
          statusCode: 403,
          code: 'WORKSPACE_ROLE_FORBIDDEN',
          message: 'Workspace role is not allowed for this operation.'
        });
        return;
      }

      next();
      return;
    }

    if (authResult.fatal) {
      sendWorkspaceAuthError(res, req.correlationId, authResult);
      return;
    }

    const secretMiddleware = requireWorkspaceSecret({ config, log });
    secretMiddleware(req, res, () => {
      req.workspaceUser = createSecretFallbackWorkspaceUser();
      next();
    });
  };
}

export async function resolveWorkspaceUser({
  req,
  config = {},
  log,
  required = false,
  supabaseClient
} = {}) {
  const token = extractBearerToken(req.headers?.authorization);
  const verificationEnabled = Boolean(config.supabase?.jwtVerificationEnabled);

  if (!token) {
    if (required) {
      return {
        ok: false,
        statusCode: 401,
        code: 'WORKSPACE_AUTH_REQUIRED',
        message: 'Workspace Authorization bearer token is required.'
      };
    }

    return {
      ok: true,
      workspaceUser: createUnauthenticatedWorkspaceUser()
    };
  }

  if (!verificationEnabled) {
    if (required) {
      return {
        ok: false,
        statusCode: 503,
        code: 'SUPABASE_JWT_VERIFICATION_DISABLED',
        message: 'Supabase JWT verification is disabled.'
      };
    }

    return {
      ok: true,
      workspaceUser: createUnauthenticatedWorkspaceUser('unauthenticated/dev')
    };
  }

  const client = supabaseClient ?? createWorkspaceSupabaseClient(config.supabase);

  if (!client) {
    return {
      ok: false,
      fatal: true,
      statusCode: 503,
      code: 'SUPABASE_WORKSPACE_AUTH_NOT_CONFIGURED',
      message: 'Supabase URL and service-role key are required for workspace auth.'
    };
  }

  const userResult = await client.auth.getUser(token);

  if (userResult.error || !userResult.data?.user) {
    log?.warn?.(
      { correlationId: req.correlationId, error: userResult.error?.message },
      'Workspace bearer token rejected.'
    );

    return {
      ok: false,
      statusCode: 401,
      code: 'WORKSPACE_INVALID_TOKEN',
      message: 'Workspace bearer token is invalid.'
    };
  }

  const user = userResult.data.user;
  const profileResult = await client
    .from('workspace_profiles')
    .select('id,user_id,email,full_name,role,is_active,created_at,updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (profileResult.error) {
    log?.warn?.(
      { correlationId: req.correlationId, error: profileResult.error.message },
      'Workspace profile lookup failed.'
    );

    return {
      ok: false,
      statusCode: 503,
      code: 'WORKSPACE_PROFILE_LOOKUP_FAILED',
      message: 'Workspace profile lookup failed.'
    };
  }

  if (!profileResult.data) {
    if (required) {
      return {
        ok: false,
        statusCode: 403,
        code: 'WORKSPACE_PROFILE_NOT_FOUND',
        message: 'Workspace profile was not found for this user.'
      };
    }

    return {
      ok: true,
      workspaceUser: createUnauthenticatedWorkspaceUser('authenticated/no-profile')
    };
  }

  const profile = profileResult.data;

  if (!profile.is_active) {
    return {
      ok: false,
      statusCode: 403,
      code: 'WORKSPACE_PROFILE_INACTIVE',
      message: 'Workspace profile is inactive.'
    };
  }

  if (!WORKSPACE_ROLES.has(profile.role)) {
    return {
      ok: false,
      statusCode: 403,
      code: 'WORKSPACE_ROLE_INVALID',
      message: 'Workspace profile role is invalid.'
    };
  }

  return {
    ok: true,
    workspaceUser: {
      authenticated: true,
      userId: profile.user_id,
      email: profile.email ?? user.email ?? '',
      fullName: profile.full_name ?? '',
      role: profile.role,
      roleSource: 'profile',
      profileId: profile.id
    }
  };
}

function createWorkspaceSupabaseClient(supabaseConfig = {}) {
  if (!supabaseConfig.url || !supabaseConfig.serviceRoleKey) {
    return null;
  }

  return createClient(supabaseConfig.url, supabaseConfig.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function extractBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') {
    return '';
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

function createUnauthenticatedWorkspaceUser(roleSource = 'unauthenticated/dev') {
  return {
    authenticated: false,
    userId: null,
    email: null,
    fullName: null,
    role: 'rep',
    roleSource
  };
}

function createSecretFallbackWorkspaceUser() {
  return {
    authenticated: false,
    userId: null,
    email: null,
    fullName: null,
    role: 'rep',
    roleSource: 'workspace-secret'
  };
}

function sendWorkspaceAuthError(res, correlationId, error) {
  res.status(error.statusCode ?? 401).json({
    ok: false,
    correlationId,
    data: null,
    warnings: [],
    errors: [
      {
        code: error.code,
        message: error.message
      }
    ]
  });
}
