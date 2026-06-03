import { createTwentyRestClient } from './restClient.js';

export async function resolveWorkspaceMemberForQuickCapture({
  config = {},
  workspaceUser,
  restClient,
  log
} = {}) {
  const email = normalizeEmail(workspaceUser?.email);

  if (!workspaceUser?.authenticated || !email) {
    return {
      workspaceMember: null,
      warnings: []
    };
  }

  if (!config.apiKey) {
    return {
      workspaceMember: null,
      warnings: [
        `Owner and assignee omitted because Twenty workspace member lookup is unavailable for ${email}.`
      ]
    };
  }

  try {
    const client = restClient ?? createTwentyRestClient(config);
    const members = await client.listRecords('workspaceMembers', { limit: 100 });
    const match = members.find((member) => normalizeEmail(member.userEmail) === email);

    if (!match?.id) {
      return {
        workspaceMember: null,
        warnings: [
          `Owner and assignee omitted because no Twenty workspace member matched ${email}.`
        ]
      };
    }

    return {
      workspaceMember: {
        id: match.id,
        userEmail: match.userEmail,
        userId: match.userId,
        name: match.name
      },
      warnings: []
    };
  } catch (error) {
    log?.warn?.(
      {
        email,
        error: error.message,
        status: error.twentyDiagnostics?.httpStatus ?? error.response?.status
      },
      'Twenty workspace member lookup failed; owner and assignee will be omitted.'
    );

    return {
      workspaceMember: null,
      warnings: [
        `Owner and assignee omitted because Twenty workspace member lookup failed for ${email}: ${error.message}`
      ]
    };
  }
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}
