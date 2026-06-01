export function evaluateSyncTestMode({
  liveTest,
  twentySyncEnabled,
  supabaseEnabled,
  twentyApiKey,
  supabaseUrl,
  supabaseServiceRoleKey
}) {
  const errors = [];
  const warnings = [];
  const liveRequested = toBoolean(liveTest);
  const syncEnabled = toBoolean(twentySyncEnabled);
  const durablePersistenceEnabled = toBoolean(supabaseEnabled);

  if (!liveRequested) {
    if (syncEnabled) {
      warnings.push(
        'TWENTY_SYNC_ENABLED is true, but LIVE_TEST is not true. The script will force dry-run mode.'
      );
    }

    return {
      mode: 'dry_run',
      ok: true,
      errors,
      warnings
    };
  }

  if (!syncEnabled) {
    errors.push('LIVE_TEST=true requires TWENTY_SYNC_ENABLED=true.');
  }

  if (!durablePersistenceEnabled) {
    errors.push('LIVE_TEST=true requires SUPABASE_ENABLED=true for durable idempotency.');
  }

  if (!twentyApiKey) {
    errors.push('LIVE_TEST=true requires TWENTY_API_KEY.');
  }

  if (!supabaseUrl) {
    errors.push('LIVE_TEST=true requires SUPABASE_URL.');
  }

  if (!supabaseServiceRoleKey) {
    errors.push('LIVE_TEST=true requires SUPABASE_SERVICE_ROLE_KEY.');
  }

  return {
    mode: 'live',
    ok: errors.length === 0,
    errors,
    warnings
  };
}

export function evaluateQuickCaptureSyncTestMode({
  liveTest,
  quickCaptureSyncEnabled,
  twentySyncEnabled,
  twentyApiKey,
  supabaseEnabled,
  supabaseUrl,
  supabaseServiceRoleKey
}) {
  const errors = [];
  const warnings = [];
  const liveRequested = toBoolean(liveTest);
  const quickCaptureEnabled = toBoolean(quickCaptureSyncEnabled);
  const twentyEnabled = toBoolean(twentySyncEnabled);
  const anyLiveFlagEnabled = liveRequested || quickCaptureEnabled || twentyEnabled;

  if (!anyLiveFlagEnabled) {
    return {
      mode: 'dry_run',
      ok: true,
      errors,
      warnings: [
        'Quick Capture live writes are disabled. Set QUICK_CAPTURE_SYNC_ENABLED=true, TWENTY_SYNC_ENABLED=true, and LIVE_TEST=true for one controlled live test.'
      ]
    };
  }

  if (!liveRequested) {
    errors.push('Quick Capture live test requires LIVE_TEST=true.');
  }

  if (!quickCaptureEnabled) {
    errors.push('Quick Capture live test requires QUICK_CAPTURE_SYNC_ENABLED=true.');
  }

  if (!twentyEnabled) {
    errors.push('Quick Capture live test requires TWENTY_SYNC_ENABLED=true.');
  }

  if (!twentyApiKey) {
    errors.push('Quick Capture live test requires TWENTY_API_KEY.');
  }

  if (!toBoolean(supabaseEnabled)) {
    warnings.push('SUPABASE_ENABLED is false. Live CRM writes can run, but no outbound event will be persisted.');
  } else {
    if (!supabaseUrl) {
      errors.push('SUPABASE_ENABLED=true requires SUPABASE_URL.');
    }

    if (!supabaseServiceRoleKey) {
      errors.push('SUPABASE_ENABLED=true requires SUPABASE_SERVICE_ROLE_KEY.');
    }
  }

  return {
    mode: errors.length === 0 ? 'live' : 'blocked',
    ok: errors.length === 0,
    errors,
    warnings
  };
}

export function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }

  return false;
}
