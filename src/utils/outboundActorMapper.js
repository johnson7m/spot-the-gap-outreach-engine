export const OUTBOUND_ACTOR_TYPES = Object.freeze({
  SYSTEM: 'system',
  HUMAN: 'human',
  AI_AGENT: 'ai_agent'
});

export const ALLOWED_OUTBOUND_ACTOR_TYPES = Object.freeze(
  Object.values(OUTBOUND_ACTOR_TYPES)
);

export function mapWorkspaceUserToOutboundActorContext(workspaceUser) {
  const sanitizedWorkspaceUser = sanitizeWorkspaceUser(workspaceUser);

  return {
    actorType: sanitizedWorkspaceUser?.authenticated
      ? OUTBOUND_ACTOR_TYPES.HUMAN
      : OUTBOUND_ACTOR_TYPES.SYSTEM,
    workspaceUser: sanitizedWorkspaceUser
  };
}

export function sanitizeWorkspaceUser(workspaceUser) {
  if (!workspaceUser) {
    return null;
  }

  return {
    authenticated: Boolean(workspaceUser.authenticated),
    userId: workspaceUser.userId ?? null,
    email: workspaceUser.email ?? null,
    fullName: workspaceUser.fullName ?? null,
    role: workspaceUser.role ?? null,
    roleSource: workspaceUser.roleSource ?? null,
    profileId: workspaceUser.profileId ?? null
  };
}
