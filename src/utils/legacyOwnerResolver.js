export const LEGACY_OWNER_EMAIL_MAP = {
  'chandler johnson': 'chandler@visiblegap.com',
  'brayson grider': 'brayson.grider@visiblegap.com',
  'darrean beller': 'darrean.beller@visiblegap.com',
  'visible gap': 'hello@visiblegap.com'
};

export function resolveLegacyOwner({ person = {}, workspaceMembers = [] } = {}) {
  const workspaceMemberIndexes = createWorkspaceMemberIndexes(workspaceMembers);
  const embeddedOwner = firstObject(person.owner, person.accountOwner, person.workspaceMember);
  const ownerId = firstString(
    person.ownerId,
    embeddedOwner?.id,
    person.accountOwnerId,
    person.workspaceMemberId
  );
  const ownerName = firstString(
    getName(embeddedOwner),
    person.ownerName,
    person.accountOwnerName,
    person.workspaceMemberName
  );
  const directOwnerEmail = normalizeEmail(
    firstString(
      embeddedOwner?.userEmail,
      embeddedOwner?.email,
      embeddedOwner?.primaryEmail,
      person.ownerEmail,
      person.accountOwnerEmail,
      person.workspaceMemberEmail
    )
  );
  const workspaceMemberById = ownerId ? workspaceMemberIndexes.byId.get(String(ownerId)) : null;
  const inferredEmail = inferWorkspaceEmailFromOwnerName(ownerName);
  const recommendedWorkspaceEmail = normalizeEmail(
    firstString(workspaceMemberById?.email, directOwnerEmail, inferredEmail)
  );
  const workspaceMemberByEmail = recommendedWorkspaceEmail
    ? workspaceMemberIndexes.byEmail.get(recommendedWorkspaceEmail)
    : null;
  const matchedWorkspaceMember = workspaceMemberById ?? workspaceMemberByEmail ?? null;
  const ownerEmail = normalizeEmail(
    firstString(workspaceMemberById?.email, directOwnerEmail, inferredEmail)
  );
  const normalizedOwnerName = normalizeName(ownerName);
  const existingOwnerResolutionStatus = determineResolutionStatus({
    ownerId,
    ownerName,
    ownerEmail,
    matchedWorkspaceMember,
    normalizedOwnerName
  });
  const createdBy = resolveCreatedBy({
    person,
    workspaceMemberIndexes
  });

  if (!ownerId && !ownerName && !ownerEmail) {
    const inferredOwner = inferOwnerFromCreatedBy({
      createdBy,
      workspaceMemberIndexes
    });
    const warnings = buildOwnerWarnings(inferredOwner.ownerResolutionStatus, {
      hasCreatedBy: Boolean(createdBy.createdById || createdBy.createdByName || createdBy.createdByEmail)
    });

    return {
      ownerId: null,
      ownerName: inferredOwner.inferredOwnerName,
      ownerEmail: inferredOwner.inferredOwnerEmail,
      ownerWorkspaceMemberId: inferredOwner.inferredOwnerWorkspaceMemberId,
      createdById: createdBy.createdById,
      createdByName: createdBy.createdByName,
      createdByEmail: createdBy.createdByEmail,
      inferredOwnerName: inferredOwner.inferredOwnerName,
      inferredOwnerEmail: inferredOwner.inferredOwnerEmail,
      inferredOwnerWorkspaceMemberId: inferredOwner.inferredOwnerWorkspaceMemberId,
      ownerResolutionStatus: inferredOwner.ownerResolutionStatus,
      ownerRecommendation: inferredOwner.ownerRecommendation,
      recommendedWorkspaceEmail: inferredOwner.inferredOwnerEmail,
      warnings
    };
  }

  const warnings = buildOwnerWarnings(existingOwnerResolutionStatus, {
    hasCreatedBy: Boolean(createdBy.createdById || createdBy.createdByName || createdBy.createdByEmail)
  });

  return {
    ownerId: ownerId || null,
    ownerName: ownerName || matchedWorkspaceMember?.name || null,
    ownerEmail: ownerEmail || null,
    ownerWorkspaceMemberId: matchedWorkspaceMember?.id ?? null,
    createdById: createdBy.createdById,
    createdByName: createdBy.createdByName,
    createdByEmail: createdBy.createdByEmail,
    inferredOwnerName: null,
    inferredOwnerEmail: null,
    inferredOwnerWorkspaceMemberId: null,
    ownerResolutionStatus: existingOwnerResolutionStatus,
    ownerRecommendation: null,
    recommendedWorkspaceEmail: recommendedWorkspaceEmail || null,
    warnings
  };
}

export function inferWorkspaceEmailFromOwnerName(ownerName) {
  return LEGACY_OWNER_EMAIL_MAP[normalizeName(ownerName)] ?? null;
}

function determineResolutionStatus({
  ownerId,
  ownerName,
  ownerEmail,
  matchedWorkspaceMember,
  normalizedOwnerName
}) {
  if (!ownerId && !ownerName && !ownerEmail) {
    return 'missing';
  }

  if (normalizedOwnerName === 'visible gap') {
    return 'legacy_visible_gap';
  }

  if (matchedWorkspaceMember || ownerEmail) {
    return 'resolved';
  }

  return 'unresolved';
}

function buildOwnerWarnings(status, { hasCreatedBy = false } = {}) {
  if (status === 'missing') {
    return ['Owner missing and Created By could not be resolved.'];
  }

  if (status === 'unresolved') {
    return ['Owner could not be resolved; retrofit can proceed but rep assignment may need review.'];
  }

  if (status === 'legacy_visible_gap') {
    return ['Owner is legacy Visible Gap; recommended workspace email is hello@visiblegap.com.'];
  }

  return [];
}

function resolveCreatedBy({ person = {}, workspaceMemberIndexes }) {
  const createdBy = firstObject(person.createdBy);
  const createdById = firstString(
    person.createdById,
    createdBy?.workspaceMemberId,
    createdBy?.workspaceMember?.id,
    createdBy?.id
  );
  const createdByWorkspaceMember = createdById
    ? workspaceMemberIndexes.byId.get(String(createdById))
    : null;
  const createdByName = firstString(
    getName(createdByWorkspaceMember),
    getActorName(createdBy),
    person.createdByName
  );
  const directCreatedByEmail = normalizeEmail(
    firstString(
      createdByWorkspaceMember?.email,
      createdBy?.userEmail,
      createdBy?.email,
      createdBy?.primaryEmail,
      person.createdByEmail,
      inferWorkspaceEmailFromOwnerName(createdByName)
    )
  );

  return {
    createdById: createdById || null,
    createdByName: createdByName || null,
    createdByEmail: directCreatedByEmail || null,
    createdByWorkspaceMember
  };
}

function inferOwnerFromCreatedBy({ createdBy = {}, workspaceMemberIndexes }) {
  const creatorEmail = normalizeEmail(createdBy.createdByEmail);
  const creatorName = firstString(createdBy.createdByName);
  const visibleGapCreator =
    creatorEmail === 'hello@visiblegap.com' || normalizeName(creatorName) === 'visible gap';
  const fallbackOwnerEmail = visibleGapCreator ? 'chandler@visiblegap.com' : creatorEmail;
  const fallbackOwnerName = visibleGapCreator ? 'Chandler Johnson' : creatorName;
  const matchedWorkspaceMember =
    (fallbackOwnerEmail ? workspaceMemberIndexes.byEmail.get(fallbackOwnerEmail) : null) ??
    (fallbackOwnerName ? workspaceMemberIndexes.byName.get(normalizeName(fallbackOwnerName)) : null) ??
    null;

  if (!fallbackOwnerEmail && !matchedWorkspaceMember) {
    return {
      inferredOwnerName: null,
      inferredOwnerEmail: null,
      inferredOwnerWorkspaceMemberId: null,
      ownerResolutionStatus: 'missing',
      ownerRecommendation: null
    };
  }

  const inferredOwnerEmail = normalizeEmail(
    firstString(matchedWorkspaceMember?.email, fallbackOwnerEmail)
  );
  const inferredOwnerName = firstString(
    matchedWorkspaceMember?.name,
    fallbackOwnerName
  );

  if (!inferredOwnerEmail && !inferredOwnerName) {
    return {
      inferredOwnerName: null,
      inferredOwnerEmail: null,
      inferredOwnerWorkspaceMemberId: null,
      ownerResolutionStatus: 'missing',
      ownerRecommendation: null
    };
  }

  return {
    inferredOwnerName: inferredOwnerName || null,
    inferredOwnerEmail: inferredOwnerEmail || null,
    inferredOwnerWorkspaceMemberId: matchedWorkspaceMember?.id ?? null,
    ownerResolutionStatus: 'inferred_from_created_by',
    ownerRecommendation: {
      source: visibleGapCreator ? 'created_by_visible_gap_fallback' : 'created_by',
      createdById: createdBy.createdById,
      createdByName: createdBy.createdByName,
      createdByEmail: createdBy.createdByEmail,
      recommendedOwnerName: inferredOwnerName || null,
      recommendedOwnerEmail: inferredOwnerEmail || null,
      recommendedOwnerWorkspaceMemberId: matchedWorkspaceMember?.id ?? null,
      futureOwnerRecommendation: matchedWorkspaceMember?.id
        ? {
            ownerId: matchedWorkspaceMember.id
          }
        : null
    }
  };
}

function createWorkspaceMemberIndexes(workspaceMembers = []) {
  const byId = new Map();
  const byEmail = new Map();
  const byName = new Map();

  for (const member of workspaceMembers ?? []) {
    if (!member?.id) {
      continue;
    }

    const normalizedMember = {
      id: String(member.id),
      email: normalizeEmail(member.userEmail ?? member.email),
      name: getName(member),
      userId: firstString(member.userId)
    };

    byId.set(normalizedMember.id, normalizedMember);

    if (normalizedMember.email) {
      byEmail.set(normalizedMember.email, normalizedMember);
    }

    if (normalizedMember.name) {
      byName.set(normalizeName(normalizedMember.name), normalizedMember);
    }
  }

  return { byId, byEmail, byName };
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) ?? null;
}

function getName(value) {
  if (!value) {
    return '';
  }

  if (typeof value.name === 'string') {
    return value.name;
  }

  return firstString(
    value.name?.fullName,
    [value.name?.firstName, value.name?.lastName].filter(Boolean).join(' '),
    value.fullName,
    value.displayName
  );
}

function getActorName(value) {
  if (!value) {
    return '';
  }

  return firstString(
    value.name,
    value.displayName,
    value.fullName,
    value.context?.name
  );
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number') {
      return String(value);
    }
  }

  return '';
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
